import { readClientEnv } from '../../shared/types/env'
import { parseActivityEvent, type ActivityEvent } from '../../shared/types/activityEvent'

/**
 * Thin client for the local hermes-monitor collector (M2 §4).
 *
 * The collector is loopback-only and the dashboard talks to it cross-origin
 * (Vite :5173 → collector :8787, allowed via CORS). State-changing /control/*
 * calls must carry the X-SyncSpace-Local header (a cross-site form cannot set
 * it — CSRF defense the collector enforces).
 */

/** Custom header the collector requires on every /control/* mutation. */
export const LOCAL_HEADER = 'X-SyncSpace-Local'

export function collectorBase(): string {
  return readClientEnv().collectorUrl
}

export interface EventsPage {
  events: ActivityEvent[]
  latestSeq: number
}

/** GET /api/events?since=<seq> — incremental feed (polling baseline + SSE replay). */
export async function fetchEventsSince(since: number, signal?: AbortSignal): Promise<EventsPage> {
  // Only set `signal` when present (exactOptionalPropertyTypes rejects undefined).
  const init: RequestInit = signal ? { signal } : {}
  const res = await fetch(`${collectorBase()}/api/events?since=${since}`, init)
  if (!res.ok) throw new Error(`collector /api/events ${res.status}`)
  const body = (await res.json()) as { events?: unknown[]; latestSeq?: number }
  const events = Array.isArray(body.events)
    ? body.events.map(parseActivityEvent).filter((e): e is ActivityEvent => e !== null)
    : []
  return { events, latestSeq: typeof body.latestSeq === 'number' ? body.latestSeq : since }
}

/** SSE stream URL. EventSource resumes via Last-Event-ID (auto) or ?since=. */
export function streamUrl(since: number): string {
  return `${collectorBase()}/api/stream?since=${since}`
}

// ---------------------------------------------------------------------------
// File tree (GET /api/tree) — see .monitor-filetree-spec.md §A.
// The server computes the LCA root of all touched paths and scans it (bounded).
// Activity-overlay fields are NOT in this response; the frontend derives them
// from the live event stream (see useFileTree).
// ---------------------------------------------------------------------------

export interface TreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: TreeNode[]
}

export interface TreeResponse {
  /** Absolute path of the computed LCA root, or null when there are no paths. */
  root: string | null
  tree: TreeNode[]
  scannedAt: string
  capped: boolean
}

const EMPTY_TREE: TreeResponse = { root: null, tree: [], scannedAt: '', capped: false }

/** GET /api/tree — 404 (no events yet) resolves to an empty tree, not an error. */
export async function fetchTree(signal?: AbortSignal): Promise<TreeResponse> {
  // Only set `signal` when present (exactOptionalPropertyTypes rejects undefined).
  const init: RequestInit = signal ? { signal } : {}
  const res = await fetch(`${collectorBase()}/api/tree`, init)
  if (res.status === 404) return EMPTY_TREE
  if (!res.ok) throw new Error(`collector /api/tree ${res.status}`)
  return (await res.json()) as TreeResponse
}

/** Per-session rollup for the dashboard (GET /api/sessions). */
export interface SessionSummary {
  sessionId: string
  agentId: string
  eventCount: number
  lastTs: string | null
  lastSeq: number
}

export async function listSessions(signal?: AbortSignal): Promise<SessionSummary[]> {
  const init: RequestInit = signal ? { signal } : {}
  const res = await fetch(`${collectorBase()}/api/sessions`, init)
  if (!res.ok) throw new Error(`collector /api/sessions ${res.status}`)
  const body = (await res.json()) as { sessions?: SessionSummary[] }
  return Array.isArray(body.sessions) ? body.sessions : []
}

/** Events for one session, ascending (GET /api/sessions/:id/events). */
export async function fetchSessionEvents(
  sessionId: string,
  since = 0,
  signal?: AbortSignal
): Promise<EventsPage> {
  const init: RequestInit = signal ? { signal } : {}
  const res = await fetch(
    `${collectorBase()}/api/sessions/${encodeURIComponent(sessionId)}/events?since=${since}`,
    init
  )
  if (!res.ok) throw new Error(`collector session events ${res.status}`)
  const body = (await res.json()) as { events?: unknown[]; latestSeq?: number }
  const events = Array.isArray(body.events)
    ? body.events.map(parseActivityEvent).filter((e): e is ActivityEvent => e !== null)
    : []
  return { events, latestSeq: typeof body.latestSeq === 'number' ? body.latestSeq : since }
}

// ---------------------------------------------------------------------------
// Control plane (rules + manual interrupt)
// ---------------------------------------------------------------------------

export type RuleKind = 'allow' | 'deny'

/** A control-plane rule as returned by GET /api/rules. */
export interface MonitorRule {
  id: string
  kind: RuleKind
  glob: string
  scope: string
  enabled: boolean
  createdAt?: string
  updatedAt?: string
}

/** Editable shape posted to /control/rules (timestamps are server-managed). */
export interface RuleDraft {
  id: string
  kind: RuleKind
  glob: string
  scope: string
  enabled: boolean
}

export interface InterventionRecord {
  id: number
  ts: string
  agentId: string
  sessionId: string | null
  ruleId: string | null
  mode: string
  trigger: string
  targetPath: string | null
  message: string | null
  createdAt: string
}

/** Headers every /control/* mutation needs: JSON + the local CSRF header. */
function controlHeaders(): HeadersInit {
  return { 'content-type': 'application/json', [LOCAL_HEADER]: '1' }
}

export async function listRules(signal?: AbortSignal): Promise<MonitorRule[]> {
  const init: RequestInit = signal ? { signal } : {}
  const res = await fetch(`${collectorBase()}/api/rules`, init)
  if (!res.ok) throw new Error(`collector /api/rules ${res.status}`)
  const body = (await res.json()) as { rules?: MonitorRule[] }
  return Array.isArray(body.rules) ? body.rules : []
}

/** POST the full rule set (replace-all). The collector re-projects the whole
 *  table to the plugin rules file, so the plugin enforces it on next mtime check. */
export async function replaceRules(rules: RuleDraft[]): Promise<MonitorRule[]> {
  const res = await fetch(`${collectorBase()}/control/rules`, {
    method: 'POST',
    headers: controlHeaders(),
    body: JSON.stringify(rules)
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'rule save'))
  const body = (await res.json()) as { rules?: MonitorRule[] }
  return Array.isArray(body.rules) ? body.rules : []
}

export async function deleteRule(id: string): Promise<boolean> {
  const res = await fetch(`${collectorBase()}/control/rules/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { [LOCAL_HEADER]: '1' }
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'rule delete'))
  const body = (await res.json()) as { deleted?: boolean }
  return body.deleted === true
}

export async function listInterventions(limit = 200, signal?: AbortSignal): Promise<InterventionRecord[]> {
  const init: RequestInit = signal ? { signal } : {}
  const res = await fetch(`${collectorBase()}/api/interventions?limit=${limit}`, init)
  if (!res.ok) throw new Error(`collector /api/interventions ${res.status}`)
  const body = (await res.json()) as { interventions?: InterventionRecord[] }
  return Array.isArray(body.interventions) ? body.interventions : []
}

export interface InterruptRequest {
  agentId: string
  sessionId?: string | null
  reason?: string | null
}

export async function postInterrupt(req: InterruptRequest): Promise<InterventionRecord> {
  const res = await fetch(`${collectorBase()}/control/interrupt`, {
    method: 'POST',
    headers: controlHeaders(),
    body: JSON.stringify(req)
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'interrupt'))
  const body = (await res.json()) as { intervention: InterventionRecord }
  return body.intervention
}

/** Pull a human-readable message out of the collector's { code, message } error. */
async function errorMessage(res: Response, label: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; code?: string }
    return body.message || body.code || `${label} failed (${res.status})`
  } catch {
    return `${label} failed (${res.status})`
  }
}
