import { NextResponse } from 'next/server'
import { createAdminClient, createSessionClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { ID, Query } from 'node-appwrite'

async function requireOwnership(
  flowId: string,
): Promise<
  | { ok: true; userId: string }
  | { ok: false; status: number; body: { error: string } }
> {
  const { account } = await createSessionClient()
  let user
  try {
    user = await account.get()
  } catch {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } }
  }
  const { databases } = createAdminClient()
  try {
    const flow = await databases.getDocument(DATABASE_ID, COLLECTIONS.flows, flowId)
    if ((flow as any).user_id !== user.$id) {
      return { ok: false, status: 404, body: { error: 'Not found' } }
    }
  } catch {
    return { ok: false, status: 404, body: { error: 'Not found' } }
  }
  return { ok: true, userId: user.$id }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const guard = await requireOwnership(id)
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status })

  const { databases } = createAdminClient()
  const [flow, nodesResult] = await Promise.all([
    databases.getDocument(DATABASE_ID, COLLECTIONS.flows, id),
    databases.listDocuments(DATABASE_ID, COLLECTIONS.flowNodes, [
      Query.equal('flow_id', id),
      Query.orderAsc('created_at'),
    ]),
  ])
  return NextResponse.json({ flow, nodes: nodesResult.documents ?? [] })
}

interface PutBody {
  name?: string
  description?: string | null
  trigger_type?: 'keyword' | 'first_inbound_message' | 'manual'
  trigger_config?: Record<string, unknown>
  entry_node_id?: string | null
  fallback_policy?: Record<string, unknown>
  nodes?: Array<{
    node_key: string
    node_type: string
    config: Record<string, unknown>
    position_x?: number
    position_y?: number
  }>
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const guard = await requireOwnership(id)
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status })

  const body = (await request.json().catch(() => null)) as PutBody | null
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (body.name !== undefined && !body.name.trim()) {
    return NextResponse.json(
      { error: 'name cannot be empty' },
      { status: 400 },
    )
  }

  const { databases } = createAdminClient()

  const flowPatch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }
  if (body.name !== undefined) flowPatch.name = body.name.trim()
  if (body.description !== undefined)
    flowPatch.description = body.description
  if (body.trigger_type !== undefined) flowPatch.trigger_type = body.trigger_type
  if (body.trigger_config !== undefined)
    flowPatch.trigger_config = body.trigger_config
  if (body.entry_node_id !== undefined)
    flowPatch.entry_node_id = body.entry_node_id
  if (body.fallback_policy !== undefined)
    flowPatch.fallback_policy = body.fallback_policy

  try {
    await databases.updateDocument(DATABASE_ID, COLLECTIONS.flows, id, flowPatch)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'update failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  if (body.nodes !== undefined) {
    try {
      const existing = await databases.listDocuments(DATABASE_ID, COLLECTIONS.flowNodes, [
        Query.equal('flow_id', id),
      ])
      for (const doc of existing.documents) {
        await databases.deleteDocument(DATABASE_ID, COLLECTIONS.flowNodes, doc.$id)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'delete nodes failed'
      return NextResponse.json({ error: message }, { status: 500 })
    }

    if (body.nodes.length > 0) {
      try {
        for (const n of body.nodes) {
          await databases.createDocument(
            DATABASE_ID,
            COLLECTIONS.flowNodes,
            ID.unique(),
            {
              flow_id: id,
              node_key: n.node_key,
              node_type: n.node_type,
              config: n.config,
              position_x: n.position_x ?? 0,
              position_y: n.position_y ?? 0,
            }
          )
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'insert nodes failed'
        return NextResponse.json({ error: message }, { status: 500 })
      }
    }
  }

  const [flow, nodesResult] = await Promise.all([
    databases.getDocument(DATABASE_ID, COLLECTIONS.flows, id),
    databases.listDocuments(DATABASE_ID, COLLECTIONS.flowNodes, [
      Query.equal('flow_id', id),
      Query.orderAsc('created_at'),
    ]),
  ])
  return NextResponse.json({ flow, nodes: nodesResult.documents ?? [] })
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const guard = await requireOwnership(id)
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status })

  const { databases } = createAdminClient()
  try {
    await databases.deleteDocument(DATABASE_ID, COLLECTIONS.flows, id)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'delete failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

