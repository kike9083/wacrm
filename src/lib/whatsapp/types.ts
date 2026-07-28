export interface SendResult {
  messageId: string
}

export interface SendTextOptions {
  contextMessageId?: string
}

export interface TemplateOptions {
  params?: string[]
  language?: string
  contextMessageId?: string
}

export interface ReactionOptions {
  targetMessageId: string
  emoji: string
}

export interface InteractiveButton {
  id: string
  title: string
}

export interface InteractiveListRow {
  id: string
  title: string
  description?: string
}

export interface InteractiveListSection {
  title?: string
  rows: InteractiveListRow[]
}

export interface InteractiveOptions {
  headerText?: string
  footerText?: string
  contextMessageId?: string
}

export interface MediaInfo {
  url: string
  mimeType: string
}

export interface MediaData {
  buffer: Buffer
  contentType: string
}

export interface PhoneInfo {
  id: string
  display_phone_number: string
  verified_name?: string
  quality_rating?: string
}

export const INTERACTIVE_LIMITS = {
  maxButtons: 3,
  buttonTitleMaxLength: 20,
  maxListSections: 10,
  maxListRowsTotal: 10,
  listRowTitleMaxLength: 24,
  listRowDescriptionMaxLength: 72,
  bodyMaxLength: 1024,
  footerMaxLength: 60,
  headerTextMaxLength: 60,
} as const

export interface WhatsAppDriver {
  sendText(to: string, text: string, options?: SendTextOptions): Promise<SendResult>
  sendTemplate(to: string, templateName: string, options?: TemplateOptions): Promise<SendResult>
  sendReaction(to: string, options: ReactionOptions): Promise<SendResult>
  sendInteractiveButtons(to: string, bodyText: string, buttons: InteractiveButton[], options?: InteractiveOptions): Promise<SendResult>
  sendInteractiveList(to: string, bodyText: string, buttonLabel: string, sections: InteractiveListSection[], options?: InteractiveOptions): Promise<SendResult>
  getMediaUrl(mediaId: string): Promise<MediaInfo>
  downloadMedia(url: string): Promise<MediaData>
  verifyConnection(): Promise<PhoneInfo>
}

export type DriverType = 'meta'
