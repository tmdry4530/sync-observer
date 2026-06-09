import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startEmbeddedDatabase, type EmbeddedDatabase } from './helpers/embeddedPostgres.js'
import { verifyDatabase } from '../src/db/verify.js'

let db: EmbeddedDatabase

beforeAll(async () => {
  db = await startEmbeddedDatabase()
}, 90_000)

afterAll(async () => {
  await db?.stop()
})

const EXPECTED_TABLES = [
  'schema_migrations',
  'app_users',
  'auth_sessions',
  'workspaces',
  'workspace_members',
  'channels',
  'documents',
  'messages',
  'participants',
  'agents',
  'agent_tokens',
  'a2a_contexts',
  'a2a_tasks',
  'a2a_messages',
  'a2a_artifacts',
  'a2a_task_events',
  'yjs_document_snapshots',
  'a2a_push_notification_configs',
  'jobs',
  'audit_logs'
]

const EXPECTED_ENUMS = [
  'participant_type',
  'workspace_member_role',
  'agent_role',
  'agent_runtime_status',
  'a2a_task_state',
  'a2a_message_role',
  'a2a_event_type',
  'job_status'
]

describe('full schema migrations', () => {
  it('creates every expected table', async () => {
    const rows = await db.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public'`
    )
    const present = new Set(rows.rows.map((row) => row.table_name))
    for (const table of EXPECTED_TABLES) {
      expect(present.has(table), `missing table: ${table}`).toBe(true)
    }
  })

  it('creates every expected enum type', async () => {
    const rows = await db.pool.query<{ typname: string }>(
      `select typname from pg_type where typtype = 'e'`
    )
    const present = new Set(rows.rows.map((row) => row.typname))
    for (const enumName of EXPECTED_ENUMS) {
      expect(present.has(enumName), `missing enum: ${enumName}`).toBe(true)
    }
  })

  it('messages.author_type is NOT NULL and references participant author', async () => {
    const rows = await db.pool.query<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns
       where table_name = 'messages' and column_name = 'author_type'`
    )
    expect(rows.rows[0]?.is_nullable).toBe('NO')
  })

  it('a2a_task_events.seq is an identity column with global ordering', async () => {
    const rows = await db.pool.query<{ is_identity: string }>(
      `select is_identity from information_schema.columns
       where table_name = 'a2a_task_events' and column_name = 'seq'`
    )
    expect(rows.rows[0]?.is_identity).toBe('YES')
  })

  it('enforces the participants exactly-one-owner constraint', async () => {
    await expect(
      db.pool.query(
        `insert into participants (participant_type, display_name) values ('human', 'invalid')`
      )
    ).rejects.toThrow()
  })

  it('supports SKIP LOCKED job claim semantics', async () => {
    await db.pool.query(
      `insert into jobs (queue_name, job_type, payload) values ('agent', 'noop', '{}'::jsonb)`
    )
    const claimed = await db.pool.query<{ id: string }>(
      `with next_job as (
         select id from jobs
         where queue_name = $1 and status = 'queued' and run_after <= now()
         order by created_at asc
         for update skip locked
         limit 1
       )
       update jobs j set status = 'running', locked_by = $2, locked_at = now()
       from next_job where j.id = next_job.id
       returning j.id`,
      ['agent', 'test-worker']
    )
    expect(claimed.rows.length).toBe(1)
  })

  it('passes verifyDatabase with no pending migrations or integrity issues', async () => {
    const report = await verifyDatabase(db.pool)
    expect(report.pending).toEqual([])
    expect(report.issues).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.appliedCount).toBe(12)
  })
})
