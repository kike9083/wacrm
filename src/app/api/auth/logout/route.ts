import { NextResponse, type NextRequest } from 'next/server'
import { deleteSession } from '@/lib/appwrite/server-api'
import { SESSION_COOKIE } from '@/app/api/auth/login/route'

export async function POST(request: NextRequest) {
  const secret = request.cookies.get(SESSION_COOKIE)?.value
  try {
    if (secret) {
      await deleteSession('current', secret)
    }
  } catch {
    // ignore session errors on logout (session may already be gone)
  }

  const response = NextResponse.json({ success: true })
  response.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })

  return response
}
