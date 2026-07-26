import { NextResponse } from 'next/server'
import { createAdminClient, createSessionClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { Query } from 'node-appwrite'

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params

  const { account } = await createSessionClient()
  let user
  try {
    user = await account.get()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { databases } = createAdminClient()

  let flow
  try {
    flow = await databases.getDocument(DATABASE_ID, COLLECTIONS.flows, id)
    if ((flow as any).user_id !== user.$id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const runsResult = await databases.listDocuments(
    DATABASE_ID,
    COLLECTIONS.flowRuns,
    [
      Query.equal('flow_id', id),
      Query.orderDesc('started_at'),
      Query.limit(50),
    ]
  )
  const runs = runsResult.documents

  const runIds = runs.map((r) => r.$id)
  let events: Array<{
    flow_run_id: string
    event_type: string
    node_key: string | null
    payload: Record<string, unknown>
    created_at: string
  }> = []
  if (runIds.length > 0) {
    try {
      const evsResult = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.flowRunEvents,
        [
          Query.equal('flow_run_id', runIds),
          Query.orderAsc('created_at'),
        ]
      )
      events = evsResult.documents as unknown as typeof events
    } catch (err) {
      console.error('[flows-runs] events fetch failed:', err instanceof Error ? err.message : err)
    }
  }

  return NextResponse.json({
    flow: { $id: flow.$id, name: (flow as any).name },
    runs,
    events,
  })
}
