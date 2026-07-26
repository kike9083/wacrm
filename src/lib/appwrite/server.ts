import { Client, Account, Databases, Users } from 'node-appwrite'
import { cookies } from 'next/headers'

export async function createSessionClient() {
  const client = new Client()
    .setEndpoint(process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!)
    .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!)

  const cookieStore = await cookies()
  const session = cookieStore.get('appwrite-session')
  if (session?.value) {
    client.setSession(session.value)
  }

  return {
    account: new Account(client),
    databases: new Databases(client),
  }
}

export function createAdminClient() {
  const client = new Client()
    .setEndpoint(process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!)
    .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!)
    .setKey(process.env.APPWRITE_API_KEY!)

  return {
    account: new Account(client),
    databases: new Databases(client),
    users: new Users(client),
  }
}
