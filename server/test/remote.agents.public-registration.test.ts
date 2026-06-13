import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { solveChallengePrompt } from '../src/auth/challenge.js'
import type { AuthAgentIdentity, ExternalAgentRegistrationResult, RegistrationChallenge } from '../src/types/contracts.js'
import { startEmbeddedDatabase, type EmbeddedDatabase } from './helpers/embeddedPostgres.js'
import { apiRequest, startTestServer, type TestServer } from './helpers/testServer.js'

let db: EmbeddedDatabase
let server: TestServer
let stub: RemoteStub
// Captured from the first self-registration; reused by the invite-join case.
let firstResult: ExternalAgentRegistrationResult

interface RemoteStub {
  server: Server
  origin: string
  cardUrl: string
  close(): Promise<void>
}

async function startRemoteStub(): Promise<RemoteStub> {
  let origin = ''
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? ''
    if (req.method === 'GET' && url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          name: 'SelfRegisterBot',
          description: 'Externally-operated A2A agent that registers itself',
          url: `${origin}/a2a`,
          protocolVersion: '1.0',
          skills: [{ id: 'research', name: 'Research' }],
          capabilities: { streaming: false, pushNotifications: false }
        })
      )
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  origin = `http://127.0.0.1:${port}`
  return {
    server: httpServer,
    origin,
    cardUrl: `${origin}/.well-known/agent-card.json`,
    close: () => new Promise((resolve) => httpServer.close(() => resolve()))
  }
}

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` }
}

async function requestPublicChallenge(): Promise<RegistrationChallenge> {
  const challenge = await apiRequest<RegistrationChallenge>(server, 'POST', '/api/v1/agents/register/challenge', {
    useCookies: false
  })
  expect(challenge.status).toBe(200)
  return challenge.body
}

beforeAll(async () => {
  process.env.A2A_ALLOW_INSECURE_WEBHOOKS = 'true'
  db = await startEmbeddedDatabase()
  server = await startTestServer(db)
  stub = await startRemoteStub()
}, 90_000)

afterAll(async () => {
  await stub?.close()
  await server?.stop()
  await db?.stop()
  delete process.env.A2A_ALLOW_INSECURE_WEBHOOKS
})

describe('public external agent self-registration', () => {
  it('lets an external A2A agent create its own account from the public skill flow', async () => {
    const challenge = await requestPublicChallenge()
    const answer = solveChallengePrompt(challenge.prompt)

    const registered = await apiRequest<ExternalAgentRegistrationResult>(server, 'POST', '/api/v1/agents/register', {
      body: {
        challengeId: challenge.challengeId,
        answer,
        agentCardUrl: stub.cardUrl,
        workspaceName: 'Self Register Workspace'
      },
      useCookies: false
    })
    expect(registered.status).toBe(200)
    expect(registered.body.identity.kind).toBe('external')
    expect(registered.body.identity.role).toBeUndefined()
    expect(registered.body.credential.agentId).toBe(registered.body.identity.agentId)
    expect(registered.body.credential.secret).toBeTruthy()
    expect(registered.body.workspace.ownerParticipantId).toBe(registered.body.identity.participantId)
    firstResult = registered.body
    expect(registered.body.agent.endpointUrl).toBe(`${stub.origin}/a2a`)
    expect(registered.body.verification.url).toBe(`${stub.origin}/.well-known/syncspace-verify.txt`)
    expect(registered.body.verification.token).toMatch(/^syncspace-verify=[A-Za-z0-9_-]+$/)

    const remoteRows = await db.pool.query<{
      workspace_id: string
      owner_participant_id: string
      verification_status: string
    }>(
      `select workspace_id, owner_participant_id, verification_status
       from remote_agents
       where id = $1`,
      [registered.body.credential.agentId]
    )
    expect(remoteRows.rows[0]).toMatchObject({
      workspace_id: registered.body.workspace.id,
      owner_participant_id: registered.body.identity.participantId,
      verification_status: 'pending'
    })

    const tokenRows = await db.pool.query<{ count: string }>(
      `select count(*)::text as count from remote_agent_tokens where remote_agent_id = $1 and revoked_at is null`,
      [registered.body.credential.agentId]
    )
    expect(tokenRows.rows[0]?.count).toBe('1')

    const participantRows = await db.pool.query<{ participant_type: string; remote_agent_id: string }>(
      `select participant_type, remote_agent_id
       from participants
       where id = $1`,
      [registered.body.identity.participantId]
    )
    expect(participantRows.rows[0]).toMatchObject({
      participant_type: 'agent',
      remote_agent_id: registered.body.credential.agentId
    })

    const memberRows = await db.pool.query<{ role: string }>(
      `select role from workspace_members where workspace_id = $1 and participant_id = $2`,
      [registered.body.workspace.id, registered.body.identity.participantId]
    )
    expect(memberRows.rows[0]?.role).toBe('owner')

    const me = await apiRequest<{ identity: AuthAgentIdentity | null }>(server, 'GET', '/api/auth/me')
    expect(me.status).toBe(200)
    expect(me.body.identity?.kind).toBe('external')
    expect(me.body.identity?.agentId).toBe(registered.body.credential.agentId)

    const login = await apiRequest<{ identity: AuthAgentIdentity }>(server, 'POST', '/api/auth/agent-login', {
      body: registered.body.credential,
      useCookies: false
    })
    expect(login.status).toBe(200)
    expect(login.body.identity.kind).toBe('external')
    expect(login.body.identity.agentId).toBe(registered.body.credential.agentId)

    const status = await apiRequest<{ status: string; identity: AuthAgentIdentity }>(
      server,
      'GET',
      '/api/v1/agents/status',
      {
        useCookies: false,
        headers: bearer(registered.body.credential.secret)
      }
    )
    expect(status.status).toBe(200)
    expect(status.body.status).toBe('pending')
    expect(status.body.identity.kind).toBe('external')
    expect(status.body.identity.agentId).toBe(registered.body.credential.agentId)
  })

  it('an external agent registering WITH an invite code joins that workspace as a member', async () => {
    const challenge = await requestPublicChallenge()
    const answer = solveChallengePrompt(challenge.prompt)

    const joined = await apiRequest<ExternalAgentRegistrationResult>(server, 'POST', '/api/v1/agents/register', {
      body: {
        challengeId: challenge.challengeId,
        answer,
        agentCardUrl: stub.cardUrl,
        inviteCode: firstResult.workspace.inviteCode
      },
      useCookies: false
    })
    expect(joined.status).toBe(200)
    // Joined the existing workspace, not a new one; original owner is preserved.
    expect(joined.body.workspace.id).toBe(firstResult.workspace.id)
    expect(joined.body.identity.workspaceId).toBe(firstResult.workspace.id)
    expect(joined.body.workspace.ownerParticipantId).toBe(firstResult.identity.participantId)
    // Same card name → slug collides in the joined workspace → unique suffix.
    expect(joined.body.identity.slug).not.toBe(firstResult.identity.slug)

    const member = await db.pool.query<{ role: string }>(
      `select role from workspace_members where workspace_id = $1 and participant_id = $2`,
      [firstResult.workspace.id, joined.body.identity.participantId]
    )
    expect(member.rows[0]?.role).toBe('member')
  })

  it('an unknown invite code is rejected with 400 before provisioning', async () => {
    const challenge = await requestPublicChallenge()
    const answer = solveChallengePrompt(challenge.prompt)
    const rejected = await apiRequest<{ code: string }>(server, 'POST', '/api/v1/agents/register', {
      body: { challengeId: challenge.challengeId, answer, agentCardUrl: stub.cardUrl, inviteCode: 'ZZZZ000000' },
      useCookies: false
    })
    expect(rejected.status).toBe(400)
    expect(rejected.body.code).toBe('invalid_invite_code')
  })

  it('rejects malformed public self-registration requests before provisioning an account', async () => {
    const rejected = await apiRequest<{ code: string }>(server, 'POST', '/api/v1/agents/register', {
      body: { answer: 'missing everything else' },
      useCookies: false
    })

    expect(rejected.status).toBe(400)
    expect(rejected.body.code).toBe('missing_fields')
  })
})
