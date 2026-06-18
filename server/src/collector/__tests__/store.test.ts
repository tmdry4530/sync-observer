import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCollectorStore, type CollectorStore } from '../store.js'
import { readRulesFile, writeRulesFile } from '../rulesFile.js'
import type { ActivityEvent } from '../activityEvent.js'

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
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

describe('collector store (node:sqlite)', () => {
  let store: CollectorStore

  beforeEach(() => {
    store = createCollectorStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  it('inserts an event and reads it back with the exact ActivityEvent shape', () => {
    const ev = makeEvent({
      eventId: 'evt-roundtrip',
      detail: { intervention: { ruleId: 'r1', mode: 'block', trigger: 'auto' } },
      paths: ['/a', '/b']
    })
    const result = store.insertEvent(ev)
    expect(result.inserted).toBe(true)
    expect(result.seq).toBe(1)

    const page = store.getEventsSince(0)
    expect(page.events).toHaveLength(1)
    expect(page.events[0]).toEqual(ev)
    expect(page.latestSeq).toBe(1)
  })

  it('dedups the same eventId (INSERT OR IGNORE) — second insert returns inserted=false', () => {
    const ev = makeEvent({ eventId: 'evt-dup' })
    const first = store.insertEvent(ev)
    const second = store.insertEvent({ ...ev, summary: 'changed but same id' })
    expect(first.inserted).toBe(true)
    expect(second.inserted).toBe(false)
    expect(second.seq).toBeNull()
    expect(store.getEventsSince(0).events).toHaveLength(1)
  })

  it('coerces visibleToUser 0/1 column back to a boolean', () => {
    store.insertEvent(makeEvent({ eventId: 'visible', visibleToUser: true }))
    store.insertEvent(makeEvent({ eventId: 'hidden', visibleToUser: false }))
    const events = store.getEventsSince(0).events
    const visible = events.find((e) => e.eventId === 'visible')
    const hidden = events.find((e) => e.eventId === 'hidden')
    expect(visible?.visibleToUser).toBe(true)
    expect(hidden?.visibleToUser).toBe(false)
  })

  it('paginates getEventsSince ascending with latestSeq tracking', () => {
    for (let i = 0; i < 5; i += 1) {
      store.insertEvent(makeEvent({ eventId: `seq-${i}` }))
    }
    const firstTwo = store.getEventsSince(0, 2)
    expect(firstTwo.events.map((e) => e.eventId)).toEqual(['seq-0', 'seq-1'])
    expect(firstTwo.latestSeq).toBe(5)

    const next = store.getEventsSince(2, 2)
    expect(next.events.map((e) => e.eventId)).toEqual(['seq-2', 'seq-3'])

    const tail = store.getEventsSince(4)
    expect(tail.events.map((e) => e.eventId)).toEqual(['seq-4'])
    expect(tail.latestSeq).toBe(5)
  })

  it('clamps the limit to 1..1000', () => {
    for (let i = 0; i < 3; i += 1) store.insertEvent(makeEvent({ eventId: `c-${i}` }))
    expect(store.getEventsSince(0, 0).events).toHaveLength(1)
    expect(store.getEventsSince(0, 9999).events).toHaveLength(3)
  })

  it('getEventsSinceWithSeq returns events paired with their seq', () => {
    store.insertEvent(makeEvent({ eventId: 'ws-0' }))
    store.insertEvent(makeEvent({ eventId: 'ws-1' }))
    const withSeq = store.getEventsSinceWithSeq(0)
    expect(withSeq.map((r) => [r.seq, r.event.eventId])).toEqual([
      [1, 'ws-0'],
      [2, 'ws-1']
    ])
  })

  it('lists sessions grouped with counts, lastTs and lastSeq', () => {
    store.insertEvent(makeEvent({ eventId: 's1-a', sessionId: 'sess-1', ts: '2026-01-01T00:00:00.000Z' }))
    store.insertEvent(makeEvent({ eventId: 's1-b', sessionId: 'sess-1', ts: '2026-01-01T00:00:01.000Z' }))
    store.insertEvent(makeEvent({ eventId: 's2-a', sessionId: 'sess-2', agentId: 'hermes:b', ts: '2026-01-01T00:00:02.000Z' }))
    store.insertEvent(makeEvent({ eventId: 'no-session', sessionId: null }))

    const sessions = store.listSessions()
    expect(sessions).toHaveLength(2)
    // Ordered by lastSeq DESC → sess-2 first (its event was inserted last among sessions).
    expect(sessions[0]?.sessionId).toBe('sess-2')
    const s1 = sessions.find((s) => s.sessionId === 'sess-1')
    expect(s1?.eventCount).toBe(2)
    expect(s1?.lastTs).toBe('2026-01-01T00:00:01.000Z')
    expect(s1?.agentId).toBe('hermes:a')
  })

  it('returns per-session events via getSessionEvents', () => {
    store.insertEvent(makeEvent({ eventId: 'x1', sessionId: 'sx' }))
    store.insertEvent(makeEvent({ eventId: 'y1', sessionId: 'sy' }))
    store.insertEvent(makeEvent({ eventId: 'x2', sessionId: 'sx' }))
    const page = store.getSessionEvents('sx', 0)
    expect(page.events.map((e) => e.eventId)).toEqual(['x1', 'x2'])
  })

  it('upserts and deletes rules', () => {
    const created = store.upsertRule({ id: 'r1', kind: 'deny', glob: '/etc/**' })
    expect(created.scope).toBe('global')
    expect(created.enabled).toBe(true)
    expect(created.createdAt).toBe(created.updatedAt)

    const updated = store.upsertRule({ id: 'r1', kind: 'allow', glob: '/etc/passwd', enabled: false })
    expect(updated.kind).toBe('allow')
    expect(updated.enabled).toBe(false)
    // createdAt preserved across upsert.
    expect(updated.createdAt).toBe(created.createdAt)

    expect(store.listRules()).toHaveLength(1)
    expect(store.deleteRule('r1')).toBe(true)
    expect(store.deleteRule('r1')).toBe(false)
    expect(store.listRules()).toHaveLength(0)
  })

  it('replaceAllRules swaps the whole table atomically', () => {
    store.upsertRule({ id: 'old', kind: 'deny', glob: '/old/**' })
    const next = store.replaceAllRules([
      { id: 'a', kind: 'allow', glob: '/a/**', scope: 'session:s1' },
      { id: 'b', kind: 'deny', glob: '/b/**' }
    ])
    expect(next.map((r) => r.id).sort()).toEqual(['a', 'b'])
    expect(store.listRules().find((r) => r.id === 'a')?.scope).toBe('session:s1')
  })

  it('records and lists interventions newest-first', () => {
    const rec = store.insertIntervention({
      ts: new Date().toISOString(),
      agentId: 'hermes:a',
      sessionId: 'sess-1',
      mode: 'interrupt',
      trigger: 'manual',
      message: 'stop'
    })
    expect(rec.id).toBe(1)
    expect(rec.mode).toBe('interrupt')
    expect(rec.message).toBe('stop')
    store.insertIntervention({ ts: new Date().toISOString(), agentId: 'hermes:a', mode: 'block', trigger: 'auto' })
    const list = store.listInterventions()
    expect(list).toHaveLength(2)
    expect(list[0]?.mode).toBe('block') // newest first
  })

  it('enqueues a pending interrupt and consumes it once (second consume returns [])', () => {
    const { id } = store.enqueueInterrupt({ agentId: 'hermes:a', sessionId: 'sess-1', reason: 'stop' })
    expect(id).toBe(1)

    const first = store.consumePending('hermes:a', 'sess-1')
    expect(first).toHaveLength(1)
    expect(first[0]?.id).toBe(id)
    expect(first[0]?.reason).toBe('stop')
    expect(typeof first[0]?.createdAt).toBe('string')

    // Consume-once: the same row is not returned again.
    expect(store.consumePending('hermes:a', 'sess-1')).toEqual([])
  })

  it('scopes pending interrupts by agentId (agent A row is not returned for agent B)', () => {
    store.enqueueInterrupt({ agentId: 'hermes:a', reason: 'for-a' })
    expect(store.consumePending('hermes:b')).toEqual([])
    const forA = store.consumePending('hermes:a')
    expect(forA).toHaveLength(1)
    expect(forA[0]?.reason).toBe('for-a')
  })

  it('matches a session-scoped pending row by its session AND when no session is queried', () => {
    store.enqueueInterrupt({ agentId: 'hermes:a', sessionId: 'sess-1', reason: 's1' })
    // Queried with the matching sessionId.
    const bySession = store.consumePending('hermes:a', 'sess-1')
    expect(bySession.map((r) => r.reason)).toEqual(['s1'])

    // Re-enqueue and consume with NO sessionId → still matched (regardless of session).
    store.enqueueInterrupt({ agentId: 'hermes:a', sessionId: 'sess-1', reason: 's1-again' })
    const noSession = store.consumePending('hermes:a')
    expect(noSession.map((r) => r.reason)).toEqual(['s1-again'])
  })

  it('does NOT return a session-scoped row when a DIFFERENT session is queried', () => {
    store.enqueueInterrupt({ agentId: 'hermes:a', sessionId: 'sess-1', reason: 's1' })
    expect(store.consumePending('hermes:a', 'sess-2')).toEqual([])
    // The row is still pending (not consumed by the mismatched query).
    expect(store.consumePending('hermes:a', 'sess-1').map((r) => r.reason)).toEqual(['s1'])
  })

  it('always returns a NULL-session pending row for its agent (session-specific query too)', () => {
    store.enqueueInterrupt({ agentId: 'hermes:a', sessionId: null, reason: 'global-stop' })
    // A NULL session_id row matches a specific-session query.
    const bySession = store.consumePending('hermes:a', 'sess-x')
    expect(bySession.map((r) => r.reason)).toEqual(['global-stop'])

    // And it matches a no-session query.
    store.enqueueInterrupt({ agentId: 'hermes:a', sessionId: null, reason: 'global-stop-2' })
    const noSession = store.consumePending('hermes:a')
    expect(noSession.map((r) => r.reason)).toEqual(['global-stop-2'])
  })
})

describe('pending interrupt TTL (stale never fires + is purged)', () => {
  it('excludes and purges interrupts older than the TTL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pending-ttl-'))
    const dbPath = join(dir, 'c.db')
    const store = createCollectorStore(dbPath)
    try {
      store.enqueueInterrupt({ agentId: 'hermes:stale', reason: 'old' })
      // Backdate created_at to 10 min ago (> 5 min TTL) via a raw connection.
      const raw = new DatabaseSync(dbPath)
      const old = new Date(Date.now() - 10 * 60_000).toISOString()
      raw.prepare('UPDATE pending_interrupts SET created_at = ? WHERE agent_id = ?').run(old, 'hermes:stale')
      raw.close()

      // Stale row is NOT delivered (TTL filter)...
      expect(store.consumePending('hermes:stale')).toEqual([])
      // ...and was purged: a fresh enqueue then consume returns only the new one.
      store.enqueueInterrupt({ agentId: 'hermes:stale', reason: 'fresh' })
      expect(store.consumePending('hermes:stale').map((r) => r.reason)).toEqual(['fresh'])
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('rules-file projection (plugin format)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'collector-rules-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the plugin-exact format (only id/kind/glob/scope/enabled)', () => {
    const store = createCollectorStore(':memory:')
    store.upsertRule({ id: 'r1', kind: 'deny', glob: '/Users/me/.ssh/**', scope: 'global', enabled: true })
    const path = join(dir, 'rules.json')
    writeRulesFile(path, store.listRules())

    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    expect(parsed).toEqual({
      rules: [{ id: 'r1', kind: 'deny', glob: '/Users/me/.ssh/**', scope: 'global', enabled: true }]
    })
    // No control-plane-only fields leak into the plugin file.
    expect(parsed.rules[0]).not.toHaveProperty('createdAt')
    expect(parsed.rules[0]).not.toHaveProperty('updatedAt')
    store.close()
  })

  it('round-trips write → read back into RuleInput records', () => {
    const path = join(dir, 'rules.json')
    const store = createCollectorStore(':memory:')
    store.replaceAllRules([
      { id: 'a', kind: 'allow', glob: '/a/**', scope: 'agent:hermes:x', enabled: true },
      { id: 'b', kind: 'deny', glob: '/b/**', scope: 'global', enabled: false }
    ])
    writeRulesFile(path, store.listRules())

    const seeded = readRulesFile(path)
    expect(seeded).toEqual([
      { id: 'a', kind: 'allow', glob: '/a/**', scope: 'agent:hermes:x', enabled: true },
      { id: 'b', kind: 'deny', glob: '/b/**', scope: 'global', enabled: false }
    ])
    store.close()
  })

  it('tolerates a missing or corrupt rules file (returns [])', () => {
    expect(readRulesFile(join(dir, 'does-not-exist.json'))).toEqual([])
    const bad = join(dir, 'corrupt.json')
    // Deliberately bypass the atomic writer to plant a corrupt file.
    writeFileSync(bad, '{ not valid json', 'utf8')
    expect(readRulesFile(bad)).toEqual([])
  })
})
