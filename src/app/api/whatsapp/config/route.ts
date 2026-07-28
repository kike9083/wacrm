import { NextResponse } from 'next/server'
import { createAdminClient, createSessionClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { ID, Query } from 'node-appwrite'
import { createMetaDriver } from '@/lib/whatsapp/driver'
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
 *   { connected: false, reason: 'meta_api_error',   message: '...' }
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

    // Meta driver: read config from DB
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

    // Try to decrypt the stored token with the current ENCRYPTION_KEY.
    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
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

    // Validate credentials against Meta
    try {
      const driver = createMetaDriver({ phoneNumberId: config.phone_number_id, accessToken })
      const phoneInfo = await driver.verifyConnection()
      return NextResponse.json({ connected: true, phone_info: phoneInfo })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('[whatsapp/config GET] Meta API verification failed:', message)
      return NextResponse.json(
        {
          connected: false,
          reason: 'meta_api_error',
          message: `Meta API rejected the credentials: ${message}`,
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
 * Verifies credentials with Meta first, then encrypts and stores.
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
    const { phone_number_id, waba_id, access_token, verify_token } = body

    if (!access_token || !phone_number_id) {
      return NextResponse.json(
        { error: 'access_token and phone_number_id are required' },
        { status: 400 }
      )
    }

    // Verify credentials BEFORE saving
    let phoneInfo
    try {
      const driver = createMetaDriver({ phoneNumberId: phone_number_id, accessToken: access_token })
      phoneInfo = await driver.verifyConnection()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown API error'
      console.error('API verification failed during save:', message)
      return NextResponse.json(
        { error: `API error: ${message}` },
        { status: 400 }
      )
    }

    // Encrypt sensitive tokens before storing
    let encryptedAccessToken: string
    let encryptedVerifyToken: string | null
    try {
      encryptedAccessToken = encrypt(access_token)
      encryptedVerifyToken = verify_token ? encrypt(verify_token) : null
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

    if (existing) {
      try {
        await databases.updateDocument(
          DATABASE_ID,
          COLLECTIONS.whatsappConfig,
          existing.$id,
          {
            phone_number_id,
            waba_id: waba_id || null,
            access_token: encryptedAccessToken,
            verify_token: encryptedVerifyToken,
            status: 'connected',
            connected_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }
        )
      } catch {
        console.error('Error updating whatsapp_config')
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
            phone_number_id,
            waba_id: waba_id || null,
            access_token: encryptedAccessToken,
            verify_token: encryptedVerifyToken,
            status: 'connected',
            connected_at: new Date().toISOString(),
          }
        )
      } catch {
        console.error('Error inserting whatsapp_config')
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
    } catch {
      console.error('Error deleting whatsapp_config')
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
