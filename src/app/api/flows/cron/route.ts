import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { ID, Query } from 'node-appwrite'
import { resolveFallbackPolicy } from '@/lib/flows/fallback'

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { databases } = createAdminClient()
  const now = new Date()

  let activeRuns
  try {
    const result = await databases.listDocuments(
      DATABASE_ID,
      COLLECTIONS.flowRuns,
      [Query.equal('status', 'active')]
    )
    activeRuns = result.documents
  } catch (err) {
    const message = err instanceof Error ? err.message : 'scan failed'
    console.error('[flows-cron] active-run scan failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }

  if (!activeRuns?.length) return NextResponse.json({ swept: 0 })

  let swept = 0
  for (const r of activeRuns) {
    const policy = resolveFallbackPolicy((r as any).fallback_policy ?? null)
    const lastAdvanced = new Date((r as any).last_advanced_at)
    const ageHours = (now.getTime() - lastAdvanced.getTime()) / (1000 * 60 * 60)
    if (ageHours < policy.on_timeout_hours) continue

    try {
      const updated = await databases.updateDocument(
        DATABASE_ID,
        COLLECTIONS.flowRuns,
        r.$id,
        {
          status: 'timed_out',
          ended_at: now.toISOString(),
          end_reason: 'stale_sweep',
        }
      )

      await databases.createDocument(
        DATABASE_ID,
        COLLECTIONS.flowRunEvents,
        ID.unique(),
        {
          flow_run_id: r.$id,
          event_type: 'timeout',
          payload: {
            age_hours: Math.round(ageHours * 10) / 10,
            policy_hours: policy.on_timeout_hours,
          },
        }
      )
      swept += 1
    } catch {
      // concurrent advance won the race — skip
    }
  }

  return NextResponse.json({ swept })
}
