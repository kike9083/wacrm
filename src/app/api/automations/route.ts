import { NextResponse } from 'next/server'
import { createAdminClient, createSessionClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { ID, Query } from 'node-appwrite'
import { getTemplate } from '@/lib/automations/templates'
import { insertSteps, type BuilderStepInput } from '@/lib/automations/steps-tree'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'

export async function GET() {
  const { account } = await createSessionClient()
  let user
  try {
    user = await account.get()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { databases } = createAdminClient()
  const { documents } = await databases.listDocuments(
    DATABASE_ID,
    COLLECTIONS.automations,
    [Query.orderDesc('created_at')]
  )
  return NextResponse.json({ automations: documents })
}

export async function POST(request: Request) {
  const { account } = await createSessionClient()
  let user
  try {
    user = await account.get()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const { name, description, trigger_type, trigger_config, is_active, steps, template } = body

  let effectiveSteps: BuilderStepInput[] | undefined = steps
  let effectiveName = name
  let effectiveDescription = description
  let effectiveTriggerType = trigger_type
  let effectiveTriggerConfig = trigger_config

  if (template && (!steps || steps.length === 0)) {
    const t = getTemplate(template)
    if (t) {
      effectiveName = effectiveName ?? t.name
      effectiveDescription = effectiveDescription ?? t.description
      effectiveTriggerType = effectiveTriggerType ?? t.trigger_type
      effectiveTriggerConfig = effectiveTriggerConfig ?? t.trigger_config
      effectiveSteps = t.steps as unknown as BuilderStepInput[]
    }
  }

  if (!effectiveName || !effectiveTriggerType) {
    return NextResponse.json(
      { error: 'name and trigger_type are required' },
      { status: 400 },
    )
  }

  if (is_active) {
    const issues = [
      ...validateTriggerForActivation(effectiveTriggerType, effectiveTriggerConfig ?? {}),
      ...validateStepsForActivation(
        (effectiveSteps ?? []) as unknown as { step_type: string; step_config: Record<string, unknown> }[],
      ),
    ]
    if (issues.length > 0) {
      return NextResponse.json(
        { error: 'Cannot activate automation with invalid configuration', issues },
        { status: 400 },
      )
    }
  }

  const { databases } = createAdminClient()
  let automation
  try {
    automation = await databases.createDocument(
      DATABASE_ID,
      COLLECTIONS.automations,
      ID.unique(),
      {
        user_id: user.$id,
        name: effectiveName,
        description: effectiveDescription ?? null,
        trigger_type: effectiveTriggerType,
        trigger_config: effectiveTriggerConfig ?? {},
        is_active: !!is_active,
      }
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'insert failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  if (effectiveSteps && effectiveSteps.length > 0) {
    const err = await insertSteps(automation.$id, effectiveSteps)
    if (err) return NextResponse.json({ error: err }, { status: 500 })
  }

  return NextResponse.json({ automation }, { status: 201 })
}
