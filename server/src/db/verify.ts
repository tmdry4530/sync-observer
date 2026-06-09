import type { Pool } from 'pg'
import { closePool, getPool } from './pool.js'
import { isMainModule, loadMigrationFiles } from './migrate.js'

export interface VerifyIssue {
  check: string
  detail: string
}

export interface VerifyReport {
  ok: boolean
  appliedCount: number
  pending: string[]
  issues: VerifyIssue[]
}

async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `select exists (
       select 1 from information_schema.tables
       where table_schema = 'public' and table_name = $1
     ) as exists`,
    [table]
  )
  return result.rows[0]?.exists ?? false
}

async function countViolations(pool: Pool, sql: string): Promise<number> {
  const result = await pool.query<{ count: string }>(sql)
  return Number(result.rows[0]?.count ?? '0')
}

/** Integrity checks that only run when their tables already exist. */
const INTEGRITY_CHECKS: { name: string; tables: string[]; sql: string }[] = [
  {
    name: 'messages_without_author_participant',
    tables: ['messages'],
    sql: `select count(*)::text as count from messages where author_participant_id is null`
  },
  {
    name: 'workspace_members_without_participant',
    tables: ['workspace_members'],
    sql: `select count(*)::text as count from workspace_members where participant_id is null`
  },
  {
    name: 'a2a_tasks_without_context',
    tables: ['a2a_tasks', 'a2a_contexts'],
    sql: `select count(*)::text as count from a2a_tasks t left join a2a_contexts c on c.id = t.context_id where c.id is null`
  },
  {
    name: 'a2a_artifacts_without_task',
    tables: ['a2a_artifacts', 'a2a_tasks'],
    sql: `select count(*)::text as count from a2a_artifacts a left join a2a_tasks t on t.id = a.task_id where t.id is null`
  }
]

export async function verifyDatabase(pool: Pool = getPool()): Promise<VerifyReport> {
  const issues: VerifyIssue[] = []

  const hasMigrationsTable = await tableExists(pool, 'schema_migrations')
  if (!hasMigrationsTable) {
    return { ok: false, appliedCount: 0, pending: [], issues: [{ check: 'schema_migrations', detail: 'table missing — run pnpm db:migrate' }] }
  }

  const appliedRows = await pool.query<{ version: string }>('select version from schema_migrations')
  const applied = new Set(appliedRows.rows.map((row) => row.version))
  const files = loadMigrationFiles()
  const pending = files.filter((file) => !applied.has(file.version)).map((file) => file.version)
  if (pending.length > 0) {
    issues.push({ check: 'pending_migrations', detail: pending.join(', ') })
  }

  for (const check of INTEGRITY_CHECKS) {
    const present = await Promise.all(check.tables.map((table) => tableExists(pool, table)))
    if (!present.every(Boolean)) continue
    const violations = await countViolations(pool, check.sql)
    if (violations > 0) {
      issues.push({ check: check.name, detail: `${violations} row(s) violate integrity` })
    }
  }

  return { ok: issues.length === 0, appliedCount: applied.size, pending, issues }
}

async function main(): Promise<void> {
  try {
    const report = await verifyDatabase()
    console.log(JSON.stringify(report, null, 2))
    await closePool()
    process.exit(report.ok ? 0 : 1)
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    await closePool().catch(() => undefined)
    process.exit(1)
  }
}

if (isMainModule(import.meta.url)) {
  void main()
}
