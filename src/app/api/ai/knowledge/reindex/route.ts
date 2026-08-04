import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { Query } from 'node-appwrite'
import { requireOwner } from '@/lib/ai/route-auth'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'

/**
 * POST /api/ai/knowledge/reindex
 *
 * Re-chunk and re-embed every document. The main use is after adding an
 * embeddings key: existing documents were stored lexical-only, and this
 * backfills their vectors so semantic search turns on. Also recovers
 * documents whose indexing failed earlier.
 */
export async function POST() {
  try {
    const auth = await requireOwner()
    if (auth.unauthorized) return auth.unauthorized
    const { userId } = auth

    const limit = checkRateLimit(`ai-kb-reindex:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { databases } = createAdminClient()
    let docs
    try {
      const res = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.aiKnowledgeDocuments,
        [Query.equal('user_id', userId)],
      )
      docs = res.documents
    } catch (err) {
      console.error('[ai/knowledge/reindex] fetch error:', err)
      return NextResponse.json(
        { error: 'Failed to load documents' },
        { status: 500 },
      )
    }

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
      databases,
      userId,
    )
    // The whole point of Reindex is usually to backfill embeddings — so
    // if a key is configured but can't be decrypted, don't quietly do a
    // lexical-only pass and report success. Stop and tell the admin.
    if (corrupt) {
      return NextResponse.json(
        {
          success: false,
          reindexed: 0,
          error:
            'Your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key in Settings → AI Assistant). Nothing was reindexed.',
        },
        { status: 200 },
      )
    }

    let reindexed = 0
    for (const doc of docs ?? []) {
      try {
        await ingestDocument(
          databases,
          userId,
          { embeddingsApiKey },
          doc.$id,
          doc.content,
        )
        reindexed += 1
      } catch (err) {
        // One bad document (e.g. a mid-run embeddings rate-limit) should
        // not abort the whole batch.
        const message = err instanceof AiError ? err.message : String(err)
        console.error(`[ai/knowledge/reindex] doc ${doc.$id} failed:`, message)
        return NextResponse.json(
          {
            success: false,
            reindexed,
            total: (docs ?? []).length,
            error: `Reindexed ${reindexed}, then hit an error: ${message}`,
          },
          { status: 200 },
        )
      }
    }

    return NextResponse.json({ success: true, reindexed })
  } catch (err) {
    console.error('[ai/knowledge/reindex] threw:', err)
    return NextResponse.json({ error: 'Failed to reindex documents' }, { status: 500 })
  }
}
