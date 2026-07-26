const ENDPOINT = process.env.APPWRITE_ENDPOINT || 'https://varios-appwrite-techpadah.fjueze.easypanel.host/v1'
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID || '6a65b6900038f0345d67'
const API_KEY = process.env.APPWRITE_API_KEY

if (!API_KEY) {
  console.error('APPWRITE_API_KEY is required')
  process.exit(1)
}

async function api(method, path, body) {
  const url = `${ENDPOINT}${path}`
  const headers = {
    'X-Appwrite-Project': PROJECT_ID,
    'X-Appwrite-Key': API_KEY,
    'Content-Type': 'application/json',
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  const data = await res.json()
  if (!res.ok) {
    throw new Error(`[${res.status}] ${data.message || JSON.stringify(data)}`)
  }
  return data
}

async function createDatabase() {
  console.log('Creating database...')
  const db = await api('POST', '/databases', {
    databaseId: 'unique()',
    name: 'wacrm',
  })
  console.log(`Database created: ${db.$id}`)
  return db.$id
}

async function createCollection(dbId, collectionId, name, permissions) {
  console.log(`Creating collection: ${name}...`)
  const col = await api('POST', `/databases/${dbId}/collections`, {
    collectionId,
    name,
    permissions: permissions || ['read("any")', 'write("any")'],
    documentSecurity: true,
  })
  return col.$id
}

async function createAttribute(dbId, collectionId, key, type, size, required, options) {
  try {
    const attrTypes = {
      string: { method: 'POST', path: 'string', body: { key, size: size || 255, required: !!required } },
      integer: { method: 'POST', path: 'integer', body: { key, required: !!required } },
      double: { method: 'POST', path: 'float', body: { key, required: !!required } },
      boolean: { method: 'POST', path: 'boolean', body: { key, required: !!required } },
    }

    const cfg = attrTypes[type]
    if (!cfg) throw new Error(`Unknown type: ${type}`)

    const url = `/databases/${dbId}/collections/${collectionId}/attributes/${cfg.path}`
    await api(cfg.method, url, cfg.body)
    console.log(`  Attribute: ${key} (${type})`)
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log(`  Attribute: ${key} (${type}) — already exists, skipping`)
    } else {
      throw e
    }
  }
}

async function createIndex(dbId, collectionId, key, type, attributes, order) {
  try {
    await api('POST', `/databases/${dbId}/collections/${collectionId}/indexes`, {
      key,
      type,
      attributes,
      orders: order || ['ASC'],
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

async function createBucket() {
  console.log('Creating avatars bucket...')
  try {
    const bucket = await api('POST', '/storage/buckets', {
      bucketId: 'avatars',
      name: 'Avatars',
      fileSecurity: false,
      maximumFileSize: 2097152,
      allowedFileExtensions: ['png', 'jpeg', 'jpg', 'webp', 'gif'],
    })
    console.log(`Bucket created: ${bucket.$id}`)
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log('Bucket already exists, skipping')
    } else {
      throw e
    }
  }
}

async function main() {
  try {
    const dbId = await createDatabase()
    const COLLECTIONS = {
      profiles: ['user_id:255', 'full_name:255', 'avatar_url:512', 'beta_features:boolean'],
      contacts: ['user_id:255', 'name:255', 'phone:50', 'email:255', 'avatar_url:512', 'last_contacted_at:50', 'notes:4096'],
      tags: ['user_id:255', 'name:100', 'color:20'],
      contact_tags: ['user_id:255', 'contact_id:255', 'tag_id:255'],
      custom_fields: ['user_id:255', 'name:100', 'type:50'],
      contact_custom_values: ['user_id:255', 'contact_id:255', 'field_id:255', 'value:4096'],
      contact_notes: ['user_id:255', 'contact_id:255', 'content:4096', 'created_at:50'],
      conversations: ['user_id:255', 'contact_id:255', 'contact_name:255', 'contact_phone:50', 'status:50', 'unread_count:integer', 'last_message_at:50', 'last_message_preview:500', 'assignee_id:255'],
      messages: ['conversation_id:255', 'role:50', 'content:4096', 'message_type:50', 'media_url:512', 'media_mime_type:100', 'wa_message_id:255', 'created_at:50', 'status:50'],
      message_reactions: ['message_id:255', 'actor_type:50', 'actor_id:255', 'emoji:50'],
      whatsapp_config: ['user_id:255', 'phone_number_id:255', 'business_account_id:255', 'access_token:512', 'webhook_secret:255', 'webhook_configured:boolean'],
      message_templates: ['user_id:255', 'name:255', 'language:50', 'category:50', 'status:50', 'body:4096', 'footer:500', 'header_type:50', 'header_media_url:512', 'wa_template_id:255'],
      pipelines: ['user_id:255', 'name:255', 'stages_order:1024'],
      pipeline_stages: ['pipeline_id:255', 'name:255', 'color:20', 'order_index:integer'],
      deals: ['pipeline_id:255', 'stage_id:255', 'contact_id:255', 'name:255', 'value:double', 'expected_close_date:50', 'order_index:integer'],
      broadcasts: ['user_id:255', 'name:255', 'status:50', 'template_id:255', 'scheduled_at:50', 'total_count:integer', 'sent_count:integer', 'delivered_count:integer', 'read_count:integer', 'failed_count:integer', 'variable_mapping:4096'],
      broadcast_recipients: ['broadcast_id:255', 'contact_id:255', 'contact_phone:50', 'contact_name:255', 'status:50', 'sent_at:50', 'delivered_at:50', 'read_at:50', 'failed_at:50', 'error_message:500'],
      automations: ['user_id:255', 'name:255', 'trigger_type:50', 'trigger_config:4096', 'is_active:boolean', 'execution_count:integer', 'last_executed_at:50'],
      automation_steps: ['automation_id:255', 'step_type:50', 'config:4096', 'order_index:integer'],
      automation_logs: ['automation_id:255', 'contact_id:255', 'conversation_id:255', 'event:255', 'result:4096', 'created_at:50'],
      automation_pending_executions: ['automation_id:255', 'contact_id:255', 'conversation_id:255', 'execute_after:50', 'step_index:integer', 'context:4096'],
      flows: ['user_id:255', 'name:255', 'description:1024', 'is_active:boolean', 'execution_count:integer'],
      flow_nodes: ['flow_id:255', 'type:50', 'label:255', 'config:4096', 'position_x:double', 'position_y:double'],
      flow_runs: ['flow_id:255', 'contact_id:255', 'status:50', 'current_node_id:255', 'variables:4096', 'started_at:50'],
      flow_run_events: ['flow_run_id:255', 'node_id:255', 'event_type:50', 'data:4096', 'created_at:50'],
    }

    for (const [name, attrs] of Object.entries(COLLECTIONS)) {
      await createCollection(dbId, name, name)
      for (const attr of attrs) {
        const [key, rest] = attr.split(':')
        if (rest === 'boolean') {
          await createAttribute(dbId, name, key, 'boolean', null, false)
        } else if (rest === 'integer') {
          await createAttribute(dbId, name, key, 'integer', null, false)
        } else if (rest === 'double') {
          await createAttribute(dbId, name, key, 'double', null, false)
        } else {
          await createAttribute(dbId, name, key, 'string', parseInt(rest), false)
        }
      }
    }

    // Create user_id indexes for filtered collections
    const indexedCollections = ['profiles', 'contacts', 'tags', 'conversations', 'whatsapp_config', 'message_templates', 'pipelines', 'broadcasts', 'automations', 'flows']
    for (const name of indexedCollections) {
      await createIndex(dbId, name, 'user_id_idx', 'key', ['user_id'])
    }

    await createBucket()

    console.log(`\n=== SUCCESS ===`)
    console.log(`Database ID: ${dbId}`)
    console.log(`\nAdd to .env.local:`)
    console.log(`NEXT_PUBLIC_APPWRITE_DATABASE_ID=${dbId}`)

  } catch (e) {
    console.error(`\nError: ${e.message}`)
    process.exit(1)
  }
}

main()
