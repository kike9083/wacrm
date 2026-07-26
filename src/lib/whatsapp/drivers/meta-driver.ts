import {
  type WhatsAppDriver,
  type SendResult,
  type SendTextOptions,
  type TemplateOptions,
  type ReactionOptions,
  type InteractiveButton,
  type InteractiveListSection,
  type InteractiveOptions,
  type MediaInfo,
  type MediaData,
  type PhoneInfo,
  INTERACTIVE_LIMITS,
} from '../types'

interface MetaConfig {
  phoneNumberId: string
  accessToken: string
}

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

interface MetaErrorResponse {
  error?: { message?: string; code?: number; type?: string }
}

async function throwMetaError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as MetaErrorResponse
    if (data.error?.message) message = data.error.message
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

function validateInteractiveBody(bodyText: string): void {
  if (!bodyText) throw new Error('Interactive message requires bodyText.')
  if (bodyText.length > INTERACTIVE_LIMITS.bodyMaxLength) {
    throw new Error(
      `Interactive bodyText exceeds ${INTERACTIVE_LIMITS.bodyMaxLength} chars.`
    )
  }
}

function validateInteractiveHeaderFooter(
  headerText: string | undefined,
  footerText: string | undefined,
): void {
  if (headerText && headerText.length > INTERACTIVE_LIMITS.headerTextMaxLength) {
    throw new Error(
      `Interactive headerText exceeds ${INTERACTIVE_LIMITS.headerTextMaxLength} chars.`
    )
  }
  if (footerText && footerText.length > INTERACTIVE_LIMITS.footerMaxLength) {
    throw new Error(
      `Interactive footerText exceeds ${INTERACTIVE_LIMITS.footerMaxLength} chars.`
    )
  }
}

export class MetaDriver implements WhatsAppDriver {
  constructor(private config: MetaConfig) {}

  async sendText(to: string, text: string, options?: SendTextOptions): Promise<SendResult> {
    const { phoneNumberId, accessToken } = this.config
    const url = `${META_API_BASE}/${phoneNumberId}/messages`
    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text },
    }
    if (options?.contextMessageId) {
      body.context = { message_id: options.contextMessageId }
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      await throwMetaError(response, `Meta API error: ${response.status}`)
    }
    const data = await response.json()
    return { messageId: data.messages[0].id }
  }

  async sendTemplate(to: string, templateName: string, options?: TemplateOptions): Promise<SendResult> {
    const { phoneNumberId, accessToken } = this.config
    const url = `${META_API_BASE}/${phoneNumberId}/messages`

    const template: Record<string, unknown> = {
      name: templateName,
      language: { code: options?.language || 'en_US' },
    }

    if (options?.params && options.params.length > 0) {
      template.components = [
        {
          type: 'body',
          parameters: options.params.map((p) => ({ type: 'text', text: String(p) })),
        },
      ]
    }

    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template,
    }
    if (options?.contextMessageId) {
      body.context = { message_id: options.contextMessageId }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      await throwMetaError(response, `Meta API error: ${response.status}`)
    }
    const data = await response.json()
    return { messageId: data.messages[0].id }
  }

  async sendReaction(to: string, options: ReactionOptions): Promise<SendResult> {
    const { phoneNumberId, accessToken } = this.config
    const url = `${META_API_BASE}/${phoneNumberId}/messages`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'reaction',
        reaction: { message_id: options.targetMessageId, emoji: options.emoji },
      }),
    })
    if (!response.ok) {
      await throwMetaError(response, `Meta API error: ${response.status}`)
    }
    const data = await response.json()
    return { messageId: data.messages[0].id }
  }

  async sendInteractiveButtons(to: string, bodyText: string, buttons: InteractiveButton[], options?: InteractiveOptions): Promise<SendResult> {
    const { phoneNumberId, accessToken } = this.config
    validateInteractiveBody(bodyText)
    validateInteractiveHeaderFooter(options?.headerText, options?.footerText)
    if (buttons.length < 1 || buttons.length > INTERACTIVE_LIMITS.maxButtons) {
      throw new Error(
        `Interactive button message requires 1-${INTERACTIVE_LIMITS.maxButtons} buttons (got ${buttons.length}).`
      )
    }
    for (const btn of buttons) {
      if (!btn.id) throw new Error('Interactive button missing id.')
      if (!btn.title) throw new Error(`Interactive button "${btn.id}" missing title.`)
      if (btn.title.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
        throw new Error(
          `Interactive button title "${btn.title}" exceeds ${INTERACTIVE_LIMITS.buttonTitleMaxLength} chars.`
        )
      }
    }

    const interactive: Record<string, unknown> = {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    }
    if (options?.headerText) interactive.header = { type: 'text', text: options.headerText }
    if (options?.footerText) interactive.footer = { text: options.footerText }

    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive,
    }
    if (options?.contextMessageId) body.context = { message_id: options.contextMessageId }

    const url = `${META_API_BASE}/${phoneNumberId}/messages`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      await throwMetaError(response, `Meta API error: ${response.status}`)
    }
    const data = await response.json()
    return { messageId: data.messages[0].id }
  }

  async sendInteractiveList(to: string, bodyText: string, buttonLabel: string, sections: InteractiveListSection[], options?: InteractiveOptions): Promise<SendResult> {
    const { phoneNumberId, accessToken } = this.config
    validateInteractiveBody(bodyText)
    validateInteractiveHeaderFooter(options?.headerText, options?.footerText)
    if (!buttonLabel) throw new Error('Interactive list requires a buttonLabel.')
    if (buttonLabel.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
      throw new Error(
        `Interactive list buttonLabel "${buttonLabel}" exceeds ${INTERACTIVE_LIMITS.buttonTitleMaxLength} chars.`
      )
    }
    if (sections.length < 1 || sections.length > INTERACTIVE_LIMITS.maxListSections) {
      throw new Error(
        `Interactive list requires 1-${INTERACTIVE_LIMITS.maxListSections} sections (got ${sections.length}).`
      )
    }
    const totalRows = sections.reduce((sum, s) => sum + s.rows.length, 0)
    if (totalRows < 1 || totalRows > INTERACTIVE_LIMITS.maxListRowsTotal) {
      throw new Error(
        `Interactive list requires 1-${INTERACTIVE_LIMITS.maxListRowsTotal} rows total across all sections (got ${totalRows}).`
      )
    }
    const seenIds = new Set<string>()
    for (const section of sections) {
      for (const row of section.rows) {
        if (!row.id) throw new Error('Interactive list row missing id.')
        if (seenIds.has(row.id)) {
          throw new Error(`Interactive list has duplicate row id "${row.id}".`)
        }
        seenIds.add(row.id)
        if (!row.title) throw new Error(`Interactive list row "${row.id}" missing title.`)
        if (row.title.length > INTERACTIVE_LIMITS.listRowTitleMaxLength) {
          throw new Error(
            `Interactive list row title "${row.title}" exceeds ${INTERACTIVE_LIMITS.listRowTitleMaxLength} chars.`
          )
        }
        if (
          row.description &&
          row.description.length > INTERACTIVE_LIMITS.listRowDescriptionMaxLength
        ) {
          throw new Error(
            `Interactive list row description for "${row.id}" exceeds ${INTERACTIVE_LIMITS.listRowDescriptionMaxLength} chars.`
          )
        }
      }
    }

    const interactive: Record<string, unknown> = {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: buttonLabel,
        sections: sections.map((s) => ({
          ...(s.title ? { title: s.title } : {}),
          rows: s.rows.map((r) => ({
            id: r.id,
            title: r.title,
            ...(r.description ? { description: r.description } : {}),
          })),
        })),
      },
    }
    if (options?.headerText) interactive.header = { type: 'text', text: options.headerText }
    if (options?.footerText) interactive.footer = { text: options.footerText }

    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive,
    }
    if (options?.contextMessageId) body.context = { message_id: options.contextMessageId }

    const url = `${META_API_BASE}/${phoneNumberId}/messages`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      await throwMetaError(response, `Meta API error: ${response.status}`)
    }
    const data = await response.json()
    return { messageId: data.messages[0].id }
  }

  async getMediaUrl(mediaId: string): Promise<MediaInfo> {
    const { accessToken } = this.config
    const response = await fetch(`${META_API_BASE}/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) {
      await throwMetaError(response, `Media fetch failed: ${response.status}`)
    }
    const data = await response.json()
    if (!data.url) throw new Error('Media URL not found in Meta response')
    return { url: data.url, mimeType: data.mime_type || 'application/octet-stream' }
  }

  async downloadMedia(url: string): Promise<MediaData> {
    const { accessToken } = this.config
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) {
      throw new Error(`Media download failed: ${response.status}`)
    }
    const contentType =
      response.headers.get('content-type') || 'application/octet-stream'
    const buffer = Buffer.from(await response.arrayBuffer())
    return { buffer, contentType }
  }

  async verifyConnection(): Promise<PhoneInfo> {
    const { phoneNumberId, accessToken } = this.config
    const url = `${META_API_BASE}/${phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating`
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) {
      await throwMetaError(response, `Meta API error: ${response.status}`)
    }
    return response.json()
  }
}
