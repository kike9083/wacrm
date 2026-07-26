/**
 * Flow runner.
 *
 * The single entry point `dispatchInboundToFlows` is called by the
 * WhatsApp webhook on every inbound message *for an account that has
 * opted into the Flows beta*. It decides whether the message belongs
 * to an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back to
 * the webhook so the webhook knows whether to also fire automations.
 *
 * Architecture in a sentence: the runner walks the customer through
 * a DB-stored node graph, suspending only at nodes that need
 * customer input. Each tap or text reply wakes it back up.
 *
 * What lives here vs elsewhere:
 *   - Pure decision logic (which button matched, where to advance to,
 *     when to fallback) — here.
 *   - DB shape (table reads/writes) — here.
 *   - Meta API calls — `meta-send.ts` (engineSendInteractive*).
 *   - Policy resolution (reprompt vs handoff vs end) — `fallback.ts`.
 *   - Type definitions — `types.ts`.
 *
 * Concurrency model:
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Optimistic UPDATE with `current_node_key` precondition: two
 *     simultaneous taps for the same run collide at the DB layer; the
 *     second is a no-op.
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT raises 23505 and the runner catches & exits.
 */

import { createAdminClient } from "@/lib/appwrite/server";
import { DATABASE_ID, COLLECTIONS } from "@/lib/appwrite/db";
import { ID, Query } from "node-appwrite";
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendText,
} from "./meta-send";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type ParsedInbound,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMessageNodeConfig,
  type SetTagNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
} from "./types";

// ============================================================
// Pure helpers — extracted so engine.test.ts can exercise them
// without a Supabase / Meta mock.
// ============================================================

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator. Stable enough that the v3 builder
 * UI can preview matches by passing canned strings.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (matchType === "exact" ? haystack === needle : haystack.includes(needle)) {
      return true;
    }
  }
  return false;
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === "start" ||
    node_type === "send_message" ||
    node_type === "condition" ||
    node_type === "set_tag"
  );
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "collect_input"
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
  }
}

// ============================================================
// DB I/O — wrapped in tiny helpers so the dispatch flow stays
// readable. Errors surface as thrown — the entry point catches.
// ============================================================

async function loadActiveRunForContact(
  userId: string,
  contactId: string,
): Promise<FlowRunRow | null> {
  const { databases } = createAdminClient();
  try {
    const result = await databases.listDocuments(
      DATABASE_ID,
      COLLECTIONS.flowRuns,
      [
        Query.equal("user_id", userId),
        Query.equal("contact_id", contactId),
        Query.equal("status", "active"),
        Query.orderDesc("started_at"),
        Query.limit(1),
      ]
    );
    return (result.documents[0] as unknown as FlowRunRow) ?? null;
  } catch (err) {
    console.error("[flows] loadActiveRunForContact error:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function loadFlow(
  flowId: string,
): Promise<FlowRow | null> {
  const { databases } = createAdminClient();
  try {
    const flow = await databases.getDocument(DATABASE_ID, COLLECTIONS.flows, flowId);
    return flow as unknown as FlowRow;
  } catch (err) {
    console.error("[flows] loadFlow error:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function loadAllNodes(
  flowId: string,
): Promise<Map<string, FlowNodeRow>> {
  const { databases } = createAdminClient();
  try {
    const result = await databases.listDocuments(
      DATABASE_ID,
      COLLECTIONS.flowNodes,
      [Query.equal("flow_id", flowId)]
    );
    const map = new Map<string, FlowNodeRow>();
    for (const row of result.documents as unknown as FlowNodeRow[]) {
      map.set(row.node_key, row);
    }
    return map;
  } catch (err) {
    console.error("[flows] loadAllNodes error:", err instanceof Error ? err.message : err);
    return new Map();
  }
}

async function logEvent(
  flowRunId: string,
  event_type:
    | "started"
    | "node_entered"
    | "message_sent"
    | "reply_received"
    | "fallback_fired"
    | "handoff"
    | "timeout"
    | "error"
    | "completed",
  node_key: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { databases } = createAdminClient();
  try {
    await databases.createDocument(
      DATABASE_ID,
      COLLECTIONS.flowRunEvents,
      ID.unique(),
      { flow_run_id: flowRunId, event_type, node_key, payload }
    );
  } catch (err) {
    console.error("[flows] logEvent error:", err instanceof Error ? err.message : err);
  }
}

async function isDuplicateInbound(
  userId: string,
  contactId: string,
  metaMessageId: string,
): Promise<boolean> {
  const { databases } = createAdminClient();
  try {
    const runsResult = await databases.listDocuments(
      DATABASE_ID,
      COLLECTIONS.flowRuns,
      [
        Query.equal("user_id", userId),
        Query.equal("contact_id", contactId),
      ]
    );
    if (!runsResult.documents.length) return false;
    const runIds = runsResult.documents.map((r) => r.$id);

    const eventsResult = await databases.listDocuments(
      DATABASE_ID,
      COLLECTIONS.flowRunEvents,
      [
        Query.equal("flow_run_id", runIds),
        Query.equal("event_type", "reply_received"),
      ]
    );
    return eventsResult.documents.some((e) => (e as any).payload?.meta_message_id === metaMessageId);
  } catch {
    return false;
  }
}

async function findEntryFlow(
  userId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
): Promise<FlowRow | null> {
  if (message.kind !== "text") return null;

  const { databases } = createAdminClient();
  try {
    const result = await databases.listDocuments(
      DATABASE_ID,
      COLLECTIONS.flows,
      [
        Query.equal("user_id", userId),
        Query.equal("status", "active"),
        Query.orderAsc("created_at"),
      ]
    );
    const flows = result.documents as unknown as FlowRow[];
    for (const flow of flows) {
      if (flow.trigger_type === "keyword") {
        if (matchesKeywordTrigger(message.text, flow.trigger_config as KeywordTriggerConfig)) {
          return flow;
        }
      } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
        return flow;
      }
    }
  } catch {
    // fall through
  }
  return null;
}

// ============================================================
// Node executors — each handles ONE node type. send_buttons and
// send_list also persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================

async function sendButtonsAndSuspend(
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  const { whatsapp_message_id } = await engineSendInteractiveButtons({
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: cfg.text,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    buttons: cfg.buttons.map((b) => ({ id: b.reply_id, title: b.title })),
  });
  await logEvent(run.id, "message_sent", node.node_key, {
    node_type: "send_buttons",
    whatsapp_message_id,
  });
  const { databases } = createAdminClient();
  try {
    const msgResult = await databases.listDocuments(
      DATABASE_ID,
      COLLECTIONS.messages,
      [Query.equal("message_id", whatsapp_message_id), Query.limit(1)]
    );
    const msgId = (msgResult.documents[0] as any)?.$id ?? null;
    await databases.updateDocument(DATABASE_ID, COLLECTIONS.flowRuns, run.id, {
      last_prompt_message_id: msgId,
    });
  } catch {
    // non-fatal
  }
  return { outcome: "advanced", node_key: node.node_key };
}

async function sendListAndSuspend(
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  const { whatsapp_message_id } = await engineSendInteractiveList({
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: cfg.text,
    buttonLabel: cfg.button_label,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    sections: cfg.sections.map((s) => ({
      title: s.title,
      rows: s.rows.map((r) => ({
        id: r.reply_id,
        title: r.title,
        description: r.description,
      })),
    })),
  });
  await logEvent(run.id, "message_sent", node.node_key, {
    node_type: "send_list",
    whatsapp_message_id,
  });
  const { databases } = createAdminClient();
  try {
    const msgResult = await databases.listDocuments(
      DATABASE_ID,
      COLLECTIONS.messages,
      [Query.equal("message_id", whatsapp_message_id), Query.limit(1)]
    );
    const msgId = (msgResult.documents[0] as any)?.$id ?? null;
    await databases.updateDocument(DATABASE_ID, COLLECTIONS.flowRuns, run.id, {
      last_prompt_message_id: msgId,
    });
  } catch {
    // non-fatal
  }
  return { outcome: "advanced", node_key: node.node_key };
}

async function executeHandoff(
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as { assign_to?: string; note?: string };
  const { databases } = createAdminClient();
  if (run.conversation_id) {
    try {
      await databases.updateDocument(DATABASE_ID, COLLECTIONS.conversations, run.conversation_id, {
        status: "pending",
        updated_at: new Date().toISOString(),
        ...(cfg.assign_to ? { assigned_agent_id: cfg.assign_to } : {}),
      });
    } catch {
      // ignore
    }
  }
  await logEvent(run.id, "handoff", node.node_key, {
    note: cfg.note ?? null,
    assigned_to: cfg.assign_to ?? null,
  });
  await endRun(run.id, "handed_off", "handoff_node");
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a Supabase mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
 *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
 *   - `contact_field` → one of name/email/phone/company on `contacts`.
 */
async function evaluateConditionNode(
  run: FlowRunRow,
  cfg: ConditionNodeConfig,
): Promise<boolean> {
  const { databases } = createAdminClient();
  let subjectValue: string | undefined;
  if (cfg.subject === "var") {
    const v = run.vars[cfg.subject_key];
    subjectValue = typeof v === "string" ? v : v === undefined ? undefined : String(v);
  } else if (cfg.subject === "tag") {
    try {
      const result = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.contactTags,
        [
          Query.equal("contact_id", run.contact_id!),
          Query.equal("tag_id", cfg.subject_key),
        ]
      );
      subjectValue = result.documents.length > 0 ? cfg.subject_key : undefined;
    } catch {
      subjectValue = undefined;
    }
  } else {
    const ALLOWED = ["name", "email", "phone", "company"] as const;
    type AllowedField = (typeof ALLOWED)[number];
    if (!ALLOWED.includes(cfg.subject_key as AllowedField)) {
      throw new Error(`unsupported contact_field: ${cfg.subject_key}`);
    }
    try {
      const contact = await databases.getDocument(DATABASE_ID, COLLECTIONS.contacts, run.contact_id!);
      const raw = (contact as any)[cfg.subject_key];
      subjectValue = typeof raw === "string" && raw.length > 0 ? raw : undefined;
    } catch {
      subjectValue = undefined;
    }
  }
  return evaluateConditionPredicate({
    operator: cfg.operator,
    subjectValue,
    configValue: cfg.value,
  });
}

function interpolateVars(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

async function endRun(
  runId: string,
  status: "completed" | "handed_off" | "timed_out" | "failed",
  reason: string,
): Promise<void> {
  const { databases } = createAdminClient();
  try {
    await databases.updateDocument(DATABASE_ID, COLLECTIONS.flowRuns, runId, {
      status,
      ended_at: new Date().toISOString(),
      end_reason: reason,
    });
  } catch {
    // ignore
  }
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (send_buttons/send_list) or
// terminates (handoff/end). Each suspending node persists the
// new current_node_key before returning.
// ============================================================

async function advanceFromNodeKey(
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  const { databases } = createAdminClient();
  let currentKey: string | null = startNodeKey;
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logEvent(run.id, "error", null, {
        reason: "next_node_key was null mid-advance",
      });
      await endRun(run.id, "failed", "missing_next_node");
      return { outcome: "completed" };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(run.id, "error", currentKey, {
        reason: "node_not_found",
      });
      await endRun(run.id, "failed", "node_not_found");
      return { outcome: "completed" };
    }
    await logEvent(run.id, "node_entered", node.node_key, {
      node_type: node.node_type,
    });

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars),
        });
        await logEvent(run.id, "message_sent", node.node_key, {
          node_type: "send_message",
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "send_text_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(run.id, "failed", "send_text_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "collect_input") {
      const cfg = node.config as unknown as CollectInputNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
        await logEvent(run.id, "message_sent", node.node_key, {
          node_type: "collect_input",
          whatsapp_message_id,
        });
        try {
          const msgResult = await databases.listDocuments(
            DATABASE_ID, COLLECTIONS.messages,
            [Query.equal("message_id", whatsapp_message_id), Query.limit(1)]
          );
          const msgId = (msgResult.documents[0] as any)?.$id ?? null;
          await databases.updateDocument(DATABASE_ID, COLLECTIONS.flowRuns, run.id, {
            last_prompt_message_id: msgId,
          });
        } catch {
          // non-fatal
        }
      } catch (err) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "collect_input_prompt_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(run.id, "failed", "collect_input_prompt_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: "true" | "false";
      try {
        branch = (await evaluateConditionNode(run, cfg))
          ? "true"
          : "false";
      } catch (err) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "condition_evaluation_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(run.id, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      currentKey =
        branch === "true" ? cfg.true_next : cfg.false_next;
      await logEvent(run.id, "node_entered", node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        if (cfg.mode === "add") {
          await databases.createDocument(
            DATABASE_ID, COLLECTIONS.contactTags, ID.unique(),
            { contact_id: run.contact_id!, tag_id: cfg.tag_id }
          );
        } else {
          const existingTags = await databases.listDocuments(
            DATABASE_ID, COLLECTIONS.contactTags,
            [Query.equal("contact_id", run.contact_id!), Query.equal("tag_id", cfg.tag_id)]
          );
          for (const doc of existingTags.documents) {
            await databases.deleteDocument(DATABASE_ID, COLLECTIONS.contactTags, doc.$id);
          }
        }
      } catch (err) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "set_tag_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_buttons") {
      await sendButtonsAndSuspend(run, node);
      const advanced = await advanceCurrentNodeKey(
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_list") {
      await sendListAndSuspend(run, node);
      const advanced = await advanceCurrentNodeKey(
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "handoff") {
      await executeHandoff(run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "end") {
      await logEvent(run.id, "completed", node.node_key);
      await endRun(run.id, "completed", "end_node");
      return { outcome: "completed" };
    }
    await logEvent(run.id, "error", node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(run.id, "failed", "unknown_node_type");
    return { outcome: "completed" };
  }
  await logEvent(run.id, "error", currentKey, {
    reason: "advance_loop_safety_break",
  });
  await endRun(run.id, "failed", "advance_loop_overflow");
  return { outcome: "completed" };
}

async function advanceCurrentNodeKey(
  runId: string,
  expectedOldKey: string | null,
  newKey: string,
): Promise<boolean> {
  const { databases } = createAdminClient();
  try {
    const run = await databases.getDocument(DATABASE_ID, COLLECTIONS.flowRuns, runId);
    if ((run as any).status !== "active") return false;
    if (expectedOldKey === null && (run as any).current_node_key !== null) return false;
    if (expectedOldKey !== null && (run as any).current_node_key !== expectedOldKey) return false;
    await databases.updateDocument(DATABASE_ID, COLLECTIONS.flowRuns, runId, {
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    console.error("[flows] advanceCurrentNodeKey error:", err instanceof Error ? err.message : err);
    return false;
  }
}

// ============================================================
// Public entry point — the webhook calls this on every inbound.
// ============================================================

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean },
): Promise<DispatchInboundResult> {
  try {
    const activeRun = await loadActiveRunForContact(
      input.userId,
      input.contactId,
    );

    if (activeRun) {
      const dupe = await isDuplicateInbound(
        input.userId,
        input.contactId,
        input.message.meta_message_id,
      );
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "duplicate_inbound_ignored",
        };
      }
      const nodes = await loadAllNodes(activeRun.flow_id);
      return handleReplyForActiveRun(activeRun, input.message, nodes);
    }

    const flow = await findEntryFlow(
      input.userId,
      input.message,
      input.isFirstInboundMessage,
    );
    if (!flow || !flow.entry_node_id) {
      return { consumed: false, outcome: "no_match" };
    }
    const nodes = await loadAllNodes(flow.id);
    return startNewRun(flow, input, nodes);
  } catch (err) {
    console.error(
      "[flows] dispatchInboundToFlows threw:",
      err instanceof Error ? err.message : err,
    );
    return { consumed: false, outcome: "no_match" };
  }
}

async function handleReplyForActiveRun(
  run: FlowRunRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // Note: we intentionally do NOT persist the raw customer text. A
  // `collect_input` prompt that asks "what's your card number?" would
  // otherwise leave the PAN sitting in flow_run_events.payload forever,
  // visible to anyone with access to the runs viewer or the events
  // table. Length is enough for "did they actually reply?" debugging;
  // for the captured value itself, the `node_entered` event already
  // records `captured_key` + `captured_length` after the var is stored.
  await logEvent(run.id, "reply_received", run.current_node_key, {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
    text_length: message.kind === "text" ? message.text.length : null,
  });

  if (!run.current_node_key) {
    await endRun(run.id, "failed", "active_run_missing_current_node");
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: "no_match",
    };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    await endRun(run.id, "failed", "current_node_not_found");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  // Two ways a reply can advance:
  //   1. Interactive button/list tap on a send_buttons/send_list node.
  //   2. Text reply on a collect_input node — capture into vars.
  //
  // Everything else falls through to the fallback policy below.
  let matched: string | null = null;
  if (
    message.kind === "interactive_reply" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
    matched = matchReplyId(currentNode, message.reply_id);
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "collect_input"
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = message.text.trim();
    if (captured.length > 0 && cfg.var_key) {
      const newVars = { ...run.vars, [cfg.var_key]: captured };
      const { databases } = createAdminClient();
      try {
        await databases.updateDocument(DATABASE_ID, COLLECTIONS.flowRuns, run.id, {
          vars: newVars,
          reprompt_count: 0,
        });
        run.vars = newVars;
        run.reprompt_count = 0;
        await logEvent(run.id, "node_entered", currentNode.node_key, {
          captured_key: cfg.var_key,
          captured_length: captured.length,
        });
        matched = cfg.next_node_key;
      } catch {
        // capture failed
      }
    }
  }

  if (matched) {
    if (run.reprompt_count !== 0) {
      const { databases } = createAdminClient();
      try {
        await databases.updateDocument(DATABASE_ID, COLLECTIONS.flowRuns, run.id, { reprompt_count: 0 });
        run.reprompt_count = 0;
      } catch {
        // ignore
      }
    }
    const outcome = await advanceFromNodeKey(run, matched, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  const policy = resolveFallbackPolicy(
    (await loadFlow(run.flow_id))?.fallback_policy,
  );
  const newReprompts = run.reprompt_count + 1;
  const { databases } = createAdminClient();
  try {
    await databases.updateDocument(DATABASE_ID, COLLECTIONS.flowRuns, run.id, { reprompt_count: newReprompts });
  } catch {
    // ignore
  }

  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await logEvent(run.id, "fallback_fired", run.current_node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === "ignore") {
    return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  }
  if (action.type === "reprompt") {
    if (currentNode.node_type === "send_buttons") {
      await sendButtonsAndSuspend(run, currentNode);
    } else if (currentNode.node_type === "send_list") {
      await sendListAndSuspend(run, currentNode);
    } else if (currentNode.node_type === "collect_input") {
      const cfg = currentNode.config as unknown as CollectInputNodeConfig;
      try {
        await engineSendText({
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
      } catch (err) {
        await logEvent(run.id, "error", currentNode.node_key, {
          reason: "reprompt_send_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") {
    const { databases: db2 } = createAdminClient();
    if (run.conversation_id) {
      try {
        await db2.updateDocument(DATABASE_ID, COLLECTIONS.conversations, run.conversation_id, {
          status: "pending", updated_at: new Date().toISOString(),
        });
      } catch {
        // ignore
      }
    }
    await logEvent(run.id, "handoff", run.current_node_key, {
      reason: "fallback_exhausted",
    });
    await endRun(run.id, "handed_off", "fallback_exhausted");
    return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
  }
  await endRun(run.id, "completed", "fallback_exhausted_end");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

async function startNewRun(
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  const { databases } = createAdminClient();
  let run: FlowRunRow;
  try {
    const inserted = await databases.createDocument(
      DATABASE_ID,
      COLLECTIONS.flowRuns,
      ID.unique(),
      {
        flow_id: flow.id,
        user_id: flow.user_id,
        contact_id: input.contactId,
        conversation_id: input.conversationId,
        status: "active",
        current_node_key: flow.entry_node_id,
      }
    );
    run = inserted as unknown as FlowRunRow;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("unique") || msg.includes("duplicate")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error("[flows] startNewRun insert error:", msg);
    return { consumed: false, outcome: "no_match" };
  }

  await logEvent(run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
  });

  const outcome = await advanceFromNodeKey(run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}
