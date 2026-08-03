import { NextRequest, NextResponse } from 'next/server'
import { createAccount, request } from '@/lib/appwrite/server-api'
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

    // Session is created client-side (SDK) after account creation, then
    // mirrored into the session cookie via POST /api/auth/login.
    return NextResponse.json({ user: { $id: account.$id, email: account.email, name: account.name } }, { status: 200 })
  } catch {
    // Never leak internal Appwrite errors
    return NextResponse.json({ error: 'Signup failed' }, { status: 400 })
  }
}
