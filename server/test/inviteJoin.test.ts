import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startEmbeddedDatabase, type EmbeddedDatabase } from './helpers/embeddedPostgres.js'
import { apiRequest, bearer, startTestServer, type TestServer } from './helpers/testServer.js'
import { solveChallengePrompt } from '../src/auth/challenge.js'
import type { AgentRegistrationResult } from '../src/types/contracts.js'

/**
 * Invite-code join: registering with an `inviteCode` provisions the new agent
 * INTO that existing workspace as a member, instead of creating a fresh
 * workspace it owns. This is what lets separately-registered agents land in the
 * same workspace and collaborate (@mention) — previously impossible.
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

async function register(body: Record<string, unknown>): ReturnType<typeof apiRequest<AgentRegistrationResult>> {
  const challenge = await apiRequest<Challenge>(server, 'POST', '/api/agents/register/challenge', { useCookies: false })
  expect(challenge.status).toBe(200)
  const answer = solveChallengePrompt(challenge.body.prompt)
  return apiRequest<AgentRegistrationResult>(server, 'POST', '/api/agents/register', {
    body: { challengeId: challenge.body.challengeId, answer, ...body },
    useCookies: false
  })
}

describe('invite-code workspace join', () => {
  let host: AgentRegistrationResult

  it('registering without an invite code creates a fresh owned workspace', async () => {
    const res = await register({ displayName: 'Host Agent', slug: 'host-agent', role: 'orchestrator' })
    expect(res.status).toBe(200)
    host = res.body
    expect(host.workspace.inviteCode).toMatch(/^[A-Z0-9]{10}$/)
    expect(host.workspace.ownerParticipantId).toBe(host.identity.participantId)
  })

  it('registering WITH a valid invite code joins that workspace as a member', async () => {
    const res = await register({ displayName: 'Joiner Agent', slug: 'joiner-agent', inviteCode: host.workspace.inviteCode })
    expect(res.status).toBe(200)
    const joiner = res.body

    // Same workspace, NOT a new one; the host stays the owner.
    expect(joiner.identity.workspaceId).toBe(host.workspace.id)
    expect(joiner.workspace.id).toBe(host.workspace.id)
    expect(joiner.workspace.ownerParticipantId).toBe(host.identity.participantId)
    expect(joiner.identity.participantId).not.toBe(host.identity.participantId)

    // Membership row is 'member', not 'owner'.
    const member = await db.pool.query<{ role: string }>(
      `select role from workspace_members where workspace_id = $1 and participant_id = $2`,
      [host.workspace.id, joiner.identity.participantId]
    )
    expect(member.rows[0]?.role).toBe('member')

    // The joiner is now a first-class agent in the host workspace → discoverable
    // for @mention collaboration, and can read the workspace as a member.
    const agents = await apiRequest<{ agents: { slug: string }[] }>(
      server,
      'GET',
      `/api/workspaces/${host.workspace.id}/agents`,
      { useCookies: false, headers: bearer(joiner.credential.secret) }
    )
    expect(agents.status).toBe(200)
    expect(agents.body.agents.some((a) => a.slug === 'joiner-agent')).toBe(true)
    expect(agents.body.agents.some((a) => a.slug === 'host-agent')).toBe(true)
  })

  it('a slug that collides inside the joined workspace gets a unique suffix', async () => {
    const res = await register({ displayName: 'Joiner Agent', slug: 'joiner-agent', inviteCode: host.workspace.inviteCode })
    expect(res.status).toBe(200)
    // 'joiner-agent' is taken in this workspace → a distinct slug is assigned.
    expect(res.body.identity.slug).not.toBe('joiner-agent')
    expect(res.body.identity.slug.startsWith('joiner-agent')).toBe(true)
    expect(res.body.identity.workspaceId).toBe(host.workspace.id)
  })

  it('an unknown invite code is rejected with 400 invalid_invite_code', async () => {
    const res = await register({ displayName: 'Lost Agent', inviteCode: 'ZZZZ000000' })
    expect(res.status).toBe(400)
    expect((res.body as unknown as { code: string }).code).toBe('invalid_invite_code')
  })
})
