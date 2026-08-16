const ENDPOINT = process.env.APPWRITE_ENDPOINT || 'https://varios-appwrite-techpadah.fjueze.easypanel.host/v1'
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID || '6a65b6900038f0345d67'
const API_KEY = process.env.APPWRITE_API_KEY

const BUCKET_ID = 'whatsapp-media'

if (!API_KEY) { console.error('APPWRITE_API_KEY is required'); process.exit(1) }

async function main() {
  const list = await fetch(`${ENDPOINT}/storage/buckets`, {
    headers: { 'X-Appwrite-Project': PROJECT_ID, 'X-Appwrite-Key': API_KEY },
  })
  const listData = await list.json()
  if (!list.ok) throw new Error(`[${list.status}] ${listData.message || JSON.stringify(listData)}`)
  const exists = listData.buckets.find((b) => b.$id === BUCKET_ID)
  if (exists) {
    console.log(`Bucket "${BUCKET_ID}" already exists (files: ${exists.filesTotal})`)
    return
  }

  const body = new URLSearchParams({
    bucketId: BUCKET_ID,
    name: 'WhatsApp Media',
    fileSecurity: 'true',
    enabled: 'true',
    maximumFileSize: '26214400',
  })
  const res = await fetch(`${ENDPOINT}/storage/buckets`, {
    method: 'POST',
    headers: {
      'X-Appwrite-Project': PROJECT_ID,
      'X-Appwrite-Key': API_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`[${res.status}] ${data.message || JSON.stringify(data)}`)
  console.log('Bucket created:', data.$id)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
