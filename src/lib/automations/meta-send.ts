import { createDriver, getDriverType } from '@/lib/whatsapp/driver'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { createAdminClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { ID, Query } from 'node-appwrite'

// ------------------------------------------------------------
// Automation-side Meta sender.
//
// Mirrors the logic in src/app/api/whatsapp/send/route.ts but uses
// the service-role client (engine has no cookies) and accepts the
// user / conversation / contact identifiers the engine already has
// on hand. Kept here (rather than refactoring the user-facing send
// route) to avoid risk to the working manual-send path — they can
// converge in a later refactor.
// ------------------------------------------------------------

interface SendTextArgs {
  userId: string
  conversationId: string
  contactId: string
  text: string
}

interface SendTemplateArgs {
  userId: string
  conversationId: string
  contactId: string
  templateName: string
  language?: string
  params?: string[]
}

export async function engineSendText(args: SendTextArgs): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'text' })
}

export async function engineSendTemplate(
  args: SendTemplateArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'template' })
}

type SendInput =
  | (SendTextArgs & { kind: 'text' })
  | (SendTemplateArgs & { kind: 'template' })

async function sendViaMeta(input: SendInput): Promise<{ whatsapp_message_id: string }> {
  const { databases } = createAdminClient()

  let contact
  try {
    contact = await databases.getDocument(DATABASE_ID, COLLECTIONS.contacts, input.contactId)
    if ((contact as any).user_id !== input.userId || !(contact as any).phone) {
      throw new Error('contact not found for this user')
    }
  } catch {
    throw new Error('contact not found for this user')
  }

  const sanitized = sanitizePhoneForMeta((contact as any).phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${(contact as any).phone}`)
  }

  let config
  try {
    const result = await databases.listDocuments(
      DATABASE_ID,
      COLLECTIONS.whatsappConfig,
      [Query.equal('user_id', input.userId)]
    )
    config = result.documents[0]
    if (!config) throw new Error('no config')
  } catch {
    throw new Error('WhatsApp not configured for this account')
  }

  const driverType = getDriverType()
  const driver = driverType === 'evolution'
    ? createDriver('evolution', { instanceName: process.env.EVOLUTION_INSTANCE_NAME || 'default' })
    : createDriver('meta', { phoneNumberId: (config as any).phone_number_id, accessToken: decrypt((config as any).access_token) })

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'template') {
      const r = await driver.sendTemplate(phone, (input as SendTemplateArgs).templateName, {
        language: (input as SendTemplateArgs).language,
        params: (input as SendTemplateArgs).params,
      })
      return r.messageId
    }
    const r = await driver.sendText(phone, (input as SendTextArgs).text)
    return r.messageId
  }

  const variants = phoneVariants(sanitized)
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (workingPhone !== sanitized) {
    await databases.updateDocument(DATABASE_ID, COLLECTIONS.contacts, (contact as any).$id, {
      phone: workingPhone,
    })
  }

  const content_type = input.kind === 'template' ? 'template' : 'text'
  const content_text = input.kind === 'text' ? (input as SendTextArgs).text : null
  const template_name = input.kind === 'template' ? (input as SendTemplateArgs).templateName : null

  try {
    await databases.createDocument(
      DATABASE_ID,
      COLLECTIONS.messages,
      ID.unique(),
      {
        conversation_id: input.conversationId,
        sender_type: 'bot',
        content_type,
        content_text,
        template_name,
        message_id: waMessageId,
        status: 'sent',
      }
    )
  } catch (err) {
    throw new Error(`sent to Meta but DB insert failed: ${err instanceof Error ? err.message : err}`)
  }

  await databases.updateDocument(DATABASE_ID, COLLECTIONS.conversations, input.conversationId, {
    last_message_text:
      input.kind === 'template' ? `[template:${template_name}]` : (input as SendTextArgs).text,
    last_message_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })

  return { whatsapp_message_id: waMessageId }
}
