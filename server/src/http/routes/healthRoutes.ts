import type { ServerConfig } from '../../config.js'
import type { Router } from '../router.js'
import { json } from '../response.js'
import { getPool } from '../../db/pool.js'

export interface HealthDeps {
  config: ServerConfig
  realtimeStats: () => unknown
  queueStats?: () => { queuedJobs: number; runningJobs: number } | null
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
    return json({
      ok: true,
      service: 'syncspace-api',
      database: deps.config.databaseUrl ? (dbOk ? 'ok' : 'unavailable') : 'not_configured',
      realtime: deps.realtimeStats(),
      ...(deps.queueStats ? { worker: deps.queueStats() } : {})
    })
  })

  router.get('/ready', async () => {
    // Readiness fails when a configured database is unreachable so Railway can
    // hold traffic until the dependency recovers.
    if (deps.config.databaseUrl) {
      const dbOk = await databaseHealthy(deps.config)
      if (!dbOk) return json({ ok: false, database: 'unavailable' }, 503)
    }
    return json({ ok: true })
  })
}
