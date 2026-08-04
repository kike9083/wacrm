import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { Query } from 'node-appwrite'
import { requireOwner } from '@/lib/ai/route-auth'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/ai/knowledge/[id] — full document.
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const auth = await requireOwner()
    if (auth.unauthorized) return auth.unauthorized
    const { userId } = auth
    const { id } = await params

    const { databases } = createAdminClient()
    let data
    try {
      const res = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.aiKnowledgeDocuments,
        [Query.equal('user_id', userId), Query.equal('$id', id), Query.limit(1)],
      )
      data = res.documents[0]
    } catch (err) {
      console.error('[ai/knowledge/[id] GET] error:', err)
      return NextResponse.json({ error: 'Failed to load document' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({
      id: data.$id,
      title: data.title,
      content: data.content,
      updated_at: data.updated_at ?? null,
    })
  } catch (err) {
    console.error('[ai/knowledge/[id] GET] threw:', err)
    return NextResponse.json({ error: 'Failed to load document' }, { status: 500 })
  }
}

/**
 * PATCH /api/ai/knowledge/[id] — update title/content and re-index when
 * the content changed.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const auth = await requireOwner()
    if (auth.unauthorized) return auth.unauthorized
    const { userId } = auth

    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = await request.json().catch(() => null)
    const title = typeof body?.title === 'string' ? body.title.trim() : undefined
    const content = typeof body?.content === 'string' ? body.content.trim() : undefined
    if (title === undefined && content === undefined) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }
    if (title !== undefined && !title) {
      return NextResponse.json({ error: 'title cannot be empty' }, { status: 400 })
    }
    if (content !== undefined && !content) {
      return NextResponse.json({ error: 'content cannot be empty' }, { status: 400 })
    }

    const { databases } = createAdminClient()
    let updated
    try {
      const res = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.aiKnowledgeDocuments,
        [Query.equal('user_id', userId), Query.equal('$id', id), Query.limit(1)],
      )
      updated = res.documents[0]
    } catch (err) {
      console.error('[ai/knowledge/[id] PATCH] lookup error:', err)
      return NextResponse.json({ error: 'Failed to update document' }, { status: 500 })
    }
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const update: Record<string, string> = { updated_at: new Date().toISOString() }
    if (title !== undefined) update.title = title
    if (content !== undefined) update.content = content

    try {
      await databases.updateDocument(
        DATABASE_ID,
        COLLECTIONS.aiKnowledgeDocuments,
        updated.$id,
        update,
      )
    } catch (err) {
      console.error('[ai/knowledge/[id] PATCH] error:', err)
      return NextResponse.json({ error: 'Failed to update document' }, { status: 500 })
    }

    if (content !== undefined) {
      const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
        databases,
        userId,
      )
      try {
        await ingestDocument(databases, userId, { embeddingsApiKey }, id, content)
      } catch (err) {
        const message = err instanceof AiError ? err.message : 'indexing failed'
        console.error('[ai/knowledge/[id] PATCH] ingest error:', err)
        return NextResponse.json(
          {
            success: true,
            warning: `Updated, but semantic indexing failed (${message}). Lexical search still works; use Reindex to retry.`,
          },
          { status: 200 },
        )
      }
      if (corrupt) {
        return NextResponse.json({
          success: true,
          warning:
            'Updated with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
        })
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[ai/knowledge/[id] PATCH] threw:', err)
    return NextResponse.json({ error: 'Failed to update document' }, { status: 500 })
  }
}

/**
 * DELETE /api/ai/knowledge/[id] — deletes the document and its chunks.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const auth = await requireOwner()
    if (auth.unauthorized) return auth.unauthorized
    const { userId } = auth
    const { id } = await params

    const { databases } = createAdminClient()
    try {
      const res = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.aiKnowledgeDocuments,
        [Query.equal('user_id', userId), Query.equal('$id', id), Query.limit(1)],
      )
      const doc = res.documents[0]
      if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })

      // Cascade: delete the document's chunks first.
      const chunks = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.aiKnowledgeChunks,
        [Query.equal('document_id', id), Query.limit(100)],
      )
      for (const chunk of chunks.documents) {
        await databases.deleteDocument(
          DATABASE_ID,
          COLLECTIONS.aiKnowledgeChunks,
          chunk.$id,
        )
      }
      await databases.deleteDocument(DATABASE_ID, COLLECTIONS.aiKnowledgeDocuments, doc.$id)
    } catch (err) {
      console.error('[ai/knowledge/[id] DELETE] error:', err)
      return NextResponse.json({ error: 'Failed to delete document' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[ai/knowledge/[id] DELETE] threw:', err)
    return NextResponse.json({ error: 'Failed to delete document' }, { status: 500 })
  }
}
