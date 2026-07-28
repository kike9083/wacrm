import { createMetaDriver } from '@/lib/whatsapp/driver'
import type { InteractiveButton, InteractiveListSection } from '@/lib/whatsapp/types'
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
// Flows-side Meta sender (interactive variants).
//
// Mirrors src/lib/automations/meta-send.ts (engineSendText /
// engineSendTemplate) but emits interactive button + list messages.
// Kept separate from the automations file so the two engines don't
// fight over each other's shape — once both stabilize, the
// phone-variant retry + DB persistence are obvious extraction
// candidates into a shared base.
//
// PR #1 ships this in isolation: callers don't exist yet. PR #2
// brings the flow runner online and wires it up. Shipping it now
// keeps the foundation PR self-contained and unit-testable.
// ------------------------------------------------------------

interface SendTextEngineArgs {
  userId: string
  conversationId: string
  contactId: string
  text: string
}

/**
 * Send a plain-text WhatsApp message from the Flows engine.
 *
 * Used by the runner's `send_message` and `collect_input` nodes —
 * both prompt the customer with text and either auto-advance (the
 * send_message case) or suspend awaiting a text reply (collect_input).
 *
 * Wraps the same phone-variant retry + DB persistence pattern as the
 * interactive senders; the duplication will be DRY'd into a shared
 * `engineSendBase` once the v2 features (templates with variables,
 * media sends) settle.
 */
export async function engineSendText(
  args: SendTextEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const { databases } = createAdminClient()

  let contact
  try {
    contact = await databases.getDocument(DATABASE_ID, COLLECTIONS.contacts, args.contactId)
    if ((contact as any).user_id !== args.userId || !(contact as any).phone) {
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
      [Query.equal('user_id', args.userId)]
    )
    config = result.documents[0]
    if (!config) throw new Error('no config')
  } catch {
    throw new Error('WhatsApp not configured for this account')
  }

  const driver = createMetaDriver({ phoneNumberId: (config as any).phone_number_id, accessToken: decrypt((config as any).access_token) })

  const attempt = async (phone: string): Promise<string> => {
    const r = await driver.sendText(phone, args.text)
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

  try {
    await databases.createDocument(
      DATABASE_ID,
      COLLECTIONS.messages,
      ID.unique(),
      {
        conversation_id: args.conversationId,
        sender_type: 'bot',
        content_type: 'text',
        content_text: args.text,
        message_id: waMessageId,
        status: 'sent',
      }
    )
  } catch (err) {
    throw new Error(`sent to Meta but DB insert failed: ${err instanceof Error ? err.message : err}`)
  }

  await databases.updateDocument(DATABASE_ID, COLLECTIONS.conversations, args.conversationId, {
    last_message_text: args.text,
    last_message_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })

  return { whatsapp_message_id: waMessageId }
}

interface SendInteractiveButtonsEngineArgs {
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttons: InteractiveButton[]
  headerText?: string
  footerText?: string
}

interface SendInteractiveListEngineArgs {
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttonLabel: string
  sections: InteractiveListSection[]
  headerText?: string
  footerText?: string
}

/**
 * Send an interactive-button WhatsApp message from the Flows engine.
 *
 * Persists the outgoing message to `messages` with
 * `content_type='interactive'` and `sender_type='bot'` so the inbox
 * surfaces it with the "Button reply" affordance and the conversation
 * thread reflects the bot's prompt.
 *
 * Returns the Meta message id so the caller (engine) can stash it on
 * the `flow_runs.last_prompt_message_id` field for later reference.
 */
export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'buttons' })
}

/**
 * Send an interactive-list WhatsApp message from the Flows engine.
 * Used when the flow needs more than 3 options (Meta's button cap).
 */
export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'list' })
}

type SendInput =
  | (SendInteractiveButtonsEngineArgs & { kind: 'buttons' })
  | (SendInteractiveListEngineArgs & { kind: 'list' })

async function sendInteractiveViaMeta(
  input: SendInput,
): Promise<{ whatsapp_message_id: string }> {
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

  const driver = createMetaDriver({ phoneNumberId: (config as any).phone_number_id, accessToken: decrypt((config as any).access_token) })

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'buttons') {
      const r = await driver.sendInteractiveButtons(
        phone,
        input.bodyText,
        input.buttons,
        { headerText: input.headerText, footerText: input.footerText },
      )
      return r.messageId
    }
    const r = await driver.sendInteractiveList(
      phone,
      input.bodyText,
      input.buttonLabel,
      input.sections,
      { headerText: input.headerText, footerText: input.footerText },
    )
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

  try {
    await databases.createDocument(
      DATABASE_ID,
      COLLECTIONS.messages,
      ID.unique(),
      {
        conversation_id: input.conversationId,
        sender_type: 'bot',
        content_type: 'interactive',
        content_text: input.bodyText,
        message_id: waMessageId,
        status: 'sent',
      }
    )
  } catch (err) {
    throw new Error(`sent to Meta but DB insert failed: ${err instanceof Error ? err.message : err}`)
  }

  await databases.updateDocument(DATABASE_ID, COLLECTIONS.conversations, input.conversationId, {
    last_message_text: input.bodyText,
    last_message_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })

  return { whatsapp_message_id: waMessageId }
}
