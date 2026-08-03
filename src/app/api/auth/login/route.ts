import { NextRequest, NextResponse } from 'next/server'
import { createEmailSession, ensureProfile } from '@/lib/appwrite/server-api'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

export const SESSION_COOKIE = 'wacrm_session'
export const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30

export function setSessionCookie(response: NextResponse, secret: string) {
  response.cookies.set(SESSION_COOKIE, secret, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE,
  })
}

export async function POST(request: NextRequest) {
  // Rate limit: 10 login attempts per minute per IP
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const rl = checkRateLimit(`auth:login:${ip}`, { limit: 10, windowMs: 60_000 })
  if (!rl.success) return rateLimitResponse(rl)

  try {
    const { email, password } = await request.json()
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 400 })
    }

    // The session is created server-side with the API key, so Appwrite
    // includes the session secret in the response body (with the web SDK
    // the secret is only delivered via X-Fallback-Cookies, which 1.8.1
    // suppresses for same-registerable-domain origins). The client SDK
    // receives the secret once via setSession; the httpOnly cookie mirrors
    // it for SSR/proxy validation.
    const session = await createEmailSession(email, password)

    // Self-heal: ensure the user's profile document exists (accounts
    // created before the profiles collection existed would 404 on the
    // client's getDocument on every page load). Never blocks the login.
    await ensureProfile(session.userId).catch(() => {})

    const response = NextResponse.json({ success: true, session: session.secret }, { status: 200 })
    setSessionCookie(response, session.secret)

    return response
  } catch {
    // Never leak internal Appwrite errors — user enumeration prevention
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }
}
