import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { Query } from 'node-appwrite'
import { requireOwner } from '@/lib/ai/route-auth'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

type Params = { params: Promise<{ conversationId: string }> }

/**
 * POST /api/ai/autoreply/[conversationId]
 *
 * Toggle the AI auto-reply bot for one conversation from the inbox — the
 * "Take over" / "Resume AI" banner.
 *
 * Body: { paused: boolean, assign_to_me?: boolean }
 *   - paused: true  → pause the bot here (a human is taking over). When
 *                     `assign_to_me` is set, also assign the thread to the
 *                     caller (the usual "Take over" flow).
 *   - paused: false → hand the thread back to the bot: clear the pause,
 *                     reset the per-conversation reply count so it gets
 *                     fresh slots, and clear the handoff note. If the
 *                     caller currently owns the thread, unassign it too so
 *                     the bot isn't blocked by the "human owns this" gate.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const auth = await requireOwner()
    if (auth.unauthorized) return auth.unauthorized
    const { userId } = auth

    // Reuse the send bucket: this is a cheap per-user inbox action and
    // toggling it in a tight loop has no legitimate use.
    const limit = checkRateLimit(`ai-takeover:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { conversationId } = await params
    const body = await request.json().catch(() => null)
    if (!body || typeof body.paused !== 'boolean') {
      return NextResponse.json(
        { error: 'paused (boolean) is required' },
        { status: 400 },
      )
    }
    const paused = body.paused as boolean
    const assignToMe = body.assign_to_me === true

    const { databases } = createAdminClient()
    let conv
    try {
      const res = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.conversations,
        [Query.equal('user_id', userId), Query.equal('$id', conversationId), Query.limit(1)],
      )
      conv = res.documents[0]
    } catch (err) {
      console.error('[ai/autoreply] conversation lookup error:', err)
      return NextResponse.json(
        { error: 'Failed to load conversation' },
        { status: 500 },
      )
    }
    if (!conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const update: Record<string, unknown> = { ai_autoreply_disabled: paused }

    if (paused) {
      if (assignToMe) update.assigned_agent_id = userId
    } else {
      // Resuming hands the thread *back to the bot*. Clear the pause and
      // the handoff note, and — crucially — release ANY assignment, not
      // just the caller's own: the auto-reply eligibility gate stands
      // down whenever a human is assigned, so leaving a stale assignee
      // would silently keep the bot muted and make "Resume AI" a no-op.
      // This is the explicit choice to let the bot own the thread again.
      update.assigned_agent_id = null
      // Give the bot a fresh reply budget on this thread. This is a
      // deliberate, manual, rate-limited action (not automatable), so it
      // can't be used to bypass the per-conversation cap at scale — it's
      // a human choosing to re-engage the assistant.
      update.ai_reply_count = 0
      update.ai_handoff_summary = null
    }

    try {
      await databases.updateDocument(
        DATABASE_ID,
        COLLECTIONS.conversations,
        conv.$id,
        update,
      )
    } catch (err) {
      console.error('[ai/autoreply] update error:', err)
      return NextResponse.json(
        { error: 'Failed to update conversation' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, paused })
  } catch (err) {
    console.error('[ai/autoreply] threw:', err)
    return NextResponse.json(
      { error: 'Failed to update conversation' },
      { status: 500 },
    )
  }
}
