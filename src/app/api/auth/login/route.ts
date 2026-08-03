import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

export const SESSION_COOKIE = 'wacrm_session'

export async function POST(request: NextRequest) {
  // Rate limit: 10 login attempts per minute per IP
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const rl = checkRateLimit(`auth:login:${ip}`, { limit: 10, windowMs: 60_000 })
  if (!rl.success) return rateLimitResponse(rl)

  try {
    const { secret } = await request.json()
    if (typeof secret !== 'string' || secret.length < 16) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 400 })
    }

    // The session is created by the client SDK so the browser keeps the
    // same session the server trusts (single source of truth). The cookie
    // mirrors that session's secret for SSR/middleware only.
    const response = NextResponse.json({ success: true }, { status: 200 })
    response.cookies.set(SESSION_COOKIE, secret, {
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
