const ENDPOINT = process.env.APPWRITE_ENDPOINT || 'https://varios-appwrite-techpadah.fjueze.easypanel.host/v1'
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID || '6a65b6900038f0345d67'
const API_KEY = process.env.APPWRITE_API_KEY

if (!API_KEY) {
  console.error('APPWRITE_API_KEY is required')
  process.exit(1)
}

const DB_ID = process.env.APPWRITE_DATABASE_ID || '6a65bc1cf1155569e283'

async function api(method, path, body) {
  const url = `${ENDPOINT}${path}`
  const headers = {
    'X-Appwrite-Project': PROJECT_ID,
    'X-Appwrite-Key': API_KEY,
    'Content-Type': 'application/json',
  }
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json()
  if (!res.ok) throw new Error(`[${res.status}] ${data.message || JSON.stringify(data)}`)
  return data
}

async function addAttribute(collectionId, key, type, size) {
  try {
    const body = { key, required: false }
    if (type === 'string') body.size = size || 255
    const path = type === 'integer' ? 'integer' : type === 'double' ? 'float' : 'string'
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
    ['conversations', 'created_at', 'string', 50],
    ['conversations', 'last_message_text', 'string', 4096],
    ['conversations', 'updated_at', 'string', 50],
    ['contacts', 'created_at', 'string', 50],
    ['deals', 'status', 'string', 50],
    ['deals', 'updated_at', 'string', 50],
    ['messages', 'sender_type', 'string', 50],
    ['messages', 'content_type', 'string', 50],
    ['messages', 'content_text', 'string', 4096],
    ['messages', 'message_id', 'string', 255],
    ['messages', 'interactive_reply_id', 'string', 255],
    ['messages', 'media_url', 'string', 2048],
    ['messages', 'updated_at', 'string', 50],
    ['broadcasts', 'created_at', 'string', 50],
    ['automation_logs', 'created_at', 'string', 50],
    ['profiles', 'email', 'string', 255],
    ['profiles', 'role', 'string', 50],
    ['pipeline_stages', 'position', 'integer', null],
    ['automation_steps', 'position', 'integer', null],
    ['pipelines', 'created_at', 'string', 50],
    ['message_templates', 'created_at', 'string', 50],
    ['automations', 'created_at', 'string', 50],
    ['tags', 'created_at', 'string', 50],
    ['flows', 'created_at', 'string', 50],
    ['flow_runs', 'created_at', 'string', 50],
    ['flow_nodes', 'created_at', 'string', 50],
  ]

  console.log('Adding missing attributes...')
  for (const [col, key, type, size] of fixes) {
    await addAttribute(col, key, type, size)
  }

  console.log('\nDone. Missing attributes added.')
}

main().catch(e => { console.error(e.message); process.exit(1) })
