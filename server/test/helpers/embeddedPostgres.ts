import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'
import { createPool } from '../../src/db/pool.js'
import { applyMigrations } from '../../src/db/migrate.js'
import type { Pool } from 'pg'

export interface EmbeddedDatabase {
  connectionString: string
  pool: Pool
  stop(): Promise<void>
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Could not resolve a free port'))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

/**
 * Boot a throwaway Postgres cluster backed by the bundled binary, apply all
 * migrations, and return a ready-to-use pool. Designed for integration tests
 * and `pnpm db:up` style local development without Docker.
 */
export async function startEmbeddedDatabase(
  options: { applyMigrations?: boolean; databaseName?: string } = {}
): Promise<EmbeddedDatabase> {
  const port = await findFreePort()
  const dataDir = mkdtempSync(join(tmpdir(), 'syncspace-pg-'))
  const password = 'postgres'
  const user = 'postgres'
  const databaseName = options.databaseName ?? 'syncspace_test'

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user,
    password,
    port,
    persistent: false,
    authMethod: 'scram-sha-256',
    onLog: () => undefined,
    onError: () => undefined
  })

  await pg.initialise()
  await pg.start()
  await pg.createDatabase(databaseName)

  const connectionString = `postgresql://${user}:${password}@127.0.0.1:${port}/${databaseName}`
  const pool = createPool(connectionString, { max: 5 })

  if (options.applyMigrations !== false) {
    await applyMigrations(pool, { logger: () => undefined })
  }

  return {
    connectionString,
    pool,
    stop: async () => {
      await pool.end().catch(() => undefined)
      await pg.stop().catch(() => undefined)
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
}
