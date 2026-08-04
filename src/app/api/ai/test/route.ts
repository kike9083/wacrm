import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { Query } from 'node-appwrite'
import { requireOwner } from '@/lib/ai/route-auth'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt } from '@/lib/whatsapp/encryption'
import { validateAiCredentials } from '@/lib/ai/validate'
import { AiError, type AiProvider } from '@/lib/ai/types'

/**
 * POST /api/ai/test
 *
 * "Test key" button: validate a candidate provider/model/key against
 * the provider WITHOUT saving. When `api_key` is omitted the stored
 * key is used, so the owner can re-test an existing config (e.g. after
 * changing the model). Returns `{ ok: true }` on success, 400 with the
 * provider's message on failure.
 */
export async function POST(request: Request) {
  try {
    const auth = await requireOwner()
    if (auth.unauthorized) return auth.unauthorized
    const { userId } = auth

    const limit = checkRateLimit(`ai-test:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const provider = body.provider as AiProvider
    if (
      provider !== 'openai' &&
      provider !== 'anthropic' &&
      provider !== 'openrouter'
    ) {
      return NextResponse.json(
        { error: 'provider must be "openai", "anthropic", or "openrouter"' },
        { status: 400 },
      )
    }
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) {
      return NextResponse.json({ error: 'model is required' }, { status: 400 })
    }

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
    let apiKeyPlain = rawKey
    if (!apiKeyPlain) {
      const { databases } = createAdminClient()
      let existing
      try {
        const rows = await databases.listDocuments(
          DATABASE_ID,
          COLLECTIONS.aiConfigs,
          [Query.equal('user_id', userId), Query.limit(1)],
        )
        existing = rows.documents[0] ?? null
      } catch {
        existing = null
      }
      if (!existing?.api_key) {
        return NextResponse.json(
          { error: 'Enter an API key to test.' },
          { status: 400 },
        )
      }
      try {
        apiKeyPlain = decrypt(existing.api_key)
      } catch {
        return NextResponse.json(
          { error: 'Stored API key could not be decrypted — re-enter your key.' },
          { status: 400 },
        )
      }
    }

    try {
      await validateAiCredentials({
        provider,
        model,
        apiKey: apiKeyPlain,
        systemPrompt: null,
        isActive: true,
        autoReplyEnabled: false,
        autoReplyMaxPerConversation: 3,
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
      console.error('[ai/test] validation error:', err)
      return NextResponse.json(
        { error: 'Could not validate the API key.' },
        { status: 400 },
      )
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[ai/test] threw:', err)
    return NextResponse.json({ error: 'Could not validate the API key.' }, { status: 500 })
  }
}
