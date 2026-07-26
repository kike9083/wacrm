import { NextResponse } from 'next/server'
import { createSessionClient } from '@/lib/appwrite/server'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import type { AutomationTriggerType } from '@/types'

export async function POST(request: Request) {
  const { account } = await createSessionClient()
  let user
  try {
    user = await account.get()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  if (!body?.trigger_type) {
    return NextResponse.json({ error: 'trigger_type required' }, { status: 400 })
  }

  await runAutomationsForTrigger({
    userId: user.$id,
    triggerType: body.trigger_type as AutomationTriggerType,
    contactId: body.contact_id ?? null,
    context: body.context ?? {},
  })

  return NextResponse.json({ ok: true })
}
