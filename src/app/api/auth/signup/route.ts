import { NextRequest, NextResponse } from 'next/server'
import { createAccount, createEmailSession, ensureProfile } from '@/lib/appwrite/server-api'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { setSessionCookie } from '@/app/api/auth/login/route'

export async function POST(request: NextRequest) {
  // Rate limit: 5 signups per minute per IP
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const rl = checkRateLimit(`auth:signup:${ip}`, { limit: 5, windowMs: 60_000 })
  if (!rl.success) return rateLimitResponse(rl)

  try {
    const { email, password, name } = await request.json()
    const account = await createAccount(email, password, name)
    await ensureProfile(account.$id).catch(() => {})

    // Create the session server-side (same path as /api/auth/login) so the
    // client SDK can bootstrap via setSession without relying on the
    // X-Fallback-Cookies header.
    const session = await createEmailSession(email, password)

    const response = NextResponse.json(
      { success: true, session: session.secret, user: { $id: account.$id, email: account.email, name: account.name } },
      { status: 200 },
    )
    setSessionCookie(response, session.secret)

    return response
  } catch {
    // Never leak internal Appwrite errors
    return NextResponse.json({ error: 'Signup failed' }, { status: 400 })
  }
}
