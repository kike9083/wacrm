import { NextRequest, NextResponse } from 'next/server'
import { createAccount, createUserSession, request } from '@/lib/appwrite/server-api'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'

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
  try {
    const { email, password, name } = await request.json()
    const account = await createAccount(email, password, name)
    await createProfile(account.$id, email, name)
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
    return NextResponse.json({ error: e.message || 'Signup failed' }, { status: e.status || 400 })
  }
}
