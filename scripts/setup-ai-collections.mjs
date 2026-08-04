// Creates the AI module collections in Appwrite:
//   ai_configs, ai_knowledge_documents, ai_knowledge_chunks, ai_usage_log
//
// Usage: node scripts/setup-ai-collections.mjs
// Reads APPWRITE_API_KEY from .env.local (or the environment).

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

function loadEnv() {
  const env = { ...process.env }
  const file = resolve('.env.local')
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (m && !(m[1] in env)) env[m[1]] = m[2]
    }
  }
  return env
}

const env = loadEnv()
const ENDPOINT = env.NEXT_PUBLIC_APPWRITE_ENDPOINT || 'https://appwrite.example.com/v1'
const PROJECT_ID = env.NEXT_PUBLIC_APPWRITE_PROJECT_ID
const DATABASE_ID = env.NEXT_PUBLIC_APPWRITE_DATABASE_ID
const API_KEY = env.APPWRITE_API_KEY

if (!API_KEY || !PROJECT_ID || !DATABASE_ID) {
  console.error('APPWRITE_API_KEY, NEXT_PUBLIC_APPWRITE_PROJECT_ID, and NEXT_PUBLIC_APPWRITE_DATABASE_ID are required')
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
  if (!res.ok) {
    throw new Error(`[${res.status}] ${data.message || JSON.stringify(data)}`)
  }
  return data
}

async function ensureCollection(collectionId, name, attrs, indexes = []) {
  try {
    await api('POST', `/databases/${DATABASE_ID}/collections`, {
      collectionId,
      name,
      permissions: ['read("any")', 'write("any")'],
      documentSecurity: true,
    })
    console.log(`Collection created: ${collectionId}`)
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log(`Collection ${collectionId}: already exists, skipping`)
    } else {
      throw e
    }
  }

  for (const [key, type, size] of attrs) {
    try {
      const attrTypes = {
        string: { method: 'POST', path: 'string', body: { key, size: size || 255, required: false } },
        integer: { method: 'POST', path: 'integer', body: { key, required: false } },
        boolean: { method: 'POST', path: 'boolean', body: { key, required: false } },
      }
      const cfg = attrTypes[type]
      await api(cfg.method, `/databases/${DATABASE_ID}/collections/${collectionId}/attributes/${cfg.path}`, cfg.body)
      console.log(`  Attribute: ${key} (${type})`)
    } catch (e) {
      if (e.message.includes('already exists')) {
        console.log(`  Attribute: ${key} (${type}) — already exists, skipping`)
      } else {
        throw e
      }
    }
  }

  for (const [key, type, attributes] of indexes) {
    try {
      await api('POST', `/databases/${DATABASE_ID}/collections/${collectionId}/indexes`, {
        key,
        type,
        attributes,
        orders: attributes.map(() => 'ASC'),
      })
      console.log(`  Index: ${key} (${type})`)
    } catch (e) {
      if (e.message.includes('already exists')) {
        console.log(`  Index: ${key} (${type}) — already exists, skipping`)
      } else {
        throw e
      }
    }
  }
}

async function main() {
  // ai_configs — single row per user (BYO keys, encrypted).
  await ensureCollection(
    'ai_configs',
    'AI Configs',
    [
      ['user_id', 'string', 255],
      ['provider', 'string', 50],
      ['model', 'string', 255],
      ['api_key', 'string', 512],
      ['system_prompt', 'string', 8192],
      ['is_active', 'boolean'],
      ['auto_reply_enabled', 'boolean'],
      ['auto_reply_max_per_conversation', 'integer'],
      ['handoff_agent_id', 'string', 255],
      ['embeddings_api_key', 'string', 512],
      ['created_at', 'string', 50],
    ],
    [['user_id_idx', 'key', ['user_id']]],
  )

  // ai_knowledge_documents — pasted docs (title + raw content).
  await ensureCollection(
    'ai_knowledge_documents',
    'AI Knowledge Documents',
    [
      ['user_id', 'string', 255],
      ['title', 'string', 255],
      ['content', 'string', 65536],
      ['created_at', 'string', 50],
      ['updated_at', 'string', 50],
    ],
    [['user_id_idx', 'key', ['user_id']]],
  )

  // ai_knowledge_chunks — chunked + embedded pieces of the documents.
  await ensureCollection(
    'ai_knowledge_chunks',
    'AI Knowledge Chunks',
    [
      ['user_id', 'string', 255],
      ['document_id', 'string', 255],
      ['chunk_index', 'integer'],
      ['content', 'string', 65536],
      ['embedding', 'string', 16384],
    ],
    [
      ['user_id_idx', 'key', ['user_id']],
      ['document_id_idx', 'key', ['document_id']],
    ],
  )

  // ai_usage_log — one row per LLM call for cost visibility.
  await ensureCollection(
    'ai_usage_log',
    'AI Usage Log',
    [
      ['user_id', 'string', 255],
      ['conversation_id', 'string', 255],
      ['mode', 'string', 50],
      ['provider', 'string', 50],
      ['model', 'string', 255],
      ['prompt_tokens', 'integer'],
      ['completion_tokens', 'integer'],
      ['total_tokens', 'integer'],
      ['created_at', 'string', 50],
    ],
    [
      ['user_id_idx', 'key', ['user_id']],
      ['created_at_idx', 'key', ['created_at']],
    ],
  )

  console.log('\n=== SUCCESS — AI collections ready ===')
}

main().catch((e) => {
  console.error(`\nError: ${e.message}`)
  process.exit(1)
})
