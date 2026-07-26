import { NextResponse } from 'next/server'
import { createAdminClient, createSessionClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { ID, Query } from 'node-appwrite'
import { getFlowTemplate } from '@/lib/flows/templates'

async function requireUserId(): Promise<string | null> {
  const { account } = await createSessionClient()
  try {
    const user = await account.get()
    return user.$id
  } catch {
    return null
  }
}

export async function GET() {
  const userId = await requireUserId()
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { databases } = createAdminClient()
  const { documents } = await databases.listDocuments(
    DATABASE_ID,
    COLLECTIONS.flows,
    [Query.equal('user_id', userId), Query.orderDesc('created_at')]
  )
  return NextResponse.json({ flows: documents })
}

export async function POST(request: Request) {
  const userId = await requireUserId()
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => null)) as
    | {
        name?: string
        description?: string | null
        trigger_type?: 'keyword' | 'first_inbound_message' | 'manual'
        trigger_config?: Record<string, unknown>
        template_slug?: string
      }
    | null
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { databases } = createAdminClient()

  if (body.template_slug) {
    const template = getFlowTemplate(body.template_slug)
    if (!template) {
      return NextResponse.json(
        { error: `Unknown template_slug "${body.template_slug}"` },
        { status: 400 },
      )
    }
    let flow
    try {
      flow = await databases.createDocument(
        DATABASE_ID,
        COLLECTIONS.flows,
        ID.unique(),
        {
          user_id: userId,
          name: body.name?.trim() || template.name,
          description: template.description,
          status: 'draft',
          trigger_type: template.trigger_type,
          trigger_config: template.trigger_config,
          entry_node_id: template.entry_node_id,
        }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'flow insert failed'
      return NextResponse.json({ error: message }, { status: 500 })
    }
    if (template.nodes.length > 0) {
      try {
        for (const n of template.nodes) {
          await databases.createDocument(
            DATABASE_ID,
            COLLECTIONS.flowNodes,
            ID.unique(),
            {
              flow_id: flow.$id,
              node_key: n.node_key,
              node_type: n.node_type,
              config: n.config,
            }
          )
        }
      } catch (err) {
        await databases.deleteDocument(DATABASE_ID, COLLECTIONS.flows, flow.$id)
        const message = err instanceof Error ? err.message : 'node insert failed'
        return NextResponse.json({ error: message }, { status: 500 })
      }
    }
    return NextResponse.json({ flow }, { status: 201 })
  }

  if (!body.name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  const trigger_type = body.trigger_type ?? 'keyword'

  try {
    const flow = await databases.createDocument(
      DATABASE_ID,
      COLLECTIONS.flows,
      ID.unique(),
      {
        user_id: userId,
        name: body.name.trim(),
        description: body.description ?? null,
        status: 'draft',
        trigger_type,
        trigger_config: body.trigger_config ?? {},
      }
    )
    return NextResponse.json({ flow }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'insert failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
