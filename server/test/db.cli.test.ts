import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startEmbeddedDatabase, type EmbeddedDatabase } from './helpers/embeddedPostgres.js'

const run = promisify(execFile)
const serverDir = fileURLToPath(new URL('..', import.meta.url))
const tsxBin = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url))

let db: EmbeddedDatabase

beforeAll(async () => {
  // Start the cluster WITHOUT applying migrations so the CLI does the work.
  db = await startEmbeddedDatabase({ applyMigrations: false })
}, 90_000)

afterAll(async () => {
  await db?.stop()
})

function cliEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DATABASE_URL: db.connectionString, NODE_ENV: 'test' }
}

describe('db CLI entry points', () => {
  it('pnpm db:migrate applies all migrations and writes schema_migrations', async () => {
    const { stdout } = await run(tsxBin, ['src/db/migrate.ts'], { cwd: serverDir, env: cliEnv() })
    const result = JSON.parse(stdout.trim().split('\n').pop() ?? '{}')
    expect(result.ok).toBe(true)
    expect(result.applied.length).toBe(12)

    const rows = await db.pool.query<{ count: string }>(`select count(*)::text as count from schema_migrations`)
    expect(Number(rows.rows[0]?.count)).toBe(12)
  }, 60_000)

  it('pnpm db:verify reports a clean database', async () => {
    const { stdout } = await run(tsxBin, ['src/db/verify.ts'], { cwd: serverDir, env: cliEnv() })
    const report = JSON.parse(stdout.trim())
    expect(report.ok).toBe(true)
    expect(report.pending).toEqual([])
    expect(report.appliedCount).toBe(12)
  }, 60_000)

  it('re-running db:migrate is idempotent', async () => {
    const { stdout } = await run(tsxBin, ['src/db/migrate.ts'], { cwd: serverDir, env: cliEnv() })
    const result = JSON.parse(stdout.trim().split('\n').pop() ?? '{}')
    expect(result.ok).toBe(true)
    expect(result.applied).toEqual([])
  }, 60_000)
})
