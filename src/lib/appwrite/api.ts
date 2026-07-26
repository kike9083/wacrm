const ENDPOINT = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!
const PROJECT_ID = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!
const API_KEY = process.env.APPWRITE_API_KEY

export async function appwriteApi(method: string, path: string, body?: unknown, session?: string) {
  const headers: Record<string, string> = {
    'X-Appwrite-Project': PROJECT_ID,
    'Content-Type': 'application/json',
  }

  if (API_KEY) headers['X-Appwrite-Key'] = API_KEY
  if (session) headers['Cookie'] = `a_session_${PROJECT_ID.toLowerCase()}=${session}`

  const res = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  const data = await res.json()
  if (!res.ok) throw new AppwriteError(data.message || 'Appwrite API error', res.status, data.type)
  return data
}

export class AppwriteError extends Error {
  constructor(message: string, public status: number, public type?: string) {
    super(message)
  }
}

export async function getAccount() {
  const { data: { user } } = await appwriteApi('GET', '/account')
  return user
}

export async function getSession(token: string) {
  return appwriteApi('GET', '/account', undefined, token)
}
