/**
 * WAHA (WhatsApp HTTP API) typed client.
 *
 * WAHA is an open-source self-hosted WhatsApp gateway (Apache-2.0,
 * devlikeapro/waha). It runs as a Docker container (EasyPanel included)
 * and exposes a REST API with a session-per-number model. Credentials
 * are a base URL + `X-Api-Key` header; sessions are identified by a
 * name (`session` field in every call).
 *
 * Endpoints used here are the stable, cross-engine API surface:
 *   GET  /health
 *   GET  /api/sessions
 *   POST /api/sendText
 *   POST /api/reaction
 *   POST /api/sendButtons          (interactive — WEBJS/WPP engines)
 *   POST /api/sendList             (interactive — WEBJS/WPP engines)
 *   GET  /api/{session}/messages/{messageId}/media
 *
 * Interactive messages (buttons / lists) are only supported by the
 * WEBJS and WPP engines — NOWEB and GOWS reject them. Callers that
 * care about engine support read `engine` from `getSessionByName`.
 */

export interface WahaApiConfig {
  baseUrl: string
  apiKey: string
}

export interface WahaSessionInfo {
  id: string
  name: string
  status: string
  engine?: string
  /** WhatsApp number (digits) when the session knows its own identity. */
  phone?: string
  pushName?: string
}

export interface WahaSendResult {
  id: string
}

/** Engines that can render interactive buttons / lists. */
export const INTERACTIVE_ENGINES = new Set(['WEBJS', 'WPP'])

/** WAHA session statuses (documented values). */
export const WAHA_STATUS = {
  WORKING: 'WORKING',
  STARTING: 'STARTING',
  SCAN_QR_CODE: 'SCAN_QR_CODE',
  STOPPED: 'STOPPED',
  FAILED: 'FAILED',
} as const

/**
 * Normalize a contact phone (E.164, possibly with `+`) into WAHA's
 * chatId encoding: `<digits>@c.us`.
 */
export function toChatId(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return `${digits}@c.us`
}

/** Strip the `@c.us` (or any @suffix) from a WAHA contact id. */
export function fromChatId(chatId: string): string {
  return chatId.replace(/@.*$/, '')
}

export class WahaApiError extends Error {}

export class WahaApi {
  private baseUrl: string
  private apiKey: string

  constructor(config: WahaApiConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.apiKey = config.apiKey
  }

  private async request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': this.apiKey,
          ...(init?.headers ?? {}),
        },
      })
    } catch (error) {
      throw new WahaApiError(
        `WAHA unreachable at ${this.baseUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }

    if (!response.ok) {
      let message = `WAHA API error: ${response.status}`
      try {
        const data = (await response.json()) as {
          error?: { message?: string }
          message?: string
        }
        message =
          data.error?.message ||
          data.message ||
          `WAHA API error: ${response.status}`
      } catch {
        // non-JSON error body — keep the status-based message
      }
      throw new WahaApiError(message)
    }

    if (response.status === 204) {
      return undefined as T
    }
    return (await response.json()) as T
  }

  /** GET /health — returns `Working` when the container is up. */
  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        headers: { 'X-Api-Key': this.apiKey },
      })
      return res.ok
    } catch {
      return false
    }
  }

  /** GET /api/sessions — every session known to this WAHA instance. */
  async getSessions(): Promise<WahaSessionInfo[]> {
    return this.request<WahaSessionInfo[]>('/api/sessions')
  }

  /** Find a session by name; undefined when the name doesn't exist. */
  async getSessionByName(name: string): Promise<WahaSessionInfo | undefined> {
    const sessions = await this.getSessions()
    return sessions.find((s) => s.name === name)
  }

  /** POST /api/sendText */
  async sendText(params: {
    session: string
    chatId: string
    text: string
    replyTo?: string
  }): Promise<WahaSendResult> {
    return this.request<WahaSendResult>('/api/sendText', {
      method: 'POST',
      body: JSON.stringify({
        session: params.session,
        chatId: params.chatId,
        text: params.text,
        ...(params.replyTo ? { reply_to: params.replyTo } : {}),
      }),
    })
  }

  /** POST /api/reaction — empty `reaction` string removes it. */
  async sendReaction(params: {
    session: string
    chatId: string
    messageId: string
    emoji: string
  }): Promise<WahaSendResult> {
    return this.request<WahaSendResult>('/api/reaction', {
      method: 'POST',
      body: JSON.stringify({
        session: params.session,
        chatId: params.chatId,
        messageId: params.messageId,
        reaction: params.emoji,
      }),
    })
  }

  /** POST /api/sendButtons — interactive; WEBJS/WPP only. */
  async sendButtons(params: {
    session: string
    chatId: string
    header?: string
    body: string
    footer?: string
    buttons: Array<{ id: string; title: string }>
  }): Promise<WahaSendResult> {
    return this.request<WahaSendResult>('/api/sendButtons', {
      method: 'POST',
      body: JSON.stringify({
        session: params.session,
        chatId: params.chatId,
        ...(params.header ? { header: params.header } : {}),
        body: params.body,
        ...(params.footer ? { footer: params.footer } : {}),
        buttons: params.buttons,
      }),
    })
  }

  /** POST /api/sendList — interactive; WEBJS/WPP only. */
  async sendList(params: {
    session: string
    chatId: string
    header?: string
    body: string
    footer?: string
    buttonText?: string
    sections: Array<{
      title?: string
      rows: Array<{ id: string; title: string; description?: string }>
    }>
  }): Promise<WahaSendResult> {
    return this.request<WahaSendResult>('/api/sendList', {
      method: 'POST',
      body: JSON.stringify({
        session: params.session,
        chatId: params.chatId,
        ...(params.header ? { header: params.header } : {}),
        body: params.body,
        ...(params.footer ? { footer: params.footer } : {}),
        ...(params.buttonText ? { button_text: params.buttonText } : {}),
        sections: params.sections,
      }),
    })
  }

  /**
   * Absolute URL of a message's media file. `mediaId` is the WAHA
   * message id (the same id exposed as `payload.id` on webhook
   * `message` events with `hasMedia: true`).
   *
   * The endpoint requires the `X-Api-Key` header to download —
   * `downloadMedia` adds it automatically.
   */
  mediaUrl(session: string, mediaId: string): string {
    return `${this.baseUrl}/api/${encodeURIComponent(
      session,
    )}/messages/${encodeURIComponent(mediaId)}/media`
  }

  /** Download a media file (binary) from a WAHA media URL. */
  async downloadMedia(url: string): Promise<{
    buffer: Buffer
    contentType: string
  }> {
    let response: Response
    try {
      response = await fetch(url, {
        headers: { 'X-Api-Key': this.apiKey },
      })
    } catch (error) {
      throw new WahaApiError(
        `WAHA media download failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    if (!response.ok) {
      throw new WahaApiError(
        `WAHA media download failed: ${response.status}`,
      )
    }
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType:
        response.headers.get('content-type') || 'application/octet-stream',
    }
  }
}