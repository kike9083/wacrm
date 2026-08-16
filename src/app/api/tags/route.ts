import { NextResponse } from 'next/server'
import { createAdminClient, createSessionClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { ID, Query } from 'node-appwrite'

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
    COLLECTIONS.tags,
    [Query.equal('user_id', userId), Query.orderAsc('name')]
  )
  return NextResponse.json({ tags: documents })
}

export async function POST(request: Request) {
  const userId = await requireUserId()
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => null)) as
    | { name?: string; color?: string }
    | null
  const name = body?.name?.trim()
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  const { databases } = createAdminClient()
  try {
    const tag = await databases.createDocument(
      DATABASE_ID,
      COLLECTIONS.tags,
      ID.unique(),
      {
        user_id: userId,
        name,
        color: body?.color ?? '#94a3b8',
      }
    )
    return NextResponse.json({ tag }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'insert failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  const userId = await requireUserId()
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const tagId = searchParams.get('id')
  if (!tagId) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  const { databases } = createAdminClient()
  try {
    const tag = await databases.getDocument(DATABASE_ID, COLLECTIONS.tags, tagId)
    if (tag.user_id !== userId) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    await databases.deleteDocument(DATABASE_ID, COLLECTIONS.tags, tagId)
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
}
