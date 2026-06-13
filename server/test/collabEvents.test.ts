/**
 * collabEvents.test.ts — MVP 2.3 slice
 *
 * Verifies that the agentTaskWorker emits real collaboration-progress
 * engineering events (agent_status, pipeline_stage, review_comment) into
 * a2a_task_events when running planner and reviewer agent tasks.
 *
 * Assertions:
 * - agent_status + pipeline_stage events are present with non-null
 *   payload.engineeringEvent and the correct stage for each role.
 * - reviewer task also has a review_comment event.
 * - NO file_edit / command_run / test_result events exist (no real code
 *   execution in this slice — 2.2 sandbox is BLOCKED).
 * - None have demo:true (these are REAL events).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startEmbeddedDatabase, type EmbeddedDatabase } from './helpers/embeddedPostgres.js'
import { apiRequest, bearer, startTestServer, type TestServer } from './helpers/testServer.js'
import { registerAgentFixture } from './helpers/agentFixture.js'
import { startJobRunner } from '../src/workers/jobRunner.js'
import { processAgentTaskJob } from '../src/workers/agentTaskWorker.js'
import { createLogger } from '../src/utils/logger.js'
import { roleToStage } from '../src/agents/collabEvents.js'

const logger = createLogger('silent')

let db: EmbeddedDatabase
let server: TestServer
let ownerSecret: string
let ownerParticipantId: string
let workspaceId: string

beforeAll(async () => {
  db = await startEmbeddedDatabase()
  server = await startTestServer(db)
  const owner = await registerAgentFixture({ displayName: 'CollabEvt Owner', slug: 'collab-evt-owner' })
  ownerSecret = owner.credential.secret
  ownerParticipantId = owner.identity.participantId
  workspaceId = owner.identity.workspaceId
}, 90_000)

afterAll(async () => {
  await server?.stop()
  await db?.stop()
})

async function agentBySlug(slug: string): Promise<{ id: string }> {
  const rows = await db.pool.query<{ id: string }>(
    `select a.id from agents a where a.workspace_id = $1 and a.slug = $2`,
    [workspaceId, slug]
  )
  expect(rows.rows[0]).toBeTruthy()
  return rows.rows[0]!
}

async function invokeAndDrain(slug: string): Promise<string> {
  const channelRows = await db.pool.query<{ id: string }>(
    `insert into channels (workspace_id, name, created_by) values ($1, $2, $3) returning id`,
    [workspaceId, `collab-evt-${slug}-${Date.now()}`, ownerParticipantId]
  )
  const channelId = channelRows.rows[0]!.id

  const agent = await agentBySlug(slug)
  const invoked = await apiRequest<{ task: { id: string } }>(
    server,
    'POST',
    `/api/workspaces/${workspaceId}/invoke`,
    {
      body: { slug, content: `@${slug} 협업 이벤트 테스트`, channelId },
      useCookies: false,
      headers: bearer(ownerSecret)
    }
  )
  expect(invoked.status).toBe(200)
  const taskId = invoked.body.task.id

  const runner = startJobRunner({
    logger,
    workerId: `collab-evt-worker-${slug}`,
    queues: [{ name: 'agent', handlers: { agent_task: (p, d) => processAgentTaskJob(p, d) } }]
  })
  await runner.drainOnce()
  await runner.stop()

  return taskId
}

async function getTaskEvents(taskId: string): Promise<Array<{ type: string; payload: any }>> {
  const res = await apiRequest<{ task: any; events: Array<{ type: string; payload: any }> }>(
    server,
    'GET',
    `/api/tasks/${taskId}`,
    { useCookies: false, headers: bearer(ownerSecret) }
  )
  expect(res.status).toBe(200)
  return res.body.events ?? []
}

// ---------- unit: roleToStage ----------

describe('roleToStage', () => {
  it('maps orchestrator and planner to planning', () => {
    expect(roleToStage('orchestrator')).toBe('planning')
    expect(roleToStage('planner')).toBe('planning')
  })
  it('maps builder and doc_writer to implementation', () => {
    expect(roleToStage('builder')).toBe('implementation')
    expect(roleToStage('doc_writer')).toBe('implementation')
  })
  it('maps reviewer to review', () => {
    expect(roleToStage('reviewer')).toBe('review')
  })
})

// ---------- integration: planner task ----------

describe('planner task emits collaboration-progress engineering events', () => {
  let taskId: string
  let events: Array<{ type: string; payload: any }>

  beforeAll(async () => {
    taskId = await invokeAndDrain('planner')
    events = await getTaskEvents(taskId)
  }, 40_000)

  it('task completed successfully', async () => {
    const res = await apiRequest<{ task: { status: { state: string } } }>(
      server, 'GET', `/api/tasks/${taskId}`,
      { useCookies: false, headers: bearer(ownerSecret) }
    )
    expect(res.body.task.status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('has agent_status event with correct engineeringEvent wrapper', () => {
    const agentStatusEvents = events.filter((e) => e.type === 'agent_status')
    expect(agentStatusEvents.length).toBeGreaterThanOrEqual(1)
    for (const e of agentStatusEvents) {
      expect(e.payload).not.toBeNull()
      expect(e.payload?.engineeringEvent).toBeDefined()
      expect(e.payload?.engineeringEvent?.kind).toBe('agent_status')
    }
  })

  it('agent_status events have working and done statuses', () => {
    const statuses = events
      .filter((e) => e.type === 'agent_status')
      .map((e) => e.payload?.engineeringEvent?.status)
    expect(statuses).toContain('working')
    expect(statuses).toContain('done')
  })

  it('has pipeline_stage event with stage=planning and active/done', () => {
    const stageEvents = events.filter((e) => e.type === 'pipeline_stage')
    expect(stageEvents.length).toBeGreaterThanOrEqual(1)
    for (const e of stageEvents) {
      expect(e.payload?.engineeringEvent).toBeDefined()
      expect(e.payload?.engineeringEvent?.kind).toBe('pipeline_stage')
      expect(e.payload?.engineeringEvent?.stage).toBe('planning')
    }
    const stageStatuses = stageEvents.map((e) => e.payload?.engineeringEvent?.status)
    expect(stageStatuses).toContain('active')
    expect(stageStatuses).toContain('done')
  })

  it('does NOT have file_edit, command_run, or test_result events', () => {
    const forbidden = ['file_edit', 'command_run', 'test_result']
    for (const type of forbidden) {
      expect(events.some((e) => e.type === type), `unexpected ${type} event`).toBe(false)
    }
  })

  it('no event has demo:true', () => {
    for (const e of events) {
      expect(e.payload?.engineeringEvent?.demo, `event ${e.type} has demo:true`).not.toBe(true)
    }
  })
})

// ---------- integration: reviewer task ----------

describe('reviewer task emits collaboration-progress events including review_comment', () => {
  let taskId: string
  let events: Array<{ type: string; payload: any }>

  beforeAll(async () => {
    taskId = await invokeAndDrain('reviewer')
    events = await getTaskEvents(taskId)
  }, 40_000)

  it('task completed successfully', async () => {
    const res = await apiRequest<{ task: { status: { state: string } } }>(
      server, 'GET', `/api/tasks/${taskId}`,
      { useCookies: false, headers: bearer(ownerSecret) }
    )
    expect(res.body.task.status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('has agent_status events with engineeringEvent wrapper', () => {
    const agentStatusEvents = events.filter((e) => e.type === 'agent_status')
    expect(agentStatusEvents.length).toBeGreaterThanOrEqual(1)
    for (const e of agentStatusEvents) {
      expect(e.payload?.engineeringEvent?.kind).toBe('agent_status')
    }
  })

  it('has pipeline_stage events with stage=review', () => {
    const stageEvents = events.filter((e) => e.type === 'pipeline_stage')
    expect(stageEvents.length).toBeGreaterThanOrEqual(1)
    for (const e of stageEvents) {
      expect(e.payload?.engineeringEvent?.stage).toBe('review')
    }
  })

  it('has a review_comment event with non-empty comment and severity=info', () => {
    const reviewComments = events.filter((e) => e.type === 'review_comment')
    expect(reviewComments.length).toBeGreaterThanOrEqual(1)
    const first = reviewComments[0]!
    expect(first.payload?.engineeringEvent).toBeDefined()
    expect(first.payload?.engineeringEvent?.kind).toBe('review_comment')
    expect(first.payload?.engineeringEvent?.severity).toBe('info')
    expect(typeof first.payload?.engineeringEvent?.comment).toBe('string')
    expect(first.payload?.engineeringEvent?.comment.length).toBeGreaterThan(0)
  })

  it('does NOT have file_edit, command_run, or test_result events', () => {
    const forbidden = ['file_edit', 'command_run', 'test_result']
    for (const type of forbidden) {
      expect(events.some((e) => e.type === type), `unexpected ${type} event`).toBe(false)
    }
  })

  it('no event has demo:true', () => {
    for (const e of events) {
      expect(e.payload?.engineeringEvent?.demo, `event ${e.type} has demo:true`).not.toBe(true)
    }
  })
})
