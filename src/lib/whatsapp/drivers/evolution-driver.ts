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
} from '../types'

interface EvolutionConfig {
  instanceName: string
}

function getBaseUrl(): string {
  const url = process.env.EVOLUTION_API_URL
  if (!url) throw new Error('EVOLUTION_API_URL environment variable not set')
  return url.replace(/\/$/, '')
}

function getApiKey(): string {
  const key = process.env.EVOLUTION_API_KEY
  if (!key) throw new Error('EVOLUTION_API_KEY environment variable not set')
  return key
}

async function evolutionFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const baseUrl = getBaseUrl()
  const apiKey = getApiKey()
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      apikey: apiKey,
      ...(options.headers as Record<string, string>),
    },
  })
}

async function throwEvolutionError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = await response.json()
    if (data.message) message = data.message
    if (data.error) message = typeof data.error === 'string' ? data.error : data.error.message || message
  } catch {
    // keep fallback
  }
  throw new Error(`Evolution API error: ${message}`)
}

export class EvolutionDriver implements WhatsAppDriver {
  constructor(private config: EvolutionConfig) {}

  async sendText(to: string, text: string, options?: SendTextOptions): Promise<SendResult> {
    const response = await evolutionFetch(`/message/sendText/${this.config.instanceName}`, {
      method: 'POST',
      body: JSON.stringify({
        number: to,
        text,
        ...(options?.contextMessageId ? { quoted: { key: { id: options.contextMessageId } } } : {}),
      }),
    })
    if (!response.ok) {
      await throwEvolutionError(response, `Failed to send text to ${to}`)
    }
    const data = await response.json()
    return { messageId: data.key?.id || data.id || '' }
  }

  async sendTemplate(to: string, templateName: string, options?: TemplateOptions): Promise<SendResult> {
    // Evolution doesn't support Meta templates, fall back to text
    return this.sendText(to, `[${templateName}] ${(options?.params || []).join(' ')}`, {
      contextMessageId: options?.contextMessageId,
    })
  }

  async sendReaction(to: string, options: ReactionOptions): Promise<SendResult> {
    const response = await evolutionFetch(`/message/sendReaction/${this.config.instanceName}`, {
      method: 'POST',
      body: JSON.stringify({
        number: to,
        reaction: options.emoji,
        messageId: options.targetMessageId,
      }),
    })
    if (!response.ok) {
      await throwEvolutionError(response, `Failed to send reaction to ${to}`)
    }
    const data = await response.json()
    return { messageId: data.key?.id || data.id || '' }
  }

  async sendInteractiveButtons(to: string, bodyText: string, buttons: InteractiveButton[], options?: InteractiveOptions): Promise<SendResult> {
    const response = await evolutionFetch(`/message/sendButtons/${this.config.instanceName}`, {
      method: 'POST',
      body: JSON.stringify({
        number: to,
        title: options?.headerText || '',
        description: bodyText,
        footer: options?.footerText || '',
        buttons: buttons.map((b) => ({
          type: 'reply',
          displayText: b.title,
          id: b.id,
        })),
      }),
    })
    if (!response.ok) {
      await throwEvolutionError(response, `Failed to send buttons to ${to}`)
    }
    const data = await response.json()
    return { messageId: data.key?.id || data.id || '' }
  }

  async sendInteractiveList(to: string, bodyText: string, buttonLabel: string, sections: InteractiveListSection[], options?: InteractiveOptions): Promise<SendResult> {
    const response = await evolutionFetch(`/message/sendList/${this.config.instanceName}`, {
      method: 'POST',
      body: JSON.stringify({
        number: to,
        title: options?.headerText || '',
        description: bodyText,
        footer: options?.footerText || '',
        buttonText: buttonLabel,
        sections: sections.map((s) => ({
          title: s.title || '',
          rows: s.rows.map((r) => ({
            title: r.title,
            description: r.description || '',
            rowId: r.id,
          })),
        })),
      }),
    })
    if (!response.ok) {
      await throwEvolutionError(response, `Failed to send list to ${to}`)
    }
    const data = await response.json()
    return { messageId: data.key?.id || data.id || '' }
  }

  async getMediaUrl(mediaId: string): Promise<MediaInfo> {
    // Evolution stores media locally — we return a proxy URL pointing
    // back to Evolution API's own media endpoint
    const baseUrl = getBaseUrl()
    return {
      url: `${baseUrl}/message/getMediaMessage/${this.config.instanceName}?messageId=${mediaId}`,
      mimeType: 'application/octet-stream',
    }
  }

  async downloadMedia(url: string): Promise<MediaData> {
    const apiKey = getApiKey()
    const response = await fetch(url, {
      headers: { apikey: apiKey },
    })
    if (!response.ok) {
      throw new Error(`Evolution media download failed: ${response.status}`)
    }
    const contentType = response.headers.get('content-type') || 'application/octet-stream'
    const buffer = Buffer.from(await response.arrayBuffer())
    return { buffer, contentType }
  }

  async verifyConnection(): Promise<PhoneInfo> {
    const response = await evolutionFetch(`/instance/connectionState/${this.config.instanceName}`)
    if (!response.ok) {
      await throwEvolutionError(response, 'Connection verification failed')
    }
    const data = await response.json()
    return {
      id: this.config.instanceName,
      display_phone_number: data.phone?.display_phone_number || data.phone?.number || this.config.instanceName,
      verified_name: data.phone?.pushName || data.phone?.name,
      quality_rating: data.state?.status || 'unknown',
    }
  }
}
