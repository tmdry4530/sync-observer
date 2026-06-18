import { createCollectorServer } from './server.js'

/**
 * Thin bootstrap for the local collector (M2 §6), mirroring src/server.ts.
 * SIGINT/SIGTERM trigger a graceful shutdown (close the HTTP server + sqlite).
 */

const collector = createCollectorServer()

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  console.log(JSON.stringify({ level: 'info', message: 'Shutting down SyncSpace collector', signal }))
  await collector.stop()
}

process.once('SIGINT', () => {
  void shutdown('SIGINT').finally(() => process.exit(0))
})

process.once('SIGTERM', () => {
  void shutdown('SIGTERM').finally(() => process.exit(0))
})

await collector.start()
