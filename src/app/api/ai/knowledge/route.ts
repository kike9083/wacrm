import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { ID, Query } from 'node-appwrite'
import { requireOwner, listOwned } from '@/lib/ai/route-auth'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'

interface KnowledgeDocument {
  $id: string
  title: string
  content: string
  updated_at?: string
}

/**
 * GET /api/ai/knowledge
 *
 * List the knowledge-base documents.
 */
export async function GET() {
  try {
    const auth = await requireOwner()
    if (auth.unauthorized) return auth.unauthorized
    const { userId } = auth

    const { databases } = createAdminClient()
    let docs
    try {
      const res = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.aiKnowledgeDocuments,
        [Query.equal('user_id', userId), Query.orderDesc('created_at')],
      )
      docs = res.documents
    } catch (err) {
      console.error('[ai/knowledge GET] error:', err)
      return NextResponse.json(
        { error: 'Failed to load knowledge base' },
        { status: 500 },
      )
    }
    return NextResponse.json({
      documents: (docs as unknown as KnowledgeDocument[]).map((d) => ({
        id: d.$id,
        title: d.title,
        updated_at: d.updated_at ?? null,
      })),
    })
  } catch (err) {
    console.error('[ai/knowledge GET] threw:', err)
    return NextResponse.json(
      { error: 'Failed to load knowledge base' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/ai/knowledge
 *
 * Create a document, then chunk + (optionally) embed it. If indexing
 * fails the document is still saved so the owner can retry via reindex.
 */
export async function POST(request: Request) {
  try {
    const auth = await requireOwner()
    if (auth.unauthorized) return auth.unauthorized
    const { userId } = auth

    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    const content = typeof body?.content === 'string' ? body.content.trim() : ''
    if (!title || !content) {
      return NextResponse.json(
        { error: 'title and content are required' },
        { status: 400 },
      )
    }

    const { databases } = createAdminClient()
    let doc
    try {
      doc = await databases.createDocument(
        DATABASE_ID,
        COLLECTIONS.aiKnowledgeDocuments,
        ID.unique(),
        {
          user_id: userId,
          title,
          content,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      )
    } catch (err) {
      console.error('[ai/knowledge POST] insert error:', err)
      return NextResponse.json(
        { error: 'Failed to save document' },
        { status: 500 },
      )
    }

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
      databases,
      userId,
    )
    try {
      await ingestDocument(databases, userId, { embeddingsApiKey }, doc.$id, content)
    } catch (err) {
      const message = err instanceof AiError ? err.message : 'indexing failed'
      console.error('[ai/knowledge POST] ingest error:', err)
      return NextResponse.json(
        {
          success: true,
          id: doc.$id,
          warning: `Saved, but semantic indexing failed (${message}). Lexical search still works; use Reindex to retry.`,
        },
        { status: 200 },
      )
    }

    if (corrupt) {
      return NextResponse.json({
        success: true,
        id: doc.$id,
        warning:
          'Saved with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
      })
    }
    return NextResponse.json({ success: true, id: doc.$id })
  } catch (err) {
    console.error('[ai/knowledge POST] threw:', err)
    return NextResponse.json({ error: 'Failed to save document' }, { status: 500 })
  }
}
