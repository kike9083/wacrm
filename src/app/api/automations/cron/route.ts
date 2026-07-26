import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { Query } from 'node-appwrite'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret')
  if (supplied !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { databases } = createAdminClient()
  let due
  try {
    const result = await databases.listDocuments(
      DATABASE_ID,
      COLLECTIONS.automationPendingExecutions,
      [
        Query.equal('status', 'pending'),
        Query.lessThanEqual('run_at', new Date().toISOString()),
        Query.orderAsc('run_at'),
        Query.limit(50),
      ]
    )
    due = result.documents
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  if (!due || due.length === 0) return NextResponse.json({ processed: 0 })

  let processed = 0
  for (const row of due) {
    try {
      await databases.updateDocument(
        DATABASE_ID,
        COLLECTIONS.automationPendingExecutions,
        row.$id,
        { status: 'running' }
      )
    } catch {
      continue
    }

    await resumePendingExecution({
      id: row.$id as string,
      automation_id: row.automation_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }

  return NextResponse.json({ processed })
}
