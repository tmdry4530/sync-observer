import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCollectorServer, type CollectorServerHandle } from '../server.js'
import { readCollectorConfig } from '../config.js'
import { Router } from '../../http/router.js'
import { createCollectorStore } from '../store.js'
import { createEventHub } from '../hub.js'
import { registerCollectorRoutes, isLoopback, isOriginAllowed } from '../routes.js'
import type { RequestContext } from '../../http/context.js'
import { isHttpError } from '../../http/errors.js'
import type { ActivityEvent } from '../activityEvent.js'

function validEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    v: 1,
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    ts: new Date().toISOString(),
    agentId: 'hermes:a',
    agentKind: 'hermes',
    sessionId: 'sess-1',
    taskId: null,
    turnId: null,
    action: 'read',
    tool: 'read_file',
    paths: ['/Users/me/project/config.ts'],
    status: 'success',
    cwd: '/Users/me/project',
    gitBranch: 'main',
    correlationId: 'corr-1',
    summary: 'read config.ts',
    detail: null,
    visibleToUser: true,
    ...overrides
  }
}

describe('collector server (boot + ingest + readback over real HTTP)', () => {
  let server: CollectorServerHandle
  let baseUrl: string
  let dir: string
  let rulesFile: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'collector-server-'))
    rulesFile = join(dir, 'rules.json')
    const config = {
      ...readCollectorConfig({
        SYNCSPACE_COLLECTOR_PORT: '0',
        SYNCSPACE_DB_PATH: join(dir, 'collector.db'),
        SYNCSPACE_RULES_FILE: rulesFile
      })
    }
    server = createCollectorServer({ config })
    const address = (await server.start()) as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('accepts a valid event on POST /ingest/events and returns it from GET /api/events?since=0', async () => {
    const ev = validEvent({ eventId: 'boot-evt' })
    const ingest = await fetch(`${baseUrl}/ingest/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ev)
    })
    expect(ingest.status).toBe(200)
    expect(await ingest.json()).toEqual({ accepted: 1, deduped: 0, rejected: 0 })

    const read = await fetch(`${baseUrl}/api/events?since=0`)
    expect(read.status).toBe(200)
    const page = (await read.json()) as { events: ActivityEvent[]; latestSeq: number }
    expect(page.events).toHaveLength(1)
    expect(page.events[0]).toEqual(ev)
    expect(page.latestSeq).toBe(1)
  })

  it('counts good/bad rows and dedups in a mixed batch', async () => {
    const good1 = validEvent({ eventId: 'g1' })
    const good2 = validEvent({ eventId: 'g2' })
    const dup = validEvent({ eventId: 'g1' }) // same id as good1 → deduped
    const bad = { not: 'an event' }
    const res = await fetch(`${baseUrl}/ingest/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([good1, good2, dup, bad])
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accepted: 2, deduped: 1, rejected: 1 })
  })

  it('lists sessions after ingest', async () => {
    await fetch(`${baseUrl}/ingest/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([validEvent({ eventId: 'a', sessionId: 'sx' }), validEvent({ eventId: 'b', sessionId: 'sx' })])
    })
    const res = await fetch(`${baseUrl}/api/sessions`)
    const body = (await res.json()) as { sessions: Array<{ sessionId: string; eventCount: number }> }
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]?.sessionId).toBe('sx')
    expect(body.sessions[0]?.eventCount).toBe(2)
  })

  it('POST /control/rules writes the plugin-format rules file atomically', async () => {
    const res = await fetch(`${baseUrl}/control/rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-syncspace-local': '1' },
      body: JSON.stringify({ id: 'r1', kind: 'deny', glob: '/Users/me/.ssh/**' })
    })
    expect(res.status).toBe(200)

    const onDisk = JSON.parse(readFileSync(rulesFile, 'utf8'))
    expect(onDisk).toEqual({
      rules: [{ id: 'r1', kind: 'deny', glob: '/Users/me/.ssh/**', scope: 'global', enabled: true }]
    })

    // GET /api/rules reflects it.
    const list = await fetch(`${baseUrl}/api/rules`)
    const body = (await list.json()) as { rules: Array<{ id: string }> }
    expect(body.rules.map((r) => r.id)).toEqual(['r1'])
  })

  it('replaceAll via array body + DELETE removes a rule and re-projects', async () => {
    await fetch(`${baseUrl}/control/rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-syncspace-local': '1' },
      body: JSON.stringify([
        { id: 'a', kind: 'allow', glob: '/a/**' },
        { id: 'b', kind: 'deny', glob: '/b/**' }
      ])
    })
    expect(JSON.parse(readFileSync(rulesFile, 'utf8')).rules).toHaveLength(2)

    const del = await fetch(`${baseUrl}/control/rules/a`, {
      method: 'DELETE',
      headers: { 'x-syncspace-local': '1' }
    })
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ deleted: true })
    const onDisk = JSON.parse(readFileSync(rulesFile, 'utf8'))
    expect(onDisk.rules.map((r: { id: string }) => r.id)).toEqual(['b'])
  })

  it('POST /control/rules without X-SyncSpace-Local is rejected (CSRF defense)', async () => {
    const res = await fetch(`${baseUrl}/control/rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'nope', kind: 'deny', glob: '/x/**' })
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('missing_local_header')
  })

  it('POST /control/rules from a disallowed Origin is rejected', async () => {
    const res = await fetch(`${baseUrl}/control/rules`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-syncspace-local': '1',
        origin: 'http://evil.example'
      },
      body: JSON.stringify({ id: 'nope', kind: 'deny', glob: '/x/**' })
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('forbidden_origin')
  })

  it('POST /control/interrupt records an intervention and publishes a cancelled event', async () => {
    const res = await fetch(`${baseUrl}/control/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-syncspace-local': '1' },
      body: JSON.stringify({ agentId: 'hermes:a', sessionId: 'sess-1', reason: 'stop now' })
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { intervention: { mode: string; trigger: string; agentId: string } }
    expect(body.intervention.mode).toBe('interrupt')
    expect(body.intervention.trigger).toBe('manual')
    expect(body.intervention.agentId).toBe('hermes:a')

    // The synthetic cancelled event is in the feed with intervention metadata.
    const read = await fetch(`${baseUrl}/api/events?since=0`)
    const page = (await read.json()) as { events: ActivityEvent[] }
    const cancelled = page.events.find((e) => e.status === 'cancelled')
    expect(cancelled).toBeTruthy()
    expect(cancelled?.detail?.intervention).toMatchObject({ ruleId: null, mode: 'interrupt', trigger: 'manual' })

    // And it is listed under interventions.
    const list = await fetch(`${baseUrl}/api/interventions`)
    const interventions = (await list.json()) as { interventions: unknown[] }
    expect(interventions.interventions).toHaveLength(1)
  })

  it('mirrors an ingested auto-block event into the interventions audit log', async () => {
    // The plugin pre-block arrives via /ingest as a `blocked` event carrying
    // detail.intervention. It MUST also land in /api/interventions, or the audit
    // log would omit the most security-relevant (automatic) blocks.
    const blockedEvent = validEvent({
      eventId: 'auto-block-1',
      status: 'blocked',
      paths: ['/Users/me/.ssh/id_rsa'],
      detail: { intervention: { ruleId: 'ssh', mode: 'block', trigger: 'auto', message: 'blocked .ssh' } }
    })
    await fetch(`${baseUrl}/ingest/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(blockedEvent)
    })

    const list = await fetch(`${baseUrl}/api/interventions`)
    const body = (await list.json()) as {
      interventions: Array<{ trigger: string; mode: string; ruleId: string | null; eventId: string | null; targetPath: string | null }>
    }
    const auto = body.interventions.find((i) => i.eventId === 'auto-block-1')
    expect(auto).toBeTruthy()
    expect(auto?.trigger).toBe('auto')
    expect(auto?.mode).toBe('block')
    expect(auto?.ruleId).toBe('ssh')
    expect(auto?.targetPath).toBe('/Users/me/.ssh/id_rsa')

    // Re-ingesting the same eventId dedups → no duplicate audit row.
    await fetch(`${baseUrl}/ingest/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(blockedEvent)
    })
    const list2 = await fetch(`${baseUrl}/api/interventions`)
    const body2 = (await list2.json()) as { interventions: Array<{ eventId: string | null }> }
    expect(body2.interventions.filter((i) => i.eventId === 'auto-block-1')).toHaveLength(1)
  })

  it('fires the interruptResolver seam', async () => {
    const calls: Array<{ agentId: string; reason: string | null }> = []
    const seamServer = createCollectorServer({
      config: readCollectorConfig({
        SYNCSPACE_COLLECTOR_PORT: '0',
        SYNCSPACE_DB_PATH: join(dir, 'seam.db'),
        SYNCSPACE_RULES_FILE: join(dir, 'seam-rules.json')
      }),
      interruptResolver: async (req) => {
        calls.push({ agentId: req.agentId, reason: req.reason })
      }
    })
    const addr = (await seamServer.start()) as AddressInfo
    try {
      await fetch(`http://127.0.0.1:${addr.port}/control/interrupt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-syncspace-local': '1' },
        body: JSON.stringify({ agentId: 'hermes:z', reason: 'halt' })
      })
      // The resolver runs detached; give the microtask queue a tick.
      await new Promise((r) => setTimeout(r, 20))
      expect(calls).toEqual([{ agentId: 'hermes:z', reason: 'halt' }])
    } finally {
      await seamServer.stop()
    }
  })

  it('POST /control/interrupt enqueues a pending row that GET /control/pending then drains', async () => {
    await fetch(`${baseUrl}/control/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-syncspace-local': '1' },
      body: JSON.stringify({ agentId: 'hermes:p', sessionId: 'sess-p', reason: 'halt' })
    })

    const pending = await fetch(`${baseUrl}/control/pending?agentId=hermes:p&sessionId=sess-p`, {
      headers: { 'x-syncspace-local': '1' }
    })
    expect(pending.status).toBe(200)
    const body = (await pending.json()) as { interrupts: Array<{ id: number; reason: string | null }> }
    expect(body.interrupts).toHaveLength(1)
    expect(body.interrupts[0]?.reason).toBe('halt')

    // Consume-once: a second drain returns nothing.
    const again = await fetch(`${baseUrl}/control/pending?agentId=hermes:p`, {
      headers: { 'x-syncspace-local': '1' }
    })
    expect(((await again.json()) as { interrupts: unknown[] }).interrupts).toHaveLength(0)
  })

  it('GET /control/pending without X-SyncSpace-Local is rejected (CSRF defense)', async () => {
    const res = await fetch(`${baseUrl}/control/pending?agentId=hermes:p`)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('missing_local_header')
  })

  it('GET /control/pending without agentId is a 400', async () => {
    const res = await fetch(`${baseUrl}/control/pending`, { headers: { 'x-syncspace-local': '1' } })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('missing_agent_id')
  })

  it('sanitizes the interrupt reason (control chars collapsed, trimmed)', async () => {
    await fetch(`${baseUrl}/control/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-syncspace-local': '1' },
      body: JSON.stringify({ agentId: 'hermes:san', reason: 'bad reason\n' })
    })
    const pending = await fetch(`${baseUrl}/control/pending?agentId=hermes:san`, {
      headers: { 'x-syncspace-local': '1' }
    })
    const body = (await pending.json()) as { interrupts: Array<{ reason: string | null }> }
    expect(body.interrupts[0]?.reason).toBe('bad reason')
  })

  it('GET /api/stream replays prior events as SSE frames with seq ids', async () => {
    await fetch(`${baseUrl}/ingest/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validEvent({ eventId: 'sse-1' }))
    })
    const controller = new AbortController()
    const res = await fetch(`${baseUrl}/api/stream`, { signal: controller.signal })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    const chunk = new TextDecoder().decode(value)
    expect(chunk).toContain('id: 1')
    expect(chunk).toContain('event: activity')
    expect(chunk).toContain('"eventId":"sse-1"')
    controller.abort()
    await reader.cancel().catch(() => undefined)
  })
})

// ---------------------------------------------------------------------------
// Loopback rejection — exercised by invoking the handler directly with a
// fabricated context whose socket reports a non-loopback remote address (we
// cannot bind a real off-host client in a unit test).
// ---------------------------------------------------------------------------

describe('collector loopback enforcement', () => {
  function buildContext(opts: {
    method: string
    pathname: string
    remoteAddress: string
    headers?: Record<string, string>
  }): RequestContext {
    const headers = opts.headers ?? {}
    return {
      req: { socket: { remoteAddress: opts.remoteAddress }, headers, on: () => undefined } as never,
      res: { writeHead: () => undefined, end: () => undefined, write: () => undefined, on: () => undefined } as never,
      method: opts.method,
      url: new URL(`http://127.0.0.1${opts.pathname}`),
      pathname: opts.pathname,
      query: new URLSearchParams(),
      params: {},
      cookies: {},
      ip: opts.remoteAddress,
      auth: null,
      rawBody: async () => Buffer.alloc(0),
      json: async () => ({}) as never,
      header: (name: string) => headers[name.toLowerCase()] ?? null
    }
  }

  it('rejects a non-loopback caller on a read route', async () => {
    const router = new Router()
    const store = createCollectorStore(':memory:')
    const hub = createEventHub()
    registerCollectorRoutes(router, { store, hub, rulesFilePath: ':memory:', allowedOrigins: ['*'] })

    const match = router.match('GET', '/api/events')!
    const ctx = buildContext({ method: 'GET', pathname: '/api/events', remoteAddress: '203.0.113.7' })
    // The read handler is synchronous, so it throws straight away; capture it.
    await expect(async () => match.handler(ctx)).rejects.toSatisfy((err: unknown) => {
      return isHttpError(err) && err.code === 'not_loopback' && err.status === 403
    })
    store.close()
  })

  it('rejects a non-loopback caller on an ingest route but allows loopback', async () => {
    const router = new Router()
    const store = createCollectorStore(':memory:')
    const hub = createEventHub()
    registerCollectorRoutes(router, { store, hub, rulesFilePath: ':memory:', allowedOrigins: ['*'] })

    const match = router.match('POST', '/ingest/events')!
    const offHost = buildContext({ method: 'POST', pathname: '/ingest/events', remoteAddress: '10.0.0.5' })
    await expect(Promise.resolve(match.handler(offHost))).rejects.toSatisfy((err: unknown) => {
      return isHttpError(err) && err.code === 'not_loopback'
    })

    // IPv4-mapped IPv6 loopback is accepted.
    const mapped = buildContext({ method: 'POST', pathname: '/ingest/events', remoteAddress: '::ffff:127.0.0.1' })
    mapped.json = async () => validEvent({ eventId: 'loop-ok' }) as never
    const ok = await match.handler(mapped)
    expect(ok).toBeTruthy()
    store.close()
  })
})

// ---------------------------------------------------------------------------
// Security-review regression locks (M2 review: HIGH-1, MEDIUM-1/2/3, finding B).
// ---------------------------------------------------------------------------

describe('isLoopback (HIGH-1: full 127.0.0.0/8, no hostname trust)', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.0.0.2', true],
    ['127.1.2.3', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['localhost', false], // hostname string must NOT be trusted
    ['10.0.0.1', false],
    ['128.0.0.1', false],
    ['126.255.255.255', false],
    ['127.999.0.1', false], // invalid octet
    ['127.0.0', false], // not a dotted quad
    ['', false],
    [undefined, false]
  ])('isLoopback(%s) === %s', (addr, expected) => {
    expect(isLoopback(addr as string | undefined)).toBe(expected)
  })
})

describe('isOriginAllowed (MEDIUM-1: no null/null collision)', () => {
  it('two unparseable strings do NOT match', () => {
    expect(isOriginAllowed('garbage', ['also-garbage'])).toBe(false)
  })
  it('valid allowed origin matches', () => {
    expect(isOriginAllowed('http://localhost:5173', ['http://localhost:5173'])).toBe(true)
  })
  it('valid disallowed origin does not match', () => {
    expect(isOriginAllowed('http://evil.example', ['http://localhost:5173'])).toBe(false)
  })
  it('wildcard allows anything', () => {
    expect(isOriginAllowed('http://anything', ['*'])).toBe(true)
  })
})

describe('rule input hardening (MEDIUM-2) + lenient ingest cap (finding B)', () => {
  let server: CollectorServerHandle
  let baseUrl: string
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'collector-sec-'))
    server = createCollectorServer({
      config: readCollectorConfig({
        SYNCSPACE_COLLECTOR_PORT: '0',
        SYNCSPACE_DB_PATH: join(dir, 'sec.db'),
        SYNCSPACE_RULES_FILE: join(dir, 'sec-rules.json')
      })
    })
    const address = (await server.start()) as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  const postRule = (rule: unknown) =>
    fetch(`${baseUrl}/control/rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-syncspace-local': '1' },
      body: JSON.stringify([rule])
    })

  it('rejects a glob containing control characters', async () => {
    const res = await postRule({ id: 'bad', kind: 'deny', glob: '/tmp/\n/x', scope: 'global', enabled: true })
    expect(res.status).toBe(400)
  })

  it('rejects an over-long glob', async () => {
    const res = await postRule({ id: 'long', kind: 'deny', glob: 'x'.repeat(5000), scope: 'global', enabled: true })
    expect(res.status).toBe(400)
  })

  it('caps the lenient ingest path at 1000 and counts the overflow as rejected', async () => {
    // 1001 valid events + 1 invalid row → strict batch parse (array .max 1000)
    // fails → lenient per-row path, which must still cap at 1000.
    const many: unknown[] = Array.from({ length: 1001 }, (_, i) => validEvent({ eventId: `cap-${i}` }))
    many.push({ garbage: true })
    const res = await fetch(`${baseUrl}/ingest/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(many)
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { accepted: number; deduped: number; rejected: number }
    expect(body.accepted).toBeLessThanOrEqual(1000)
    expect(body.rejected).toBeGreaterThanOrEqual(2) // ≥1 overflow + 1 garbage
  })
})

describe('CORS for the local dashboard (LOW-4)', () => {
  let server: CollectorServerHandle
  let baseUrl: string
  let dir: string
  const ORIGIN = 'http://localhost:5173'

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'collector-cors-'))
    server = createCollectorServer({
      config: readCollectorConfig({
        SYNCSPACE_COLLECTOR_PORT: '0',
        SYNCSPACE_DB_PATH: join(dir, 'cors.db'),
        SYNCSPACE_RULES_FILE: join(dir, 'cors-rules.json')
      })
    })
    const address = (await server.start()) as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('preflight from an allowed origin permits the X-SyncSpace-Local header', async () => {
    const res = await fetch(`${baseUrl}/control/rules`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-headers': 'x-syncspace-local' }
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect((res.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain('x-syncspace-local')
  })

  it('reflects ACAO for an allowed origin and omits it for a disallowed one', async () => {
    const allowed = await fetch(`${baseUrl}/api/events?since=0`, { headers: { origin: ORIGIN } })
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    const denied = await fetch(`${baseUrl}/api/events?since=0`, { headers: { origin: 'http://evil.example' } })
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  })
})
