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
import {
  WahaApi,
  INTERACTIVE_ENGINES,
  WAHA_STATUS,
  toChatId,
} from '../waha-api'

export interface WahaDriverConfig {
  baseUrl: string
  apiKey: string
  session: string
}

/**
 * WhatsAppDriver implementation backed by a self-hosted WAHA instance.
 *
 * Behavioral notes (deliberate deviations from Meta Cloud API):
 *  - sendTemplate: WAHA has no Meta-style approved templates. The call
 *    degrades to a plain text message using the template params joined
 *    (when present) or the template name — broadcasts keep working for
 *    WAHA-connected accounts. Templates remain a Meta-only feature.
 *  - Interactive buttons/lists only render on WEBJS/WPP engines. On
 *    NOWEB/GOWS the driver falls back to a plain text enumeration of
 *    the options so flows never silently break.
 */
export class WahaDriver implements WhatsAppDriver {
  private api: WahaApi
  private engine: string | null | undefined

  constructor(private config: WahaDriverConfig) {
    this.api = new WahaApi({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    })
  }

  /** Session engine, resolved once per driver instance. */
  private async getEngine(): Promise<string | null> {
    if (this.engine === undefined) {
      try {
        const session = await this.api.getSessionByName(this.config.session)
        this.engine = session?.engine ?? null
      } catch {
        this.engine = null
      }
    }
    return this.engine
  }

  private supportsInteractive(engine: string | null): boolean {
    return !!engine && INTERACTIVE_ENGINES.has(engine)
  }

  async sendText(
    to: string,
    text: string,
    options?: SendTextOptions,
  ): Promise<SendResult> {
    const result = await this.api.sendText({
      session: this.config.session,
      chatId: toChatId(to),
      text,
      ...(options?.contextMessageId
        ? { replyTo: options.contextMessageId }
        : {}),
    })
    return { messageId: result.id }
  }

  async sendTemplate(
    to: string,
    templateName: string,
    options?: TemplateOptions,
  ): Promise<SendResult> {
    const fallbackBody =
      options?.params && options.params.length > 0
        ? options.params.join(' ')
        : templateName
    const result = await this.api.sendText({
      session: this.config.session,
      chatId: toChatId(to),
      text: fallbackBody,
      ...(options?.contextMessageId
        ? { replyTo: options.contextMessageId }
        : {}),
    })
    return { messageId: result.id }
  }

  async sendReaction(
    to: string,
    options: ReactionOptions,
  ): Promise<SendResult> {
    const result = await this.api.sendReaction({
      session: this.config.session,
      chatId: toChatId(to),
      messageId: options.targetMessageId,
      emoji: options.emoji,
    })
    return { messageId: result.id }
  }

  async sendInteractiveButtons(
    to: string,
    bodyText: string,
    buttons: InteractiveButton[],
    options?: InteractiveOptions,
  ): Promise<SendResult> {
    if (buttons.length < 1 || buttons.length > INTERACTIVE_LIMITS.maxButtons) {
      throw new Error(
        `Interactive button message requires 1-${INTERACTIVE_LIMITS.maxButtons} buttons (got ${buttons.length}).`,
      )
    }

    const engine = await this.getEngine()
    if (!this.supportsInteractive(engine)) {
      return this.sendInteractiveFallbackText(
        to,
        bodyText,
        buttons.map((b, i) => `${i + 1}. ${b.title}`),
        options,
      )
    }

    const result = await this.api.sendButtons({
      session: this.config.session,
      chatId: toChatId(to),
      header: options?.headerText,
      body: bodyText,
      footer: options?.footerText,
      buttons: buttons.map((b) => ({ id: b.id, title: b.title })),
    })
    return { messageId: result.id }
  }

  async sendInteractiveList(
    to: string,
    bodyText: string,
    buttonLabel: string,
    sections: InteractiveListSection[],
    options?: InteractiveOptions,
  ): Promise<SendResult> {
    const totalRows = sections.reduce((sum, s) => sum + s.rows.length, 0)
    if (totalRows < 1) {
      throw new Error('Interactive list requires at least one row.')
    }

    const engine = await this.getEngine()
    if (!this.supportsInteractive(engine)) {
      const lines: string[] = []
      for (const section of sections) {
        if (section.title) lines.push(`${section.title}:`)
        for (const row of section.rows) {
          lines.push(
            `• ${row.title}${row.description ? ` — ${row.description}` : ''}`,
          )
        }
      }
      return this.sendInteractiveFallbackText(
        to,
        bodyText,
        lines,
        options,
      )
    }

    const result = await this.api.sendList({
      session: this.config.session,
      chatId: toChatId(to),
      header: options?.headerText,
      body: bodyText,
      footer: options?.footerText,
      buttonText: buttonLabel,
      sections: sections.map((s) => ({
        title: s.title,
        rows: s.rows.map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
        })),
      })),
    })
    return { messageId: result.id }
  }

  /**
   * Non-interactive engines (NOWEB/GOWS) get the options as plain text.
   * The reply ids are lost, so flows keyed on button/row ids degrade to
   * keyword matching on the option text — documented, acceptable tradeoff.
   */
  private async sendInteractiveFallbackText(
    to: string,
    bodyText: string,
    optionLines: string[],
    options?: InteractiveOptions,
  ): Promise<SendResult> {
    const lines: string[] = []
    if (options?.headerText) lines.push(options.headerText)
    lines.push(bodyText)
    lines.push(...optionLines)
    if (options?.footerText) lines.push(options.footerText)
    return this.sendText(to, lines.join('\n'))
  }

  async getMediaUrl(mediaId: string): Promise<MediaInfo> {
    return {
      url: this.api.mediaUrl(this.config.session, mediaId),
      mimeType: 'application/octet-stream',
    }
  }

  async downloadMedia(url: string): Promise<MediaData> {
    const { buffer, contentType } = await this.api.downloadMedia(url)
    return { buffer, contentType }
  }

  async verifyConnection(): Promise<PhoneInfo> {
    const session = await this.api.getSessionByName(this.config.session)
    if (!session) {
      throw new Error(
        `Session "${this.config.session}" not found on the WAHA instance. ` +
          'Check the session name and that the instance is running.',
      )
    }
    if (session.status !== WAHA_STATUS.WORKING) {
      throw new Error(
        `Session "${this.config.session}" is not ready (status: ${session.status}). ` +
          (session.status === WAHA_STATUS.SCAN_QR_CODE
            ? 'Scan the QR code in the WAHA dashboard to link the number.'
            : 'Start the session in the WAHA dashboard first.'),
      )
    }
    return {
      id: session.name,
      display_phone_number: session.phone || session.name,
      verified_name: session.pushName || session.engine || session.name,
      quality_rating: session.engine,
    }
  }
}