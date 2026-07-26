import { NextResponse } from 'next/server'
import { deleteSession, getSessions } from '@/lib/appwrite/server-api'

export async function POST() {
  try {
    const sessions = await getSessions()
    for (const s of sessions.sessions || []) {
      await deleteSession(s.$id)
    }
  } catch {
    // ignore session errors on logout
  }

  const response = NextResponse.json({ success: true })
  response.cookies.set('appwrite-session', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })

  return response
}
