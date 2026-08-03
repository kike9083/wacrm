import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'

const ENDPOINT = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!
const PROJECT_ID = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!
const API_KEY = process.env.APPWRITE_API_KEY

export async function request(method: string, path: string, body?: unknown, session?: string) {
  const headers: Record<string, string> = {
    'X-Appwrite-Project': PROJECT_ID,
    'Content-Type': 'application/json',
  }

  if (session) {
    headers['X-Appwrite-Session'] = session
  } else if (API_KEY) {
    headers['X-Appwrite-Key'] = API_KEY
  }

  const res = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  const data = await res.json()
  if (!res.ok) {
    const err = new Error(data.message || 'Appwrite API request failed') as Error & { status: number; type: string }
    err.status = res.status
    err.type = data.type
    throw err
  }
  return data
}

export async function createAccount(email: string, password: string, name: string) {
  const account = await request('POST', '/account', { userId: 'unique()', email, password, name })
  await request('PATCH', `/users/${account.$id}/verification`, { emailVerification: true })
  return account
}

export async function createEmailSession(email: string, password: string) {
  const session = await request('POST', '/account/sessions/email', { email, password })
  if (typeof session.secret !== 'string' || session.secret.length < 16) {
    throw new Error('Session response did not include a secret')
  }
  return session
}

export async function getProfile(userId: string) {
  try {
    return await request('GET', `/databases/${DATABASE_ID}/collections/${COLLECTIONS.profiles}/documents/${userId}`)
  } catch {
    return null
  }
}

/**
 * Creates the user's profile document if it does not exist yet (self-heal:
 * accounts created before the profiles collection existed, or signups whose
 * profile write failed, would otherwise 404 in the client on every load).
 */
export async function ensureProfile(userId: string) {
  const existing = await getProfile(userId)
  if (existing) return existing

  const user = await request('GET', `/users/${userId}`)
  return request('POST', `/databases/${DATABASE_ID}/collections/${COLLECTIONS.profiles}/documents`, {
    documentId: userId,
    data: {
      user_id: userId,
      full_name: user.name,
      email: user.email,
      avatar_url: null,
      role: 'member',
      beta_features: false,
    },
    permissions: ['read("any")', 'write("any")'],
  })
}

export async function deleteSession(sessionId: string, session?: string) {
  return request('DELETE', `/account/sessions/${sessionId}`, undefined, session)
}

export async function createRecovery(email: string, redirectUrl: string) {
  return request('POST', '/account/recovery', { email, url: redirectUrl })
}

export async function getAccount(session: string) {
  return request('GET', '/account', undefined, session)
}
