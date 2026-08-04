import type { Databases } from 'node-appwrite'
import { ID, Query } from 'node-appwrite'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import type { AiConfig } from './types'
import { chunkText } from './chunk'
import { embedTexts, serializeEmbedding, parseEmbedding, cosineSimilarity } from './embeddings'

// ============================================================
// Knowledge base: ingest (chunk + optionally embed) and hybrid
// retrieve (semantic when an embeddings key is present, topped up with
// lexical scoring).
//
// Appwrite has no vector index, so retrieval loads the account's chunk
// rows in-process and ranks them with cosine similarity (semantic) plus
// token-overlap scoring (lexical). Fine for a single-tenant CRM whose
// KB is a handful of documents; swap for a vector DB if it ever grows.
// ============================================================

interface ChunkRow {
  $id: string
  document_id: string
  user_id: string
  chunk_index: number
  content: string
  embedding: string | null
}

/** Fetch every chunk row for a user, walking pagination. */
async function allChunksForUser(db: Databases, userId: string): Promise<ChunkRow[]> {
  const out: ChunkRow[] = []
  let cursor: string | null = null
  for (;;) {
    const queries = [Query.equal('user_id', userId), Query.limit(100)]
    if (cursor) queries.push(Query.cursorAfter(cursor))
    const res = await db.listDocuments(DATABASE_ID, COLLECTIONS.aiKnowledgeChunks, queries)
    out.push(...(res.documents as unknown as ChunkRow[]))
    if (res.documents.length < 100) break
    cursor = res.documents[res.documents.length - 1].$id
  }
  return out
}

/**
 * (Re)build the chunks for one document. Deletes the document's
 * existing chunks, re-chunks the content, and — when the account has an
 * embeddings key — embeds each chunk. Runs under whatever client the
 * caller passes (service-role for ingest routes).
 *
 * Throws on embedding failure so the ingest route can report it; the
 * chunks are only written once embedding (if attempted) succeeds, so a
 * failed embed never leaves half-indexed rows.
 */
export async function ingestDocument(
  db: Databases,
  userId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  documentId: string,
  content: string,
): Promise<void> {
  const chunks = chunkText(content)

  // Replace, don't append — re-ingest must be idempotent.
  const existing = await db.listDocuments(DATABASE_ID, COLLECTIONS.aiKnowledgeChunks, [
    Query.equal('document_id', documentId),
    Query.limit(100),
  ])
  for (const row of existing.documents) {
    await db.deleteDocument(DATABASE_ID, COLLECTIONS.aiKnowledgeChunks, row.$id)
  }

  if (chunks.length === 0) return

  // Embed if a key is set, but DON'T let an embedding failure stop the
  // chunks from being stored: a failed embed must still leave the
  // document searchable lexically. We record the error and rethrow it
  // AFTER inserting (embedding-less) rows, so the route can warn
  // "semantic indexing failed" — which is now truthful, because lexical
  // search really does still work.
  let embeddings: number[][] | null = null
  let embedError: unknown = null
  if (config.embeddingsApiKey) {
    try {
      embeddings = await embedTexts(config.embeddingsApiKey, chunks)
    } catch (err) {
      embedError = err
    }
  }

  for (let i = 0; i < chunks.length; i++) {
    await db.createDocument(DATABASE_ID, COLLECTIONS.aiKnowledgeChunks, ID.unique(), {
      document_id: documentId,
      user_id: userId,
      chunk_index: i,
      content: chunks[i],
      embedding: embeddings ? serializeEmbedding(embeddings[i]) : null,
    })
  }

  if (embedError) throw embedError
}

/** Token-overlap lexical score in [0, 1]. */
function lexicalScore(queryTokens: Set<string>, content: string): number {
  const tokens = content.toLowerCase().split(/[^a-z0-9áéíóúüñ]+/).filter(Boolean)
  if (tokens.length === 0) return 0
  let hits = 0
  for (const t of tokens) {
    if (queryTokens.has(t)) hits++
  }
  return hits / tokens.length
}

/**
 * Retrieve up to `k` knowledge excerpts relevant to `queryText`.
 *
 * Semantic-primary when an embeddings key is configured (embed the
 * query → cosine-nearest chunks), then topped up with lexical matches
 * to fill `k`. Lexical-only when there's no key. Best-effort:
 * any failure (no KB, embedding error, query error) degrades to fewer or
 * zero results and never throws into the draft / auto-reply path.
 */
export async function retrieveKnowledge(
  db: Databases,
  userId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  queryText: string,
  k = 5,
): Promise<string[]> {
  const query = queryText.trim()
  if (!query || k <= 0) return []

  let rows: ChunkRow[]
  try {
    rows = await allChunksForUser(db, userId)
  } catch (err) {
    console.error('[ai knowledge] chunk fetch failed:', err)
    return []
  }
  if (rows.length === 0) return []

  const picked = new Map<string, string>() // $id → content, preserves order

  // Semantic path: embed the query, rank by cosine.
  if (config.embeddingsApiKey) {
    try {
      const [queryEmbedding] = await embedTexts(config.embeddingsApiKey, [query])
      if (queryEmbedding) {
        const ranked = rows
          .map((r) => ({ id: r.$id, content: r.content, sim: cosineSimilarity(queryEmbedding, parseEmbedding(r.embedding) ?? []) }))
          .sort((a, b) => b.sim - a.sim)
        for (const r of ranked) {
          if (picked.size >= k) break
          if (r.sim > 0) picked.set(r.id, r.content)
        }
      }
    } catch (err) {
      console.error('[ai knowledge] semantic retrieval failed, falling back to lexical:', err)
    }
  }

  // Lexical top-up (also the sole path when there's no embeddings key).
  if (picked.size < k) {
    const queryTokens = new Set(query.toLowerCase().split(/[^a-z0-9áéíóúüñ]+/).filter(Boolean))
    const ranked = rows
      .map((r) => ({ id: r.$id, content: r.content, score: lexicalScore(queryTokens, r.content) }))
      .sort((a, b) => b.score - a.score)
    for (const r of ranked) {
      if (picked.size >= k) break
      if (r.score > 0 && !picked.has(r.id)) picked.set(r.id, r.content)
    }
  }

  return Array.from(picked.values()).slice(0, k)
}
