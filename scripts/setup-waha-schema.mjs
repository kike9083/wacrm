/**
 * Adds the WAHA driver attributes to the existing `whatsapp_config`
 * collection. Additive only — existing rows and attributes are
 * untouched, so this is safe to run against a production database.
 *
 * New attributes:
 *   driver                  string   — 'meta' (default) | 'waha'
 *   waha_base_url           string   — WAHA instance URL (plaintext)
 *   waha_api_key            string   — encrypted with ENCRYPTION_KEY
 *   waha_session            string   — session name (plaintext)
 *   waha_webhook_secret     string   — encrypted with ENCRYPTION_KEY
 *
 * Usage (same env as scripts/setup-appwrite.mjs):
 *   $env:APPWRITE_API_KEY="..." ; node scripts/setup-waha-schema.mjs
 */

const ENDPOINT = process.env.APPWRITE_ENDPOINT || 'https://varios-appwrite-techpadah.fjueze.easypanel.host/v1'
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID || '6a65b6900038f0345d67'
const API_KEY = process.env.APPWRITE_API_KEY
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID || process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID

if (!API_KEY) {
  console.error('APPWRITE_API_KEY is required')
  process.exit(1)
}
if (!DATABASE_ID) {
  console.error('APPWRITE_DATABASE_ID (or NEXT_PUBLIC_APPWRITE_DATABASE_ID) is required')
  process.exit(1)
}

const COLLECTION = 'whatsapp_config'

const ATTRIBUTES = [
  { key: 'driver', type: 'string', size: 20 },
  { key: 'waha_base_url', type: 'string', size: 512 },
  { key: 'waha_api_key', type: 'string', size: 512 },
  { key: 'waha_session', type: 'string', size: 255 },
  { key: 'waha_webhook_secret', type: 'string', size: 512 },
]

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
  if (!res.ok) {
    throw new Error(`[${res.status}] ${data.message || JSON.stringify(data)}`)
  }
  return data
}

async function main() {
  console.log(`Adding WAHA attributes to ${DATABASE_ID}/${COLLECTION}...`)

  for (const attr of ATTRIBUTES) {
    try {
      await api(
        'POST',
        `/databases/${DATABASE_ID}/collections/${COLLECTION}/attributes/string`,
        { key: attr.key, size: attr.size, required: false },
      )
      console.log(`  Attribute: ${attr.key} (string, ${attr.size})`)
    } catch (e) {
      if (e.message.includes('already exists')) {
        console.log(`  Attribute: ${attr.key} — already exists, skipping`)
      } else {
        console.error(`  Attribute: ${attr.key} — ${e.message}`)
        process.exitCode = 1
      }
    }
  }

  const idxPath = `/databases/${DATABASE_ID}/collections/${COLLECTION}/indexes`
  try {
    await api('POST', idxPath, {
      key: 'waha_session_idx',
      type: 'key',
      attributes: ['waha_session'],
      orders: ['ASC'],
    })
    console.log('  Index: waha_session_idx (key)')
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log('  Index: waha_session_idx — already exists, skipping')
    } else {
      console.error(`  Index: waha_session_idx — ${e.message}`)
      process.exitCode = 1
    }
  }

  if (process.exitCode) {
    console.error('\nDone with errors (see above).')
  } else {
    console.log('\n=== SUCCESS ===')
    console.log('now set waha_session on each meta config row if needed, or re-save via Settings > WhatsApp.')
  }
}

main().catch((e) => {
  console.error(`\nError: ${e.message}`)
  process.exit(1)
})