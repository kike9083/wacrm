const ENDPOINT = process.env.APPWRITE_ENDPOINT || 'https://varios-appwrite-techpadah.fjueze.easypanel.host/v1'
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID || '6a65b6900038f0345d67'
const API_KEY = process.env.APPWRITE_API_KEY
const DB_ID = process.env.APPWRITE_DATABASE_ID || '6a65bc1cf1155569e283'

if (!API_KEY) {
  console.error('APPWRITE_API_KEY is required')
  process.exit(1)
}

async function api(method, path, body) {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: {
      'X-Appwrite-Project': PROJECT_ID,
      'X-Appwrite-Key': API_KEY,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`[${res.status}] ${data.message || JSON.stringify(data)}`)
  return data
}

async function addAttribute(collectionId, key, type, size) {
  try {
    const body = { key, required: false }
    if (type === 'string') body.size = size || 255
    if (type === 'boolean') body.xdefault = false
    const path = type === 'integer' ? 'integer' : type === 'double' ? 'float' : type === 'boolean' ? 'boolean' : 'string'
    await api('POST', `/databases/${DB_ID}/collections/${collectionId}/attributes/${path}`, body)
    console.log(`  + ${collectionId}.${key} (${type})`)
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log(`  ~ ${collectionId}.${key} — already exists`)
    } else {
      throw e
    }
  }
}

async function main() {
  const fixes = [
    // AI auto-reply / agent assignment
    ['conversations', 'ai_handoff_summary', 'string', 4096],
    ['conversations', 'assigned_agent_id', 'string', 255],
    ['conversations', 'ai_reply_count', 'integer', null],
    // Broadcast tracking
    ['broadcast_recipients', 'whatsapp_message_id', 'string', 255],
    // Reactions conversation lookup
    ['message_reactions', 'conversation_id', 'string', 255],
    // Deals ordering
    ['deals', 'created_at', 'string', 50],
  ]

  console.log('Adding missing attributes...')
  for (const [col, key, type, size] of fixes) {
    await addAttribute(col, key, type, size)
  }
  console.log('\nDone.')
}

main().catch(e => { console.error(e.message); process.exit(1) })
