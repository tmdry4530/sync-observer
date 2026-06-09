import { existsSync, readFileSync } from 'node:fs'
import type { Pool } from 'pg'
import { closePool, getPool } from './pool.js'
import { isMainModule, resolveMigrationsDir } from './migrate.js'

export interface RollbackResult {
  rolledBack: string[]
}

/**
 * Roll back the most recent `steps` migrations. A migration named
 * `0007_a2a_core.sql` is reverted by running `0007_a2a_core.down.sql` when it
 * exists; migrations without a down file stop the rollback to avoid silent
 * partial reverts.
 */
export async function rollback(
  steps = 1,
  pool: Pool = getPool(),
  options: { migrationsDir?: string; logger?: (message: string) => void } = {}
): Promise<RollbackResult> {
  const log = options.logger ?? ((message: string) => console.log(message))
  const dir = options.migrationsDir ?? resolveMigrationsDir()

  const recent = await pool.query<{ version: string; name: string }>(
    'select version, name from schema_migrations order by applied_at desc, version desc limit $1',
    [steps]
  )

  const rolledBack: string[] = []
  for (const row of recent.rows) {
    const downPath = `${dir}${row.version}.down.sql`
    if (!existsSync(downPath)) {
      log(`no down migration for ${row.version}; stopping rollback`)
      break
    }
    const sql = readFileSync(downPath, 'utf8')
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(sql)
      await client.query('delete from schema_migrations where version = $1', [row.version])
      await client.query('commit')
      rolledBack.push(row.version)
      log(`rolled back ${row.version}`)
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw new Error(`Failed to roll back ${row.version}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      client.release()
    }
  }

  return { rolledBack }
}

async function main(): Promise<void> {
  const steps = Number.parseInt(process.argv[2] ?? '1', 10)
  try {
    const result = await rollback(Number.isInteger(steps) && steps > 0 ? steps : 1)
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
