import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startEmbeddedDatabase, type EmbeddedDatabase } from './helpers/embeddedPostgres.js'
import { apiRequest, startTestServer, type TestServer } from './helpers/testServer.js'
import { registerAgentFixture } from './helpers/agentFixture.js'
import { isReadOnlyAllowed } from '../src/realtime/readOnly.js'

/**
 * Spectator model: the platform's activity is performed by agents (Bearer/A2A).
 * A logged-in human (web session cookie) is a read-only spectator — no channel
 * /document/chat writes and no invoke.
 */

describe('WS read-only message filter (spectator)', () => {
  it('allows reads and presence, drops document/chat writes', () => {
    expect(isReadOnlyAllowed(new Uint8Array([]))).toBe(true) // empty
    expect(isReadOnlyAllowed(new Uint8Array([1, 7, 7]))).toBe(true) // awareness/presence
    expect(isReadOnlyAllowed(new Uint8Array([3]))).toBe(true) // queryAwareness
    expect(isReadOnlyAllowed(new Uint8Array([0, 0, 9]))).toBe(true) // sync step1 = state request (read)
    expect(isReadOnlyAllowed(new Uint8Array([0, 1, 9]))).toBe(false) // sync step2 = send state (write)
    expect(isReadOnlyAllowed(new Uint8Array([0, 2, 9]))).toBe(false) // sync update = live edit (write)
    expect(isReadOnlyAllowed(Buffer.from([0, 2, 9]))).toBe(false) // Buffer path
  })
})

describe('spectator REST gating (cookie = human read-only, bearer = agent)', () => {
  let db: EmbeddedDatabase
  let server: TestServer
  let secret: string
  let workspaceId: string

  const bearer = () => ({ authorization: `Bearer ${secret}` })
  const cookie = () => ({ cookie: `syncspace_session=${secret}` })

  beforeAll(async () => {
    db = await startEmbeddedDatabase()
    server = await startTestServer(db)
    const owner = await registerAgentFixture({ displayName: 'Spectator Owner', slug: 'spectator-owner' })
    secret = owner.credential.secret
    workspaceId = owner.identity.workspaceId
  }, 90_000)

  afterAll(async () => {
    await server?.stop()
    await db?.stop()
  })

  it('agent (bearer) CAN create a channel; human (cookie) CANNOT (403 spectator_read_only)', async () => {
    const agentRes = await apiRequest<{ channel: { id: string } }>(server, 'POST', `/api/workspaces/${workspaceId}/channels`, {
      body: { name: 'agent-made' },
      useCookies: false,
      headers: bearer()
    })
    expect(agentRes.status).toBe(200)

    const humanRes = await apiRequest<{ code?: string }>(server, 'POST', `/api/workspaces/${workspaceId}/channels`, {
      body: { name: 'human-made' },
      useCookies: false,
      headers: cookie()
    })
    expect(humanRes.status).toBe(403)
    expect(humanRes.body.code).toBe('spectator_read_only')
  })

  it('human (cookie) CANNOT create a document (403)', async () => {
    const res = await apiRequest<{ code?: string }>(server, 'POST', `/api/workspaces/${workspaceId}/documents`, {
      body: { title: 'human-doc' },
      useCookies: false,
      headers: cookie()
    })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('spectator_read_only')
  })

  it('human (cookie) CANNOT invoke an agent (403)', async () => {
    const res = await apiRequest<{ code?: string }>(server, 'POST', `/api/workspaces/${workspaceId}/invoke`, {
      body: { slug: 'planner', content: '계획 세워줘' },
      useCookies: false,
      headers: cookie()
    })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('spectator_read_only')
  })

  it('human (cookie) CAN still read (spectate): list channels', async () => {
    const res = await apiRequest<{ channels: unknown[] }>(server, 'GET', `/api/workspaces/${workspaceId}/channels`, {
      useCookies: false,
      headers: cookie()
    })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.channels)).toBe(true)
  })
})
