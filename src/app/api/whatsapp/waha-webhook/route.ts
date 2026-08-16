import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createAdminClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { Query } from 'node-appwrite'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  processMessagesForConfig,
  handleStatusUpdate,
} from '@/app/api/whatsapp/webhook/route'
import {
  isFromMe,
  wahaMessageToMeta,
  wahaMessageToContact,
  wahaReactionToMeta,
  wahaAckToStatus,
  type WahaWebhookBody,
} from '@/lib/whatsapp/waha-webhook-adapter'

/**
 * POST /api/whatsapp/waha-webhook
 *
 * Webhook target for self-hosted WAHA instances. WAHA signs each
 * delivery with `X-Webhook-Hmac: <hex>` = HMAC-SHA512 of the raw body
 * using the per-session `WHATSAPP_HOOK_HMAC_KEY`. The CRM stores that
 * key per config row (waha_webhook_secret) so each WAHA session is
 * verified against its owner's secret.
 *
 * The config row is resolved by the WAHA `session` name — the pipeline
 * is then fed through the same `processMessagesForConfig` /
 * `handleStatusUpdate` functions the Meta webhook uses.
 */
export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-webhook-hmac')

  if (!signature) {
    console.warn('[waha-webhook] rejected request without X-Webhook-Hmac')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: WahaWebhookBody
  try {
    body = JSON.parse(rawBody) as WahaWebhookBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const session = body.session
  const event = body.event
  const payload = body.payload ?? {}

  if (!session || !event || !payload) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  // Resolve the config row that owns this WAHA session.
  const { databases } = createAdminClient()
  let configs
  try {
    configs = await databases.listDocuments(
      DATABASE_ID,
      COLLECTIONS.whatsappConfig,
      [Query.equal('waha_session', session)],
    )
  } catch (error) {
    console.error('[waha-webhook] config lookup failed:', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
  const config = configs.documents[0]
  if (!config) {
    console.warn('[waha-webhook] no config found for session:', session)
    return NextResponse.json({ error: 'Unknown session' }, { status: 404 })
  }

  // Fail closed: without a stored HMAC key nobody can prove a delivery
  // came from the configured WAHA instance.
  let secret: string
  try {
    secret = decrypt(config.waha_webhook_secret)
  } catch {
    console.error(
      '[waha-webhook] waha_webhook_secret missing or undecryptable for session:',
      session,
    )
    return NextResponse.json(
      { error: 'Webhook not configured for this session' },
      { status: 401 },
    )
  }

  const expected = crypto
    .createHmac('sha512', secret)
    .update(rawBody)
    .digest('hex')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.warn('[waha-webhook] rejected request with invalid HMAC for session:', session)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // WAHA (WEBJS) now delivers inbound contacts as Linked IDs (`@lid`)
  // instead of the phone-number-based `@c.us`. The CRM pipeline keys
  // contacts/conversations by phone number, so resolve the LID to the
  // real number before adapting the payload. If resolution fails we
  // keep the original value — the adapter will drop the message and
  // log the reason.
  const resolvedFrom = await resolveLidToPhone(config, session, payload.from)
  if (resolvedFrom) payload.from = resolvedFrom

  // Dispatch — process asynchronously so WAHA gets its 200 ack fast.
  switch (event) {
    case 'message': {
      if (isFromMe(body)) break // our own sends were already persisted
      // TEMP DEBUG: capture raw media-message shapes to fix adapter mapping
      if (payload.type !== 'chat' && payload.type !== 'text') {
        console.warn('[waha-webhook] media payload:', JSON.stringify({
          type: payload.type,
          hasMedia: payload.hasMedia,
          body: typeof payload.body === 'string' ? payload.body.slice(0, 30) : payload.body,
          media: payload.media,
          mimetype: payload.mimetype,
        }))
      }
      const message = wahaMessageToMeta(payload)
      if (message) {
        processMessagesForConfig(config, [message], [wahaMessageToContact(payload)])
          .catch((error) => {
            console.error('[waha-webhook] message processing failed:', error)
          })
      }
      break
    }
    case 'message.reaction': {
      if (isFromMe(body)) break // agent reactions are mirrored by the react route
      const message = wahaReactionToMeta(payload)
      if (message) {
        processMessagesForConfig(config, [message], [wahaMessageToContact(payload)])
          .catch((error) => {
            console.error('[waha-webhook] reaction processing failed:', error)
          })
      }
      break
    }
    case 'message.ack': {
      // Only our own sends have status meaning in the pipeline.
      if (isFromMe(body)) {
        const status = wahaAckToStatus(payload)
        if (status) {
          handleStatusUpdate(status).catch((error) => {
            console.error('[waha-webhook] status processing failed:', error)
          })
        }
      }
      break
    }
    default:
      // session.status, message.update and friends are not consumed.
      break
  }

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

/**
 * Resolve a WAHA Linked ID (`<number>@lid`) to the phone-number-based
 * JID (`<number>@c.us`) the CRM keys on. Uses WAHA's LID→PN mapping
 * endpoint. Returns null when the JID is already a phone number, the
 * mapping is unknown, or the lookup fails — callers keep the original.
 */
async function resolveLidToPhone(
  config: Record<string, unknown>,
  session: string,
  jid: unknown,
): Promise<string | null> {
  if (typeof jid !== 'string' || !jid.endsWith('@lid')) return null
  if (typeof config.waha_base_url !== 'string' || typeof config.waha_api_key !== 'string') {
    return null
  }
  const baseUrl = config.waha_base_url.replace(/\/+$/, '')
  let apiKey: string
  try {
    apiKey = decrypt(config.waha_api_key)
  } catch {
    return null
  }
  try {
    const res = await fetch(
      `${baseUrl}/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(jid)}`,
      { headers: { 'X-Api-Key': apiKey } },
    )
    if (!res.ok) return null
    const data = (await res.json()) as { pn?: string | null }
    return typeof data.pn === 'string' && data.pn.endsWith('@c.us') ? data.pn : null
  } catch {
    return null
  }
}

/**
 * WAHA has no GET challenge flow — webhook delivery is verified purely
 * by HMAC. Keep a 200 so dashboard "test connection" pings don't 404.
 */
export async function GET() {
  return NextResponse.json({ ok: true })
}