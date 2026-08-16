import type { WhatsAppMessage } from '@/app/api/whatsapp/webhook/route'

/**
 * WAHA webhook payload adapter.
 *
 * The CRM's inbound pipeline (`processWebhook` in
 * `src/app/api/whatsapp/webhook/route.ts`) consumes Meta Cloud API
 * message shapes. WAHA delivers one event per HTTP call
 * (`{ session, event, payload }`) with its own payload layout. This
 * module translates WAHA events into the Meta shapes the pipeline
 * understands, so inbound messages, reactions and status ACKs flow
 * through the exact same code paths as Meta.
 *
 * WAHA events handled:
 *   message            → Meta `WhatsAppMessage` + contact
 *   message.reaction   → Meta `reaction`-type message
 *   message.ack        → Meta status update
 *
 * Events originating from our own number (`fromMe: true`) are dropped
 * for `message` / `message.reaction` — those messages were already
 * persisted by the send routes. ACKs from our own sends are the ones
 * we keep: they drive the status ladder.
 */

export interface WahaWebhookBody {
  session: string
  event: string
  payload: Record<string, unknown>
}

export function isFromMe(body: WahaWebhookBody): boolean {
  return body.payload?.fromMe === true
}

function stripChatSuffix(chatId: string | undefined): string {
  if (!chatId) return ''
  return chatId.replace(/@.*$/, '')
}

/** Map a WAHA media mimetype to the pipeline's message type. */
function mimeToMessageType(mimetype: string): string {
  const prefix = mimetype.split('/')[0]?.toLowerCase()
  if (prefix === 'image' || prefix === 'video' || prefix === 'audio') return prefix
  return 'document'
}

function timestampSeconds(payload: Record<string, unknown>): string {
  const ts = payload.timestamp
  if (typeof ts === 'number' || typeof ts === 'string') {
    const n = Number(ts)
    if (Number.isFinite(n) && n > 0) return String(n)
  }
  return String(Math.floor(Date.now() / 1000))
}

/**
 * `message` event → a Meta-shaped `message` object the pipeline can
 * persist. Returns null for events that must be dropped (groups,
 * fromMe echoes — handled by the caller — or missing identity).
 */
export function wahaMessageToMeta(
  payload: Record<string, unknown>,
): WhatsAppMessage | null {
  const from = typeof payload.from === 'string' ? payload.from : ''
  const id = typeof payload.id === 'string' ? payload.id : ''

  // 1:1 CRM — group chats (e.g. -1234@g.us) are not supported.
  if (!from.endsWith('@c.us') && !from.endsWith('@s.whatsapp.net')) {
    return null
  }

  const media = payload.media as
    | { url?: string; mimetype?: string; filename?: string; caption?: string }
    | undefined

  // WAHA omits `type` on media messages (image/audio/video/document) —
  // the payload only carries `hasMedia` + `media.mimetype`. Derive the
  // message type from the MIME prefix so the pipeline can render it.
  const rawType = typeof payload.type === 'string' ? payload.type : ''
  const type =
    rawType ||
    (payload.hasMedia === true && typeof media?.mimetype === 'string'
      ? mimeToMessageType(media.mimetype)
      : 'text')

  // Media download id: WAHA serves files at /api/files/{session}/{filename}
  // where filename = `{messageId}.{ext}` — take it from the media URL so
  // the driver keeps the extension. Falls back to the message id.
  const mediaId =
    typeof media?.url === 'string'
      ? (media.url.split('/').pop() ?? id)
      : id

  const base: WhatsAppMessage = {
    id,
    from,
    timestamp: timestampSeconds(payload),
    type,
  }

  const replyTo = payload.replyTo as
    | { id?: string; message?: string }
    | undefined
  if (replyTo?.id && typeof replyTo.id === 'string') {
    base.context = { id: replyTo.id }
  }

  if (type === 'text' || type === 'chat') {
    // WAHA reports plain text messages with `type: chat`; normalize the
    // type so the pipeline's parseMessageContent switch handles it.
    base.type = 'text'
    base.text = { body: typeof payload.body === 'string' ? payload.body : '' }
    return base
  }

  const caption = media?.caption || (typeof payload.body === 'string' && payload.body ? payload.body : undefined)

  switch (type) {
    case 'image':
      base.image = { id: mediaId, mime_type: media?.mimetype || 'image/jpeg', ...(caption ? { caption } : {}) }
      return base
    case 'video':
      base.video = { id: mediaId, mime_type: media?.mimetype || 'video/mp4', ...(caption ? { caption } : {}) }
      return base
    case 'document':
      base.document = {
        id: mediaId,
        mime_type: media?.mimetype || 'application/octet-stream',
        ...(media?.filename ? { filename: media.filename } : {}),
        ...(caption ? { caption } : {}),
      }
      return base
    case 'audio':
      base.audio = { id: mediaId, mime_type: media?.mimetype || 'audio/ogg' }
      return base
    case 'ptt':
      // Voice notes arrive from WAHA WEBJS as `ptt` (push-to-talk), not
      // `audio`. Normalize to audio so the pipeline renders the player.
      base.type = 'audio'
      base.audio = { id: mediaId, mime_type: media?.mimetype || 'audio/ogg' }
      return base
    case 'sticker':
      base.sticker = { id, mime_type: media?.mimetype || 'image/webp' }
      return base
    case 'location': {
      const loc = payload.location as
        | { latitude?: number; longitude?: number; name?: string; address?: string }
        | undefined
      if (loc) {
        base.location = {
          latitude: typeof loc.latitude === 'number' ? loc.latitude : 0,
          longitude: typeof loc.longitude === 'number' ? loc.longitude : 0,
          ...(loc.name ? { name: loc.name } : {}),
          ...(loc.address ? { address: loc.address } : {}),
        }
      }
      return base
    }
    case 'buttons_response': {
      const id2 = typeof payload.selectedButtonId === 'string' ? payload.selectedButtonId : ''
      const title = typeof payload.selectedButtonText === 'string' ? payload.selectedButtonText : id2
      if (!id2) return null
      base.type = 'interactive'
      base.interactive = { type: 'button_reply', button_reply: { id: id2, title } }
      return base
    }
    case 'list_response': {
      const id2 = typeof payload.selectedRowId === 'string' ? payload.selectedRowId : ''
      const title = typeof payload.selectedRowText === 'string' ? payload.selectedRowText : id2
      if (!id2) return null
      base.type = 'interactive'
      base.interactive = {
        type: 'list_reply',
        list_reply: {
          id: id2,
          title,
          ...(typeof payload.description === 'string' && payload.description
            ? { description: payload.description }
            : {}),
        },
      }
      return base
    }
    default:
      // icon, protocol, poll, call, etc. — surface as unsupported text
      base.type = 'text'
      base.text = { body: `[Unsupported message type: ${type}]` }
      return base
  }
}

/** `message` event → contact object (wa_id + sender display name). */
export function wahaMessageToContact(
  payload: Record<string, unknown>,
): { profile: { name: string }; wa_id: string } {
  const from = typeof payload.from === 'string' ? payload.from : ''
  const waId = stripChatSuffix(from) || from
  const name =
    (typeof payload.senderName === 'string' && payload.senderName) ||
    (typeof payload.pushName === 'string' && payload.pushName) ||
    waId
  return { profile: { name }, wa_id: waId }
}

/**
 * `message.reaction` event → a Meta-shaped `reaction`-type message.
 * Empty `reaction.text` means the customer removed the reaction (Meta's
 * removal semantics), which `handleReaction` already understands.
 */
export function wahaReactionToMeta(
  payload: Record<string, unknown>,
): WhatsAppMessage | null {
  const reaction = payload.reaction as
    | { messageId?: string; text?: string }
    | undefined
  if (!reaction?.messageId) return null

  const from = typeof payload.from === 'string' ? payload.from : ''
  if (!from.endsWith('@c.us') && !from.endsWith('@s.whatsapp.net')) {
    return null
  }

  return {
    id: typeof payload.id === 'string' ? payload.id : `reaction_${reaction.messageId}`,
    from,
    timestamp: timestampSeconds(payload),
    type: 'reaction',
    reaction: { message_id: reaction.messageId, emoji: reaction.text ?? '' },
  }
}

type AckName = 'SENT' | 'DEVICE' | 'READ' | 'PLAYED'

const ACK_STATUS: Record<AckName, string> = {
  SENT: 'sent',
  DEVICE: 'delivered',
  READ: 'read',
  // voice notes never reach READ; PLAYED is their terminal state
  PLAYED: 'read',
}

/**
 * `message.ack` event → Meta-shaped status update. ACKs are only
 * meaningful for messages we sent (`fromMe: true`).
 */
export function wahaAckToStatus(
  payload: Record<string, unknown>,
): { id: string; status: string; timestamp: string; recipient_id: string } | null {
  const ackName = payload.ackName as AckName | undefined
  const id = typeof payload.id === 'string' ? payload.id : ''
  if (!ackName || !ACK_STATUS[ackName] || !id) return null

  return {
    id,
    status: ACK_STATUS[ackName],
    timestamp: timestampSeconds(payload),
    recipient_id: stripChatSuffix(
      typeof payload.from === 'string' ? payload.from : undefined,
    ),
  }
}