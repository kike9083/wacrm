import { NextRequest, NextResponse } from 'next/server'
import { createAccount, createUserSession, request } from '@/lib/appwrite/server-api'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

async function createProfile(userId: string, email: string, name: string) {
  try {
    await request('POST', `/databases/${DATABASE_ID}/collections/${COLLECTIONS.profiles}/documents`, {
      documentId: userId,
      data: {
        user_id: userId,
        full_name: name,
        email,
        avatar_url: null,
        role: 'member',
        beta_features: false,
      },
      permissions: ['read("any")', 'write("any")'],
    })
  } catch (e: any) {
    console.warn('[signup] profile creation failed:', e.message)
  }
}

export async function POST(request: NextRequest) {
  // Rate limit: 5 signups per minute per IP
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const rl = checkRateLimit(`auth:signup:${ip}`, { limit: 5, windowMs: 60_000 })
  if (!rl.success) return rateLimitResponse(rl)

  try {
    const { email, password, name } = await request.json()
    const account = await createAccount(email, password, name)
    await createProfile(account.$id, email, name)
    const session = await createUserSession(email, password)

    const response = NextResponse.json({ user: session.user, secret: session.secret }, { status: 200 })
    response.cookies.set('appwrite-session', session.secret, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    })

    return response
  } catch {
    // Never leak internal Appwrite errors
    return NextResponse.json({ error: 'Signup failed' }, { status: 400 })
  }
}
