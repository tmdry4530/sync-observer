import { z } from 'zod'

/**
 * Canonical contract for the SyncSpace activity / monitor event stream.
 *
 * This zod schema is the AUTHORITY. Three things must agree with it:
 *   1. the hermes plugin emit shape — hermes-plugin/syncspace_monitor/events.py build_event()
 *   2. the collector ingest validator — uses this schema on POST /ingest/events
 *   3. the frontend mirror — src/shared/types/activityEvent.ts (manual parser, no zod)
 *
 * One normalized event = one tool-call lifecycle point (started → success|error)
 * or one intervention (blocked|cancelled). See docs/PIVOT_DIRECTION.md §3 and
 * docs/HERMES_OPERATION.md ② for how the hermes pre/post_tool_call hooks map here.
 */

// ---------- Enums (kept in lockstep with the frontend mirror) ----------

/** Normalized verb. hermes tool → action: read_file→read, write_file→write,
 *  patch→edit, search_files→grep|glob, terminal→bash, delegate_task→task. */
export const ACTIVITY_ACTIONS = [
  'read',
  'edit',
  'write',
  'grep',
  'glob',
  'bash',
  'search',
  'task',
  'other'
] as const
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number]

/** Tool-call lifecycle / intervention outcome.
 *  started = pre_tool_call; success|error = post_tool_call;
 *  blocked = pre-block rule veto; cancelled = interrupt. */
export const ACTIVITY_STATUSES = ['started', 'success', 'error', 'blocked', 'cancelled'] as const
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number]

/** hermes-only for now; widened only if more adapters are ever added. */
export const ACTIVITY_AGENT_KINDS = ['hermes'] as const
export type ActivityAgentKind = (typeof ACTIVITY_AGENT_KINDS)[number]

/** How a human may control an agent (ADR-012). block = pre-execution veto
 *  (file tools), interrupt = stop the current turn, kill = process/sandbox. */
export const INTERVENTION_MODES = ['block', 'interrupt', 'kill'] as const
export type InterventionMode = (typeof INTERVENTION_MODES)[number]

export const INTERVENTION_TRIGGERS = ['auto', 'manual'] as const
export type InterventionTrigger = (typeof INTERVENTION_TRIGGERS)[number]

// ---------- Intervention detail (carried inside `detail.intervention`) ----------

export const InterventionDetailSchema = z.object({
  ruleId: z.string(),
  mode: z.enum(INTERVENTION_MODES),
  trigger: z.enum(INTERVENTION_TRIGGERS),
  message: z.string().optional()
})
export type InterventionDetail = z.infer<typeof InterventionDetailSchema>

// ---------- The event ----------

export const ActivityEventSchema = z.object({
  /** Schema version. Bump on breaking change. */
  v: z.literal(1),
  /** Globally unique id. at-least-once dedup key (UNIQUE in sqlite). */
  eventId: z.string().min(1),
  /** Source occurrence time (ISO-8601, ms). NOT ingest time. */
  ts: z.string().min(1),
  /** Stable emitting agent id, e.g. `hermes:<disambiguator>`. Drives per-agent lanes. */
  agentId: z.string().min(1),
  agentKind: z.enum(ACTIVITY_AGENT_KINDS),
  /** Source session id (hermes session_id). */
  sessionId: z.string().nullable(),
  /** Sub-task unit (subagent / delegate_task). null when absent. */
  taskId: z.string().nullable(),
  /** Turn id within a session. */
  turnId: z.string().nullable(),
  action: z.enum(ACTIVITY_ACTIONS),
  /** Raw source tool name (provenance): read_file, terminal, ... */
  tool: z.string(),
  /** Absolute (realpath-normalized) paths this action touched. Product centerpiece. */
  paths: z.array(z.string()),
  status: z.enum(ACTIVITY_STATUSES),
  /** Working directory at action time. */
  cwd: z.string().nullable(),
  gitBranch: z.string().nullable(),
  /** Pairs started↔success/error (= hermes tool_call_id). */
  correlationId: z.string().nullable(),
  /** Short human label ("read config.ts"). */
  summary: z.string().nullable(),
  /** Action-specific extras; intervention metadata lives under detail.intervention. */
  detail: z.record(z.string(), z.unknown()).nullable(),
  /** Spectator visibility gate. */
  visibleToUser: z.boolean().default(true)
})

export type ActivityEvent = z.infer<typeof ActivityEventSchema>

/** Validate an unknown ingest payload. Returns null on any schema violation. */
export function parseActivityEvent(value: unknown): ActivityEvent | null {
  const result = ActivityEventSchema.safeParse(value)
  return result.success ? result.data : null
}

/** Batch variant for POST /ingest/events (single or array accepted). */
export const ActivityEventBatchSchema = z.union([
  ActivityEventSchema,
  z.array(ActivityEventSchema).max(1000)
])

/** Extract the intervention record from an event, if this is an intervention. */
export function getIntervention(event: ActivityEvent): InterventionDetail | null {
  const raw = event.detail?.intervention
  if (raw == null) return null
  const parsed = InterventionDetailSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
