import { NextResponse } from 'next/server'
import { createAdminClient, createSessionClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { ID, Query } from 'node-appwrite'
import {
  createDriverFromConfig,
  createMetaDriver,
  createWahaDriver,
  driverTypeOf,
  type WhatsAppConfigRow,
} from '@/lib/whatsapp/driver'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

/**
 * GET /api/whatsapp/config
 *
 * Used by the "Test API Connection" button and by the page to check
 * whether the saved config is healthy. Returns 200 in all non-auth cases
 * so the UI can render an appropriate message rather than show a 500.
 *
 * Response shape:
 *   { connected: true,  phone_info: {...} }
 *   { connected: false, reason: 'no_config',        message: '...' }
 *   { connected: false, reason: 'token_corrupted',  message: '...', needs_reset: true }
 *   { connected: false, reason: 'provider_error',   message: '...' }
 */
export async function GET() {
  try {
    const { account } = await createSessionClient()
    let user
    try {
      user = await account.get()
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Read config from DB
    const { databases } = createAdminClient()
    let configs
    try {
      configs = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.whatsappConfig,
        [Query.equal('user_id', user.$id)]
      )
    } catch {
      return NextResponse.json(
        { connected: false, reason: 'db_error', message: 'Failed to fetch configuration' },
        { status: 200 }
      )
    }
    const config = configs.documents[0]

    if (!config) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message: 'No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.',
        },
        { status: 200 }
      )
    }

    // Meta rows store the access token encrypted. Try to decrypt it with
    // the current ENCRYPTION_KEY so a key mismatch surfaces as a clear
    // "reset required" instead of a confusing provider error. WAHA rows
    // keep their secrets encrypted too but the driver handles those.
    if (driverTypeOf(config) === 'meta') {
      try {
        decrypt(config.access_token)
      } catch (err) {
        console.error('[whatsapp/config GET] Token decryption failed:', err)
        return NextResponse.json(
          {
            connected: false,
            reason: 'token_corrupted',
            needs_reset: true,
            message:
              'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. This usually means the key changed, or it differs between environments (local vs Hostinger vs Vercel). Click "Reset Configuration" below, then re-save.',
          },
          { status: 200 }
        )
      }
    }

    // Validate credentials against the configured provider
    try {
      const driver = createDriverFromConfig(config as WhatsAppConfigRow)
      const phoneInfo = await driver.verifyConnection()
      return NextResponse.json({ connected: true, phone_info: phoneInfo })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown provider error'
      console.error('[whatsapp/config GET] Provider verification failed:', message)
      return NextResponse.json(
        {
          connected: false,
          reason: 'provider_error',
          message: `Provider rejected the credentials: ${message}`,
        },
        { status: 200 }
      )
    }
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/whatsapp/config
 *
 * Saves or updates the WhatsApp config for the authenticated user.
 * Verifies credentials with the chosen provider first, then encrypts
 * and stores. Provider selection (`driver`):
 *   - `meta` (default): Meta Cloud API — phone_number_id + access_token
 *   - `waha`: self-hosted WAHA — base_url + api_key + session
 */
export async function POST(request: Request) {
  try {
    const { account } = await createSessionClient()
    let user
    try {
      user = await account.get()
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const {
      driver,
      phone_number_id,
      waba_id,
      access_token,
      verify_token,
      waha_base_url,
      waha_api_key,
      waha_session,
      waha_webhook_secret,
    } = body

    const isWaha = driver === 'waha'

    if (isWaha) {
      if (!waha_base_url || !waha_api_key || !waha_session) {
        return NextResponse.json(
          { error: 'waha_base_url, waha_api_key and waha_session are required for WAHA' },
          { status: 400 }
        )
      }
    } else if (!access_token || !phone_number_id) {
      return NextResponse.json(
        { error: 'access_token and phone_number_id are required' },
        { status: 400 }
      )
    }

    // Verify credentials BEFORE saving
    let phoneInfo
    try {
      const driverInstance = isWaha
        ? createWahaDriver({
            baseUrl: waha_base_url,
            apiKey: waha_api_key,
            session: waha_session,
          })
        : createMetaDriver({
            phoneNumberId: phone_number_id,
            accessToken: access_token,
          })
      phoneInfo = await driverInstance.verifyConnection()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown API error'
      console.error('API verification failed during save:', message)
      return NextResponse.json(
        { error: `API error: ${message}` },
        { status: 400 }
      )
    }

    // Encrypt sensitive tokens before storing
    let encryptedAccessToken: string | null = null
    let encryptedVerifyToken: string | null = null
    let encryptedWahaApiKey: string | null = null
    let encryptedWahaWebhookSecret: string | null = null
    try {
      if (isWaha) {
        encryptedWahaApiKey = encrypt(waha_api_key)
        if (waha_webhook_secret) {
          encryptedWahaWebhookSecret = encrypt(waha_webhook_secret)
        }
      } else {
        encryptedAccessToken = encrypt(access_token)
        encryptedVerifyToken = verify_token ? encrypt(verify_token) : null
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown encryption error'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 }
      )
    }

    // Upsert — overwrite any existing (possibly corrupted) config
    const { databases } = createAdminClient()
    let existingDocs
    try {
      existingDocs = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.whatsappConfig,
        [Query.equal('user_id', user.$id)]
      )
    } catch {
      return NextResponse.json(
        { error: 'Failed to save configuration' },
        { status: 500 }
      )
    }
    const existing = existingDocs.documents[0]

    const data: Record<string, unknown> = {
      driver: isWaha ? 'waha' : 'meta',
      status: 'connected',
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    if (isWaha) {
      data.waha_base_url = waha_base_url.replace(/\/+$/, '')
      data.waha_api_key = encryptedWahaApiKey
      data.waha_session = waha_session
      data.waha_webhook_secret = encryptedWahaWebhookSecret
      data.phone_number_id = null
      data.access_token = null
      data.verify_token = null
      data.waba_id = null
    } else {
      data.phone_number_id = phone_number_id
      data.waba_id = waba_id || null
      data.access_token = encryptedAccessToken
      data.verify_token = encryptedVerifyToken
      data.waha_base_url = null
      data.waha_api_key = null
      data.waha_session = null
      data.waha_webhook_secret = null
    }

    if (existing) {
      try {
        await databases.updateDocument(
          DATABASE_ID,
          COLLECTIONS.whatsappConfig,
          existing.$id,
          data
        )
      } catch (error) {
        console.error('Error updating whatsapp_config:', error)
        return NextResponse.json(
          { error: 'Failed to update configuration' },
          { status: 500 }
        )
      }
    } else {
      try {
        await databases.createDocument(
          DATABASE_ID,
          COLLECTIONS.whatsappConfig,
          ID.unique(),
          {
            user_id: user.$id,
            ...data,
          }
        )
      } catch (error) {
        console.error('Error inserting whatsapp_config:', error)
        return NextResponse.json(
          { error: 'Failed to save configuration' },
          { status: 500 }
        )
      }
    }

    return NextResponse.json({ success: true, phone_info: phoneInfo })
  } catch (error) {
    console.error('Error in WhatsApp config POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/whatsapp/config
 *
 * Removes the authenticated user's WhatsApp configuration row.
 * Used by the "Reset Configuration" button to recover from a corrupted
 * encrypted token (mismatched ENCRYPTION_KEY across environments).
 */
export async function DELETE() {
  try {
    const { account } = await createSessionClient()
    let user
    try {
      user = await account.get()
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { databases } = createAdminClient()
    let configs
    try {
      configs = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.whatsappConfig,
        [Query.equal('user_id', user.$id)]
      )
    } catch {
      return NextResponse.json(
        { error: 'Failed to delete configuration' },
        { status: 500 }
      )
    }
    const config = configs.documents[0]
    if (!config) {
      return NextResponse.json({ success: true })
    }

    try {
      await databases.deleteDocument(
        DATABASE_ID,
        COLLECTIONS.whatsappConfig,
        config.$id
      )
    } catch (error) {
      console.error('Error deleting whatsapp_config:', error)
      return NextResponse.json(
        { error: 'Failed to delete configuration' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
