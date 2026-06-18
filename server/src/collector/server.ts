import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createLogger, type Logger } from '../utils/logger.js'
import { Router } from '../http/router.js'
import { createRequestContext } from '../http/context.js'
import { json, sendResponse } from '../http/response.js'
import { isHttpError } from '../http/errors.js'
import { readCollectorConfig, type CollectorConfig } from './config.js'
import { createCollectorStore, type CollectorStore } from './store.js'
import { createEventHub, type EventHub } from './hub.js'
import { registerCollectorRoutes, isOriginAllowed, type InterruptResolver } from './routes.js'
import { readRulesFile, writeRulesFile } from './rulesFile.js'

/**
 * The LOCAL hermes-monitor collector + control plane server (M2 §6).
 *
 * Mirrors the ergonomics of SyncSpaceServerHandle (start/stop returning the bound
 * address) but is intentionally pg-/Yjs-/auth-free: it boots with DATABASE_URL
 * unset and binds 127.0.0.1 only. On boot it seeds the rules table from the
 * plugin rules file (if the table is empty) and re-projects the table back to the
 * file so the two are always consistent.
 */

export interface CollectorServerOptions {
  config?: CollectorConfig
  logger?: Logger
  /** Seam wired in M5 to bind a manual interrupt to the live agent. */
  interruptResolver?: InterruptResolver
}

export interface CollectorServerHandle {
  server: HttpServer
  store: CollectorStore
  hub: EventHub
  config: CollectorConfig
  router: Router
  start(): Promise<AddressInfo>
  stop(): Promise<void>
}

export function createCollectorServer(options: CollectorServerOptions = {}): CollectorServerHandle {
  const config = options.config ?? readCollectorConfig()
  const logger = options.logger ?? createLogger('info')
  const store = createCollectorStore(config.dbPath)
  const hub = createEventHub()

  seedRulesFromFile(store, config.rulesFilePath, logger)

  const router = new Router()
  registerCollectorRoutes(router, {
    store,
    hub,
    rulesFilePath: config.rulesFilePath,
    allowedOrigins: config.allowedOrigins,
    ...(options.interruptResolver ? { interruptResolver: options.interruptResolver } : {})
  })

  const server = createServer((request, response) => {
    void dispatch(request, response, router, logger, config.allowedOrigins)
  })

  return {
    server,
    store,
    hub,
    config,
    router,
    start: () =>
      new Promise<AddressInfo>((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.port, config.host, () => {
          server.off('error', reject)
          const address = server.address()
          if (!address || typeof address === 'string') {
            reject(new Error('Collector did not expose an address'))
            return
          }
          logger.info('SyncSpace collector listening', {
            host: config.host,
            port: address.port,
            dbPath: config.dbPath,
            rulesFile: config.rulesFilePath
          })
          resolve(address)
        })
      }),
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close((error) => (error ? reject(error) : resolve()))
      })
      store.close()
    }
  }
}

/**
 * If the rules table is empty and the rules file exists, import the file into the
 * table (seed). Always re-project the table back to the file afterward so the two
 * representations are byte-consistent from boot.
 */
function seedRulesFromFile(store: CollectorStore, rulesFilePath: string, logger: Logger): void {
  if (store.listRules().length === 0) {
    const seeded = readRulesFile(rulesFilePath)
    if (seeded.length > 0) {
      store.replaceAllRules(seeded)
      logger.info('Seeded rules from rules file', { count: seeded.length, rulesFile: rulesFilePath })
    }
  }
  // Project the current table (possibly just seeded) to the file so the plugin
  // and the control plane agree from the first byte.
  writeRulesFile(rulesFilePath, store.listRules())
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  router: Router,
  logger: Logger,
  allowedOrigins: string[]
): Promise<void> {
  const ctx = createRequestContext(request, response)

  try {
    // CORS for the local dashboard served from a different port (e.g. Vite :5173
    // → collector :8787). Only reflect allow-listed origins; the actual security
    // boundary stays loopback + X-SyncSpace-Local enforced per-route. No
    // credentials are used (no cookies/auth), so we never set Allow-Credentials.
    const origin = ctx.header('origin')
    if (origin && isOriginAllowed(origin, allowedOrigins)) {
      response.setHeader('Access-Control-Allow-Origin', origin)
      response.setHeader('Vary', 'Origin')
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-SyncSpace-Local, Last-Event-ID')
    }

    if (ctx.method === 'OPTIONS') {
      // Preflight: the CORS headers above (set when the Origin is allowed) tell the
      // browser the custom X-SyncSpace-Local header is permitted on /control/*.
      response.writeHead(204)
      response.end()
      return
    }

    const match = router.match(ctx.method, ctx.pathname)
    if (!match) {
      sendResponse(response, json({ code: 'not_found', message: 'Route not found' }, 404))
      return
    }

    ctx.params = match.params
    const result = await match.handler(ctx)
    // SSE and other raw handlers return void and own the socket themselves.
    if (result) sendResponse(response, result)
  } catch (error) {
    if (response.headersSent) return
    if (isHttpError(error)) {
      sendResponse(response, json({ code: error.code, message: error.message }, error.status))
      return
    }
    logger.error('Unhandled collector error', {
      error: error instanceof Error ? error.message : String(error)
    })
    sendResponse(response, json({ code: 'internal_error', message: 'Collector request failed.' }, 500))
  }
}
