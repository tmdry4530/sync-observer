import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startEmbeddedDatabase, type EmbeddedDatabase } from './helpers/embeddedPostgres.js'
import { verifyDatabase } from '../src/db/verify.js'
import { applyMigrations } from '../src/db/migrate.js'

let db: EmbeddedDatabase

beforeAll(async () => {
  db = await startEmbeddedDatabase()
}, 90_000)

afterAll(async () => {
  await db?.stop()
})

describe('database migrations', () => {
  it('records applied migrations in schema_migrations', async () => {
    const rows = await db.pool.query<{ version: string }>('select version from schema_migrations order by version')
    expect(rows.rows.length).toBeGreaterThan(0)
    expect(rows.rows.map((row) => row.version)).toContain('0001_extensions')
  })

  it('enables the pgcrypto extension', async () => {
    const rows = await db.pool.query<{ count: string }>(
      `select count(*)::text as count from pg_extension where extname = 'pgcrypto'`
    )
    expect(rows.rows[0]?.count).toBe('1')
  })

  it('is idempotent when re-applied', async () => {
    const result = await applyMigrations(db.pool, { logger: () => undefined })
    expect(result.applied).toEqual([])
  })

  it('passes verifyDatabase', async () => {
    const report = await verifyDatabase(db.pool)
    expect(report.issues).toEqual([])
    expect(report.ok).toBe(true)
  })
})
