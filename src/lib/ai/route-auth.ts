import { NextResponse } from 'next/server'
import { createAdminClient, createSessionClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { Query } from 'node-appwrite'

/**
 * Server-side auth for AI API routes.
 *
 * Mirrors the WhatsApp send route's pattern: resolve the session from
 * the `wacrm_session` cookie and return the user id, or a 401 response.
 * This fork is single-user per install, so "admin" (the upstream's
 * requireRole('admin')) collapses to "the authenticated owner" — there
 * are no other members to gate against.
 *
 * Returns `{ userId, unauthorized }`; callers should return
 * `unauthorized` early when set.
 */
export async function requireOwner(): Promise<
  | { userId: string; unauthorized: null }
  | { userId: null; unauthorized: NextResponse }
> {
  const { account } = await createSessionClient()
  let user
  try {
    user = await account.get()
  } catch {
    return {
      userId: null,
      unauthorized: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }
  return { userId: user.$id, unauthorized: null }
}

/**
 * Verify a document belongs to the caller before reading/writing it.
 * Returns `{ doc, missing }` — callers return `missing` early when set.
 * For conversations, also checks `user_id` ownership (the tenant key).
 */
export async function getOwnedDocument<T>(
  userId: string,
  collection: string,
  documentId: string,
): Promise<{ doc: T; missing: null } | { doc: null; missing: NextResponse }> {
  const { databases } = createAdminClient()
  try {
    const doc = await databases.getDocument(
      DATABASE_ID,
      collection,
      documentId,
    )
    if ((doc as unknown as { user_id?: string }).user_id !== userId) {
      return {
        doc: null,
        missing: NextResponse.json({ error: 'Not found' }, { status: 404 }),
      }
    }
    return { doc: doc as unknown as T, missing: null }
  } catch {
    return {
      doc: null,
      missing: NextResponse.json({ error: 'Not found' }, { status: 404 }),
    }
  }
}

/** List docs owned by the caller, ordered by `created_at` desc. */
export async function listOwned<T>(
  userId: string,
  collection: string,
): Promise<T[]> {
  const { databases } = createAdminClient()
  const res = await databases.listDocuments(DATABASE_ID, collection, [
    Query.equal('user_id', userId),
    Query.orderDesc('created_at'),
  ])
  return res.documents as unknown as T[]
}
