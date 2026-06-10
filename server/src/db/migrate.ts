import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Pool, PoolClient } from 'pg'
import { closePool, getPool } from './pool.js'

export interface MigrationFile {
  version: string
  name: string
  path: string
  sql: string
  checksum: string
}

export interface MigrationResult {
  applied: string[]
  skipped: string[]
}

/** Resolve `server/migrations` from both `src/db` (tsx) and `dist/db` (node) layouts. */
export function resolveMigrationsDir(): string {
  return fileURLToPath(new URL('../../migrations/', import.meta.url))
}

export function loadMigrationFiles(dir = resolveMigrationsDir()): MigrationFile[] {
  const entries = readdirSync(dir)
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort((a, b) => a.localeCompare(b))

  return entries.map((file) => {
    const path = `${dir}${file}`
    const sql = readFileSync(path, 'utf8')
    return {
      version: file.replace(/\.sql$/, ''),
      name: file,
      path,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex')
    }
  })
}

const MIGRATION_LOCK_KEY_1 = 1_397_919_047
const MIGRATION_LOCK_KEY_2 = 1

async function ensureMigrationsTable(client: Pool | PoolClient): Promise<void> {
  await client.query(`
    create table if not exists schema_migrations (
      version text primary key,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null default now()
    );
  `)
}

export async function applyMigrations(
  pool: Pool = getPool(),
  options: { migrationsDir?: string; logger?: (message: string) => void } = {}
): Promise<MigrationResult> {
  const log = options.logger ?? ((message: string) => console.log(message))
  const applied: string[] = []
  const skipped: string[] = []
  const files = loadMigrationFiles(options.migrationsDir)
  const client = await pool.connect()

  try {
    // Railway can deploy API and worker services at the same time. Hold a
    // database-wide advisory lock so both services may safely run pre-deploy
    // migrations without racing on schema_migrations.
    await client.query('select pg_advisory_lock($1, $2)', [MIGRATION_LOCK_KEY_1, MIGRATION_LOCK_KEY_2])
    await ensureMigrationsTable(client)

    for (const migration of files) {
      const existing = await client.query<{ checksum: string }>(
        'select checksum from schema_migrations where version = $1',
        [migration.version]
      )

      if (existing.rows.length > 0) {
        const previous = existing.rows[0]?.checksum
        if (previous !== migration.checksum) {
          throw new Error(
            `Migration ${migration.name} changed after being applied (checksum mismatch). ` +
              'Create a new migration instead of editing an applied one.'
          )
        }
        skipped.push(migration.version)
        continue
      }

      try {
        await client.query('begin')
        await client.query(migration.sql)
        await client.query(
          'insert into schema_migrations (version, name, checksum) values ($1, $2, $3)',
          [migration.version, migration.name, migration.checksum]
        )
        await client.query('commit')
        applied.push(migration.version)
        log(`applied ${migration.name}`)
      } catch (error) {
        await client.query('rollback').catch(() => undefined)
        throw new Error(`Failed to apply migration ${migration.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock($1, $2)', [MIGRATION_LOCK_KEY_1, MIGRATION_LOCK_KEY_2]).catch(() => undefined)
    client.release()
  }

  log(`migrations complete: ${applied.length} applied, ${skipped.length} already current`)
  return { applied, skipped }
}

async function main(): Promise<void> {
  try {
    const result = await applyMigrations()
    console.log(JSON.stringify({ ok: true, ...result }))
    await closePool()
    process.exit(0)
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    await closePool().catch(() => undefined)
    process.exit(1)
  }
}

if (isMainModule(import.meta.url)) {
  void main()
}

export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return moduleUrl === pathToFileURL(entry).href
}
