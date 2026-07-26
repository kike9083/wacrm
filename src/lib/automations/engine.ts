import type {
  Automation,
  AutomationLogStepResult,
  AutomationStep,
  AutomationTriggerType,
  ConditionStepConfig,
  KeywordMatchTriggerConfig,
  SendMessageStepConfig,
  SendTemplateStepConfig,
  SendWebhookStepConfig,
  TagStepConfig,
  UpdateContactFieldStepConfig,
  WaitStepConfig,
  CreateDealStepConfig,
  AssignConversationStepConfig,
} from '@/types'
import { createAdminClient } from '@/lib/appwrite/server'
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db'
import { ID, Query } from 'node-appwrite'
import { engineSendText, engineSendTemplate } from './meta-send'

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export interface AutomationContext {
  /** Raw message text, for keyword_match + message_content conditions. */
  message_text?: string
  /** Conversation the event belongs to, if any. */
  conversation_id?: string
  /** Arbitrary variables accumulated during execution. */
  vars?: Record<string, unknown>
  /** The tag id that was added, for tag_added trigger. */
  tag_id?: string
  /** Agent the conversation was assigned to, for conversation_assigned. */
  agent_id?: string
}

export interface DispatchInput {
  userId: string
  triggerType: AutomationTriggerType
  contactId?: string | null
  context?: AutomationContext
}

/**
 * Fire all active automations matching the given trigger for a user.
 *
 * Must never throw — callers use fire-and-forget from the webhook.
 * All errors are caught and logged; per-automation failures are
 * recorded into automation_logs with status='failed'.
 */
export async function runAutomationsForTrigger(input: DispatchInput): Promise<void> {
  try {
    const { databases } = createAdminClient()
    const result = await databases.listDocuments(
      DATABASE_ID,
      COLLECTIONS.automations,
      [
        Query.equal('user_id', input.userId),
        Query.equal('trigger_type', input.triggerType),
        Query.equal('is_active', true),
      ]
    )
    const automations = result.documents as unknown as Automation[]

    if (!automations || automations.length === 0) return

    for (const automation of automations) {
      if (!triggerMatches(automation, input.context)) continue
      try {
        await executeAutomation(automation, input)
      } catch (err) {
        console.error('[automations] execute failed:', automation.id, err)
      }
    }
  } catch (err) {
    console.error('[automations] dispatch failed:', err)
  }
}

/**
 * Resume a run that was parked at a wait step. Called from the cron
 * endpoint after it grabs a due `automation_pending_executions` row.
 */
export async function resumePendingExecution(pending: {
  id: string
  automation_id: string
  user_id: string
  contact_id: string | null
  log_id: string | null
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  next_step_position: number
  context: AutomationContext
}): Promise<void> {
  const { databases } = createAdminClient()
  let automation
  try {
    automation = await databases.getDocument(DATABASE_ID, COLLECTIONS.automations, pending.automation_id)
  } catch (err) {
    console.error('[automations] resume: missing automation', pending.automation_id, err)
    await markPending(pending.id, 'failed')
    return
  }

  try {
    await executeStepsFrom({
      automation: automation as unknown as Automation,
      contactId: pending.contact_id,
      context: pending.context ?? {},
      parentStepId: pending.parent_step_id,
      branch: pending.branch,
      startPosition: pending.next_step_position,
      logId: pending.log_id,
      triggerEvent: 'resumed_wait',
    })
    await markPending(pending.id, 'done')
  } catch (err) {
    console.error('[automations] resume failed:', err)
    await markPending(pending.id, 'failed')
  }
}

// ------------------------------------------------------------
// Internal execution
// ------------------------------------------------------------

async function executeAutomation(automation: Automation, input: DispatchInput) {
  const { databases } = createAdminClient()

  let log
  try {
    log = await databases.createDocument(
      DATABASE_ID,
      COLLECTIONS.automationLogs,
      ID.unique(),
      {
        automation_id: automation.id,
        user_id: automation.user_id,
        contact_id: input.contactId ?? null,
        trigger_event: input.triggerType,
        steps_executed: [],
        status: 'success',
      }
    )
  } catch (err) {
    console.error('[automations] cannot create log:', err)
    return
  }

  await executeStepsFrom({
    automation,
    contactId: input.contactId ?? null,
    context: input.context ?? {},
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: log.$id,
    triggerEvent: input.triggerType,
  })
}

interface ExecuteArgs {
  automation: Automation
  contactId: string | null
  context: AutomationContext
  parentStepId: string | null
  branch: 'yes' | 'no' | null
  startPosition: number
  logId: string | null
  triggerEvent: string
}

async function executeStepsFrom(args: ExecuteArgs): Promise<void> {
  const { databases } = createAdminClient()

  let steps
  try {
    const queries = [
      Query.equal('automation_id', args.automation.id),
      Query.greaterThanEqual('position', args.startPosition),
      Query.orderAsc('position'),
    ]
    if (args.parentStepId === null) {
      queries.push(Query.isNull('parent_step_id'))
    } else {
      queries.push(Query.equal('parent_step_id', args.parentStepId))
      queries.push(Query.equal('branch', args.branch ?? 'yes'))
    }
    const result = await databases.listDocuments(
      DATABASE_ID,
      COLLECTIONS.automationSteps,
      queries
    )
    steps = result.documents
  } catch (err) {
    await finalizeLog(args.logId, 'failed', err instanceof Error ? err.message : 'fetch failed')
    return
  }

  if (!steps || steps.length === 0) {
    if (args.parentStepId === null && args.logId) {
      await finalizeLog(args.logId, 'success', null)
    }
    return
  }

  const results: AutomationLogStepResult[] = []
  let status: 'success' | 'partial' | 'failed' = 'success'
  let errorMessage: string | null = null

  for (const step of steps as unknown as AutomationStep[]) {
    if (step.step_type === 'wait') {
      const cfg = step.step_config as WaitStepConfig
      const ms = waitMs(cfg)
      await databases.createDocument(
        DATABASE_ID,
        COLLECTIONS.automationPendingExecutions,
        ID.unique(),
        {
          automation_id: args.automation.id,
          user_id: args.automation.user_id,
          contact_id: args.contactId,
          log_id: args.logId,
          parent_step_id: args.parentStepId,
          branch: args.branch,
          next_step_position: step.position + 1,
          context: args.context,
          run_at: new Date(Date.now() + ms).toISOString(),
          status: 'pending',
        }
      )
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail: `waiting ${cfg.amount} ${cfg.unit}`,
      })
      status = 'partial'
      await appendResults(args.logId, results, status, errorMessage)
      return
    }

    try {
      if (step.step_type === 'condition') {
        const cfg = step.step_config as ConditionStepConfig
        const taken = await evaluateCondition(cfg, args)
        results.push({
          step_id: step.id,
          step_type: 'condition',
          status: 'success',
          detail: `branch=${taken ? 'yes' : 'no'}`,
        })
        // Recurse into the chosen branch at position 0 (children use their
        // own ordering within the branch scope).
        await executeStepsFrom({
          ...args,
          parentStepId: step.id,
          branch: taken ? 'yes' : 'no',
          startPosition: 0,
          logId: args.logId,
        })
        continue
      }

      const detail = await runStep(step, args)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'failed',
        detail: msg,
      })
      status = 'failed'
      errorMessage = msg
      break
    }
  }

  if (args.parentStepId === null) {
    await appendResults(args.logId, results, status, errorMessage)
  } else {
    // Nested branch — just append results; parent scope decides final status.
    await appendResults(args.logId, results, null, errorMessage)
  }
}

async function runStep(step: AutomationStep, args: ExecuteArgs): Promise<string> {
  const { databases } = createAdminClient()

  switch (step.step_type) {
    case 'send_message': {
      const cfg = step.step_config as SendMessageStepConfig
      if (!args.contactId) throw new Error('send_message needs a contact')
      const text = interpolate(cfg.text, args)
      if (!text.trim()) throw new Error('send_message has empty text')
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendText({
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        text,
      })
      return `sent via Meta (${whatsapp_message_id})`
    }

    case 'send_template': {
      const cfg = step.step_config as SendTemplateStepConfig
      if (!args.contactId) throw new Error('send_template needs a contact')
      if (!cfg.template_name) throw new Error('send_template needs template_name')
      const conversationId = await resolveConversationId(args)
      const params = cfg.variables
        ? Object.keys(cfg.variables)
            .sort((a, b) => {
              const na = Number(a)
              const nb = Number(b)
              const aNum = Number.isFinite(na)
              const bNum = Number.isFinite(nb)
              if (aNum && bNum) return na - nb
              if (aNum) return -1
              if (bNum) return 1
              return a.localeCompare(b)
            })
            .map((k) => String(cfg.variables![k]))
        : []
      const { whatsapp_message_id } = await engineSendTemplate({
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        templateName: cfg.template_name,
        language: cfg.language,
        params,
      })
      return `template sent via Meta (${whatsapp_message_id})`
    }

    case 'add_tag': {
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('add_tag needs contact + tag_id')
      try {
        const existing = await databases.listDocuments(
          DATABASE_ID,
          COLLECTIONS.contactTags,
          [
            Query.equal('contact_id', args.contactId),
            Query.equal('tag_id', cfg.tag_id),
          ]
        )
        if (existing.documents.length === 0) {
          await databases.createDocument(
            DATABASE_ID,
            COLLECTIONS.contactTags,
            ID.unique(),
            { contact_id: args.contactId, tag_id: cfg.tag_id }
          )
        }
      } catch {
        // ignore upsert errors
      }
      return `tag ${cfg.tag_id} added`
    }

    case 'remove_tag': {
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('remove_tag needs contact + tag_id')
      try {
        const existing = await databases.listDocuments(
          DATABASE_ID,
          COLLECTIONS.contactTags,
          [
            Query.equal('contact_id', args.contactId),
            Query.equal('tag_id', cfg.tag_id),
          ]
        )
        for (const doc of existing.documents) {
          await databases.deleteDocument(DATABASE_ID, COLLECTIONS.contactTags, doc.$id)
        }
      } catch {
        // ignore delete errors
      }
      return `tag ${cfg.tag_id} removed`
    }

    case 'assign_conversation': {
      const cfg = step.step_config as AssignConversationStepConfig
      if (!args.contactId) throw new Error('assign_conversation needs a contact')
      let agentId = cfg.agent_id
      if (cfg.mode === 'round_robin') {
        try {
          const profilesResult = await databases.listDocuments(
            DATABASE_ID,
            COLLECTIONS.profiles,
            [Query.equal('user_id', args.automation.user_id), Query.limit(1)]
          )
          agentId = (profilesResult.documents[0] as any)?.user_id
        } catch {
          agentId = undefined
        }
      }
      if (!agentId) return 'no agent resolved'
      try {
        const conversations = await databases.listDocuments(
          DATABASE_ID,
          COLLECTIONS.conversations,
          [
            Query.equal('user_id', args.automation.user_id),
            Query.equal('contact_id', args.contactId),
          ]
        )
        for (const conv of conversations.documents) {
          await databases.updateDocument(
            DATABASE_ID,
            COLLECTIONS.conversations,
            conv.$id,
            { assigned_agent_id: agentId }
          )
        }
      } catch {
        // ignore
      }
      return `assigned to ${agentId}`
    }

    case 'update_contact_field': {
      const cfg = step.step_config as UpdateContactFieldStepConfig
      if (!args.contactId) throw new Error('update_contact_field needs a contact')
      const allowed = new Set(['name', 'email', 'company'])
      if (!allowed.has(cfg.field)) {
        return `field ${cfg.field} not writable from automations`
      }
      await databases.updateDocument(
        DATABASE_ID,
        COLLECTIONS.contacts,
        args.contactId,
        { [cfg.field]: cfg.value, updated_at: new Date().toISOString() }
      )
      return `${cfg.field} updated`
    }

    case 'create_deal': {
      const cfg = step.step_config as CreateDealStepConfig
      if (!cfg.pipeline_id || !cfg.stage_id) throw new Error('create_deal needs pipeline + stage')
      await databases.createDocument(
        DATABASE_ID,
        COLLECTIONS.deals,
        ID.unique(),
        {
          user_id: args.automation.user_id,
          pipeline_id: cfg.pipeline_id,
          stage_id: cfg.stage_id,
          contact_id: args.contactId,
          title: interpolate(cfg.title, args),
          value: cfg.value ?? 0,
          status: 'open',
        }
      )
      return 'deal created'
    }

    case 'send_webhook': {
      const cfg = step.step_config as SendWebhookStepConfig
      if (!cfg.url) throw new Error('send_webhook needs url')
      const body = cfg.body_template ? interpolate(cfg.body_template, args) : JSON.stringify(args.context)
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
        body,
      })
      if (!res.ok) throw new Error(`webhook returned ${res.status}`)
      return `webhook ${res.status}`
    }

    case 'close_conversation': {
      if (!args.contactId) throw new Error('close_conversation needs a contact')
      try {
        const conversations = await databases.listDocuments(
          DATABASE_ID,
          COLLECTIONS.conversations,
          [
            Query.equal('user_id', args.automation.user_id),
            Query.equal('contact_id', args.contactId),
          ]
        )
        for (const conv of conversations.documents) {
          await databases.updateDocument(
            DATABASE_ID,
            COLLECTIONS.conversations,
            conv.$id,
            { status: 'closed', updated_at: new Date().toISOString() }
          )
        }
      } catch {
        // ignore
      }
      return 'conversation closed'
    }

    default:
      return `unknown step: ${step.step_type}`
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Pick the conversation a send-type step should use. Prefer the id the
 * webhook handed us (it's the one that just got the inbound message);
 * fall back to the contact's conversation for resumed/wait paths and
 * manual engine POSTs. Throws if none exists — send steps have
 * no meaningful target without a conversation.
 */
async function resolveConversationId(args: ExecuteArgs): Promise<string> {
  const fromCtx = args.context.conversation_id
  if (fromCtx) return fromCtx
  if (!args.contactId) throw new Error('cannot resolve conversation: no contact')
  const { databases } = createAdminClient()
  try {
    const result = await databases.listDocuments(
      DATABASE_ID,
      COLLECTIONS.conversations,
      [
        Query.equal('user_id', args.automation.user_id),
        Query.equal('contact_id', args.contactId),
        Query.limit(1),
      ]
    )
    if (!result.documents[0]?.$id) throw new Error('no conversation for contact')
    return result.documents[0].$id
  } catch (err) {
    throw new Error(`conversation lookup failed: ${err instanceof Error ? err.message : 'unknown'}`)
  }
}

function triggerMatches(automation: Automation, ctx: AutomationContext | undefined): boolean {
  if (automation.trigger_type !== 'keyword_match') return true
  const cfg = automation.trigger_config as KeywordMatchTriggerConfig
  if (!cfg?.keywords || cfg.keywords.length === 0) return false
  const text = (ctx?.message_text ?? '').toString()
  if (!text) return false
  const haystack = cfg.case_sensitive ? text : text.toLowerCase()
  return cfg.keywords.some((raw) => {
    const k = cfg.case_sensitive ? raw : raw.toLowerCase()
    return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k)
  })
}

async function evaluateCondition(cfg: ConditionStepConfig, args: ExecuteArgs): Promise<boolean> {
  const { databases } = createAdminClient()
  switch (cfg.subject) {
    case 'tag_presence': {
      if (!args.contactId || !cfg.operand) return false
      try {
        const result = await databases.listDocuments(
          DATABASE_ID,
          COLLECTIONS.contactTags,
          [
            Query.equal('contact_id', args.contactId),
            Query.equal('tag_id', cfg.operand),
          ]
        )
        return result.documents.length > 0
      } catch {
        return false
      }
    }
    case 'contact_field': {
      if (!args.contactId || !cfg.operand) return false
      try {
        const contact = await databases.getDocument(DATABASE_ID, COLLECTIONS.contacts, args.contactId)
        const v = (contact as any)[cfg.operand]
        return v != null && String(v) === String(cfg.value ?? '')
      } catch {
        return false
      }
    }
    case 'message_content': {
      const text = (args.context.message_text ?? '').toString()
      return text.toLowerCase().includes((cfg.value ?? '').toLowerCase())
    }
    case 'time_of_day': {
      const [from, to] = (cfg.operand ?? '').split('-')
      if (!from || !to) return false
      const now = new Date()
      const mins = now.getHours() * 60 + now.getMinutes()
      const parse = (s: string) => {
        const [h, m] = s.split(':').map(Number)
        return (h || 0) * 60 + (m || 0)
      }
      const f = parse(from)
      const t = parse(to)
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t
    }
    default:
      return false
  }
}

function waitMs(cfg: WaitStepConfig): number {
  const unitMs = cfg.unit === 'days' ? 86_400_000 : cfg.unit === 'hours' ? 3_600_000 : 60_000
  return Math.max(1_000, cfg.amount * unitMs)
}

function interpolate(s: string, args: ExecuteArgs): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.')
    if (ns === 'message' && prop === 'text') return String(args.context.message_text ?? '')
    if (ns === 'vars' && prop) return String(args.context.vars?.[prop] ?? '')
    return ''
  })
}

async function appendResults(
  logId: string | null,
  newItems: AutomationLogStepResult[],
  status: 'success' | 'partial' | 'failed' | null,
  errorMessage: string | null,
) {
  if (!logId) return
  const { databases } = createAdminClient()
  try {
    const log = await databases.getDocument(DATABASE_ID, COLLECTIONS.automationLogs, logId)
    const existingSteps = (log as any).steps_executed as AutomationLogStepResult[] | undefined
    const merged = [...(existingSteps ?? []), ...newItems]
    const update: Record<string, unknown> = { steps_executed: merged }
    if (status !== null) update.status = status
    if (errorMessage) update.error_message = errorMessage
    await databases.updateDocument(DATABASE_ID, COLLECTIONS.automationLogs, logId, update)
  } catch {
    // ignore append errors
  }
}

async function finalizeLog(
  logId: string | null,
  status: 'success' | 'partial' | 'failed',
  errorMessage: string | null,
) {
  if (!logId) return
  const { databases } = createAdminClient()
  try {
    await databases.updateDocument(DATABASE_ID, COLLECTIONS.automationLogs, logId, {
      status,
      error_message: errorMessage,
    })
  } catch {
    // ignore finalize errors
  }
}

async function markPending(id: string, status: 'done' | 'failed') {
  const { databases } = createAdminClient()
  try {
    await databases.updateDocument(DATABASE_ID, COLLECTIONS.automationPendingExecutions, id, { status })
  } catch {
    // ignore
  }
}
