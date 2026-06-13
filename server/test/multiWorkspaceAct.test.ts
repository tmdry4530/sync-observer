import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startEmbeddedDatabase, type EmbeddedDatabase } from './helpers/embeddedPostgres.js'
import { apiRequest, bearer, startTestServer, type TestServer } from './helpers/testServer.js'
import { solveChallengePrompt } from '../src/auth/challenge.js'
import type { AgentRegistrationResult } from '../src/types/contracts.js'

/**
 * Multi-workspace ACTING: one identity (credential) can not only READ joined
 * workspaces but ACT in them — be @mentionable and run tasks — through a
 * per-workspace PRESENCE agent whose credential_participant_id is the joining
 * identity's home participant. The cross-workspace IDOR boundary (404 for
 * non-members) is preserved, and acting in the home workspace still works.
 */

let db: EmbeddedDatabase
let server: TestServer

beforeAll(async () => {
  db = await startEmbeddedDatabase()
  server = await startTestServer(db)
}, 90_000)

afterAll(async () => {
  await server?.stop()
  await db?.stop()
})

interface Challenge {
  challengeId: string
  prompt: string
  expiresAt: string
}

async function register(displayName: string, slug: string): Promise<AgentRegistrationResult> {
  const ch = await apiRequest<Challenge>(server, 'POST', '/api/agents/register/challenge', { useCookies: false })
  expect(ch.status).toBe(200)
  const answer = solveChallengePrompt(ch.body.prompt)
  const res = await apiRequest<AgentRegistrationResult>(server, 'POST', '/api/agents/register', {
    body: { challengeId: ch.body.challengeId, answer, displayName, slug },
    useCookies: false
  })
  expect(res.status).toBe(200)
  return res.body
}

describe('multi-workspace acting via credential presence', () => {
  let a: AgentRegistrationResult // home WS1
  let b: AgentRegistrationResult // home WS2 (the workspace A joins)
  let c: AgentRegistrationResult // home WS3, a non-member of WS2

  beforeAll(async () => {
    a = await register('Agent A', 'agent-a')
    b = await register('Agent B', 'agent-b')
    c = await register('Agent C', 'agent-c')
  }, 60_000)

  it('migration backfill: every pre-existing agent self-owns its credential identity', async () => {
    // After 0021, every agent.credential_participant_id equals its OWN
    // participant. Registration seeds the default roster too, so this covers many
    // rows created before any join/presence logic ran for this identity.
    const rows = await db.pool.query<{ agent_id: string; mismatched: number }>(
      `select count(*)::int as mismatched
       from agents a
       join participants p on p.agent_id = a.id
       where a.credential_participant_id is distinct from p.id`
    )
    expect(rows.rows[0]?.mismatched).toBe(0)
  })

  it('A joins B’s workspace and gains an actable presence agent there', async () => {
    const res = await apiRequest<{ workspace: { id: string } }>(server, 'POST', '/api/workspaces/join', {
      body: { inviteCode: b.workspace.inviteCode },
      useCookies: false,
      headers: bearer(a.credential.secret)
    })
    expect(res.status).toBe(200)
    expect(res.body.workspace.id).toBe(b.workspace.id)

    // A presence agent exists in WS2 whose credential_participant_id is A's
    // identity participant (NOT a brand-new self-owning participant).
    const presence = await db.pool.query<{ id: string; participant_id: string; credential_participant_id: string }>(
      `select a.id, p.id as participant_id, a.credential_participant_id
       from agents a
       join participants p on p.agent_id = a.id
       where a.workspace_id = $1 and a.credential_participant_id = $2`,
      [b.workspace.id, a.identity.participantId]
    )
    expect(presence.rows).toHaveLength(1)
    expect(presence.rows[0]?.credential_participant_id).toBe(a.identity.participantId)
    // The presence is its own agent row with its own participant, distinct from
    // A's home agent participant.
    expect(presence.rows[0]?.participant_id).not.toBe(a.identity.participantId)
  })

  it('joining again is idempotent (no duplicate presence agent)', async () => {
    const res = await apiRequest(server, 'POST', '/api/workspaces/join', {
      body: { inviteCode: b.workspace.inviteCode },
      useCookies: false,
      headers: bearer(a.credential.secret)
    })
    expect(res.status).toBe(200)
    const presence = await db.pool.query(
      `select 1 from agents where workspace_id = $1 and credential_participant_id = $2`,
      [b.workspace.id, a.identity.participantId]
    )
    expect(presence.rows).toHaveLength(1)
  })

  it('A can ACT in B’s workspace: invoke a roster agent → task scoped to WS2, authored by A’s presence', async () => {
    const invoke = await apiRequest<{ task: { id: string } }>(
      server,
      'POST',
      `/api/workspaces/${b.workspace.id}/invoke`,
      {
        body: { slug: 'planner', content: 'Plan the sprint in B’s workspace.' },
        useCookies: false,
        headers: bearer(a.credential.secret)
      }
    )
    expect(invoke.status).toBe(200)
    const taskId = invoke.body.task.id
    expect(taskId).toBeTruthy()

    // A's presence participant in WS2 authored the task; the task lives in WS2.
    const presence = await db.pool.query<{ participant_id: string }>(
      `select p.id as participant_id
       from agents a join participants p on p.agent_id = a.id
       where a.workspace_id = $1 and a.credential_participant_id = $2`,
      [b.workspace.id, a.identity.participantId]
    )
    const presenceParticipantId = presence.rows[0]?.participant_id
    expect(presenceParticipantId).toBeTruthy()

    const task = await db.pool.query<{ workspace_id: string; created_by_participant_id: string | null }>(
      `select workspace_id, created_by_participant_id from a2a_tasks where id = $1`,
      [taskId]
    )
    expect(task.rows[0]?.workspace_id).toBe(b.workspace.id)
    expect(task.rows[0]?.created_by_participant_id).toBe(presenceParticipantId)
  })

  it('a non-member (C) still gets 404 invoking in B’s workspace (IDOR preserved)', async () => {
    const res = await apiRequest(server, 'POST', `/api/workspaces/${b.workspace.id}/invoke`, {
      body: { slug: 'planner', content: 'I should not be here.' },
      useCookies: false,
      headers: bearer(c.credential.secret)
    })
    expect(res.status).toBe(404)
  })

  it('regression: A can still act in its OWN home workspace WS1', async () => {
    const invoke = await apiRequest<{ task: { id: string } }>(
      server,
      'POST',
      `/api/workspaces/${a.workspace.id}/invoke`,
      {
        body: { slug: 'planner', content: 'Plan at home.' },
        useCookies: false,
        headers: bearer(a.credential.secret)
      }
    )
    expect(invoke.status).toBe(200)
    const task = await db.pool.query<{ workspace_id: string; created_by_participant_id: string | null }>(
      `select workspace_id, created_by_participant_id from a2a_tasks where id = $1`,
      [invoke.body.task.id]
    )
    expect(task.rows[0]?.workspace_id).toBe(a.workspace.id)
    // In the home workspace the acting presence IS the home agent, so authorship
    // is A's home participant.
    expect(task.rows[0]?.created_by_participant_id).toBe(a.identity.participantId)
  })
})
