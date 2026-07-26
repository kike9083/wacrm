import { NextRequest, NextResponse } from 'next/server'
import { createUserSession } from '@/lib/appwrite/server-api'

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json()
    const session = await createUserSession(email, password)

    const response = NextResponse.json({ user: session.user, secret: session.secret }, { status: 200 })
    response.cookies.set('appwrite-session', session.secret, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    })

    return response
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Login failed' }, { status: e.status || 401 })
  }
}
