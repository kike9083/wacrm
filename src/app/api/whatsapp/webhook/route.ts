import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { ID, Query } from 'node-appwrite'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { createMetaDriver } from '@/lib/whatsapp/driver'
import type { WhatsAppDriver } from '@/lib/whatsapp/types'
import { normalizePhone, phonesMatch } from '@/lib/whatsapp/phone-utils'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'

// Lazy-initialized Appwrite admin client
let _admin: ReturnType<typeof createAdminClient> | null = null
function adminDb() {
  if (!_admin) {
    _admin = createAdminClient()
  }
  return _admin.databases
}

interface WhatsAppMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  /**
   * Set when the customer taps a button or list row on an interactive
   * message we sent. `button_reply.id` / `list_reply.id` is whatever id
   * we put on the button/row when sending — the Flows engine uses this
   * to advance the per-contact run.
   */
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  /** Present when the customer swipe-replies to one of our messages. */
  context?: { id: string }
}

interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product: string
      metadata: {
        display_phone_number: string
        phone_number_id: string
      }
      contacts?: Array<{
        profile: { name: string }
        wa_id: string
      }>
      messages?: WhatsAppMessage[]
      statuses?: Array<{
        id: string
        status: string
        timestamp: string
        recipient_id: string
      }>
    }
    field: string
  }>
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      )
    }

    // Fetch all whatsapp configs to check verify tokens
    let configs
    try {
      configs = await adminDb().listDocuments(
        DATABASE_ID,
        COLLECTIONS.whatsappConfig,
      )
    } catch (error) {
      console.error('Error fetching configs for verification:', error)
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      )
    }
    const configList = configs.documents

    // Check if any config's verify_token matches. Also collect the
    // matching row so we can opportunistically upgrade its token to
    // GCM if it was still in the legacy CBC format.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null
    for (const config of configList) {
      if (!config.verify_token) continue
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matchedConfig = config
          break
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) {
      // Fire-and-forget GCM upgrade. Safe to run on every subscribe
      // since it's a no-op once the column is already GCM.
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void adminDb().updateDocument(
          DATABASE_ID,
          COLLECTIONS.whatsappConfig,
          matchedConfig.$id,
          { verify_token: encrypt(verifyToken) },
        ).catch((error: Error) => {
          console.warn(
            '[webhook] verify_token GCM upgrade failed:',
            error?.message ?? error,
          )
        })
      }
      // Return challenge as plain text
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    console.error('Error in webhook GET verification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST - Receive messages
export async function POST(request: Request) {
  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed. request.json() would re-encode and break the signature.
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    // 401 (not 200) — we want Meta's delivery dashboard to show failures
    // loudly if a misconfiguration causes signatures to stop matching,
    // rather than silently eating events.
    console.warn('[webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: { entry?: WhatsAppWebhookEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Process asynchronously so we can ack Meta within their timeout.
  processWebhook(body).catch((error) => {
    console.error('Error processing webhook:', error)
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processWebhook(body: { entry?: WhatsAppWebhookEntry[] }) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      const value = change.value

      // Handle status updates
      if (value.statuses) {
        for (const status of value.statuses) {
          await handleStatusUpdate(status)
        }
      }

      // Handle incoming messages
      if (!value.messages || !value.contacts) continue

      const phoneNumberId = value.metadata.phone_number_id

      // Find user's config by phone_number_id
      let configResult
      try {
        configResult = await adminDb().listDocuments(
          DATABASE_ID,
          COLLECTIONS.whatsappConfig,
          [Query.equal('phone_number_id', phoneNumberId)]
        )
      } catch (error) {
        console.error('Error fetching config for phone_number_id:', phoneNumberId, error)
        continue
      }
      const config = configResult.documents[0]
      if (!config) {
        console.error('No config found for phone_number_id:', phoneNumberId)
        continue
      }

      const decryptedAccessToken = decrypt(config.access_token)

      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i]
        const contact = value.contacts[i] || value.contacts[0]

        const metaDriver = createMetaDriver({
          phoneNumberId: config.phone_number_id,
          accessToken: decryptedAccessToken,
        })
        await processMessage(
          message,
          contact,
          config.user_id,
          metaDriver
        )
      }
    }
  }
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once Meta has
// delivered or the user has read or replied, a later "failed" status
// event is a bug in Meta's pipeline or a spoof attempt and must be
// ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false // unknown incoming status
  if (ci < 0) return true // unknown current — accept anything on the ladder
  return ii > ci
}

async function handleStatusUpdate(status: {
  id: string
  status: string
  timestamp: string
  recipient_id: string
}) {
  // 1) Mirror onto messages (legacy behavior) — look up by message_id then update
  try {
    const msgResult = await adminDb().listDocuments(
      DATABASE_ID,
      COLLECTIONS.messages,
      [Query.equal('message_id', status.id)]
    )
    if (msgResult.documents.length > 0) {
      await adminDb().updateDocument(
        DATABASE_ID,
        COLLECTIONS.messages,
        msgResult.documents[0].$id,
        { status: status.status }
      )
    }
  } catch (error) {
    console.error('Error updating message status:', error)
  }

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  const tsIso = new Date(parseInt(status.timestamp) * 1000).toISOString()

  let recResult
  try {
    recResult = await adminDb().listDocuments(
      DATABASE_ID,
      COLLECTIONS.broadcastRecipients,
      [Query.equal('whatsapp_message_id', status.id)]
    )
  } catch (error) {
    console.error('Error fetching broadcast recipient:', error)
    return
  }
  const recipient = recResult.documents[0]
  if (!recipient) return // message wasn't part of a broadcast — fine

  // Guard transitions
  if (!isValidStatusTransition(recipient.status, status.status)) return

  const update: Record<string, unknown> = { status: status.status }
  if (status.status === 'sent' && !('sent_at' in update)) update.sent_at = tsIso
  if (status.status === 'delivered') update.delivered_at = tsIso
  if (status.status === 'read') update.read_at = tsIso

  try {
    await adminDb().updateDocument(
      DATABASE_ID,
      COLLECTIONS.broadcastRecipients,
      recipient.$id,
      update,
    )
  } catch (error) {
    console.error('Error updating broadcast recipient status:', error)
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(userId: string, contactId: string) {
  try {
    // Find broadcasts belonging to this user
    const broadcastResult = await adminDb().listDocuments(
      DATABASE_ID,
      COLLECTIONS.broadcasts,
      [Query.equal('user_id', userId)]
    )
    if (broadcastResult.documents.length === 0) return
    const broadcastIds = broadcastResult.documents.map((b: any) => b.$id)

    // Most recent outbound broadcast recipient that hasn't been replied to yet
    const recs = await adminDb().listDocuments(
      DATABASE_ID,
      COLLECTIONS.broadcastRecipients,
      [
        Query.equal('contact_id', contactId),
        Query.equal('broadcast_id', broadcastIds),
        Query.equal('status', ['sent', 'delivered', 'read']),
        Query.orderDesc('created_at'),
        Query.limit(1),
      ]
    )

    if (recs.documents.length === 0) return

    const row = recs.documents[0]
    await adminDb().updateDocument(
      DATABASE_ID,
      COLLECTIONS.broadcastRecipients,
      row.$id,
      { status: 'replied', replied_at: new Date().toISOString() },
    )
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Resolve a Meta-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  try {
    const result = await adminDb().listDocuments(
      DATABASE_ID,
      COLLECTIONS.messages,
      [
        Query.equal('message_id', metaId),
        Query.equal('conversation_id', conversationId),
      ]
    )
    return result.documents[0]?.$id ?? null
  } catch (error) {
    console.error('[webhook] lookupInternalIdByMetaId failed:', error instanceof Error ? error.message : error)
    return null
  }
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
 */
async function handleReaction(
  message: WhatsAppMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction
  if (!reaction?.message_id) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.message_id
    )
    return
  }

  // Empty emoji = removal (per Meta's Cloud API spec).
  if (!reaction.emoji) {
    try {
      const existing = await adminDb().listDocuments(
        DATABASE_ID,
        COLLECTIONS.messageReactions,
        [
          Query.equal('message_id', targetInternalId),
          Query.equal('actor_type', 'customer'),
          Query.equal('actor_id', contactId),
        ]
      )
      if (existing.documents.length > 0) {
        await adminDb().deleteDocument(
          DATABASE_ID,
          COLLECTIONS.messageReactions,
          existing.documents[0].$id,
        )
      }
    } catch (error) {
      console.error('[webhook] reaction delete failed:', error instanceof Error ? error.message : error)
    }
    return
  }

  // Upsert: check for existing, then create or update
  try {
    const existing = await adminDb().listDocuments(
      DATABASE_ID,
      COLLECTIONS.messageReactions,
      [
        Query.equal('message_id', targetInternalId),
        Query.equal('actor_type', 'customer'),
        Query.equal('actor_id', contactId),
      ]
    )

    if (existing.documents.length > 0) {
      await adminDb().updateDocument(
        DATABASE_ID,
        COLLECTIONS.messageReactions,
        existing.documents[0].$id,
        { emoji: reaction.emoji }
      )
    } else {
      await adminDb().createDocument(
        DATABASE_ID,
        COLLECTIONS.messageReactions,
        ID.unique(),
        {
          message_id: targetInternalId,
          conversation_id: conversationId,
          actor_type: 'customer',
          actor_id: contactId,
          emoji: reaction.emoji,
        }
      )
    }
  } catch (error) {
    console.error('[webhook] reaction upsert failed:', error instanceof Error ? error.message : error)
  }
}

async function processMessage(
  message: WhatsAppMessage,
  contact: { profile: { name: string }; wa_id: string },
  userId: string,
  driver: WhatsAppDriver
) {
  const senderPhone = normalizePhone(message.from)
  const contactName = contact.profile.name

  // Find or create contact
  const contactOutcome = await findOrCreateContact(
    userId,
    senderPhone,
    contactName
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  // Find or create conversation
  const conversation = await findOrCreateConversation(
    userId,
    contactRecord.$id
  )
  if (!conversation) return

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  // Done before parseMessageContent so the media-URL fetch is skipped.
  if (message.type === 'reaction') {
    await handleReaction(message, conversation.$id, contactRecord.$id)
    return
  }

  // Parse message content based on type
  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await parseMessageContent(message, driver)

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null
  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(
      message.context.id,
      conversation.$id
    )
    if (!replyToInternalId) {
      console.warn(
        '[webhook] reply context parent not found:',
        message.context.id
      )
    }
  }

  // Insert message — field names MUST match the messages table schema
  // (see supabase/migrations/001_initial_schema.sql):
  //   conversation_id, sender_type, content_type, content_text,
  //   media_url, template_name, message_id, status, created_at
  // `mediaType` is intentionally unused — the schema has no media_type
  // column; the MIME type is only used to construct the proxy URL during
  // parseMessageContent. Silence the unused-var warning:
  void mediaType

  // The messages.content_type CHECK constraint (widened in migration 010
  // to add 'interactive' for button/list taps) allows:
  //   text, image, document, audio, video, location, template, interactive
  // Map incoming WhatsApp types that aren't in that list to the closest
  // allowed value so the INSERT doesn't fail with a constraint error.
  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'   // stickers are images
      : 'text'    // reaction, unknown → text fallback

  // Determine whether this is the contact's very first inbound message
  let priorCustomerMsgCount = 0
  try {
    const priorMsgs = await adminDb().listDocuments(
      DATABASE_ID,
      COLLECTIONS.messages,
      [
        Query.equal('conversation_id', conversation.$id),
        Query.equal('sender_type', 'customer'),
      ]
    )
    priorCustomerMsgCount = priorMsgs.documents.length
  } catch {
    // If query fails, assume not first to avoid over-triggering
  }
  const isFirstInboundMessage = priorCustomerMsgCount === 0

  try {
    await adminDb().createDocument(
      DATABASE_ID,
      COLLECTIONS.messages,
      ID.unique(),
      {
        conversation_id: conversation.$id,
        sender_type: 'customer',
        content_type: contentType,
        content_text: contentText,
        media_url: mediaUrl,
        message_id: message.id,
        status: 'delivered',
        created_at: new Date(parseInt(message.timestamp) * 1000).toISOString(),
        reply_to_message_id: replyToInternalId,
        interactive_reply_id: interactiveReplyId,
      }
    )
  } catch (error) {
    console.error('Error inserting message:', error)
    return
  }

  // Update conversation
  try {
    await adminDb().updateDocument(
      DATABASE_ID,
      COLLECTIONS.conversations,
      conversation.$id,
      {
        last_message_text: contentText || `[${message.type}]`,
        last_message_at: new Date().toISOString(),
        unread_count: (conversation.unread_count || 0) + 1,
        updated_at: new Date().toISOString(),
      }
    )
  } catch (error) {
    console.error('Error updating conversation:', error)
  }

  // If this contact was a recent broadcast recipient, flag the reply
  // so the broadcast's `replied_count` advances (via the aggregate
  // trigger installed in migration 003).
  await flagBroadcastReplyIfAny(userId, contactRecord.$id)

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an active
  // run or started a new one), we suppress the `new_message_received`
  // + `keyword_match` automation triggers for this inbound. Customer
  // is navigating the bot menu, not sending a fresh trigger word
  // that should fork into automations.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed — those
  // are about WHO is messaging, not what they said.
  //
  // Awaited (not fire-and-forget) because we need the `consumed`
  // result before deciding whether to dispatch automations. The
  // runner has its own try/catch and never throws. Accounts with
  // no active flows take the runner's early-exit "no_match" path
  // basically for free (one indexed SELECT for the active run).
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    userId,
    contactId: contactRecord.$id,
    conversationId: conversation.$id,
    message:
      interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: interactiveReplyId,
            reply_title: contentText ?? '',
            meta_message_id: message.id,
          }
        : {
            kind: 'text',
            text: contentText ?? message.text?.body ?? '',
            meta_message_id: message.id,
          },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  // Fire any automations that react to this webhook event. All dispatches
  // run here (not earlier) so the contact, conversation, and inbound
  // message all exist before any step — including send_message — runs.
  // Fire-and-forget: a slow or failing automation must not block the
  // webhook's 200 OK response to Meta.
  const inboundText = contentText ?? message.text?.body ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = []
  // Content-level triggers are suppressed when a flow consumed the
  // message — see the comment block above.
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
  }
  // new_contact_created fires only when the webhook just auto-created the
  // contact row. first_inbound_message fires whenever this is the contact's
  // first-ever customer-sent message — a superset that also catches
  // manually-imported contacts sending for the first time. We dispatch both
  // so users can pick whichever semantic they want; an automation that
  // listens to only one trigger runs only when that trigger matches.
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      userId,
      triggerType,
      contactId: contactRecord.$id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.$id,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // AI auto-reply — fire-and-forget after automations and flows.
  // Flows win: if a flow consumed the message, skip AI.
  if (!flowConsumed) {
    dispatchInboundToAiReply({
      userId,
      conversationId: conversation.$id,
      contactId: contactRecord.$id,
    }).catch((err) => console.error('[ai-autoreply] dispatch failed:', err))
  }
}

async function parseMessageContent(
  message: WhatsAppMessage,
  driver: WhatsAppDriver
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null
}> {
  const verifyAndBuildUrl = async (
    mediaId: string
  ): Promise<string | null> => {
    try {
      await driver.getMediaUrl(mediaId)
      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId}:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  // Default shape — each case overrides only the fields it cares about.
  // Keeps the new `interactiveReplyId` field DRY across every return site.
  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  }

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null }

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.image.id),
          mediaType: message.image.mime_type,
        }
      }
      return empty

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.video.id),
          mediaType: message.video.mime_type,
        }
      }
      return empty

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          mediaUrl: await verifyAndBuildUrl(message.document.id),
          mediaType: message.document.mime_type,
        }
      }
      return empty

    case 'audio':
      if (message.audio?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.audio.id),
          mediaType: message.audio.mime_type,
        }
      }
      return empty

    case 'sticker':
      // Stickers are images under the hood. Treat them as such so the
      // MessageBubble renders the <img>. The caller maps the DB
      // content_type to 'image' for the CHECK constraint.
      if (message.sticker?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.sticker.id),
          mediaType: message.sticker.mime_type,
        }
      }
      return empty

    case 'location':
      if (message.location) {
        const loc = message.location
        const locationText = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
          .filter(Boolean)
          .join(' - ')
        return { ...empty, contentText: locationText }
      }
      return empty

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null }

    case 'interactive': {
      // The customer tapped a reply button or a list row on a message
      // we previously sent. Meta delivers `interactive.button_reply` for
      // 3-button messages and `interactive.list_reply` for list messages.
      // Use the human-readable title as contentText so the inbox bubble
      // renders the tap legibly ("Existing customer"), and stash the
      // stable id separately so the Flows engine can route on it.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply
      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        }
      }
      return { ...empty, contentText: '[Interactive reply]' }
    }

    default:
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean
}

async function findOrCreateContact(
  userId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  // Look up existing contacts for this user
  let contactsResult
  try {
    contactsResult = await adminDb().listDocuments(
      DATABASE_ID,
      COLLECTIONS.contacts,
      [Query.equal('user_id', userId)]
    )
  } catch (error) {
    console.error('Error fetching contacts:', error)
    return null
  }

  // Use phonesMatch for flexible matching
  const existingContact = contactsResult.documents.find((c: ContactRow) => phonesMatch(c.phone, phone))

  if (existingContact) {
    // Update name if it changed
    if (name && name !== existingContact.name) {
      try {
        await adminDb().updateDocument(
          DATABASE_ID,
          COLLECTIONS.contacts,
          existingContact.$id,
          { name, updated_at: new Date().toISOString() }
        )
      } catch (error) {
        console.error('Error updating contact:', error)
      }
    }
    return { contact: existingContact, wasCreated: false }
  }

  // Create new contact
  let newContact
  try {
    newContact = await adminDb().createDocument(
      DATABASE_ID,
      COLLECTIONS.contacts,
      ID.unique(),
      {
        user_id: userId,
        phone,
        name: name || phone,
      }
    )
  } catch (error) {
    console.error('Error creating contact:', error)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(userId: string, contactId: string) {
  // Look for existing conversation
  try {
    const result = await adminDb().listDocuments(
      DATABASE_ID,
      COLLECTIONS.conversations,
      [
        Query.equal('user_id', userId),
        Query.equal('contact_id', contactId),
      ]
    )
    if (result.documents.length > 0) {
      return result.documents[0]
    }
  } catch (error) {
    console.error('Error finding conversation:', error)
    return null
  }

  // Create new conversation
  try {
    return await adminDb().createDocument(
      DATABASE_ID,
      COLLECTIONS.conversations,
      ID.unique(),
      {
        user_id: userId,
        contact_id: contactId,
      }
    )
  } catch (error) {
    console.error('Error creating conversation:', error)
    return null
  }
}
