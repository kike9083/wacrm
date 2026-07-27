import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { ID, Query } from 'node-appwrite'
import { normalizePhone, phonesMatch } from '@/lib/whatsapp/phone-utils'
import { createDriver } from '@/lib/whatsapp/driver'
import type { WhatsAppDriver } from '@/lib/whatsapp/types'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'

let _admin: ReturnType<typeof createAdminClient> | null = null
function adminDb() {
  if (!_admin) {
    _admin = createAdminClient()
  }
  return _admin.databases
}

type EvolutionEvent =
  | 'MESSAGES_UPSERT'
  | 'MESSAGES_UPDATE'
  | 'MESSAGES_DELETE'
  | 'SEND_MESSAGE'
  | 'SEND_MESSAGE_UPDATE'
  | 'CONNECTION_UPDATE'
  | 'PRESENCE_UPDATE'
  | 'CALL'
  | 'QRCODE_UPDATED'

interface EvolutionWebhookPayload {
  event: EvolutionEvent
  instance: string
  data: Record<string, unknown>
}

function stripSuffix(jid: string): string {
  return jid.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '')
}

function extractNumber(data: Record<string, unknown>): string | null {
  const key = data.key as Record<string, unknown> | undefined
  if (key?.remoteJid && typeof key.remoteJid === 'string') {
    return stripSuffix(key.remoteJid)
  }
  return null
}

function extractMessageId(data: Record<string, unknown>): string | null {
  const key = data.key as Record<string, unknown> | undefined
  if (key?.id && typeof key.id === 'string') {
    return key.id
  }
  return null
}

function extractPushName(data: Record<string, unknown>): string {
  return (data.pushName as string) || (data.notifyName as string) || ''
}

function extractMessageTimestamp(data: Record<string, unknown>): string {
  const ts = data.messageTimestamp ?? data.timestamp
  if (typeof ts === 'number') return String(ts)
  return String(Math.floor(Date.now() / 1000))
}

function isFromMe(data: Record<string, unknown>): boolean {
  const key = data.key as Record<string, unknown> | undefined
  return key?.fromMe === true
}

function parseEvolutionMessage(
  data: Record<string, unknown>,
  driver: WhatsAppDriver,
): Promise<{
  type: string
  contentText: string | null
  mediaUrl: string | null
  interactiveReplyId: string | null
}> {
  const rawMessage = (data.message as Record<string, unknown>) || {}
  const msgType = (data.messageType as string) || ''

  switch (msgType) {
    case 'conversation':
      return Promise.resolve({
        type: 'text',
        contentText: (rawMessage.conversation as string) || null,
        mediaUrl: null,
        interactiveReplyId: null,
      })

    case 'extendedTextMessage': {
      const ext = rawMessage.extendedTextMessage as Record<string, unknown> | undefined
      return Promise.resolve({
        type: 'text',
        contentText: (ext?.text as string) || null,
        mediaUrl: null,
        interactiveReplyId: null,
      })
    }

    case 'imageMessage': {
      const img = rawMessage.imageMessage as Record<string, unknown> | undefined
      return handleEvolutionMedia(img, driver, img?.caption as string | undefined)
    }

    case 'videoMessage': {
      const vid = rawMessage.videoMessage as Record<string, unknown> | undefined
      return handleEvolutionMedia(vid, driver, vid?.caption as string | undefined)
    }

    case 'documentMessage': {
      const doc = rawMessage.documentMessage as Record<string, unknown> | undefined
      return handleEvolutionMedia(doc, driver, doc?.caption as string | undefined)
    }

    case 'audioMessage':
    case 'ptvMessage': {
      const aud = rawMessage.audioMessage || rawMessage.ptvMessage
      return handleEvolutionMedia(aud as Record<string, unknown>, driver)
    }

    case 'stickerMessage': {
      const stk = rawMessage.stickerMessage as Record<string, unknown> | undefined
      return handleEvolutionMedia(stk, driver)
    }

    case 'locationMessage': {
      const loc = rawMessage.locationMessage as Record<string, unknown> | undefined
      if (loc) {
        const parts = [loc.name, loc.address, `${loc.degreesLatitude || '?'},${loc.degreesLongitude || '?'}`]
          .filter(Boolean)
          .join(' - ')
        return Promise.resolve({ type: 'location', contentText: parts, mediaUrl: null, interactiveReplyId: null })
      }
      return Promise.resolve({ type: 'text', contentText: '[Location]', mediaUrl: null, interactiveReplyId: null })
    }

    case 'reactionMessage': {
      const react = rawMessage.reactionMessage as Record<string, unknown> | undefined
      return Promise.resolve({
        type: 'reaction',
        contentText: (react?.text as string) || null,
        mediaUrl: null,
        interactiveReplyId: null,
      })
    }

    case 'buttonsResponseMessage': {
      const btn = rawMessage.buttonsResponseMessage as Record<string, unknown> | undefined
      return Promise.resolve({
        type: 'interactive',
        contentText: (btn?.selectedButtonId as string) || (btn?.selectedDisplayText as string) || null,
        mediaUrl: null,
        interactiveReplyId: (btn?.selectedButtonId as string) || null,
      })
    }

    case 'listResponseMessage': {
      const list = rawMessage.listResponseMessage as Record<string, unknown> | undefined
      const row = list?.singleSelectReply as Record<string, unknown> | undefined
      const replyId = row?.selectedRowId as string | undefined
      return Promise.resolve({
        type: 'interactive',
        contentText: (list?.title as string) || replyId || null,
        mediaUrl: null,
        interactiveReplyId: replyId || null,
      })
    }

    case 'orderMessage':
      return Promise.resolve({ type: 'text', contentText: '[Order]', mediaUrl: null, interactiveReplyId: null })

    default:
      return Promise.resolve({ type: 'text', contentText: `[${msgType}]`, mediaUrl: null, interactiveReplyId: null })
  }
}

async function handleEvolutionMedia(
  media: Record<string, unknown> | undefined,
  driver: WhatsAppDriver,
  caption?: string,
) {
  if (!media?.id) {
    return { type: 'text', contentText: caption || '[Media]', mediaUrl: null, interactiveReplyId: null }
  }
  try {
    await driver.getMediaUrl(media.id as string)
  } catch {
    return { type: 'text', contentText: caption || '[Media]', mediaUrl: null, interactiveReplyId: null }
  }
  return { type: 'image', contentText: caption || null, mediaUrl: `/api/whatsapp/media/${media.id}`, interactiveReplyId: null }
}

async function findOrCreateContact(userId: string, phone: string, name: string) {
  let contactsResult
  try {
    contactsResult = await adminDb().listDocuments(DATABASE_ID, COLLECTIONS.contacts, [
      Query.equal('user_id', userId),
    ])
  } catch {
    return null
  }
  const existing = contactsResult.documents.find((c: any) => phonesMatch(c.phone, phone))
  if (existing) {
    if (name && name !== existing.name) {
      try {
        await adminDb().updateDocument(DATABASE_ID, COLLECTIONS.contacts, existing.$id, {
          name,
          updated_at: new Date().toISOString(),
        })
      } catch { /* best-effort */ }
    }
    return { contact: existing, wasCreated: false }
  }
  try {
    const newContact = await adminDb().createDocument(DATABASE_ID, COLLECTIONS.contacts, ID.unique(), {
      user_id: userId,
      phone,
      name: name || phone,
    })
    return { contact: newContact, wasCreated: true }
  } catch {
    return null
  }
}

async function findOrCreateConversation(userId: string, contactId: string) {
  try {
    const result = await adminDb().listDocuments(DATABASE_ID, COLLECTIONS.conversations, [
      Query.equal('user_id', userId),
      Query.equal('contact_id', contactId),
    ])
    if (result.documents.length > 0) return result.documents[0]
  } catch {
    return null
  }
  try {
    return await adminDb().createDocument(DATABASE_ID, COLLECTIONS.conversations, ID.unique(), {
      user_id: userId,
      contact_id: contactId,
    })
  } catch {
    return null
  }
}

async function upsertMessage(
  conversationId: string,
  contactId: string,
  msgId: string,
  contentType: string,
  contentText: string | null,
  mediaUrl: string | null,
  interactiveReplyId: string | null,
  timestamp: string,
  userId: string,
) {
  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video', 'location', 'template', 'interactive',
  ])
  const ct = ALLOWED_CONTENT_TYPES.has(contentType) ? contentType : 'text'

  try {
    await adminDb().createDocument(DATABASE_ID, COLLECTIONS.messages, ID.unique(), {
      conversation_id: conversationId,
      sender_type: 'customer',
      content_type: ct,
      content_text: contentText,
      media_url: mediaUrl,
      message_id: msgId,
      status: 'delivered',
      created_at: new Date(parseInt(timestamp) * 1000).toISOString(),
      interactive_reply_id: interactiveReplyId,
    })
  } catch (error) {
    console.error('Error inserting evolution message:', error)
    return false
  }

  try {
    await adminDb().updateDocument(DATABASE_ID, COLLECTIONS.conversations, conversationId, {
      last_message_text: contentText || `[${contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (await getUnreadCount(conversationId)) + 1,
      updated_at: new Date().toISOString(),
    })
  } catch { /* best-effort */ }

  return true
}

async function getUnreadCount(conversationId: string): Promise<number> {
  try {
    const conv = await adminDb().getDocument(DATABASE_ID, COLLECTIONS.conversations, conversationId)
    return (conv as any).unread_count || 0
  } catch {
    return 0
  }
}

async function handleIncomingMessage(
  data: Record<string, unknown>,
  userId: string,
  driver: WhatsAppDriver,
  instanceName: string,
) {
  const number = extractNumber(data)
  if (!number) return

  const pushName = extractPushName(data)
  const contactOutcome = await findOrCreateContact(userId, number, pushName)
  if (!contactOutcome) return

  const conversation = await findOrCreateConversation(userId, contactOutcome.contact.$id)
  if (!conversation) return

  const msgType = (data.messageType as string) || ''

  if (msgType === 'reactionMessage') {
    await handleReactionMessage(data, userId)
    return
  }

  const { type, contentText, mediaUrl, interactiveReplyId } = await parseEvolutionMessage(data, driver)
  const msgId = extractMessageId(data) || `${Date.now()}`
  const ts = extractMessageTimestamp(data)
  const isFirstInbound = await priorCustomerMsgCount(conversation.$id) === 0

  await upsertMessage(
    conversation.$id,
    contactOutcome.contact.$id,
    msgId,
    type,
    contentText,
    mediaUrl,
    interactiveReplyId,
    ts,
    userId,
  )

  const flowResult = await dispatchInboundToFlows({
    userId,
    contactId: contactOutcome.contact.$id,
    conversationId: conversation.$id,
    message: interactiveReplyId
      ? { kind: 'interactive_reply', reply_id: interactiveReplyId, reply_title: contentText ?? '', meta_message_id: msgId }
      : { kind: 'text', text: contentText ?? '', meta_message_id: msgId },
    isFirstInbound,
  })

  const triggers: string[] = []
  if (!flowResult.consumed) {
    triggers.push('new_message_received', 'keyword_match')
  }
  if (contactOutcome.wasCreated) triggers.unshift('new_contact_created')
  if (isFirstInbound) triggers.unshift('first_inbound_message')

  for (const triggerType of triggers) {
    runAutomationsForTrigger({
      userId,
      triggerType: triggerType as any,
      contactId: contactOutcome.contact.$id,
      context: { message_text: contentText ?? '', conversation_id: conversation.$id },
    }).catch((err) => console.error('[evolution-webhook] automation dispatch failed:', err))
  }
}

async function priorCustomerMsgCount(conversationId: string): Promise<number> {
  try {
    const msgs = await adminDb().listDocuments(DATABASE_ID, COLLECTIONS.messages, [
      Query.equal('conversation_id', conversationId),
      Query.equal('sender_type', 'customer'),
    ])
    return msgs.documents.length
  } catch {
    return 0
  }
}

async function handleStatusUpdate(data: Record<string, unknown>) {
  const statusStr = (data.status as string) || ''
  const msgId = extractMessageId(data)
  const number = extractNumber(data)
  if (!msgId) return

  const evolutionStatusMap: Record<string, string> = {
    PENDING: 'pending',
    SENT: 'sent',
    RECEIVED: 'delivered',
    READ: 'read',
    ERROR: 'failed',
  }
  const status = evolutionStatusMap[statusStr.toUpperCase()] || statusStr

  try {
    const msgResult = await adminDb().listDocuments(DATABASE_ID, COLLECTIONS.messages, [
      Query.equal('message_id', msgId),
    ])
    if (msgResult.documents.length > 0) {
      await adminDb().updateDocument(DATABASE_ID, COLLECTIONS.messages, msgResult.documents[0].$id, { status })
    }
  } catch { /* best-effort */ }

  if (number && status) {
    try {
      const recs = await adminDb().listDocuments(DATABASE_ID, COLLECTIONS.broadcastRecipients, [
        Query.equal('whatsapp_message_id', msgId),
      ])
      if (recs.documents.length > 0) {
        const update: Record<string, unknown> = { status }
        if (status === 'sent') update.sent_at = new Date().toISOString()
        if (status === 'delivered') update.delivered_at = new Date().toISOString()
        if (status === 'read') update.read_at = new Date().toISOString()
        await adminDb().updateDocument(DATABASE_ID, COLLECTIONS.broadcastRecipients, recs.documents[0].$id, update)
      }
    } catch { /* best-effort */ }
  }
}

async function handleReactionMessage(data: Record<string, unknown>, userId: string) {
  const rawMessage = data.message as Record<string, unknown> | undefined
  const react = rawMessage?.reactionMessage as Record<string, unknown> | undefined
  if (!react?.key?.id || !react?.text) return

  const number = extractNumber(data)
  const msgId = extractMessageId(data)
  if (!number || !msgId) return

  const normalizedNumber = normalizePhone(number)
  let contactsResult
  try {
    contactsResult = await adminDb().listDocuments(DATABASE_ID, COLLECTIONS.contacts, [
      Query.equal('user_id', userId),
    ])
  } catch {
    return
  }
  const contact = contactsResult?.documents.find((c: any) => phonesMatch(c.phone, normalizedNumber))
  if (!contact) return

  let convs
  try {
    convs = await adminDb().listDocuments(DATABASE_ID, COLLECTIONS.conversations, [
      Query.equal('contact_id', contact.$id),
    ])
  } catch {
    return
  }
  const conv = convs?.documents[0]
  if (!conv) return

  const targetMsgId = react.key.id as string
  let targetMsgs
  try {
    targetMsgs = await adminDb().listDocuments(DATABASE_ID, COLLECTIONS.messages, [
      Query.equal('message_id', targetMsgId),
      Query.equal('conversation_id', conv.$id),
    ])
  } catch {
    return
  }
  const target = targetMsgs?.documents[0]
  if (!target) return

  const emoji = react.text as string
  if (!emoji) {
    try {
      const existing = await adminDb().listDocuments(DATABASE_ID, COLLECTIONS.messageReactions, [
        Query.equal('message_id', target.$id),
        Query.equal('actor_type', 'customer'),
        Query.equal('actor_id', contact.$id),
      ])
      if (existing.documents.length > 0) {
        await adminDb().deleteDocument(DATABASE_ID, COLLECTIONS.messageReactions, existing.documents[0].$id)
      }
    } catch { /* best-effort */ }
    return
  }

  try {
    const existing = await adminDb().listDocuments(DATABASE_ID, COLLECTIONS.messageReactions, [
      Query.equal('message_id', target.$id),
      Query.equal('actor_type', 'customer'),
      Query.equal('actor_id', contact.$id),
    ])
    if (existing.documents.length > 0) {
      await adminDb().updateDocument(DATABASE_ID, COLLECTIONS.messageReactions, existing.documents[0].$id, { emoji })
    } else {
      await adminDb().createDocument(DATABASE_ID, COLLECTIONS.messageReactions, ID.unique(), {
        message_id: target.$id,
        conversation_id: conv.$id,
        actor_type: 'customer',
        actor_id: contact.$id,
        emoji,
      })
    }
  } catch { /* best-effort */ }
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  let payload: EvolutionWebhookPayload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const driver = createDriver('evolution', {
    instanceName: payload.instance || process.env.EVOLUTION_INSTANCE_NAME || 'default',
  })

  let userId = process.env.EVOLUTION_USER_ID
  if (!userId) {
    try {
      const profiles = await adminDb().listDocuments(DATABASE_ID, COLLECTIONS.profiles, [Query.limit(1)])
      userId = profiles.documents[0]?.user_id || profiles.documents[0]?.$id || null
    } catch {
      userId = null
    }
  }

  if (!userId) {
    console.error('[evolution-webhook] no userId configured — set EVOLUTION_USER_ID env var')
    return NextResponse.json({ error: 'No user configured' }, { status: 500 })
  }

  void processEvolutionWebhook(payload, userId, driver).catch((err) => {
    console.error('[evolution-webhook] processing error:', err)
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processEvolutionWebhook(
  payload: EvolutionWebhookPayload,
  userId: string,
  driver: WhatsAppDriver,
) {
  const { event, instance, data } = payload
  const instanceName = instance || process.env.EVOLUTION_INSTANCE_NAME || 'default'

  switch (event) {
    case 'MESSAGES_UPSERT':
      if (!isFromMe(data)) {
        await handleIncomingMessage(data, userId, driver, instanceName)
      }
      break

    case 'MESSAGES_UPDATE': {
      const update = data.update as Record<string, unknown> | undefined
      if (update) {
        await handleStatusUpdate({ ...data, ...update })
      }
      break
    }

    case 'SEND_MESSAGE':
    case 'SEND_MESSAGE_UPDATE':
      await handleStatusUpdate(data)
      break

    case 'CONNECTION_UPDATE':
      console.log(`[evolution-webhook] CONNECTION_UPDATE for ${instanceName}:`, data.status || data)
      break

    default:
      console.log(`[evolution-webhook] unhandled event: ${event}`)
  }
}
