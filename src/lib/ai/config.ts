import type { Databases } from 'node-appwrite'
import { Query } from 'node-appwrite'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { AiConfig, AiProvider } from './types'

interface AiConfigRow {
  $id: string
  provider: AiProvider
  model: string
  api_key: string
  system_prompt: string | null
  is_active: boolean
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number
  handoff_agent_id: string | null
  embeddings_api_key: string | null
}

/**
 * Load and decrypt the user's AI config for *use* (draft or
 * auto-reply). Returns `null` when there's no row or the master switch
 * (`is_active`) is off — both mean "AI is not available", which callers
 * treat identically. Throws only if the stored key can't be decrypted
 * (mismatched `ENCRYPTION_KEY`), so that distinct failure surfaces
 * rather than looking like "not configured".
 *
 * Works with any client: pass the session-scoped Databases instance
 * from a dashboard route, or the admin client from the webhook.
 */
export async function loadAiConfig(
  db: Databases,
  userId: string,
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  const { requireActive = true } = opts

  let rows
  try {
    rows = await db.listDocuments(DATABASE_ID, COLLECTIONS.aiConfigs, [
      Query.equal('user_id', userId),
      Query.limit(1),
    ])
  } catch (err) {
    console.error('[ai config] load failed:', err)
    throw err
  }
  const data = rows.documents[0]
  if (!data) return null

  const row = data as unknown as AiConfigRow
  // The Playground passes requireActive:false so an admin can test the
  // agent before flipping the master switch on.
  if (requireActive && !row.is_active) return null
  if (!row.api_key) return null

  // The embeddings key is optional and independent of the chat key —
  // a corrupt/undecryptable one should downgrade to lexical KB, not
  // take down draft/auto-reply, so decrypt failures are swallowed here.
  let embeddingsApiKey: string | null = null
  if (row.embeddings_api_key) {
    try {
      embeddingsApiKey = decrypt(row.embeddings_api_key)
    } catch {
      console.error(
        `[ai config] embeddings key for user ${userId} could not be decrypted — check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`,
      )
      embeddingsApiKey = null
    }
  }

  return {
    provider: row.provider,
    model: row.model,
    apiKey: decrypt(row.api_key),
    systemPrompt: row.system_prompt,
    isActive: row.is_active,
    autoReplyEnabled: row.auto_reply_enabled,
    autoReplyMaxPerConversation: row.auto_reply_max_per_conversation,
    handoffAgentId: row.handoff_agent_id,
    embeddingsApiKey,
  }
}

/**
 * Load + decrypt just the embeddings key, independent of `is_active`.
 * Used by the knowledge-base ingest routes so the KB gets embedded (and
 * semantic search works) whenever an embeddings key is present, even if
 * the assistant's master switch is currently off.
 *
 * Returns `{ key, corrupt }`: `key` is null when there's no key OR it
 * can't be decrypted; `corrupt` distinguishes those cases so callers can
 * warn ("a key is set but unusable") rather than silently indexing
 * lexical-only and reporting success.
 */
export async function loadEmbeddingsKey(
  db: Databases,
  userId: string,
): Promise<{ key: string | null; corrupt: boolean }> {
  try {
    const rows = await db.listDocuments(DATABASE_ID, COLLECTIONS.aiConfigs, [
      Query.equal('user_id', userId),
      Query.limit(1),
    ])
    const raw = rows.documents[0]?.embeddings_api_key
    if (!raw) return { key: null, corrupt: false }
    try {
      return { key: decrypt(raw as string), corrupt: false }
    } catch {
      console.error(
        `[ai config] embeddings key for user ${userId} could not be decrypted — check ENCRYPTION_KEY.`,
      )
      return { key: null, corrupt: true }
    }
  } catch {
    return { key: null, corrupt: false }
  }
}
