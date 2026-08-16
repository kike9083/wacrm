import { createAdminClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { ID, Query } from 'node-appwrite'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  userId: string
  conversationId: string
  contactId: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { userId, conversationId, contactId } = args

  try {
    const { databases } = createAdminClient()

    const config = await loadAiConfig(databases, userId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const autoResponders = await databases.listDocuments(
      DATABASE_ID,
      COLLECTIONS.automations,
      [
        Query.equal('user_id', userId),
        Query.equal('is_active', true),
        Query.equal('trigger_type', ['new_message_received', 'keyword_match']),
        Query.limit(1),
      ],
    )
    if (autoResponders.documents.length > 0) return

    let conv
    try {
      conv = await databases.getDocument(
        DATABASE_ID,
        COLLECTIONS.conversations,
        conversationId,
      )
    } catch {
      return
    }
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the claim below
    // (this read can race a concurrent inbound — acceptable in this
    // single-instance fork, see the comment at the claim site).
    if ((conv.ai_reply_count ?? 0) >= config.autoReplyMaxPerConversation) return

    const messages = await buildConversationContext(databases, conversationId)
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${userId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${userId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      databases,
      userId,
      config,
      latestUserMessage(messages),
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
    })

    const { text, handoff, followup, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(databases, {
      userId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary: summary,
      }
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = config.handoffAgentId
      }
      await databases.updateDocument(
        DATABASE_ID,
        COLLECTIONS.conversations,
        conversationId,
        update,
      )

      // Post the handoff summary as an internal message so the assigned
      // agent sees the context in the inbox thread without opening the
      // conversation settings. sender_type 'bot' keeps it visually
      // distinct from agent replies.
      await databases
        .createDocument(DATABASE_ID, COLLECTIONS.messages, ID.unique(), {
          conversation_id: conversationId,
          sender_type: 'bot',
          content_type: 'text',
          content_text: summary,
          message_id: `handoff_${conversationId}_${Date.now()}`,
          status: 'sent',
          ai_generated: true,
          created_at: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          console.warn('[ai auto-reply] handoff summary insert failed:', err)
        })

      // Ping the agent on WhatsApp with the summary so they know a
      // customer is waiting for a human.
      if (config.handoffAgentId) {
        try {
          const profiles = await databases.listDocuments(
            DATABASE_ID,
            COLLECTIONS.profiles,
            [Query.equal('user_id', config.handoffAgentId), Query.limit(1)],
          )
          const agentPhone = profiles.documents[0]?.whatsapp_number
          if (agentPhone) {
            const { createDriverFromConfig } = await import('@/lib/whatsapp/driver')
            const waConfigs = await databases.listDocuments(
              DATABASE_ID,
              COLLECTIONS.whatsappConfig,
              [Query.equal('user_id', userId), Query.limit(1)],
            )
            const waConfig = waConfigs.documents[0]
            if (waConfig) {
              const driver = createDriverFromConfig(waConfig)
              await driver.sendText(
                agentPhone,
                `🔔 Handoff — el cliente pidió hablar con un asesor\n\n${summary}`,
              )
            }
          }
        } catch (err) {
          console.warn('[ai auto-reply] handoff WhatsApp notification failed:', err)
        }
      }
      return
    }

    // Claim a reply slot. Appwrite has no atomic conditional UPDATE (the
    // upstream used a Postgres RPC), so this is read-check-increment.
    // In this single-instance fork the webhook processes inbounds
    // serially, so the race window is negligible; the early count check
    // above plus this re-check keeps overshoot to at most one reply.
    const fresh = await databases.getDocument(
      DATABASE_ID,
      COLLECTIONS.conversations,
      conversationId,
    )
    const currentCount = fresh.ai_reply_count ?? 0
    if (currentCount >= config.autoReplyMaxPerConversation) return
    await databases.updateDocument(
      DATABASE_ID,
      COLLECTIONS.conversations,
      conversationId,
      { ai_reply_count: currentCount + 1 },
    )

    await engineSendText({
      userId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })

    // Follow-up flag: the model answered generically because it lacks a
    // specific fact (price, coverage, availability). The customer gets
    // the generic reply (already sent above), the bot stays active, and
    // we (a) drop an internal note on the contact so the team sees the
    // pending follow-up, and (b) ping the configured agent on WhatsApp
    // with a short conversation summary so they can jump in with the
    // specifics.
    if (followup) {
      const lastUserMsg = latestUserMessage(messages)
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })

      // Internal note on the contact (visible in the inbox sidebar).
      await databases
        .createDocument(DATABASE_ID, COLLECTIONS.contactNotes, ID.unique(), {
          contact_id: contactId,
          user_id: userId,
          author_name: 'IA',
          content: `📌 Seguimiento pendiente — el cliente preguntó: "${lastUserMsg}". La IA respondió de forma general porque no tiene ese dato específico.`,
        })
        .catch((err: unknown) => {
          console.warn('[ai auto-reply] followup note insert failed:', err)
        })

      // WhatsApp ping to the configured agent with the summary.
      if (config.handoffAgentId) {
        try {
          const profiles = await databases.listDocuments(
            DATABASE_ID,
            COLLECTIONS.profiles,
            [Query.equal('user_id', config.handoffAgentId), Query.limit(1)],
          )
          const agentPhone = profiles.documents[0]?.whatsapp_number
          if (agentPhone) {
            const { createDriverFromConfig } = await import('@/lib/whatsapp/driver')
            const waConfigs = await databases.listDocuments(
              DATABASE_ID,
              COLLECTIONS.whatsappConfig,
              [Query.equal('user_id', userId), Query.limit(1)],
            )
            const waConfig = waConfigs.documents[0]
            if (waConfig) {
              const driver = createDriverFromConfig(waConfig)
              await driver.sendText(
                agentPhone,
                `📌 Seguimiento pendiente\n\n${summary}`,
              )
            }
          }
        } catch (err) {
          console.warn('[ai auto-reply] agent WhatsApp notification failed:', err)
        }
      }
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
