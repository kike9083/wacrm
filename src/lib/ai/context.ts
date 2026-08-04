import type { Databases } from 'node-appwrite'
import { Query } from 'node-appwrite'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
}

/**
 * Fetch the last N text messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Non-text messages (media,
 * templates, interactive) are excluded — they carry no text to model.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: Databases,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  let rows
  try {
    rows = await db.listDocuments(DATABASE_ID, COLLECTIONS.messages, [
      Query.equal('conversation_id', conversationId),
      Query.equal('content_type', 'text'),
      Query.orderDesc('created_at'),
      Query.limit(limit),
    ])
  } catch (err) {
    console.error('[ai context] message fetch failed:', err)
    throw err
  }

  const ordered = (rows.documents as unknown as DbMessage[]).reverse()
  return ordered
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: m.content_text!.trim(),
    }))
}
