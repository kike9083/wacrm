import { NextRequest, NextResponse } from 'next/server'
import { createRecovery } from '@/lib/appwrite/server-api'

export async function POST(request: NextRequest) {
  try {
    const { email } = await request.json()
    const origin = request.headers.get('origin') || 'http://localhost:3000'
    await createRecovery(email, `${origin}/reset-password`)

    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Recovery request failed' }, { status: e.status || 400 })
  }
}
