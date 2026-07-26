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

export async function createUserSession(email: string, password: string) {
  return request('POST', '/account/sessions/email', { email, password })
}

export async function createAccount(email: string, password: string, name: string) {
  const account = await request('POST', '/account', { userId: 'unique()', email, password, name })
  await request('PATCH', `/users/${account.$id}/verification`, { emailVerification: true })
  return account
}

export async function deleteSession(sessionId: string) {
  return request('DELETE', `/account/sessions/${sessionId}`)
}

export async function createRecovery(email: string, redirectUrl: string) {
  return request('POST', '/account/recovery', { email, url: redirectUrl })
}

export async function getAccount(session: string) {
  return request('GET', '/account', undefined, session)
}

export async function listSessions() {
  return request('GET', '/account/sessions')
}

export async function getSessions() {
  return request('GET', '/account/sessions')
}
