import { NextResponse } from 'next/server'
import { createAdminClient, createSessionClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { ID, Query } from 'node-appwrite'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { account } = await createSessionClient()
  let user
  try {
    user = await account.get()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { databases } = createAdminClient()
  let original
  try {
    original = await databases.getDocument(DATABASE_ID, COLLECTIONS.automations, id)
    if (original.user_id !== user.$id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  let copy
  try {
    copy = await databases.createDocument(
      DATABASE_ID,
      COLLECTIONS.automations,
      ID.unique(),
      {
        user_id: user.$id,
        name: `${(original as any).name} (Copy)`,
        description: (original as any).description,
        trigger_type: (original as any).trigger_type,
        trigger_config: (original as any).trigger_config,
        is_active: false,
      }
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'copy failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  let steps: any[] = []
  try {
    const result = await databases.listDocuments(
      DATABASE_ID,
      COLLECTIONS.automationSteps,
      [
        Query.equal('automation_id', id),
        Query.orderAsc('position'),
      ]
    )
    steps = result.documents
  } catch {
    steps = []
  }

  if (steps && steps.length > 0) {
    const idMap = new Map<string, string>()
    const uid = () =>
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36)
    for (const row of steps) idMap.set(row.$id, uid())

    for (const row of steps) {
      const newId = idMap.get(row.$id)!
      await databases.createDocument(
        DATABASE_ID,
        COLLECTIONS.automationSteps,
        newId,
        {
          id: newId,
          automation_id: copy.$id,
          parent_step_id: row.parent_step_id ? idMap.get(row.parent_step_id as string) : null,
          branch: row.branch,
          step_type: row.step_type,
          step_config: row.step_config,
          position: row.position,
        }
      )
    }
  }

  return NextResponse.json({ automation: copy }, { status: 201 })
}
