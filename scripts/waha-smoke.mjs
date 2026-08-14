#!/usr/bin/env node
/**
 * WAHA connectivity smoke test (Fase 1 — isolated, touches nothing in
 * the CRM). Verifies, in order:
 *
 *   1. The WAHA instance is reachable (/health)
 *   2. The API key is valid (GET /api/sessions)
 *   3. The configured session exists and is WORKING
 *   4. (optional) A plain text message is delivered (toasts the WAHA id)
 *
 * Usage:
 *   $env:WAHA_BASE_URL="https://waha.your-server.com"          ; $env:WAHA_API_KEY="..." ; $env:WAHA_SESSION="default" ; node scripts/waha-smoke.mjs
 *   # add WAHA_SMOKE_TO="+5491100000000" to send a test message
 *
 * Exit code 0 = all checks passed. No CRM code is imported — this can
 * be run against a bare WAHA install before any driver is configured.
 */

const BASE_URL = (process.env.WAHA_BASE_URL || '').replace(/\/+$/, '')
const API_KEY = process.env.WAHA_API_KEY || ''
const SESSION = process.env.WAHA_SESSION || 'default'
const SMOKE_TO = process.env.WAHA_SMOKE_TO || ''

if (!BASE_URL || !API_KEY) {
  console.error('Missing env: WAHA_BASE_URL and WAHA_API_KEY are required')
  console.error('Usage: node scripts/waha-smoke.mjs (see header for env vars)')
  process.exit(2)
}

let failures = 0

function pass(step, detail) {
  console.log(`  ok   ${step}${detail ? ` — ${detail}` : ''}`)
}

function fail(step, detail) {
  failures++
  console.error(`  FAIL ${step}${detail ? ` — ${detail}` : ''}`)
}

async function api(path, init) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': API_KEY,
      ...(init?.headers || {}),
    },
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { res, data }
}

async function main() {
  console.log(`WAHA smoke test`)
  console.log(`  instance: ${BASE_URL}`)
  console.log(`  session:  ${SESSION}`)
  console.log('')

  // 1. Reachability
  try {
    const res = await fetch(`${BASE_URL}/health`, { headers: { 'X-Api-Key': API_KEY } })
    if (res.ok) {
      pass('health', `HTTP ${res.status}`)
    } else {
      fail('health', `HTTP ${res.status} — instance up but unhealthy`)
    }
  } catch (err) {
    fail('health', `unreachable: ${err.message}`)
  }

  // 2. API key
  let sessions = []
  try {
    const { res, data } = await api('/api/sessions')
    if (!res.ok) {
      fail('sessions', `HTTP ${res.status} — invalid API key? ${JSON.stringify(data)}`)
    } else {
      sessions = Array.isArray(data) ? data : []
      pass('sessions', `${sessions.length} found`)
    }
  } catch (err) {
    fail('sessions', `error: ${err.message}`)
  }

  // 3. Session status
  const session = sessions.find((s) => s.name === SESSION)
  if (!session) {
    fail('session', `"${SESSION}" not found in WAHA. Known: ${sessions.map((s) => s.name).join(', ') || '(none)'}`)
  } else {
    const engine = session.engine ? `, engine ${session.engine}` : ''
    if (session.status === 'WORKING') {
      pass('session', `"${SESSION}" is WORKING (${session.status.toLowerCase()}${engine})`)
    } else {
      fail('session', `"${SESSION}" status is ${session.status}${engine}`)
      if (session.status === 'SCAN_QR_CODE') {
        console.error('         Scan the QR code in the WAHA dashboard to link the number.')
      }
    }
  }

  // 4. Optional send
  if (SMOKE_TO) {
    const chatId = `${SMOKE_TO.replace(/\D/g, '')}@c.us`
    try {
      const { res, data } = await api('/api/sendText', {
        method: 'POST',
        body: JSON.stringify({
          session: SESSION,
          chatId,
          text: 'WAHA smoke test — if you receive this, the gateway is connected.',
        }),
      })
      if (res.ok) {
        pass('sendText', `message id ${data?.id || '(no id)'}`)
      } else {
        fail('sendText', `HTTP ${res.status} — ${JSON.stringify(data)}`)
      }
    } catch (err) {
      fail('sendText', `error: ${err.message}`)
    }
  } else {
    console.log('  (skip) sendText — set WAHA_SMOKE_TO to test an actual send')
  }

  console.log('')
  if (failures > 0) {
    console.error(`RESULT: ${failures} check(s) FAILED`)
    process.exit(1)
  }
  console.log('RESULT: all checks passed')
  console.log('Ready to configure the CRM: Settings > WhatsApp > Provider = WAHA')
  process.exit(0)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})