import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startEmbeddedDatabase, type EmbeddedDatabase } from './helpers/embeddedPostgres.js'
import { apiRequest, startTestServer, type TestServer } from './helpers/testServer.js'
import type { AuthUser, Channel, ChatMessage, DocumentMeta, Workspace } from '../src/types/contracts.js'

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

describe('app auth + REST surface', () => {
  it('registers a user, sets a session cookie, and returns the current user', async () => {
    const registered = await apiRequest<{ user: AuthUser }>(server, 'POST', '/api/auth/register', {
      body: { email: 'ada@syncspace.dev', password: 'password123', displayName: 'Ada Lovelace' }
    })
    expect(registered.status).toBe(200)
    expect(registered.body.user.email).toBe('ada@syncspace.dev')

    const me = await apiRequest<{ user: AuthUser | null }>(server, 'GET', '/api/auth/me')
    expect(me.body.user?.email).toBe('ada@syncspace.dev')
  })

  it('rejects duplicate registration and wrong credentials', async () => {
    const dup = await apiRequest(server, 'POST', '/api/auth/register', {
      body: { email: 'ada@syncspace.dev', password: 'password123' },
      useCookies: false
    })
    expect(dup.status).toBe(409)

    const bad = await apiRequest(server, 'POST', '/api/auth/login', {
      body: { email: 'ada@syncspace.dev', password: 'wrongpass' },
      useCookies: false
    })
    expect(bad.status).toBe(401)
  })

  it('requires a session for protected routes', async () => {
    const anon = await apiRequest(server, 'GET', '/api/workspaces', { useCookies: false })
    expect(anon.status).toBe(401)
  })

  it('creates a workspace (owner auto-membership) and lists it', async () => {
    const created = await apiRequest<{ workspace: Workspace }>(server, 'POST', '/api/workspaces', {
      body: { name: 'Demo Workspace' }
    })
    expect(created.status).toBe(200)
    const workspaceId = created.body.workspace.id

    const list = await apiRequest<{ workspaces: Workspace[] }>(server, 'GET', '/api/workspaces')
    expect(list.body.workspaces.some((w) => w.id === workspaceId)).toBe(true)

    const channel = await apiRequest<{ channel: Channel }>(server, 'POST', `/api/workspaces/${workspaceId}/channels`, {
      body: { name: 'general' }
    })
    expect(channel.status).toBe(200)

    const doc = await apiRequest<{ document: DocumentMeta }>(server, 'POST', `/api/workspaces/${workspaceId}/documents`, {
      body: { title: 'Welcome' }
    })
    expect(doc.status).toBe(200)

    const messages = await apiRequest<{ items: ChatMessage[]; nextCursor: string | null }>(
      server,
      'GET',
      `/api/channels/${channel.body.channel.id}/messages`
    )
    expect(messages.status).toBe(200)
    expect(Array.isArray(messages.body.items)).toBe(true)
  })

  it('does not leak workspaces to non-members (404, not 403)', async () => {
    // Create a workspace as Ada.
    const created = await apiRequest<{ workspace: Workspace }>(server, 'POST', '/api/workspaces', {
      body: { name: 'Private' }
    })
    const workspaceId = created.body.workspace.id

    // Register a second user with a fresh cookie jar.
    const outsider = await startTestServer(db)
    await apiRequest(outsider, 'POST', '/api/auth/register', {
      body: { email: 'grace@syncspace.dev', password: 'password123' }
    })
    const channels = await apiRequest(outsider, 'GET', `/api/workspaces/${workspaceId}/channels`)
    expect(channels.status).toBe(404)
    await outsider.stop()
  })

  it('logs out and clears the session', async () => {
    await apiRequest(server, 'POST', '/api/auth/logout')
    const me = await apiRequest<{ user: AuthUser | null }>(server, 'GET', '/api/auth/me')
    expect(me.body.user).toBeNull()
  })
})
