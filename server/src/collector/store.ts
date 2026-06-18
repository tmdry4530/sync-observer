import { DatabaseSync } from 'node:sqlite'
import type { ActivityEvent } from './activityEvent.js'
import { INTERVENTION_MODES, INTERVENTION_TRIGGERS, type InterventionMode, type InterventionTrigger } from './activityEvent.js'

/**
 * node:sqlite persistence for the local collector (M2 §1).
 *
 * Hard constraints (per the M2 brief):
 *   - node:sqlite only (DatabaseSync). NO pg / drizzle / new npm deps.
 *   - WAL + foreign_keys ON.
 *   - events.event_id is UNIQUE; ingest uses INSERT OR IGNORE for at-least-once
 *     dedup (the hermes emitter retries, so the same eventId can arrive twice).
 *   - DB rows map back to the EXACT ActivityEvent shape (JSON columns parsed,
 *     visible_to_user 0/1 coerced to boolean).
 */

export const RULE_KINDS = ['allow', 'deny'] as const
export type RuleKind = (typeof RULE_KINDS)[number]

/** A control-plane rule row (mirrors the plugin's rule contract). */
export interface CollectorRule {
  id: string
  kind: RuleKind
  glob: string
  /** 'global' | 'session:<id>' | 'agent:<id>' */
  scope: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/** Input for upserting a rule (timestamps are managed by the store). */
export interface RuleInput {
  id: string
  kind: RuleKind
  glob: string
  scope?: string
  enabled?: boolean
}

/** Per-session rollup for the dashboard. */
export interface SessionSummary {
  sessionId: string
  agentId: string
  eventCount: number
  lastTs: string | null
  lastSeq: number
}

/** A recorded human/auto intervention. */
export interface InterventionRecord {
  id: number
  ts: string
  agentId: string
  sessionId: string | null
  ruleId: string | null
  mode: InterventionMode
  trigger: InterventionTrigger
  targetPath: string | null
  eventId: string | null
  message: string | null
  createdAt: string
}

/** Input for recording an intervention (id/createdAt are managed by the store). */
export interface InterventionInput {
  ts: string
  agentId: string
  sessionId?: string | null
  ruleId?: string | null
  mode: InterventionMode
  trigger: InterventionTrigger
  targetPath?: string | null
  eventId?: string | null
  message?: string | null
}

export interface EventsPage {
  events: ActivityEvent[]
  latestSeq: number
}

/** An event paired with its durable sequence number (used by SSE for `id:`). */
export interface SeqEvent {
  seq: number
  event: ActivityEvent
}

export interface CollectorStore {
  /** INSERT OR IGNORE on event_id. Returns inserted=false (seq=null) when deduped. */
  insertEvent(ev: ActivityEvent): { inserted: boolean; seq: number | null }
  /** Events with seq > `since`, ascending, limit clamped to 1..1000 (default 500). */
  getEventsSince(since: number, limit?: number): EventsPage
  /** Same window as getEventsSince but each event carries its seq (SSE replay). */
  getEventsSinceWithSeq(since: number, limit?: number): SeqEvent[]
  /** Per-session rollups, most-recently-active first. */
  listSessions(): SessionSummary[]
  /** Events for one session with seq > `since`, ascending. */
  getSessionEvents(sessionId: string, since?: number, limit?: number): EventsPage
  listRules(): CollectorRule[]
  upsertRule(rule: RuleInput): CollectorRule
  deleteRule(id: string): boolean
  /** Replace the entire rules table in one transaction (used by the full-array PUT/POST). */
  replaceAllRules(rules: RuleInput[]): CollectorRule[]
  insertIntervention(rec: InterventionInput): InterventionRecord
  listInterventions(limit?: number): InterventionRecord[]
  /** Underlying handle (close on shutdown). */
  close(): void
}

const DEFAULT_PAGE_LIMIT = 500
const MAX_PAGE_LIMIT = 1000
const DEFAULT_INTERVENTION_LIMIT = 200

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       TEXT NOT NULL UNIQUE,
  ts             TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  agent_kind     TEXT NOT NULL,
  session_id     TEXT,
  task_id        TEXT,
  turn_id        TEXT,
  action         TEXT NOT NULL,
  tool           TEXT NOT NULL,
  paths          TEXT NOT NULL,
  status         TEXT NOT NULL,
  cwd            TEXT,
  git_branch     TEXT,
  correlation_id TEXT,
  summary        TEXT,
  detail         TEXT,
  visible_to_user INTEGER NOT NULL DEFAULT 1,
  ingested_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events (session_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_agent_seq ON events (agent_id, seq);

CREATE TABLE IF NOT EXISTS rules (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  glob       TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'global',
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interventions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  session_id  TEXT,
  rule_id     TEXT,
  mode        TEXT NOT NULL,
  trigger     TEXT NOT NULL,
  target_path TEXT,
  event_id    TEXT,
  message     TEXT,
  created_at  TEXT NOT NULL
);
`

interface EventRow {
  seq: number
  event_id: string
  ts: string
  agent_id: string
  agent_kind: string
  session_id: string | null
  task_id: string | null
  turn_id: string | null
  action: string
  tool: string
  paths: string
  status: string
  cwd: string | null
  git_branch: string | null
  correlation_id: string | null
  summary: string | null
  detail: string | null
  visible_to_user: number
}

interface RuleRow {
  id: string
  kind: string
  glob: string
  scope: string
  enabled: number
  created_at: string
  updated_at: string
}

interface InterventionRow {
  id: number
  ts: string
  agent_id: string
  session_id: string | null
  rule_id: string | null
  mode: string
  trigger: string
  target_path: string | null
  event_id: string | null
  message: string | null
  created_at: string
}

export function createCollectorStore(dbPath: string): CollectorStore {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)

  const insertEventStmt = db.prepare(`
    INSERT OR IGNORE INTO events (
      event_id, ts, agent_id, agent_kind, session_id, task_id, turn_id,
      action, tool, paths, status, cwd, git_branch, correlation_id,
      summary, detail, visible_to_user, ingested_at
    ) VALUES (
      :event_id, :ts, :agent_id, :agent_kind, :session_id, :task_id, :turn_id,
      :action, :tool, :paths, :status, :cwd, :git_branch, :correlation_id,
      :summary, :detail, :visible_to_user, :ingested_at
    )
  `)
  const seqByEventIdStmt = db.prepare('SELECT seq FROM events WHERE event_id = :event_id')

  const insertEvent = (ev: ActivityEvent): { inserted: boolean; seq: number | null } => {
    const result = insertEventStmt.run({
      event_id: ev.eventId,
      ts: ev.ts,
      agent_id: ev.agentId,
      agent_kind: ev.agentKind,
      session_id: ev.sessionId,
      task_id: ev.taskId,
      turn_id: ev.turnId,
      action: ev.action,
      tool: ev.tool,
      paths: JSON.stringify(ev.paths),
      status: ev.status,
      cwd: ev.cwd,
      git_branch: ev.gitBranch,
      correlation_id: ev.correlationId,
      summary: ev.summary,
      detail: ev.detail == null ? null : JSON.stringify(ev.detail),
      visible_to_user: ev.visibleToUser ? 1 : 0,
      ingested_at: new Date().toISOString()
    })
    if (result.changes === 0) {
      // Deduped: the row already existed (same event_id).
      return { inserted: false, seq: null }
    }
    return { inserted: true, seq: Number(result.lastInsertRowid) }
  }

  const eventsSinceStmt = db.prepare(
    'SELECT * FROM events WHERE seq > :since ORDER BY seq ASC LIMIT :limit'
  )
  const latestSeqStmt = db.prepare('SELECT COALESCE(MAX(seq), 0) AS latest FROM events')

  const latestSeq = (): number => {
    const row = latestSeqStmt.get() as { latest: number } | undefined
    return row ? Number(row.latest) : 0
  }

  const getEventsSince = (since: number, limit = DEFAULT_PAGE_LIMIT): EventsPage => {
    const rows = eventsSinceStmt.all({
      since: normalizeSince(since),
      limit: clampLimit(limit)
    }) as unknown as EventRow[]
    const events = rows.map(rowToEvent)
    const pageMax = events.length > 0 ? Number(rows[rows.length - 1]!.seq) : normalizeSince(since)
    // latestSeq is the highest seq in the store, so a caller knows when caught up.
    return { events, latestSeq: Math.max(pageMax, latestSeq()) }
  }

  const getEventsSinceWithSeq = (since: number, limit = DEFAULT_PAGE_LIMIT): SeqEvent[] => {
    const rows = eventsSinceStmt.all({
      since: normalizeSince(since),
      limit: clampLimit(limit)
    }) as unknown as EventRow[]
    return rows.map((row) => ({ seq: Number(row.seq), event: rowToEvent(row) }))
  }

  const sessionEventsStmt = db.prepare(
    'SELECT * FROM events WHERE session_id = :session_id AND seq > :since ORDER BY seq ASC LIMIT :limit'
  )

  const getSessionEvents = (sessionId: string, since = 0, limit = DEFAULT_PAGE_LIMIT): EventsPage => {
    const rows = sessionEventsStmt.all({
      session_id: sessionId,
      since: normalizeSince(since),
      limit: clampLimit(limit)
    }) as unknown as EventRow[]
    const events = rows.map(rowToEvent)
    const pageMax = events.length > 0 ? Number(rows[rows.length - 1]!.seq) : normalizeSince(since)
    return { events, latestSeq: Math.max(pageMax, latestSeq()) }
  }

  const listSessionsStmt = db.prepare(`
    SELECT
      session_id      AS sessionId,
      MAX(agent_id)   AS agentId,
      COUNT(*)        AS eventCount,
      MAX(ts)         AS lastTs,
      MAX(seq)        AS lastSeq
    FROM events
    WHERE session_id IS NOT NULL
    GROUP BY session_id
    ORDER BY lastSeq DESC
  `)

  const listSessions = (): SessionSummary[] => {
    const rows = listSessionsStmt.all() as unknown as Array<{
      sessionId: string
      agentId: string
      eventCount: number
      lastTs: string | null
      lastSeq: number
    }>
    return rows.map((row) => ({
      sessionId: row.sessionId,
      agentId: row.agentId,
      eventCount: Number(row.eventCount),
      lastTs: row.lastTs,
      lastSeq: Number(row.lastSeq)
    }))
  }

  const listRulesStmt = db.prepare('SELECT * FROM rules ORDER BY created_at ASC, id ASC')
  const upsertRuleStmt = db.prepare(`
    INSERT INTO rules (id, kind, glob, scope, enabled, created_at, updated_at)
    VALUES (:id, :kind, :glob, :scope, :enabled, :created_at, :updated_at)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      glob = excluded.glob,
      scope = excluded.scope,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `)
  const getRuleStmt = db.prepare('SELECT * FROM rules WHERE id = :id')
  const deleteRuleStmt = db.prepare('DELETE FROM rules WHERE id = :id')
  const clearRulesStmt = db.prepare('DELETE FROM rules')

  const listRules = (): CollectorRule[] => {
    const rows = listRulesStmt.all() as unknown as RuleRow[]
    return rows.map(rowToRule)
  }

  const upsertRule = (rule: RuleInput): CollectorRule => {
    const now = new Date().toISOString()
    const existing = getRuleStmt.get({ id: rule.id }) as unknown as RuleRow | undefined
    const createdAt = existing ? existing.created_at : now
    upsertRuleStmt.run({
      id: rule.id,
      kind: rule.kind,
      glob: rule.glob,
      scope: rule.scope ?? 'global',
      enabled: (rule.enabled ?? true) ? 1 : 0,
      created_at: createdAt,
      updated_at: now
    })
    return rowToRule(getRuleStmt.get({ id: rule.id }) as unknown as RuleRow)
  }

  const deleteRule = (id: string): boolean => {
    const result = deleteRuleStmt.run({ id })
    return result.changes > 0
  }

  const replaceAllRules = (rules: RuleInput[]): CollectorRule[] => {
    db.exec('BEGIN')
    try {
      clearRulesStmt.run()
      const now = new Date().toISOString()
      for (const rule of rules) {
        upsertRuleStmt.run({
          id: rule.id,
          kind: rule.kind,
          glob: rule.glob,
          scope: rule.scope ?? 'global',
          enabled: (rule.enabled ?? true) ? 1 : 0,
          created_at: now,
          updated_at: now
        })
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return listRules()
  }

  const insertInterventionStmt = db.prepare(`
    INSERT INTO interventions (
      ts, agent_id, session_id, rule_id, mode, trigger,
      target_path, event_id, message, created_at
    ) VALUES (
      :ts, :agent_id, :session_id, :rule_id, :mode, :trigger,
      :target_path, :event_id, :message, :created_at
    )
  `)
  const getInterventionStmt = db.prepare('SELECT * FROM interventions WHERE id = :id')
  const listInterventionsStmt = db.prepare(
    'SELECT * FROM interventions ORDER BY id DESC LIMIT :limit'
  )

  const insertIntervention = (rec: InterventionInput): InterventionRecord => {
    const now = new Date().toISOString()
    const result = insertInterventionStmt.run({
      ts: rec.ts,
      agent_id: rec.agentId,
      session_id: rec.sessionId ?? null,
      rule_id: rec.ruleId ?? null,
      mode: rec.mode,
      trigger: rec.trigger,
      target_path: rec.targetPath ?? null,
      event_id: rec.eventId ?? null,
      message: rec.message ?? null,
      created_at: now
    })
    const row = getInterventionStmt.get({ id: Number(result.lastInsertRowid) }) as unknown as InterventionRow
    return rowToIntervention(row)
  }

  const listInterventions = (limit = DEFAULT_INTERVENTION_LIMIT): InterventionRecord[] => {
    const rows = listInterventionsStmt.all({ limit: clampLimit(limit) }) as unknown as InterventionRow[]
    return rows.map(rowToIntervention)
  }

  return {
    insertEvent,
    getEventsSince,
    getEventsSinceWithSeq,
    listSessions,
    getSessionEvents,
    listRules,
    upsertRule,
    deleteRule,
    replaceAllRules,
    insertIntervention,
    listInterventions,
    close: () => db.close()
  }
}

function rowToEvent(row: EventRow): ActivityEvent {
  return {
    v: 1,
    eventId: row.event_id,
    ts: row.ts,
    agentId: row.agent_id,
    agentKind: 'hermes',
    sessionId: row.session_id,
    taskId: row.task_id,
    turnId: row.turn_id,
    action: row.action as ActivityEvent['action'],
    tool: row.tool,
    paths: parseJsonArray(row.paths),
    status: row.status as ActivityEvent['status'],
    cwd: row.cwd,
    gitBranch: row.git_branch,
    correlationId: row.correlation_id,
    summary: row.summary,
    detail: row.detail == null ? null : (parseJsonObject(row.detail) as ActivityEvent['detail']),
    visibleToUser: row.visible_to_user !== 0
  }
}

function rowToRule(row: RuleRow): CollectorRule {
  return {
    id: row.id,
    // Fail closed: a corrupt/unknown kind reads back as 'deny', never 'allow'.
    // This is a deny-overrides control plane — over-enforcing is the safe
    // direction; silently downgrading a rule to 'allow' would be fail-unsafe.
    kind: (row.kind === 'allow' ? 'allow' : 'deny') as RuleKind,
    glob: row.glob,
    scope: row.scope || 'global',
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function rowToIntervention(row: InterventionRow): InterventionRecord {
  return {
    id: Number(row.id),
    ts: row.ts,
    agentId: row.agent_id,
    sessionId: row.session_id,
    ruleId: row.rule_id,
    mode: coerceMode(row.mode),
    trigger: coerceTrigger(row.trigger),
    targetPath: row.target_path,
    eventId: row.event_id,
    message: row.message,
    createdAt: row.created_at
  }
}

function coerceMode(value: string): InterventionMode {
  return (INTERVENTION_MODES as readonly string[]).includes(value) ? (value as InterventionMode) : 'interrupt'
}

function coerceTrigger(value: string): InterventionTrigger {
  return (INTERVENTION_TRIGGERS as readonly string[]).includes(value) ? (value as InterventionTrigger) : 'manual'
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT
  const floored = Math.floor(limit)
  if (floored < 1) return 1
  if (floored > MAX_PAGE_LIMIT) return MAX_PAGE_LIMIT
  return floored
}

function normalizeSince(since: number): number {
  if (!Number.isFinite(since) || since < 0) return 0
  return Math.floor(since)
}
