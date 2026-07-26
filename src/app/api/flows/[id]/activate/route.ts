import { NextResponse } from 'next/server'
import { createAdminClient, createSessionClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { Query } from 'node-appwrite'
import { validateFlowForActivation } from '@/lib/flows/validate'

export async function POST(
  request: Request,
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

  const body = (await request.json().catch(() => null)) as
    | { status?: 'draft' | 'active' | 'archived' }
    | null
  const status = body?.status
  if (!status || !['draft', 'active', 'archived'].includes(status)) {
    return NextResponse.json(
      { error: "status must be one of 'draft' | 'active' | 'archived'" },
      { status: 400 },
    )
  }

  const { databases } = createAdminClient()

  try {
    const existing = await databases.getDocument(DATABASE_ID, COLLECTIONS.flows, id)
    if ((existing as any).user_id !== user.$id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (status === 'active') {
    const [flow, nodesResult] = await Promise.all([
      databases.getDocument(DATABASE_ID, COLLECTIONS.flows, id),
      databases.listDocuments(DATABASE_ID, COLLECTIONS.flowNodes, [
        Query.equal('flow_id', id),
      ]),
    ])
    if (!flow) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    const issues = validateFlowForActivation(
      flow as unknown as {
        name: string
        trigger_type: 'keyword' | 'first_inbound_message' | 'manual'
        trigger_config: Record<string, unknown>
        entry_node_id: string | null
      },
      (nodesResult.documents ?? []) as unknown as Array<{
        node_key: string
        node_type: string
        config: Record<string, unknown>
      }>,
    )
    const blockers = issues.filter((i) => i.severity === 'error')
    if (blockers.length > 0) {
      return NextResponse.json(
        {
          error: 'Cannot activate flow — fix the issues below first.',
          issues,
        },
        { status: 422 },
      )
    }
  }

  try {
    const updated = await databases.updateDocument(
      DATABASE_ID,
      COLLECTIONS.flows,
      id,
      { status, updated_at: new Date().toISOString() }
    )
    return NextResponse.json({ flow: updated })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'update failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
