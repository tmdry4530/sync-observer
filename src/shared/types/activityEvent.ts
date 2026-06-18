/**
 * Frontend mirror of server/src/collector/activityEvent.ts (the zod authority).
 * DO NOT import server code — this is the canonical frontend copy.
 *
 * Canonical contract for the SyncSpace activity / monitor event stream:
 * one normalized event = one hermes tool-call lifecycle point (started →
 * success|error) or one intervention (blocked|cancelled). The hermes plugin
 * (hermes-plugin/syncspace_monitor/events.py) emits exactly this shape.
 * See docs/PIVOT_DIRECTION.md §3.
 */

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

export const ACTIVITY_STATUSES = ['started', 'success', 'error', 'blocked', 'cancelled'] as const
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number]

export const ACTIVITY_AGENT_KINDS = ['hermes'] as const
export type ActivityAgentKind = (typeof ACTIVITY_AGENT_KINDS)[number]

export const INTERVENTION_MODES = ['block', 'interrupt', 'kill'] as const
export type InterventionMode = (typeof INTERVENTION_MODES)[number]

export const INTERVENTION_TRIGGERS = ['auto', 'manual'] as const
export type InterventionTrigger = (typeof INTERVENTION_TRIGGERS)[number]

export interface InterventionDetail {
  ruleId: string
  mode: InterventionMode
  trigger: InterventionTrigger
  message?: string
}

export interface ActivityEvent {
  v: 1
  eventId: string
  ts: string
  agentId: string
  agentKind: ActivityAgentKind
  sessionId: string | null
  taskId: string | null
  turnId: string | null
  action: ActivityAction
  tool: string
  paths: string[]
  status: ActivityStatus
  cwd: string | null
  gitBranch: string | null
  correlationId: string | null
  summary: string | null
  detail: Record<string, unknown> | null
  visibleToUser: boolean
}

export function isActivityAction(v: string): v is ActivityAction {
  return (ACTIVITY_ACTIONS as readonly string[]).includes(v)
}

export function isActivityStatus(v: string): v is ActivityStatus {
  return (ACTIVITY_STATUSES as readonly string[]).includes(v)
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string'
}

/**
 * Safely parse an unknown payload as an ActivityEvent (mirror of the server's
 * zod validation, kept lenient so one malformed row never crashes a view).
 * Returns null if a required field is missing or mistyped.
 */
export function parseActivityEvent(value: unknown): ActivityEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  if (o.v !== 1) return null
  if (typeof o.eventId !== 'string' || o.eventId.length === 0) return null
  if (typeof o.ts !== 'string' || o.ts.length === 0) return null
  if (typeof o.agentId !== 'string' || o.agentId.length === 0) return null
  if (o.agentKind !== 'hermes') return null
  if (!isStringOrNull(o.sessionId)) return null
  if (!isStringOrNull(o.taskId)) return null
  if (!isStringOrNull(o.turnId)) return null
  if (typeof o.action !== 'string' || !isActivityAction(o.action)) return null
  if (typeof o.tool !== 'string') return null
  if (!Array.isArray(o.paths) || !o.paths.every((p) => typeof p === 'string')) return null
  if (typeof o.status !== 'string' || !isActivityStatus(o.status)) return null
  if (!isStringOrNull(o.cwd)) return null
  if (!isStringOrNull(o.gitBranch)) return null
  if (!isStringOrNull(o.correlationId)) return null
  if (!isStringOrNull(o.summary)) return null
  if (o.detail !== null && (typeof o.detail !== 'object' || Array.isArray(o.detail))) return null
  if (typeof o.visibleToUser !== 'boolean') return null
  return o as unknown as ActivityEvent
}

/** Extract the intervention record from an event, if it is an intervention. */
export function getIntervention(event: ActivityEvent): InterventionDetail | null {
  const raw = event.detail?.intervention as Record<string, unknown> | undefined
  if (raw == null || typeof raw !== 'object') return null
  const { ruleId, mode, trigger, message } = raw as Record<string, unknown>
  if (typeof ruleId !== 'string') return null
  if (typeof mode !== 'string' || !(INTERVENTION_MODES as readonly string[]).includes(mode)) return null
  if (typeof trigger !== 'string' || !(INTERVENTION_TRIGGERS as readonly string[]).includes(trigger))
    return null
  const detail: InterventionDetail = {
    ruleId,
    mode: mode as InterventionMode,
    trigger: trigger as InterventionTrigger
  }
  if (typeof message === 'string') detail.message = message
  return detail
}
