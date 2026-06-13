import type { A2aMessageRole, A2aTaskState } from '../../a2a/types.js'
import { query, queryOne } from '../query.js'
import type { Queryable } from '../query.js'

export const EVENT_NOTIFY_CHANNEL = 'a2a_task_events'

// ---------- Contexts ----------

export interface A2aContextRow {
  id: string
  workspace_id: string
  channel_id: string | null
  document_id: string | null
  created_by_participant_id: string | null
  external_context_id: string | null
  metadata: Record<string, unknown>
  created_at: string
}

export async function createContext(
  input: {
    workspaceId: string
    channelId?: string | null
    documentId?: string | null
    createdByParticipantId?: string | null
    metadata?: Record<string, unknown>
  },
  client?: Queryable
): Promise<A2aContextRow> {
  const rows = await query<A2aContextRow>(
    `insert into a2a_contexts (workspace_id, channel_id, document_id, created_by_participant_id, metadata)
     values ($1, $2, $3, $4, coalesce($5::jsonb, '{}'::jsonb))
     returning *`,
    [
      input.workspaceId,
      input.channelId ?? null,
      input.documentId ?? null,
      input.createdByParticipantId ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null
    ],
    client
  )
  const row = rows[0]
  if (!row) throw new Error('Failed to create a2a context')
  return row
}

export async function getContext(id: string, client?: Queryable): Promise<A2aContextRow | null> {
  return queryOne<A2aContextRow>(`select * from a2a_contexts where id = $1`, [id], client)
}

// ---------- Tasks ----------

export interface A2aTaskRow {
  id: string
  context_id: string
  workspace_id: string
  channel_id: string | null
  document_id: string | null
  agent_id: string | null
  remote_agent_id: string | null
  title: string | null
  status_state: A2aTaskState
  status_message: Record<string, unknown> | null
  status_updated_at: string
  accepted_output_modes: string[]
  metadata: Record<string, unknown>
  created_by_participant_id: string | null
  external_task_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export async function createTask(
  input: {
    contextId: string
    workspaceId: string
    channelId?: string | null
    documentId?: string | null
    agentId?: string | null
    remoteAgentId?: string | null
    title?: string | null
    createdByParticipantId?: string | null
    acceptedOutputModes?: string[]
    metadata?: Record<string, unknown>
  },
  client?: Queryable
): Promise<A2aTaskRow> {
  const rows = await query<A2aTaskRow>(
    `insert into a2a_tasks
       (context_id, workspace_id, channel_id, document_id, agent_id, remote_agent_id, title,
        accepted_output_modes, metadata, created_by_participant_id)
     values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::text[], array['text/plain']), coalesce($9::jsonb, '{}'::jsonb), $10)
     returning *`,
    [
      input.contextId,
      input.workspaceId,
      input.channelId ?? null,
      input.documentId ?? null,
      input.agentId ?? null,
      input.remoteAgentId ?? null,
      input.title ?? null,
      input.acceptedOutputModes ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.createdByParticipantId ?? null
    ],
    client
  )
  const row = rows[0]
  if (!row) throw new Error('Failed to create a2a task')
  return row
}

export async function getTask(id: string, client?: Queryable): Promise<A2aTaskRow | null> {
  return queryOne<A2aTaskRow>(`select * from a2a_tasks where id = $1`, [id], client)
}

/** Record the remote side's task id on a local task that proxies a remote agent. */
export async function setTaskExternalId(taskId: string, externalTaskId: string, client?: Queryable): Promise<void> {
  await query(`update a2a_tasks set external_task_id = $2, updated_at = now() where id = $1`, [taskId, externalTaskId], client)
}

const TERMINAL_SQL_STATES = [
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED'
]

export async function updateTaskStatus(
  input: { taskId: string; state: A2aTaskState; statusMessage?: Record<string, unknown> | null },
  client?: Queryable
): Promise<A2aTaskRow | null> {
  const isTerminal = TERMINAL_SQL_STATES.includes(input.state)
  return queryOne<A2aTaskRow>(
    `update a2a_tasks
     set status_state = $2,
         status_message = $3::jsonb,
         status_updated_at = now(),
         completed_at = case when $4 then now() else completed_at end,
         updated_at = now()
     where id = $1
     returning *`,
    [input.taskId, input.state, input.statusMessage ? JSON.stringify(input.statusMessage) : null, isTerminal],
    client
  )
}

export interface ListTasksFilter {
  workspaceId: string
  contextId?: string | null
  status?: A2aTaskState | null
  limit: number
  cursor?: string | null
}

export interface ListTasksResult {
  rows: A2aTaskRow[]
  nextCursor: string | null
}

function encodeCursor(row: A2aTaskRow): string {
  return Buffer.from(JSON.stringify({ u: row.status_updated_at, i: row.id })).toString('base64url')
}

function decodeCursor(cursor: string): { u: string; i: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (typeof parsed?.u === 'string' && typeof parsed?.i === 'string') return parsed
    return null
  } catch {
    return null
  }
}

export async function listTasks(filter: ListTasksFilter, client?: Queryable): Promise<ListTasksResult> {
  const limit = Math.min(Math.max(filter.limit, 1), 100)
  const conditions = ['workspace_id = $1']
  const params: unknown[] = [filter.workspaceId]

  if (filter.contextId) {
    params.push(filter.contextId)
    conditions.push(`context_id = $${params.length}`)
  }
  if (filter.status) {
    params.push(filter.status)
    conditions.push(`status_state = $${params.length}`)
  }
  if (filter.cursor) {
    const decoded = decodeCursor(filter.cursor)
    if (decoded) {
      params.push(decoded.u, decoded.i)
      conditions.push(`(status_updated_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`)
    }
  }

  params.push(limit + 1)
  const rows = await query<A2aTaskRow>(
    `select * from a2a_tasks
     where ${conditions.join(' and ')}
     order by status_updated_at desc, id desc
     limit $${params.length}`,
    params,
    client
  )

  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    rows: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null
  }
}

// ---------- A2A messages ----------

export interface A2aMessageRow {
  id: string
  message_id: string
  task_id: string | null
  context_id: string
  role: A2aMessageRole
  participant_id: string | null
  parts: unknown[]
  extensions: string[]
  metadata: Record<string, unknown>
  created_at: string
}

export async function findA2aMessage(
  contextId: string,
  messageId: string,
  client?: Queryable
): Promise<A2aMessageRow | null> {
  return queryOne<A2aMessageRow>(
    `select * from a2a_messages where context_id = $1 and message_id = $2`,
    [contextId, messageId],
    client
  )
}

export async function insertA2aMessage(
  input: {
    messageId: string
    taskId?: string | null
    contextId: string
    role: A2aMessageRole
    participantId?: string | null
    parts: unknown[]
    extensions?: string[]
    metadata?: Record<string, unknown>
  },
  client?: Queryable
): Promise<A2aMessageRow> {
  const inserted = await query<A2aMessageRow>(
    `insert into a2a_messages (message_id, task_id, context_id, role, participant_id, parts, extensions, metadata)
     values ($1, $2, $3, $4, $5, $6::jsonb, coalesce($7::text[], array[]::text[]), coalesce($8::jsonb, '{}'::jsonb))
     on conflict (context_id, message_id) do nothing
     returning *`,
    [
      input.messageId,
      input.taskId ?? null,
      input.contextId,
      input.role,
      input.participantId ?? null,
      JSON.stringify(input.parts),
      input.extensions ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null
    ],
    client
  )
  if (inserted[0]) return inserted[0]
  const existing = await findA2aMessage(input.contextId, input.messageId, client)
  if (!existing) throw new Error('Failed to insert a2a message')
  return existing
}

export async function listA2aMessages(taskId: string, client?: Queryable): Promise<A2aMessageRow[]> {
  return query<A2aMessageRow>(`select * from a2a_messages where task_id = $1 order by created_at asc`, [taskId], client)
}

// ---------- Artifacts ----------

export interface A2aArtifactRow {
  id: string
  task_id: string
  artifact_id: string
  name: string | null
  description: string | null
  parts: unknown[]
  extensions: string[]
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

export async function upsertArtifact(
  input: {
    taskId: string
    artifactId: string
    name?: string | null
    description?: string | null
    parts: unknown[]
    extensions?: string[]
    metadata?: Record<string, unknown>
  },
  client?: Queryable
): Promise<A2aArtifactRow> {
  const rows = await query<A2aArtifactRow>(
    `insert into a2a_artifacts (task_id, artifact_id, name, description, parts, extensions, metadata)
     values ($1, $2, $3, $4, $5::jsonb, coalesce($6::text[], array[]::text[]), coalesce($7::jsonb, '{}'::jsonb))
     on conflict (task_id, artifact_id) do update
       set name = excluded.name,
           description = excluded.description,
           parts = excluded.parts,
           extensions = excluded.extensions,
           metadata = excluded.metadata,
           updated_at = now()
     returning *`,
    [
      input.taskId,
      input.artifactId,
      input.name ?? null,
      input.description ?? null,
      JSON.stringify(input.parts),
      input.extensions ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null
    ],
    client
  )
  const row = rows[0]
  if (!row) throw new Error('Failed to upsert artifact')
  return row
}

export async function listArtifacts(taskId: string, client?: Queryable): Promise<A2aArtifactRow[]> {
  return query<A2aArtifactRow>(`select * from a2a_artifacts where task_id = $1 order by created_at asc`, [taskId], client)
}

// ---------- Events (ordered, with LISTEN/NOTIFY) ----------

export type A2aEventType =
  | 'task_snapshot'
  | 'message'
  | 'status_update'
  | 'artifact_update'
  | 'push_delivery'
  | 'debug'
  | 'agent_status'
  | 'pipeline_stage'
  | 'file_edit'
  | 'command_run'
  | 'test_result'
  | 'review_comment'
  | 'vcs_event'

export interface A2aTaskEventRow {
  id: string
  seq: string
  task_id: string
  context_id: string
  event_type: A2aEventType
  payload: Record<string, unknown>
  visible_to_user: boolean
  created_at: string
}

export async function appendEvent(
  input: {
    taskId: string
    contextId: string
    eventType: A2aEventType
    payload: Record<string, unknown>
    visibleToUser?: boolean
  },
  client?: Queryable
): Promise<A2aTaskEventRow> {
  const rows = await query<A2aTaskEventRow>(
    `insert into a2a_task_events (task_id, context_id, event_type, payload, visible_to_user)
     values ($1, $2, $3, $4::jsonb, $5)
     returning *`,
    [input.taskId, input.contextId, input.eventType, JSON.stringify(input.payload), input.visibleToUser ?? true],
    client
  )
  const row = rows[0]
  if (!row) throw new Error('Failed to append task event')

  // Notify streaming subscribers (cross-process via Postgres LISTEN/NOTIFY).
  await query(
    `select pg_notify($1, $2)`,
    [EVENT_NOTIFY_CHANNEL, JSON.stringify({ taskId: row.task_id, seq: row.seq })],
    client
  )
  return row
}

export async function listEvents(taskId: string, sinceSeq?: string | null, client?: Queryable): Promise<A2aTaskEventRow[]> {
  if (sinceSeq) {
    return query<A2aTaskEventRow>(
      `select * from a2a_task_events where task_id = $1 and seq > $2 order by seq asc`,
      [taskId, sinceSeq],
      client
    )
  }
  return query<A2aTaskEventRow>(`select * from a2a_task_events where task_id = $1 order by seq asc`, [taskId], client)
}

export async function getEventBySeq(seq: string, client?: Queryable): Promise<A2aTaskEventRow | null> {
  return queryOne<A2aTaskEventRow>(`select * from a2a_task_events where seq = $1`, [seq], client)
}

/**
 * User-visible events for a context, across every task in the collaboration
 * chain, ordered by seq ascending.  Used by the Mission View to show the
 * engineering timeline for a shared a2a context (= one mission).
 *
 * Capped at the NEWEST `MISSION_EVENT_LIMIT` rows (inner desc, outer asc) so
 * an unbounded mission cannot blow up the response; the tail of the story is
 * what the Mission View needs.
 */
const MISSION_EVENT_LIMIT = 1000

export async function listEventsByContext(contextId: string, client?: Queryable): Promise<A2aTaskEventRow[]> {
  return query<A2aTaskEventRow>(
    `select * from (
       select * from a2a_task_events
       where context_id = $1 and visible_to_user
       order by seq desc
       limit ${MISSION_EVENT_LIMIT}
     ) latest
     order by seq asc`,
    [contextId],
    client
  )
}

export interface ContextTaskSummaryRow {
  id: string
  agent_id: string | null
  status_state: A2aTaskState
  title: string | null
  created_at: string
}

/**
 * Lightweight task summary for all tasks belonging to a context.
 * Used by the Mission View to list participating agents and their states.
 */
export async function listContextTasks(contextId: string, client?: Queryable): Promise<ContextTaskSummaryRow[]> {
  return query<ContextTaskSummaryRow>(
    `select id, agent_id, status_state, title, created_at
     from a2a_tasks
     where context_id = $1
     order by created_at asc`,
    [contextId],
    client
  )
}
