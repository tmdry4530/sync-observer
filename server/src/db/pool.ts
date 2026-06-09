import { Pool, type PoolConfig } from 'pg'
import { readConfig } from '../config.js'

let sharedPool: Pool | null = null
let poolIsExternal = false

/**
 * Build a node-postgres Pool for the given connection string.
 *
 * SSL is enabled automatically when the connection string asks for it
 * (`sslmode=require`) or when a managed provider host is detected, which keeps
 * Railway's external Postgres endpoints working without hand-tuning every env.
 */
export function createPool(connectionString: string, overrides: PoolConfig = {}): Pool {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...sslOptions(connectionString),
    ...overrides
  })
}

export function getPool(): Pool {
  if (sharedPool) return sharedPool
  const { databaseUrl } = readConfig()
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not configured. Set it before using the Postgres-backed features.')
  }
  sharedPool = createPool(databaseUrl)
  return sharedPool
}

/**
 * Override the process-wide pool. Used by tests against an embedded Postgres.
 * An externally owned pool is not ended by closePool — its owner handles teardown.
 */
export function setPool(pool: Pool, options: { external?: boolean } = {}): void {
  sharedPool = pool
  poolIsExternal = options.external ?? true
}

export async function closePool(): Promise<void> {
  if (!sharedPool) return
  // An externally owned pool (test harness) keeps its reference so other
  // consumers in the same process keep working; its owner ends it.
  if (poolIsExternal) return
  const pool = sharedPool
  sharedPool = null
  await pool.end()
}

function sslOptions(connectionString: string): Pick<PoolConfig, 'ssl'> {
  const requiresSsl = /[?&]sslmode=require/.test(connectionString)
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString) || connectionString.includes('host=localhost')
  if (requiresSsl && !isLocal) {
    return { ssl: { rejectUnauthorized: false } }
  }
  return {}
}
