import { NextResponse } from 'next/server'
import { createAdminClient, createSessionClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { ID, Query } from 'node-appwrite'
import { sendTextMessage, sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

export async function POST(request: Request) {
  try {
    const { account } = await createSessionClient()
    let user
    try {
      user = await account.get()
    } catch {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Per-user rate limit. Bucket key is scoped to this route so
    // `/broadcast` has an independent budget.
    const limit = checkRateLimit(`send:${user.$id}`, RATE_LIMITS.send)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const body = await request.json()
    const {
      conversation_id,
      message_type,
      content_text,
      media_url,
      template_name,
      template_params,
      reply_to_message_id,
    } = body

    if (!conversation_id || !message_type) {
      return NextResponse.json(
        { error: 'conversation_id and message_type are required' },
        { status: 400 }
      )
    }

    if (message_type === 'text' && !content_text) {
      return NextResponse.json(
        { error: 'content_text is required for text messages' },
        { status: 400 }
      )
    }

    if (message_type === 'template' && !template_name) {
      return NextResponse.json(
        { error: 'template_name is required for template messages' },
        { status: 400 }
      )
    }

    const { databases } = createAdminClient()

    // Fetch conversation
    let conversation
    try {
      conversation = await databases.getDocument(
        DATABASE_ID,
        COLLECTIONS.conversations,
        conversation_id,
      )
    } catch {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      )
    }
    if (conversation.user_id !== user.$id) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      )
    }

    // Fetch contact
    let contactList
    try {
      contactList = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.contacts,
        [Query.equal('$id', conversation.contact_id)]
      )
    } catch {
      return NextResponse.json(
        { error: 'Contact phone number not found' },
        { status: 400 }
      )
    }
    const contact = contactList.documents[0]
    if (!contact?.phone) {
      return NextResponse.json(
        { error: 'Contact phone number not found' },
        { status: 400 }
      )
    }

    // Sanitize and validate phone
    const sanitizedPhone = sanitizePhoneForMeta(contact.phone)
    if (!isValidE164(sanitizedPhone)) {
      return NextResponse.json(
        { error: 'Invalid phone number format' },
        { status: 400 }
      )
    }

    // Fetch and decrypt WhatsApp config
    let configs
    try {
      configs = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.whatsappConfig,
        [Query.equal('user_id', user.$id)]
      )
    } catch {
      return NextResponse.json(
        { error: 'WhatsApp not configured. Please set up your WhatsApp integration first.' },
        { status: 400 }
      )
    }
    const config = configs.documents[0]
    if (!config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured. Please set up your WhatsApp integration first.' },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Self-heal legacy CBC-encrypted tokens. Fire-and-forget.
    if (isLegacyFormat(config.access_token)) {
      void databases.updateDocument(
        DATABASE_ID,
        COLLECTIONS.whatsappConfig,
        config.$id,
        { access_token: encrypt(accessToken) },
      ).catch((error: Error) => {
        console.warn(
          '[whatsapp/send] access_token GCM upgrade failed:',
          error.message,
        )
      })
    }

    // Resolve the reply target (if any) to its Meta message_id
    let contextMessageId: string | undefined
    if (reply_to_message_id) {
      let parent
      try {
        parent = await databases.getDocument(
          DATABASE_ID,
          COLLECTIONS.messages,
          reply_to_message_id,
        )
      } catch {
        return NextResponse.json(
          { error: 'reply_to_message_id not found in this conversation' },
          { status: 400 }
        )
      }
      if (parent.conversation_id !== conversation_id) {
        return NextResponse.json(
          { error: 'reply_to_message_id not found in this conversation' },
          { status: 400 }
        )
      }
      if (!parent.message_id) {
        console.warn(
          '[whatsapp/send] reply target has no Meta message_id; sending without context'
        )
      } else {
        contextMessageId = parent.message_id
      }
    }

    // Send via Meta API — retry with phone-number variants
    let waMessageId = ''
    let workingPhone = sanitizedPhone

    const attempt = async (phone: string): Promise<string> => {
      if (message_type === 'template') {
        const result = await sendTemplateMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          templateName: template_name,
          params: template_params || [],
          contextMessageId,
        })
        return result.messageId
      }
      const result = await sendTextMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        text: content_text,
        contextMessageId,
      })
      return result.messageId
    }

    try {
      const variants = phoneVariants(sanitizedPhone)
      let lastError: unknown = null

      for (const variant of variants) {
        try {
          waMessageId = await attempt(variant)
          workingPhone = variant
          lastError = null
          break
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (!isRecipientNotAllowedError(message)) {
            throw err
          }
          lastError = err
          console.warn(`[whatsapp/send] variant "${variant}" rejected by Meta, trying next…`)
        }
      }

      if (lastError) throw lastError
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('Meta API send failed for all variants:', message)
      return NextResponse.json(
        { error: `Meta API error: ${message}` },
        { status: 502 }
      )
    }

    // If a non-original variant succeeded, update the contact
    if (workingPhone !== sanitizedPhone) {
      console.log(
        `[whatsapp/send] Auto-corrected contact phone: ${sanitizedPhone} → ${workingPhone}`
      )
      try {
        await databases.updateDocument(
          DATABASE_ID,
          COLLECTIONS.contacts,
          contact.$id,
          { phone: workingPhone }
        )
      } catch (err) {
        console.error('[whatsapp/send] Failed to update contact phone:', err)
      }
    }

    // Insert message into DB
    let messageRecord
    try {
      messageRecord = await databases.createDocument(
        DATABASE_ID,
        COLLECTIONS.messages,
        ID.unique(),
        {
          conversation_id,
          sender_type: 'agent',
          content_type: message_type,
          content_text: content_text || null,
          media_url: media_url || null,
          template_name: template_name || null,
          message_id: waMessageId,
          status: 'sent',
          reply_to_message_id: reply_to_message_id || null,
        }
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      console.error('Error inserting sent message:', msg)
      return NextResponse.json(
        { error: `Message sent to Meta but failed to save to DB: ${msg}` },
        { status: 500 }
      )
    }

    // Update conversation
    try {
      await databases.updateDocument(
        DATABASE_ID,
        COLLECTIONS.conversations,
        conversation_id,
        {
          last_message_text: content_text || `[${message_type}]`,
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
      )
    } catch (err) {
      console.error('[whatsapp/send] Failed to update conversation:', err)
    }

    // Pause any active Flow run for this contact
    try {
      let activeRuns
      try {
        activeRuns = await databases.listDocuments(
          DATABASE_ID,
          COLLECTIONS.flowRuns,
          [
            Query.equal('user_id', user.$id),
            Query.equal('contact_id', contact.$id),
            Query.equal('status', 'active'),
          ]
        )
      } catch {
        // Best-effort — no active runs or query failed
        return
      }
      for (const run of activeRuns.documents) {
        await databases.updateDocument(
          DATABASE_ID,
          COLLECTIONS.flowRuns,
          run.$id,
          {
            status: 'paused_by_agent',
            ended_at: new Date().toISOString(),
            end_reason: 'agent_replied',
          }
        ).catch((err: Error) => {
          console.error('[flows] pause-on-agent-send failed:', err.message)
        })
      }
    } catch (err) {
      console.error(
        '[flows] pause-on-agent-send threw:',
        err instanceof Error ? err.message : err,
      )
    }

    return NextResponse.json({
      success: true,
      message_id: messageRecord.$id,
      whatsapp_message_id: waMessageId,
    })
  } catch (error) {
    console.error('Error in WhatsApp send POST:', error)
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    )
  }
}
