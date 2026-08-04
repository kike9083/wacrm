import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { ID, Query } from 'node-appwrite'
import { requireOwner } from '@/lib/ai/route-auth'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { validateAiCredentials } from '@/lib/ai/validate'
import { embedTexts } from '@/lib/ai/embeddings'
import { AiError, type AiProvider } from '@/lib/ai/types'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/ai/config
 *
 * Returns the AI setup so the inbox/settings can reflect whether AI is
 * set up. The encrypted key is NEVER returned — only a `has_key` flag;
 * the settings form shows a masked placeholder.
 */
export async function GET() {
  try {
    const auth = await requireOwner()
    if (auth.unauthorized) return auth.unauthorized
    const { userId } = auth

    const { databases } = createAdminClient()
    let rows
    try {
      rows = await databases.listDocuments(DATABASE_ID, COLLECTIONS.aiConfigs, [
        Query.equal('user_id', userId),
        Query.limit(1),
      ])
    } catch (err) {
      console.error('[ai/config GET] fetch error:', err)
      return NextResponse.json(
        { error: 'Failed to load AI configuration' },
        { status: 500 },
      )
    }

    const data = rows.documents[0]
    if (!data) return NextResponse.json({ configured: false })

    // The keys are selected only to derive the has_* flags; neither is
    // returned to the client.
    return NextResponse.json({
      configured: true,
      has_key: !!data.api_key,
      has_embeddings_key: !!data.embeddings_api_key,
      provider: data.provider,
      model: data.model,
      system_prompt: data.system_prompt,
      is_active: data.is_active,
      auto_reply_enabled: data.auto_reply_enabled,
      auto_reply_max_per_conversation: data.auto_reply_max_per_conversation,
      handoff_agent_id: data.handoff_agent_id,
    })
  } catch (err) {
    console.error('[ai/config GET] threw:', err)
    return NextResponse.json({ error: 'Failed to load AI configuration' }, { status: 500 })
  }
}

/**
 * POST /api/ai/config
 *
 * Upsert the AI config. Validates the key with the provider before
 * persisting (mirrors the WhatsApp config verifying with Meta first),
 * then stores the key AES-256-GCM-encrypted. When `api_key` is omitted
 * the existing stored key is reused (the form sends it only when the
 * user re-enters it).
 */
export async function POST(request: Request) {
  try {
    const auth = await requireOwner()
    if (auth.unauthorized) return auth.unauthorized
    const { userId } = auth

    const limit = checkRateLimit(`ai-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const provider = body.provider as AiProvider
    if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'openrouter') {
      return bad('provider must be "openai", "anthropic", or "openrouter"')
    }
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) return bad('model is required')

    const systemPrompt =
      typeof body.system_prompt === 'string' && body.system_prompt.trim()
        ? body.system_prompt.trim()
        : null
    const isActive = body.is_active === true
    const autoReplyEnabled = body.auto_reply_enabled === true

    let maxPer = Number(body.auto_reply_max_per_conversation)
    if (!Number.isFinite(maxPer)) maxPer = 3
    maxPer = Math.min(20, Math.max(1, Math.floor(maxPer)))

    // Handoff routing target for auto-reply. A non-empty string must be
    // this install's own user id (this fork is single-user); an empty
    // string / null means "leave unassigned" (the shared queue). Absent
    // → left unchanged on update below.
    const rawHandoff =
      typeof body.handoff_agent_id === 'string' ? body.handoff_agent_id.trim() : ''
    const handoffProvided = 'handoff_agent_id' in body
    let handoffAgentId: string | null = null
    if (rawHandoff && rawHandoff !== userId) {
      return bad('handoff_agent_id must be the account owner in this build')
    }
    if (rawHandoff) handoffAgentId = rawHandoff

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''

    // Embeddings key (optional, for semantic KB search): a non-empty
    // string sets/replaces it; an explicit null clears it; absent leaves
    // it unchanged. The form only sends it when the admin edits it.
    const rawEmbeddingsKey =
      typeof body.embeddings_api_key === 'string'
        ? body.embeddings_api_key.trim()
        : ''
    const clearEmbeddingsKey = body.embeddings_api_key === null

    // Reuse the stored key when the form didn't send a fresh one.
    const { databases } = createAdminClient()
    let existing
    try {
      const rows = await databases.listDocuments(DATABASE_ID, COLLECTIONS.aiConfigs, [
        Query.equal('user_id', userId),
        Query.limit(1),
      ])
      existing = rows.documents[0] ?? null
    } catch {
      existing = null
    }

    let apiKeyPlain: string
    if (rawKey) {
      apiKeyPlain = rawKey
    } else if (existing?.api_key) {
      try {
        apiKeyPlain = decrypt(existing.api_key)
      } catch {
        return bad('Stored API key could not be decrypted — re-enter your key.')
      }
    } else {
      return bad('api_key is required')
    }

    // Only spend a provider round-trip when the credentials that affect
    // reachability actually changed. A save that just flips a toggle or
    // edits the system prompt on an existing, already-validated config
    // skips the call — no wasted token/latency on the account's key.
    const credentialsChanged =
      !existing ||
      rawKey !== '' ||
      provider !== existing.provider ||
      model !== existing.model

    if (credentialsChanged) {
      try {
        await validateAiCredentials({
          provider,
          model,
          apiKey: apiKeyPlain,
          systemPrompt,
          isActive,
          autoReplyEnabled,
          autoReplyMaxPerConversation: maxPer,
          handoffAgentId: null,
          embeddingsApiKey: null,
        })
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: err.message, code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] validation error:', err)
        return bad('Could not validate the API key with the provider.')
      }
    }

    // Validate a new embeddings key before storing (a cheap 1-input
    // embed), same "verify before save" discipline as the chat key.
    if (rawEmbeddingsKey) {
      try {
        await embedTexts(rawEmbeddingsKey, ['ping'])
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: `Embeddings key: ${err.message}`, code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] embeddings validation error:', err)
        return bad('Could not validate the embeddings key.')
      }
    }

    const encryptedKey = rawKey ? encrypt(rawKey) : null
    const shared: Record<string, unknown> = {
      provider,
      model,
      system_prompt: systemPrompt,
      is_active: isActive,
      auto_reply_enabled: autoReplyEnabled,
      auto_reply_max_per_conversation: maxPer,
    }
    // Only touch the handoff target when the form actually sent the field,
    // so a partial save (e.g. flipping a toggle) doesn't wipe it.
    if (handoffProvided) shared.handoff_agent_id = handoffAgentId
    if (rawEmbeddingsKey) {
      shared.embeddings_api_key = encrypt(rawEmbeddingsKey)
    } else if (clearEmbeddingsKey) {
      shared.embeddings_api_key = null
    }

    try {
      if (existing) {
        await databases.updateDocument(
          DATABASE_ID,
          COLLECTIONS.aiConfigs,
          existing.$id,
          encryptedKey ? { ...shared, api_key: encryptedKey } : shared,
        )
      } else {
        await databases.createDocument(DATABASE_ID, COLLECTIONS.aiConfigs, ID.unique(), {
          user_id: userId,
          api_key: encryptedKey, // guaranteed non-null: rawKey required when no existing row
          ...shared,
        })
      }
    } catch (err) {
      console.error('[ai/config POST] save error:', err)
      return NextResponse.json(
        { error: 'Failed to save AI configuration' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[ai/config POST] threw:', err)
    return NextResponse.json({ error: 'Failed to save AI configuration' }, { status: 500 })
  }
}

/**
 * DELETE /api/ai/config
 *
 * Removes the AI config (turns everything off and forgets the key).
 * Also used to recover from a corrupted encrypted key.
 */
export async function DELETE() {
  try {
    const auth = await requireOwner()
    if (auth.unauthorized) return auth.unauthorized
    const { userId } = auth

    const { databases } = createAdminClient()
    try {
      const rows = await databases.listDocuments(DATABASE_ID, COLLECTIONS.aiConfigs, [
        Query.equal('user_id', userId),
        Query.limit(1),
      ])
      for (const row of rows.documents) {
        await databases.deleteDocument(DATABASE_ID, COLLECTIONS.aiConfigs, row.$id)
      }
    } catch (err) {
      console.error('[ai/config DELETE] error:', err)
      return NextResponse.json(
        { error: 'Failed to delete AI configuration' },
        { status: 500 },
      )
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[ai/config DELETE] threw:', err)
    return NextResponse.json({ error: 'Failed to delete AI configuration' }, { status: 500 })
  }
}
