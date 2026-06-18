import type { Router } from '../http/router.js'
import type { RequestContext } from '../http/context.js'
import { json, type HttpResponse } from '../http/response.js'
import { badRequest, forbidden, internalError } from '../http/errors.js'
import {
  ActivityEventBatchSchema,
  getIntervention,
  type ActivityEvent,
  type InterventionDetail
} from './activityEvent.js'
import type { CollectorStore, RuleInput, RuleKind } from './store.js'
import type { EventHub } from './hub.js'
import { writeRulesFile } from './rulesFile.js'

/**
 * Collector + control-plane HTTP routes (M2 §4).
 *
 * Mounted on the existing Router. State-changing routes (/ingest/*, /control/*)
 * are defended in depth:
 *   (a) loopback-only — the socket remoteAddress must be 127.0.0.1 / ::1, so
 *       nothing off-host can ingest or control;
 *   (b) Origin allow-list — if an Origin header is present it must satisfy the
 *       allow-list, blocking cross-origin browser CSRF;
 *   (c) /control/* additionally requires the custom header X-SyncSpace-Local: 1,
 *       which a cross-site HTML <form> cannot set (CSRF defense the UI satisfies).
 * GET read routes are loopback-only but need no custom header.
 */

export interface InterruptRequest {
  agentId: string
  sessionId: string | null
  reason: string | null
}

/** Seam for actually binding an interrupt to a running agent (wired in M5). */
export type InterruptResolver = (req: InterruptRequest) => Promise<void>

export interface CollectorRouteDeps {
  store: CollectorStore
  hub: EventHub
  rulesFilePath: string
  /** Permitted browser origins (control/read CSRF guard). */
  allowedOrigins: string[]
  /** Default is a no-op; real agent binding lands in M5. */
  interruptResolver?: InterruptResolver
}

const LOCAL_HEADER = 'x-syncspace-local'
const HEARTBEAT_MS = 15_000
const SSE_RING_REPLAY_LIMIT = 1000
/** Mirrors ActivityEventBatchSchema's array .max(1000) so the lenient per-row
 *  fallback can't be used to bypass the batch cap with an oversized array. */
const MAX_INGEST_BATCH = 1000

const noopResolver: InterruptResolver = async () => {}

export function registerCollectorRoutes(router: Router, deps: CollectorRouteDeps): void {
  const { store, hub, rulesFilePath, allowedOrigins } = deps
  const interruptResolver = deps.interruptResolver ?? noopResolver

  const reproject = (): void => {
    try {
      writeRulesFile(rulesFilePath, store.listRules())
    } catch (error) {
      // The DB is the UI's source of truth, but the PLUGIN trusts the rules FILE.
      // A failed projection means the plugin is still enforcing the OLD ruleset —
      // fail loud (500) rather than returning a misleading 200 that implies the
      // new rule is active. Local single-user tool: the operator sees this in the
      // UI, and the next successful mutation re-projects the whole table.
      throw internalError(
        `Rule saved to the database but writing the plugin rules file failed; the plugin is NOT yet enforcing it: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'rules_projection_failed'
      )
    }
  }

  // ---- Ingest (loopback + origin guarded) -------------------------------------
  router.post('/ingest/events', async (ctx) => {
    guardStateChange(ctx, allowedOrigins, { requireLocalHeader: false })
    const body = await ctx.json<unknown>()
    const parsed = ActivityEventBatchSchema.safeParse(body)
    if (!parsed.success) {
      // The batch wrapper rejects only when the whole payload is unusable
      // (not an event and not an array); per-row leniency is handled below.
      return countingIngest(toCandidateArray(body), store, hub)
    }
    const events = Array.isArray(parsed.data) ? parsed.data : [parsed.data]
    let accepted = 0
    let deduped = 0
    for (const ev of events) {
      const result = store.insertEvent(ev)
      if (result.inserted) {
        accepted += 1
        hub.publish(ev)
        recordInterventionFromEvent(ev, store)
      } else {
        deduped += 1
      }
    }
    return json({ accepted, deduped, rejected: 0 })
  })

  // ---- Read feed (loopback only) ----------------------------------------------
  router.get('/api/events', (ctx) => {
    guardRead(ctx)
    const since = parseIntParam(ctx.query.get('since'), 0)
    const limit = parseIntParam(ctx.query.get('limit'), 500)
    const page = store.getEventsSince(since, limit)
    return json(page)
  })

  router.get('/api/sessions', (ctx) => {
    guardRead(ctx)
    return json({ sessions: store.listSessions() })
  })

  router.get('/api/sessions/:id/events', (ctx) => {
    guardRead(ctx)
    const sessionId = ctx.params.id
    if (!sessionId) throw badRequest('missing_session_id', 'A session id path segment is required.')
    const since = parseIntParam(ctx.query.get('since'), 0)
    const limit = parseIntParam(ctx.query.get('limit'), 500)
    return json(store.getSessionEvents(sessionId, since, limit))
  })

  // ---- SSE stream (loopback only, raw response) -------------------------------
  router.get('/api/stream', (ctx) => {
    guardRead(ctx)
    startSseStream(ctx, store, hub)
    // Returning void: dispatch() must not also write a response. We own the
    // socket from here until the client disconnects.
  })

  // ---- Rules (read open; mutate loopback + origin + custom-header) -------------
  router.get('/api/rules', (ctx) => {
    guardRead(ctx)
    return json({ rules: store.listRules() })
  })

  router.post('/control/rules', async (ctx) => {
    guardStateChange(ctx, allowedOrigins, { requireLocalHeader: true })
    const body = await ctx.json<unknown>()
    // Two accepted shapes (documented):
    //   - an array → replaceAllRules (full-set PUT semantics)
    //   - a single rule object → upsertRule
    if (Array.isArray(body)) {
      const inputs = body.map((item, index) => parseRuleInput(item, index))
      const rules = store.replaceAllRules(inputs)
      reproject()
      return json({ rules })
    }
    const input = parseRuleInput(body, 0)
    const rule = store.upsertRule(input)
    reproject()
    return json({ rule })
  })

  router.delete('/control/rules/:id', (ctx) => {
    guardStateChange(ctx, allowedOrigins, { requireLocalHeader: true })
    const id = ctx.params.id
    if (!id) throw badRequest('missing_rule_id', 'A rule id path segment is required.')
    const deleted = store.deleteRule(id)
    reproject()
    return json({ deleted })
  })

  // ---- Interventions read -----------------------------------------------------
  router.get('/api/interventions', (ctx) => {
    guardRead(ctx)
    const limit = parseIntParam(ctx.query.get('limit'), 200)
    return json({ interventions: store.listInterventions(limit) })
  })

  // ---- Manual interrupt (loopback + origin + custom-header) --------------------
  router.post('/control/interrupt', async (ctx) => {
    guardStateChange(ctx, allowedOrigins, { requireLocalHeader: true })
    const body = await ctx.json<{ agentId?: unknown; sessionId?: unknown; reason?: unknown }>()
    const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
    if (!agentId) throw badRequest('missing_agent_id', 'agentId is required to interrupt an agent.')
    const sessionId = typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : null
    // reason flows to the agent's context via the plugin block message, so cap
    // length + strip control chars (parity with the rule-field hardening).
    const reason = sanitizeReason(body.reason)
    const ts = new Date().toISOString()

    const intervention = store.insertIntervention({
      ts,
      agentId,
      sessionId,
      ruleId: null,
      mode: 'interrupt',
      trigger: 'manual',
      targetPath: null,
      eventId: null,
      message: reason
    })

    // Publish a synthetic cancelled event so the live feed reflects the interrupt.
    const detail: InterventionDetail = {
      ruleId: '',
      mode: 'interrupt',
      trigger: 'manual',
      ...(reason ? { message: reason } : {})
    }
    const syntheticEvent: ActivityEvent = {
      v: 1,
      // The intervention PK is already unique; no timestamp suffix needed (and a
      // deterministic id lets a retried interrupt dedup instead of duplicating).
      eventId: `interrupt-${intervention.id}`,
      ts,
      agentId,
      agentKind: 'hermes',
      sessionId,
      taskId: null,
      turnId: null,
      action: 'other',
      tool: 'interrupt',
      paths: [],
      status: 'cancelled',
      cwd: null,
      gitBranch: null,
      correlationId: null,
      summary: reason ? `Manual interrupt: ${reason}` : 'Manual interrupt',
      // The contract carries intervention metadata under detail.intervention.
      // ruleId:null for a manual interrupt (no rule drove it).
      detail: { intervention: { ...detail, ruleId: null } },
      visibleToUser: true
    }
    const insert = store.insertEvent(syntheticEvent)
    if (insert.inserted) hub.publish(syntheticEvent)

    // Queue the interrupt for the plugin to poll + enforce in-process (M5). The
    // resolver seam below is the in-memory push path; this is the durable pull
    // path the plugin drains via GET /control/pending.
    store.enqueueInterrupt({ agentId, sessionId, reason })

    // Fire the seam (M5 binds this to the live agent). Never block the response
    // on a resolver failure — record-keeping already succeeded.
    void interruptResolver({ agentId, sessionId, reason }).catch(() => undefined)

    return json({ intervention })
  })

  // ---- Pending interrupt drain (plugin pull; loopback + origin + custom-header) -
  // Consuming is a mutation (consume-once marks rows consumed_at), so it carries
  // the same X-SyncSpace-Local CSRF guard as the other /control/* mutations even
  // though it is a GET.
  router.get('/control/pending', (ctx) => {
    guardStateChange(ctx, allowedOrigins, { requireLocalHeader: true })
    const agentId = (ctx.query.get('agentId') ?? '').trim()
    if (!agentId) throw badRequest('missing_agent_id', 'agentId is required to drain pending interrupts.')
    const sessionIdParam = ctx.query.get('sessionId')
    const sessionId = sessionIdParam != null && sessionIdParam.length > 0 ? sessionIdParam : null
    return json({ interrupts: store.consumePending(agentId, sessionId) })
  })
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function startSseStream(ctx: RequestContext, store: CollectorStore, hub: EventHub): void {
  const { res } = ctx
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // Disable proxy buffering if anything sits in front (defensive; local only).
    'x-accel-buffering': 'no'
  })

  // Resume point: Last-Event-ID header wins, else ?since=, else from 0. The id we
  // emit IS the durable store seq, so on reconnect the client's Last-Event-ID maps
  // straight back to store.getEventsSinceWithSeq(seq) — no drift.
  const lastEventId = ctx.header('last-event-id')
  const sinceQuery = ctx.query.get('since')
  const resumeFrom = parseIntParam(lastEventId ?? sinceQuery, 0)

  // Replay everything the client missed straight from the durable store so a
  // reconnect resumes exactly where it left off (the ring buffer is best-effort).
  let lastSentSeq = resumeFrom
  for (const { seq, event } of store.getEventsSinceWithSeq(resumeFrom, SSE_RING_REPLAY_LIMIT)) {
    writeSseEvent(res, event, seq)
    lastSentSeq = seq
  }

  // On each live publish, drain any rows past what we've sent (this includes the
  // just-published event) so every frame carries its true store seq as the id.
  // hub.publish isolates listeners, but if a write/query here ever throws we tear
  // this subscriber down so one dead client can't churn on every publish.
  const live = hub.subscribe(() => {
    try {
      for (const { seq, event } of store.getEventsSinceWithSeq(lastSentSeq, SSE_RING_REPLAY_LIMIT)) {
        writeSseEvent(res, event, seq)
        lastSentSeq = seq
      }
    } catch {
      cleanup()
    }
  })

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return
    // SSE comment line keeps intermediaries from idling the connection.
    res.write(': heartbeat\n\n')
  }, HEARTBEAT_MS)
  // Don't keep the process alive solely for a heartbeat timer.
  heartbeat.unref?.()

  const cleanup = (): void => {
    clearInterval(heartbeat)
    live()
  }
  ctx.req.on('close', cleanup)
  ctx.res.on('close', cleanup)
}

/**
 * Writes one SSE frame. The `id:` IS the durable store seq; the client echoes it
 * back via Last-Event-ID on reconnect and we resume from
 * store.getEventsSinceWithSeq(id).
 */
function writeSseEvent(res: RequestContext['res'], event: ActivityEvent, seq: number): void {
  // The socket may close between a publish firing and its 'close' handler
  // unsubscribing; writing after end throws ERR_STREAM_WRITE_AFTER_END. Guard so
  // a dead client is a no-op rather than an exception (paired with hub isolation).
  if (res.writableEnded || res.destroyed) return
  res.write(`id: ${seq}\n`)
  res.write('event: activity\n')
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

// ---------------------------------------------------------------------------
// Security guards
// ---------------------------------------------------------------------------

export function isLoopback(remoteAddress: string | undefined | null): boolean {
  if (!remoteAddress) return false
  // Node may report IPv4-mapped IPv6 (::ffff:127.0.0.1) for loopback v4.
  const addr = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice('::ffff:'.length) : remoteAddress
  if (addr === '::1') return true
  // Full IPv4 loopback block (127.0.0.0/8), validated as a real dotted quad. We do
  // NOT trust the hostname string 'localhost' — socket.remoteAddress is always a
  // numeric IP, and accepting a hostname here would be a footgun for a guard whose
  // whole job is to keep this control plane off-host-unreachable.
  const parts = addr.split('.')
  if (parts.length !== 4 || parts[0] !== '127') return false
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

function guardRead(ctx: RequestContext): void {
  if (!isLoopback(ctx.req.socket.remoteAddress)) {
    throw forbidden('Collector is loopback-only.', 'not_loopback')
  }
}

function guardStateChange(
  ctx: RequestContext,
  allowedOrigins: string[],
  opts: { requireLocalHeader: boolean }
): void {
  if (!isLoopback(ctx.req.socket.remoteAddress)) {
    throw forbidden('Collector is loopback-only.', 'not_loopback')
  }
  // If a browser sent an Origin, it must be on the allow-list (blocks CSRF from
  // other web origins, including http://evil.example).
  const origin = ctx.header('origin')
  if (origin && !isOriginAllowed(origin, allowedOrigins)) {
    throw forbidden('Origin is not allowed.', 'forbidden_origin')
  }
  if (opts.requireLocalHeader && ctx.header(LOCAL_HEADER) !== '1') {
    throw forbidden('Missing X-SyncSpace-Local header.', 'missing_local_header')
  }
}

export function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  if (allowedOrigins.includes('*')) return true
  const normalized = normalizeOrigin(origin)
  return allowedOrigins.some((allowed) => {
    if (allowed === origin) return true
    const allowedNorm = normalizeOrigin(allowed)
    // Guard the null/null collision: two UNPARSEABLE strings must NOT match (a
    // typo'd ALLOWED_ORIGINS entry could otherwise let any garbage Origin pass).
    return allowedNorm !== null && normalized !== null && allowedNorm === normalized
  })
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Ingest helpers
// ---------------------------------------------------------------------------

/**
 * Per-row lenient ingest: validate each candidate independently, insert the good
 * ones, count the bad ones. Used when the strict batch parse failed so that one
 * malformed row in an array does not reject the whole batch.
 */
function countingIngest(candidates: unknown[], store: CollectorStore, hub: EventHub): HttpResponse {
  let accepted = 0
  let deduped = 0
  let rejected = 0
  // Enforce the batch cap here too: an array >MAX_INGEST_BATCH fails the strict
  // schema (array .max) and lands here, so without this it would bypass the cap.
  let capped = candidates
  if (candidates.length > MAX_INGEST_BATCH) {
    rejected += candidates.length - MAX_INGEST_BATCH
    capped = candidates.slice(0, MAX_INGEST_BATCH)
  }
  for (const candidate of capped) {
    const parsed = ActivityEventBatchSchema.options[0].safeParse(candidate)
    if (!parsed.success) {
      rejected += 1
      continue
    }
    const result = store.insertEvent(parsed.data)
    if (result.inserted) {
      accepted += 1
      hub.publish(parsed.data)
      recordInterventionFromEvent(parsed.data, store)
    } else {
      deduped += 1
    }
  }
  return json({ accepted, deduped, rejected })
}

/**
 * Mirror an intervention-bearing event into the interventions audit table. The
 * plugin's automatic pre-block emits arrive here as `blocked` events carrying
 * detail.intervention — without this, the interventions log would only ever show
 * MANUAL interrupts and silently omit the automatic blocks, which are the most
 * security-relevant actions. Only called for freshly-inserted events (dedup-safe).
 */
function recordInterventionFromEvent(event: ActivityEvent, store: CollectorStore): void {
  if (event.status !== 'blocked' && event.status !== 'cancelled') return
  const iv = getIntervention(event)
  if (!iv) return
  store.insertIntervention({
    ts: event.ts,
    agentId: event.agentId,
    sessionId: event.sessionId,
    ruleId: iv.ruleId || null,
    mode: iv.mode,
    trigger: iv.trigger,
    targetPath: event.paths[0] ?? null,
    eventId: event.eventId,
    message: iv.message ?? null
  })
}

function toCandidateArray(body: unknown): unknown[] {
  if (Array.isArray(body)) return body
  if (body == null) return []
  return [body]
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseIntParam(value: string | null | undefined, fallback: number): number {
  if (value == null || value === '') return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  // since/limit are never meaningfully negative; clamp at the route boundary so a
  // negative never reaches the store (defense-in-depth alongside normalizeSince).
  return parsed < 0 ? 0 : parsed
}

/** Cap on rule string fields so a malformed/oversized rule cannot reach the
 *  plugin file (which the plugin trusts) or bloat the projected JSON. */
const MAX_RULE_FIELD_LEN = 4096
// Control chars have no place in a path glob and would make the projected JSON
// file ambiguous / hard for the plugin to match safely (C0 range + DEL).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

function parseRuleInput(raw: unknown, index: number): RuleInput {
  if (!raw || typeof raw !== 'object') {
    throw badRequest('invalid_rule', `Rule at index ${index} is not an object.`)
  }
  const obj = raw as Record<string, unknown>
  const id = typeof obj.id === 'string' ? obj.id.trim() : ''
  if (!id) throw badRequest('invalid_rule', `Rule at index ${index} is missing a non-empty id.`)
  if (id.length > MAX_RULE_FIELD_LEN) throw badRequest('invalid_rule', `Rule "${id.slice(0, 32)}…" id is too long.`)
  const kind = obj.kind
  if (kind !== 'allow' && kind !== 'deny') {
    throw badRequest('invalid_rule', `Rule "${id}" must have kind 'allow' or 'deny'.`)
  }
  const glob = typeof obj.glob === 'string' ? obj.glob : ''
  if (!glob) throw badRequest('invalid_rule', `Rule "${id}" must have a non-empty glob.`)
  if (glob.length > MAX_RULE_FIELD_LEN) throw badRequest('invalid_rule', `Rule "${id}" glob is too long.`)
  if (CONTROL_CHARS.test(glob)) throw badRequest('invalid_rule', `Rule "${id}" glob contains control characters.`)
  const scope = typeof obj.scope === 'string' && obj.scope.length > 0 ? obj.scope : 'global'
  if (scope.length > MAX_RULE_FIELD_LEN) throw badRequest('invalid_rule', `Rule "${id}" scope is too long.`)
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : true
  return { id, kind: kind as RuleKind, glob, scope, enabled }
}

/** Sanitize an interrupt reason: non-empty string, control chars stripped,
 *  length-capped. Returns null when absent/empty (parity with rule hardening). */
function sanitizeReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, MAX_RULE_FIELD_LEN)
  return cleaned.length > 0 ? cleaned : null
}
