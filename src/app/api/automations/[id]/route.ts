import { NextResponse } from 'next/server'
import { createAdminClient, createSessionClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { Query } from 'node-appwrite'
import {
  loadStepsTree,
  replaceSteps,
  type BuilderStepInput,
} from '@/lib/automations/steps-tree'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'

async function requireUser() {
  const { account } = await createSessionClient()
  try {
    return await account.get()
  } catch {
    return null
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { databases } = createAdminClient()
  let automation
  try {
    automation = await databases.getDocument(DATABASE_ID, COLLECTIONS.automations, id)
    if (automation.user_id !== user.$id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const steps = await loadStepsTree(id)
  return NextResponse.json({ automation, steps })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const { databases } = createAdminClient()

  let existing
  try {
    existing = await databases.getDocument(DATABASE_ID, COLLECTIONS.automations, id)
    if (existing.user_id !== user.$id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const update: Record<string, unknown> = {}
  for (const k of [
    'name',
    'description',
    'trigger_type',
    'trigger_config',
    'is_active',
  ] as const) {
    if (k in body) update[k] = body[k]
  }

  const willBeActive =
    typeof update.is_active === 'boolean' ? update.is_active : existing.is_active
  if (willBeActive) {
    const mergedTriggerType = (update.trigger_type ?? existing.trigger_type) as string
    const mergedTriggerConfig = update.trigger_config ?? existing.trigger_config
    const mergedSteps = Array.isArray(body.steps)
      ? (body.steps as { step_type: string; step_config: Record<string, unknown> }[])
      : await loadStepsTree(id)
    const issues = [
      ...validateTriggerForActivation(mergedTriggerType, mergedTriggerConfig),
      ...validateStepsForActivation(mergedSteps),
    ]
    if (issues.length > 0) {
      return NextResponse.json(
        {
          error: 'Cannot keep automation active with invalid configuration',
          issues,
        },
        { status: 400 },
      )
    }
  }

  if (Object.keys(update).length > 0) {
    try {
      await databases.updateDocument(DATABASE_ID, COLLECTIONS.automations, id, update)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'update failed'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  if (Array.isArray(body.steps)) {
    const err = await replaceSteps(id, body.steps as BuilderStepInput[])
    if (err) return NextResponse.json({ error: err }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { databases } = createAdminClient()
  try {
    const automation = await databases.getDocument(DATABASE_ID, COLLECTIONS.automations, id)
    if (automation.user_id !== user.$id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    await databases.deleteDocument(DATABASE_ID, COLLECTIONS.automations, id)
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
