import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { Query } from 'node-appwrite'
import { requireOwner } from '@/lib/ai/route-auth'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { buildConversationContext } from '@/lib/ai/context'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { generateReply } from '@/lib/ai/generate'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { latestUserMessage } from '@/lib/ai/query'
import { logAiUsage } from '@/lib/ai/usage'
import { AiError } from '@/lib/ai/types'

/**
 * POST /api/ai/draft
 *
 * Body: { conversation_id }
 * Returns: { draft } — a suggested reply for the agent to edit + send.
 *
 * Uses the configured provider/key (BYO). Read-only: it never sends or
 * stores anything, just hands text back to the composer.
 */
export async function POST(request: Request) {
  try {
    const auth = await requireOwner()
    if (auth.unauthorized) return auth.unauthorized
    const { userId } = auth

    const userLimit = checkRateLimit(`ai-draft:${userId}`, RATE_LIMITS.aiDraft)
    if (!userLimit.success) return rateLimitResponse(userLimit)
    const accountLimit = checkRateLimit(
      `ai-draft-acct:${userId}`,
      RATE_LIMITS.aiDraftAccount,
    )
    if (!accountLimit.success) return rateLimitResponse(accountLimit)

    const body = await request.json().catch(() => null)
    const conversationId =
      body && typeof body.conversation_id === 'string' ? body.conversation_id : ''
    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversation_id is required' },
        { status: 400 },
      )
    }

    const { databases } = createAdminClient()
    let conversation
    try {
      conversation = await databases.getDocument(
        DATABASE_ID,
        COLLECTIONS.conversations,
        conversationId,
      )
    } catch {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }
    if (conversation.user_id !== userId) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const config = await loadAiConfig(databases, userId).catch((err) => {
      // Decrypt failure — surface distinctly from "not configured".
      console.error('[ai/draft] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: 'AI assistant is not set up. Enable it in Settings → AI Assistant.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    const messages = await buildConversationContext(databases, conversationId)
    // Nothing to draft from — a brand-new thread with no customer text
    // would otherwise produce a nonsensical reply-to-nothing.
    if (messages.length === 0) {
      return NextResponse.json(
        {
          error: 'No messages to draft from yet.',
          code: 'no_messages',
        },
        { status: 400 },
      )
    }

    // Ground the draft in the knowledge base (best-effort — returns []
    // when there's no KB or retrieval fails).
    const knowledge = await retrieveKnowledge(
      databases,
      userId,
      config,
      latestUserMessage(messages),
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'draft',
      knowledge,
    })

    const { text, usage } = await generateReply({ config, systemPrompt, messages })

    // Record spend on the BYO key. Best-effort + fire-and-forget so the
    // response isn't held for a DB round-trip.
    try {
      void logAiUsage(databases, {
        userId,
        conversationId,
        mode: 'draft',
        provider: config.provider,
        model: config.model,
        usage,
      })
    } catch (logErr) {
      console.error('[ai/draft] usage log skipped:', logErr)
    }

    return NextResponse.json({ draft: text })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    console.error('[ai/draft] threw:', err)
    return NextResponse.json({ error: 'Failed to generate draft' }, { status: 500 })
  }
}
