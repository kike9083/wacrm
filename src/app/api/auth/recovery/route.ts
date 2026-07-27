import { NextRequest, NextResponse } from 'next/server'
import { createRecovery } from '@/lib/appwrite/server-api'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

export async function POST(request: NextRequest) {
  // Rate limit: 3 recovery requests per minute per IP
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const rl = checkRateLimit(`auth:recovery:${ip}`, { limit: 3, windowMs: 60_000 })
  if (!rl.success) return rateLimitResponse(rl)

  try {
    const { email } = await request.json()

    // M5: Use explicit site URL instead of trusting Origin header.
    // Origin can be spoofed by attackers to trigger password resets
    // pointing to a malicious domain.
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    await createRecovery(email, `${siteUrl}/reset-password`)

    // Always return success — never reveal whether the email exists
    return NextResponse.json({ success: true })
  } catch {
    // Always return success to prevent email enumeration
    return NextResponse.json({ success: true })
  }
}
