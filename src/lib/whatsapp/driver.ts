import { type WhatsAppDriver, type DriverType } from './types'
import { MetaDriver } from './drivers/meta-driver'
import { WahaDriver } from './drivers/waha-driver'
import { createAdminClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { Query } from 'node-appwrite'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * WhatsApp config row (subset of the whatsapp_config collection fields
 * the driver factory reads). The shape is intentionally loose — rows
 * come from Appwrite and predate the WAHA fields.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WhatsAppConfigRow = Record<string, any>

export function createMetaDriver(config: {
  phoneNumberId: string
  accessToken: string
}): WhatsAppDriver {
  return new MetaDriver({
    phoneNumberId: config.phoneNumberId,
    accessToken: config.accessToken,
  })
}

/** Raw-credential WAHA driver — used before secrets are encrypted. */
export function createWahaDriver(config: {
  baseUrl: string
  apiKey: string
  session: string
}): WhatsAppDriver {
  return new WahaDriver({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    session: config.session,
  })
}

export function driverTypeOf(config: WhatsAppConfigRow): DriverType {
  return config.driver === 'waha' ? 'waha' : 'meta'
}

/**
 * Build the right driver for a stored whatsapp_config row.
 *
 * Rows saved before the WAHA feature (`driver` field unset) resolve to
 * Meta — existing integrations are unaffected. WAHA rows decrypt their
 * stored secrets (waha_api_key) here so callers never touch plaintext.
 *
 * Throws when a declared driver is missing its required fields instead
 * of silently falling back — a misconfigured WAHA row must fail loudly
 * in the health check, not degrade to a broken Meta call.
 */
export function createDriverFromConfig(
  config: WhatsAppConfigRow,
): WhatsAppDriver {
  if (driverTypeOf(config) === 'waha') {
    if (!config.waha_base_url || !config.waha_api_key || !config.waha_session) {
      throw new Error(
        'WAHA configuration is incomplete. Re-save the WhatsApp settings ' +
          'with the WAHA base URL, API key and session name.',
      )
    }
    return new WahaDriver({
      baseUrl: config.waha_base_url,
      apiKey: decrypt(config.waha_api_key),
      session: config.waha_session,
    })
  }

  if (!config.phone_number_id || !config.access_token) {
    throw new Error(
      'WhatsApp configuration is incomplete. Re-save the WhatsApp ' +
        'settings with your provider credentials.',
    )
  }
  return new MetaDriver({
    phoneNumberId: config.phone_number_id,
    accessToken: decrypt(config.access_token),
  })
}

export async function getDriverForUser(
  userId: string,
): Promise<{ driver: WhatsAppDriver; config: WhatsAppConfigRow }> {
  const { databases } = createAdminClient()
  const configs = await databases.listDocuments(
    DATABASE_ID,
    COLLECTIONS.whatsappConfig,
    [Query.equal('user_id', userId)]
  )
  const config = configs.documents[0]
  if (!config) throw new Error('WhatsApp not configured')

  return {
    driver: createDriverFromConfig(config),
    config,
  }
}