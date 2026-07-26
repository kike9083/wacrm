import { Query, type Databases } from "appwrite";
import { DATABASE_ID, COLLECTIONS } from "@/lib/appwrite/db";
import {
  daysAgoStart,
  DOW_SHORT_MON_FIRST,
  lastNDayKeys,
  localDayKey,
  mondayIndex,
  startOfLocalDay,
} from './date-utils'
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  MetricsBundle,
  PipelineDonutData,
  PipelineStageSlice,
  ResponseTimeBucket,
  ResponseTimeSummary,
} from './types'

// ------------------------------------------------------------
// All client-side aggregation. RLS scopes every query to the
// signed-in user automatically, so we never pass user_id explicitly
// here. Perf is acceptable for the current scale (low thousands of
// messages) — if a tenant's dataset outgrows this, we'd migrate the
// heavy aggregations to SQL RPCs. Noted in the PR.
// ------------------------------------------------------------

type DB = Databases

async function countDocs(
  db: DB,
  collectionId: string,
  queries: string[] = [],
): Promise<number> {
  const res = await db.listDocuments(DATABASE_ID, collectionId, [
    ...queries,
    Query.limit(1),
  ])
  return res.total
}

// --- 1. Metric cards ---------------------------------------------------

export async function loadMetrics(db: DB): Promise<MetricsBundle> {
  const todayStart = startOfLocalDay().toISOString()
  const yesterdayStart = daysAgoStart(1).toISOString()

  const [
    openConvCur,
    newConvToday,
    newConvYesterday,
    newContactsToday,
    newContactsYesterday,
    openDealsRes,
    messagesToday,
    messagesYesterday,
  ] = await Promise.all([
    countDocs(db, COLLECTIONS.conversations, [Query.equal('status', 'open')]),
    countDocs(db, COLLECTIONS.conversations, [
      Query.equal('status', 'open'),
      Query.greaterThanEqual('created_at', todayStart),
    ]),
    countDocs(db, COLLECTIONS.conversations, [
      Query.equal('status', 'open'),
      Query.greaterThanEqual('created_at', yesterdayStart),
      Query.lessThan('created_at', todayStart),
    ]),
    countDocs(db, COLLECTIONS.contacts, [
      Query.greaterThanEqual('created_at', todayStart),
    ]),
    countDocs(db, COLLECTIONS.contacts, [
      Query.greaterThanEqual('created_at', yesterdayStart),
      Query.lessThan('created_at', todayStart),
    ]),
    db.listDocuments(DATABASE_ID, COLLECTIONS.deals, [
      Query.equal('status', 'open'),
      Query.limit(5000),
    ]),
    countDocs(db, COLLECTIONS.messages, [
      Query.equal('sender_type', 'agent'),
      Query.greaterThanEqual('created_at', todayStart),
    ]),
    countDocs(db, COLLECTIONS.messages, [
      Query.equal('sender_type', 'agent'),
      Query.greaterThanEqual('created_at', yesterdayStart),
      Query.lessThan('created_at', todayStart),
    ]),
  ])

  const openDealsRows = openDealsRes.documents as unknown as { value: number | null }[]
  const openDealsValue = openDealsRows.reduce((sum, d) => sum + (d.value ?? 0), 0)

  return {
    activeConversations: {
      current: openConvCur,
      previous: newConvToday - newConvYesterday,
    },
    newContactsToday: {
      current: newContactsToday,
      previous: newContactsYesterday,
    },
    openDealsValue,
    openDealsCount: openDealsRows.length,
    messagesSentToday: {
      current: messagesToday,
      previous: messagesYesterday,
    },
  }
}

// --- 2. Conversations over time ---------------------------------------

export async function loadConversationsSeries(
  db: DB,
  rangeDays: number,
): Promise<ConversationsSeriesPoint[]> {
  const start = daysAgoStart(rangeDays - 1).toISOString()
  const response = await db.listDocuments(DATABASE_ID, COLLECTIONS.messages, [
    Query.greaterThanEqual('created_at', start),
    Query.orderAsc('created_at'),
    Query.limit(5000),
  ])

  const rows = response.documents as unknown as {
    $id: string
    created_at: string
    sender_type: string
  }[]

  const keys = lastNDayKeys(rangeDays)
  const buckets = new Map<string, { incoming: number; outgoing: number }>()
  for (const k of keys) buckets.set(k, { incoming: 0, outgoing: 0 })

  for (const row of rows) {
    const key = localDayKey(row.created_at)
    const bucket = buckets.get(key)
    if (!bucket) continue
    if (row.sender_type === 'customer') bucket.incoming += 1
    else bucket.outgoing += 1
  }

  return keys.map((day) => ({ day, ...(buckets.get(day) ?? { incoming: 0, outgoing: 0 }) }))
}

// --- 3. Pipeline donut -------------------------------------------------

export async function loadPipelineDonut(db: DB): Promise<PipelineDonutData> {
  const [stagesRes, dealsRes] = await Promise.all([
    db.listDocuments(DATABASE_ID, COLLECTIONS.pipelineStages, [
      Query.orderAsc('order_index'),
    ]),
    db.listDocuments(DATABASE_ID, COLLECTIONS.deals, [
      Query.equal('status', 'open'),
      Query.limit(5000),
    ]),
  ])

  const stages =
    stagesRes.documents as unknown as { $id: string; name: string; color: string; pipeline_id: string; order_index: number }[]
  const deals = dealsRes.documents as unknown as { stage_id: string; value: number | null }[]

  const byStage = new Map<string, { count: number; total: number }>()
  for (const d of deals) {
    const row = byStage.get(d.stage_id) ?? { count: 0, total: 0 }
    row.count += 1
    row.total += d.value ?? 0
    byStage.set(d.stage_id, row)
  }

  const slices: PipelineStageSlice[] = stages
    .map((s) => ({
      id: s.$id,
      name: s.name,
      color: s.color || '#64748b',
      dealCount: byStage.get(s.$id)?.count ?? 0,
      totalValue: byStage.get(s.$id)?.total ?? 0,
    }))
    .filter((s) => s.totalValue > 0 || s.dealCount > 0)

  return {
    stages: slices,
    totalValue: slices.reduce((sum, s) => sum + s.totalValue, 0),
  }
}

// --- 4. Response time by day of week ----------------------------------

export async function loadResponseTime(db: DB): Promise<ResponseTimeSummary> {
  const fourteenDaysAgo = daysAgoStart(13).toISOString()
  const response = await db.listDocuments(DATABASE_ID, COLLECTIONS.messages, [
    Query.greaterThanEqual('created_at', fourteenDaysAgo),
    Query.orderAsc('conversation_id'),
    Query.orderAsc('created_at'),
    Query.limit(5000),
  ])

  const rows = response.documents as unknown as {
    $id: string
    conversation_id: string
    sender_type: string
    created_at: string
  }[]

  interface Sample {
    customerAt: Date
    responseAt: Date
  }
  const samples: Sample[] = []

  let currentConv = ''
  let pendingCustomer: Date | null = null
  for (const row of rows) {
    if (row.conversation_id !== currentConv) {
      currentConv = row.conversation_id
      pendingCustomer = null
    }
    const ts = new Date(row.created_at)
    if (row.sender_type === 'customer') {
      if (!pendingCustomer) pendingCustomer = ts
    } else if (pendingCustomer) {
      samples.push({ customerAt: pendingCustomer, responseAt: ts })
      pendingCustomer = null
    }
  }

  const now = new Date()
  const thisWeekStart = daysAgoStart(mondayIndex(now))
  const lastWeekStart = daysAgoStart(mondayIndex(now) + 7)

  const byDow = new Map<number, number[]>()
  for (let i = 0; i < 7; i++) byDow.set(i, [])
  const thisWeekMins: number[] = []
  const lastWeekMins: number[] = []

  for (const s of samples) {
    const diffMin = (s.responseAt.getTime() - s.customerAt.getTime()) / 60_000
    if (diffMin < 0) continue
    const dow = mondayIndex(s.customerAt)
    byDow.get(dow)!.push(diffMin)
    if (s.customerAt >= thisWeekStart) {
      thisWeekMins.push(diffMin)
    } else if (s.customerAt >= lastWeekStart && s.customerAt < thisWeekStart) {
      lastWeekMins.push(diffMin)
    }
  }

  const avg = (arr: number[]) =>
    arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length

  const buckets: ResponseTimeBucket[] = Array.from({ length: 7 }, (_, dow) => {
    const samples = byDow.get(dow) ?? []
    return {
      dow,
      avgMinutes: avg(samples),
      samples: samples.length,
    }
  })

  void DOW_SHORT_MON_FIRST

  return {
    buckets,
    thisWeekAvg: avg(thisWeekMins),
    lastWeekAvg: avg(lastWeekMins),
  }
}

// --- 5. Activity feed --------------------------------------------------

async function resolveMessageContacts(
  db: DB,
  msgs: Array<{ conversation_id: string }>,
): Promise<Map<string, { name: string | null; phone: string }>> {
  const convIds = [...new Set(msgs.map(m => m.conversation_id).filter(Boolean))]
  const result = new Map<string, { name: string | null; phone: string }>()
  if (convIds.length === 0) return result

  const convsRes = await db.listDocuments(DATABASE_ID, COLLECTIONS.conversations, [
    Query.equal('$id', convIds),
    Query.limit(convIds.length),
  ])

  const contactIds = [
    ...new Set(convsRes.documents.map((c: any) => c.contact_id).filter(Boolean)),
  ]
  if (contactIds.length === 0) return result

  const contactsRes = await db.listDocuments(DATABASE_ID, COLLECTIONS.contacts, [
    Query.equal('$id', contactIds),
    Query.limit(contactIds.length),
  ])
  const contactMap = new Map(
    contactsRes.documents.map((c: any) => [c.$id, { name: c.name ?? null, phone: c.phone ?? '' }]),
  )

  for (const conv of convsRes.documents as any[]) {
    result.set(conv.$id, contactMap.get(conv.contact_id) ?? { name: null, phone: '' })
  }

  return result
}

async function resolveAutomationLogRelations(
  db: DB,
  logs: Array<{ automation_id?: string; contact_id?: string }>,
): Promise<{
  autoMap: Map<string, string>
  contactMap: Map<string, { name: string | null; phone: string }>
}> {
  const autoIds: string[] = [...new Set(logs.map(l => l.automation_id).filter((x): x is string => !!x))]
  const contactIds: string[] = [...new Set(logs.map(l => l.contact_id).filter((x): x is string => !!x))]

  const [autoRes, contactsRes] = await Promise.all([
    autoIds.length > 0
      ? db.listDocuments(DATABASE_ID, COLLECTIONS.automations, [
          Query.equal('$id', autoIds),
          Query.limit(autoIds.length),
        ])
      : { documents: [] },
    contactIds.length > 0
      ? db.listDocuments(DATABASE_ID, COLLECTIONS.contacts, [
          Query.equal('$id', contactIds),
          Query.limit(contactIds.length),
        ])
      : { documents: [] },
  ])

  const autoMap = new Map(
    (autoRes.documents as any[]).map(a => [a.$id, a.name ?? 'Automation']),
  )
  const contactMap = new Map(
    (contactsRes.documents as any[]).map(c => [c.$id, { name: c.name ?? null, phone: c.phone ?? '' }]),
  )

  return { autoMap, contactMap }
}

async function resolveDealStages(
  db: DB,
): Promise<Map<string, string>> {
  const stagesRes = await db.listDocuments(DATABASE_ID, COLLECTIONS.pipelineStages, [
    Query.limit(100),
  ])
  return new Map(
    (stagesRes.documents as any[]).map(s => [s.$id, s.name ?? '']),
  )
}

export async function loadActivity(db: DB, limit = 20): Promise<ActivityItem[]> {
  const [msgsRes, contactsRes, dealsRes, broadcastsRes, autoLogsRes, stageMap] =
    await Promise.all([
      db.listDocuments(DATABASE_ID, COLLECTIONS.messages, [
        Query.equal('sender_type', 'customer'),
        Query.orderDesc('created_at'),
        Query.limit(10),
      ]),
      db.listDocuments(DATABASE_ID, COLLECTIONS.contacts, [
        Query.orderDesc('created_at'),
        Query.limit(10),
      ]),
      db.listDocuments(DATABASE_ID, COLLECTIONS.deals, [
        Query.orderDesc('updated_at'),
        Query.limit(10),
      ]),
      db.listDocuments(DATABASE_ID, COLLECTIONS.broadcasts, [
        Query.orderDesc('created_at'),
        Query.limit(5),
      ]),
      db.listDocuments(DATABASE_ID, COLLECTIONS.automationLogs, [
        Query.orderDesc('created_at'),
        Query.limit(10),
      ]),
      resolveDealStages(db),
    ])

  const msgs = msgsRes.documents as unknown as Array<{
    $id: string
    content: string | null
    sender_type: string
    created_at: string
    conversation_id: string
  }>
  const contacts = contactsRes.documents as unknown as Array<{
    $id: string
    name: string | null
    phone: string
    created_at: string
  }>
  const deals = dealsRes.documents as unknown as Array<{
    $id: string
    name: string
    updated_at: string
    stage_id: string
  }>
  const broadcasts = broadcastsRes.documents as unknown as Array<{
    $id: string
    name: string
    status: string
    total_count: number
    created_at: string
  }>
  const autoLogs = autoLogsRes.documents as unknown as Array<{
    $id: string
    event: string
    status: string
    created_at: string
    automation_id: string
    contact_id: string
  }>

  const [msgContactMap, { autoMap, contactMap: logContactMap }] = await Promise.all([
    resolveMessageContacts(db, msgs),
    resolveAutomationLogRelations(db, autoLogs),
  ])

  const items: ActivityItem[] = []

  for (const m of msgs) {
    const contact = msgContactMap.get(m.conversation_id)
    const who = contact?.name || contact?.phone || 'Unknown'
    items.push({
      id: `msg-${m.$id}`,
      kind: 'message',
      text: `New message from ${who}`,
      at: m.created_at,
      href: `/inbox?c=${m.conversation_id}`,
    })
  }

  for (const c of contacts) {
    items.push({
      id: `contact-${c.$id}`,
      kind: 'contact',
      text: `New contact: ${c.name || c.phone}`,
      at: c.created_at,
      href: '/contacts',
    })
  }

  for (const d of deals) {
    const stageName = stageMap.get(d.stage_id)
    items.push({
      id: `deal-${d.$id}`,
      kind: 'deal',
      text: stageName
        ? `Deal "${d.name}" in ${stageName}`
        : `Deal "${d.name}" updated`,
      at: d.updated_at,
      href: '/pipelines',
    })
  }

  for (const b of broadcasts) {
    const label =
      b.status === 'sent'
        ? `sent to ${b.total_count} contacts`
        : `${b.status} (${b.total_count} recipients)`
    items.push({
      id: `broadcast-${b.$id}`,
      kind: 'broadcast',
      text: `Broadcast "${b.name}" ${label}`,
      at: b.created_at,
      href: '/broadcasts',
    })
  }

  for (const l of autoLogs) {
    const who = l.contact_id
      ? logContactMap.get(l.contact_id)?.name ||
        logContactMap.get(l.contact_id)?.phone ||
        'a contact'
      : 'a contact'
    const autoName = l.automation_id
      ? autoMap.get(l.automation_id) ?? 'Automation'
      : 'Automation'
    items.push({
      id: `auto-${l.$id}`,
      kind: 'automation',
      text: `Automation "${autoName}" ${l.status === 'failed' ? 'failed for' : 'triggered for'} ${who}`,
      at: l.created_at,
    })
  }

  return items
    .sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0))
    .slice(0, limit)
}
