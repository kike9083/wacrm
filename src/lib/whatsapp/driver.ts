import { type WhatsAppDriver } from './types'
import { MetaDriver } from './drivers/meta-driver'
import { createAdminClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { Query } from 'node-appwrite'
import { decrypt } from '@/lib/whatsapp/encryption'

export function createMetaDriver(config: { phoneNumberId: string; accessToken: string }): WhatsAppDriver {
  return new MetaDriver({ phoneNumberId: config.phoneNumberId, accessToken: config.accessToken })
}

export async function getDriverForUser(userId: string): Promise<{ driver: WhatsAppDriver; config: Record<string, string> }> {
  const { databases } = createAdminClient()
  const configs = await databases.listDocuments(
    DATABASE_ID,
    COLLECTIONS.whatsappConfig,
    [Query.equal('user_id', userId)]
  )
  const config = configs.documents[0]
  if (!config) throw new Error('WhatsApp not configured')

  const accessToken = decrypt((config as any).access_token)
  return {
    driver: new MetaDriver({
      phoneNumberId: (config as any).phone_number_id,
      accessToken,
    }),
    config: config as unknown as Record<string, string>,
  }
}
