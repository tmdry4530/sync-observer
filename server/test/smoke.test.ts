import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startEmbeddedDatabase, type EmbeddedDatabase } from './helpers/embeddedPostgres.js'
import { apiRequest, startTestServer, type TestServer } from './helpers/testServer.js'
import { solveChallengePrompt } from '../src/auth/challenge.js'
import { startJobRunner } from '../src/workers/jobRunner.js'
import { processAgentTaskJob } from '../src/workers/agentTaskWorker.js'
import { createLogger } from '../src/utils/logger.js'
import type { AgentProfile, AgentRegistrationResult } from '../src/types/contracts.js'

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

/** End-to-end journey for the agent-credential model (plan §10.2 smoke checklist). */
describe('end-to-end smoke (registered agent)', () => {
  it('register -> agent-login -> workspace -> agents -> invoke -> completed task', async () => {
    // 1. Register an agent by solving the capability challenge (gives us the secret).
    const challenge = await apiRequest<{ challengeId: string; prompt: string }>(
      server,
      'POST',
      '/api/agents/register/challenge',
      { useCookies: false }
    )
    expect(challenge.status).toBe(200)
    const answer = solveChallengePrompt(challenge.body.prompt)
    const registered = await apiRequest<AgentRegistrationResult>(server, 'POST', '/api/agents/register', {
      body: { challengeId: challenge.body.challengeId, answer, displayName: 'Smoke Ada', slug: 'smoke-ada', role: 'planner' },
      useCookies: false
    })
    expect(registered.status).toBe(200)
    const { agentId, secret } = registered.body.credential
    const workspaceId = registered.body.identity.workspaceId
    // The AGENT acts via its Bearer credential; activity (create/invoke) is
    // agent-only. The owner's web cookie is a read-only spectator (asserted below).
    const asAgent = { authorization: `Bearer ${secret}` }

    // 2. Owner-login with the agent credential sets the session cookie.
    const login = await apiRequest<{ identity: { agentId: string } }>(server, 'POST', '/api/auth/agent-login', {
      body: { agentId, secret }
    })
    expect(login.status).toBe(200)
    expect(login.body.identity.agentId).toBe(agentId)

    // 3. The workspace list shows the agent's own workspace (read works for the cookie session too).
    const workspaces = await apiRequest<{ workspaces: { id: string }[] }>(server, 'GET', '/api/workspaces')
    expect(workspaces.body.workspaces.some((ws) => ws.id === workspaceId)).toBe(true)

    // 3b. The human (cookie) is a spectator: a write is rejected.
    const humanWrite = await apiRequest<{ code?: string }>(server, 'POST', `/api/workspaces/${workspaceId}/channels`, {
      body: { name: 'human-attempt' }
    })
    expect(humanWrite.status).toBe(403)
    expect(humanWrite.body.code).toBe('spectator_read_only')

    // 4. The agent (bearer) creates channels + documents.
    const channel = await apiRequest<{ channel: { id: string; name: string } }>(
      server,
      'POST',
      `/api/workspaces/${workspaceId}/channels`,
      { body: { name: 'general' }, useCookies: false, headers: asAgent }
    )
    expect(channel.status).toBe(200)
    const channelId = channel.body.channel.id

    const doc = await apiRequest<{ document: { id: string } }>(server, 'POST', `/api/workspaces/${workspaceId}/documents`, {
      body: { title: 'Welcome' },
      useCookies: false,
      headers: asAgent
    })
    expect(doc.status).toBe(200)
    const documents = await apiRequest<{ documents: { title: string }[] }>(server, 'GET', `/api/workspaces/${workspaceId}/documents`)
    expect(documents.body.documents.length).toBeGreaterThan(0)

    // 5. The default collaborator roster is present (Planner exists).
    const agentsRes = await apiRequest<{ agents: AgentProfile[] }>(server, 'GET', `/api/workspaces/${workspaceId}/agents`)
    expect(agentsRes.body.agents.length).toBeGreaterThanOrEqual(5)
    const planner = agentsRes.body.agents.find((a) => a.slug === 'planner')!
    expect(planner).toBeTruthy()

    // 6. The agent (bearer) invokes @planner -> task created.
    const invoke = await apiRequest<{ task: { id: string } }>(server, 'POST', `/api/agents/${planner.id}/invoke`, {
      body: { content: '@planner SyncSpace에 A2A 협업 구조를 설계해줘', channelId },
      useCookies: false,
      headers: asAgent
    })
    expect(invoke.status).toBe(200)

    // 7. Worker drives the task to a terminal state with an artifact + chat mirror.
    const runner = startJobRunner({
      logger: createLogger('silent'),
      workerId: 'smoke-worker',
      queues: [{ name: 'agent', handlers: { agent_task: (p, d) => processAgentTaskJob(p, d) } }]
    })
    await runner.drainOnce()
    await runner.stop()

    const detail = await apiRequest<{ task: any }>(server, 'GET', `/api/tasks/${invoke.body.task.id}`)
    expect(detail.body.task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(detail.body.task.artifacts.some((a: any) => a.artifactId === 'plan.md')).toBe(true)

    // 8. The agent chat-mirror message is persisted to the channel as the agent participant.
    const messages = await apiRequest<{ items: { content: string; user?: { displayName: string } }[] }>(
      server,
      'GET',
      `/api/channels/${channelId}/messages`
    )
    expect(messages.body.items.some((m) => m.user?.displayName === 'Planner')).toBe(true)
  }, 40_000)

  it('serves the public A2A Agent Card', async () => {
    const card = await apiRequest<{ name: string; capabilities: { streaming: boolean } }>(
      server,
      'GET',
      '/.well-known/agent-card.json',
      { useCookies: false }
    )
    expect(card.status).toBe(200)
    expect(card.body.capabilities.streaming).toBe(true)
  })

  it('reports health with database + realtime status', async () => {
    const health = await apiRequest<{ ok: boolean; database: string }>(server, 'GET', '/health', { useCookies: false })
    expect(health.body.ok).toBe(true)
    expect(health.body.database).toBe('ok')
  })
})
