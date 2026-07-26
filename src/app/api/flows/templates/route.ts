import { NextResponse } from 'next/server'
import { createSessionClient } from '@/lib/appwrite/server'
import { listFlowTemplates } from '@/lib/flows/templates'

export async function GET() {
  const { account } = await createSessionClient()
  try {
    await account.get()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const templates = listFlowTemplates().map((t) => ({
    slug: t.slug,
    name: t.name,
    description: t.description,
    icon: t.icon,
    trigger_type: t.trigger_type,
    node_count: t.nodes.length,
  }))
  return NextResponse.json({ templates })
}
