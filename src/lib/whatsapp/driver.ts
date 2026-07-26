import { type WhatsAppDriver, type DriverType } from './types'
import { MetaDriver } from './drivers/meta-driver'
import { EvolutionDriver } from './drivers/evolution-driver'
import { createAdminClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { Query } from 'node-appwrite'
import { decrypt } from '@/lib/whatsapp/encryption'

export function createDriver(type: DriverType, config: Record<string, string>): WhatsAppDriver {
  switch (type) {
    case 'evolution':
      return new EvolutionDriver({ instanceName: config.instanceName })
    case 'meta':
      return new MetaDriver({
        phoneNumberId: config.phoneNumberId,
        accessToken: config.accessToken,
      })
    default:
      throw new Error(`Unknown WhatsApp driver type: ${type}`)
  }
}

export function getDriverType(): DriverType {
  return (process.env.WHATSAPP_DRIVER as DriverType) || 'meta'
}

export async function getDriverForUser(userId: string): Promise<{ driver: WhatsAppDriver; config: Record<string, string> }> {
  const driverType = getDriverType()

  if (driverType === 'evolution') {
    return {
      driver: new EvolutionDriver({
        instanceName: process.env.EVOLUTION_INSTANCE_NAME || 'default',
      }),
      config: {},
    }
  }

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
