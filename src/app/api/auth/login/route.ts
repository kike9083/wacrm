import { NextRequest, NextResponse } from 'next/server'
import { createUserSession } from '@/lib/appwrite/server-api'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

export async function POST(request: NextRequest) {
  // Rate limit: 10 login attempts per minute per IP
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const rl = checkRateLimit(`auth:login:${ip}`, { limit: 10, windowMs: 60_000 })
  if (!rl.success) return rateLimitResponse(rl)

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
  } catch {
    // Never leak internal Appwrite errors — user enumeration prevention
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }
}
