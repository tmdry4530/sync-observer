import type { ServerConfig } from '../../config.js'
import type { Router } from '../router.js'
import { json } from '../response.js'
import { getPool } from '../../db/pool.js'

export interface HealthDeps {
  config: ServerConfig
  realtimeStats: () => unknown
  queueStats?: (() => Promise<{ queuedJobs: number; runningJobs: number }> | { queuedJobs: number; runningJobs: number } | null) | undefined
}

async function databaseHealthy(config: ServerConfig): Promise<boolean> {
  if (!config.databaseUrl) return false
  try {
    await getPool().query('select 1')
    return true
  } catch {
    return false
  }
}

export function registerHealthRoutes(router: Router, deps: HealthDeps): void {
  router.get('/health', async () => {
    const dbOk = await databaseHealthy(deps.config)
    let worker: { queuedJobs: number; runningJobs: number } | null = null
    if (deps.queueStats && dbOk) {
      worker = await Promise.resolve(deps.queueStats()).catch(() => null)
    }
    return json({
      ok: true,
      service: 'syncspace-api',
      database: deps.config.databaseUrl ? (dbOk ? 'ok' : 'unavailable') : 'not_configured',
      realtime: deps.realtimeStats(),
      ...(worker ? { worker } : {})
    })
  })

  router.get('/ready', async () => {
    // Railway uses this endpoint to decide whether the container itself came up.
    // Keep DB strictness opt-in so a transient managed-Postgres delay does not
    // turn a successful deploy into a healthcheck failure.
    if (deps.config.databaseUrl) {
      const dbOk = await databaseHealthy(deps.config)
      if (!dbOk && deps.config.strictReadyChecks) {
        return json({ ok: false, database: 'unavailable' }, 503)
      }
      return json({ ok: true, database: dbOk ? 'ok' : 'unavailable' })
    }
    return json({ ok: true })
  })
}
