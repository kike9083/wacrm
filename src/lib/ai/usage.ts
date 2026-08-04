import type { Databases } from 'node-appwrite'
import { ID } from 'node-appwrite'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import type { AiProvider, AiUsage } from './types'

export interface LogAiUsageArgs {
  userId: string
  /** Null for a draft not tied to one thread, or when the row was
   *  deleted between generation and logging. */
  conversationId: string | null
  mode: 'auto_reply' | 'draft'
  provider: AiProvider
  model: string
  /** Provider usage; a no-op when null (nothing worth recording). */
  usage: AiUsage | null
}

/**
 * Best-effort append to `ai_usage_log` — one row per LLM call, for cost
 * visibility on the account's BYO key. NEVER throws: usage accounting
 * must not fail a reply the customer is waiting on, so any DB error is
 * logged and swallowed. Skips entirely when the provider didn't report
 * usage (we'd only be writing zeros).
 */
export async function logAiUsage(
  db: Databases,
  args: LogAiUsageArgs,
): Promise<void> {
  if (!args.usage) return
  try {
    await db.createDocument(DATABASE_ID, COLLECTIONS.aiUsageLog, ID.unique(), {
      user_id: args.userId,
      conversation_id: args.conversationId,
      mode: args.mode,
      provider: args.provider,
      model: args.model,
      prompt_tokens: args.usage.promptTokens,
      completion_tokens: args.usage.completionTokens,
      total_tokens: args.usage.totalTokens,
      created_at: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[ai usage] log insert failed:', err)
  }
}
