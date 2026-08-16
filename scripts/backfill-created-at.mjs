const ENDPOINT = process.env.APPWRITE_ENDPOINT || 'https://varios-appwrite-techpadah.fjueze.easypanel.host/v1'
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID || '6a65b6900038f0345d67'
const API_KEY = process.env.APPWRITE_API_KEY
const DB_ID = process.env.APPWRITE_DATABASE_ID || '6a65bc1cf1155569e283'

if (!API_KEY) { console.error('APPWRITE_API_KEY is required'); process.exit(1) }

async function api(method, path, body) {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: { 'X-Appwrite-Project': PROJECT_ID, 'X-Appwrite-Key': API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`[${res.status}] ${data.message || JSON.stringify(data)}`)
  return data
}

async function main() {
  const q = '?queries[]=' + encodeURIComponent(JSON.stringify({ method: 'isNull', attribute: 'created_at' })) +
            '&queries[]=' + encodeURIComponent(JSON.stringify({ method: 'limit', values: [100] }))
  const r = await api('GET', `/databases/${DB_ID}/collections/messages/documents${q}`)
  console.log('messages with null created_at:', r.total)
  for (const doc of r.documents) {
    const sysCreated = doc['$createdAt']
    await api('PATCH', `/databases/${DB_ID}/collections/messages/documents/${doc.$id}`, { data: { created_at: sysCreated } })
    console.log(`  backfilled ${doc.$id} -> ${sysCreated}`)
  }
  console.log('Done.')
}

main().catch(e => { console.error(e.message); process.exit(1) })
