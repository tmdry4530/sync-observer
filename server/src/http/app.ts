import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isOriginAllowed, readConfig, type ServerConfig } from '../config.js'
import { createRealtimeAuthorizer, type RealtimeAuthorizer } from '../auth/realtimeAuth.js'
import { createMessagePersistenceAdapter, type MessagePersistenceAdapter } from '../persistence/messagePersistence.js'
import { setupYWebsocketServer, type RealtimeServerHandle } from '../realtime/setupYWebsocket.js'
import { createLogger, type Logger } from '../utils/logger.js'
import { closePool } from '../db/pool.js'
import { Router } from './router.js'
import { createRequestContext, type RequestContext } from './context.js'
import { json, sendResponse, type HttpResponse } from './response.js'
import { isHttpError } from './errors.js'
import { registerHealthRoutes } from './routes/healthRoutes.js'
import { registerAuthRoutes } from './routes/authRoutes.js'
import { registerWorkspaceRoutes } from './routes/workspaceRoutes.js'

export interface SyncSpaceServerOptions {
  config?: ServerConfig
  logger?: Logger
  messagePersistence?: MessagePersistenceAdapter
  authorizer?: RealtimeAuthorizer
  /** Extra raw handlers tried before the REST router (used to mount the A2A surface). */
  rawHandlers?: RawHttpHandler[]
  queueStats?: () => { queuedJobs: number; runningJobs: number } | null
}

/** A raw handler returns a response when it claims the request, or null to pass through. */
export type RawHttpHandler = (ctx: RequestContext) => Promise<HttpResponse | null> | HttpResponse | null

export interface SyncSpaceServerHandle {
  server: HttpServer
  realtime: RealtimeServerHandle
  config: ServerConfig
  router: Router
  start(): Promise<AddressInfo>
  stop(): Promise<void>
}

export function createSyncSpaceServer(options: SyncSpaceServerOptions = {}): SyncSpaceServerHandle {
  const config = options.config ?? readConfig()
  const logger = options.logger ?? createLogger(config.logLevel)
  const messagePersistence = options.messagePersistence ?? createMessagePersistenceAdapter(config, logger)
  const authorizer = options.authorizer ?? createRealtimeAuthorizer(config, logger)
  const rawHandlers = options.rawHandlers ?? []

  let realtime: RealtimeServerHandle
  const router = new Router()
  registerHealthRoutes(router, {
    config,
    realtimeStats: () => realtime.stats(),
    ...(options.queueStats ? { queueStats: options.queueStats } : {})
  })
  registerAuthRoutes(router, config)
  registerWorkspaceRoutes(router, config)

  const server = createServer((request, response) => {
    void dispatch(request, response, router, config, logger, rawHandlers)
  })

  realtime = setupYWebsocketServer({ server, config, logger, messagePersistence, authorizer })

  return {
    server,
    realtime,
    config,
    router,
    start: () =>
      new Promise<AddressInfo>((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.port, config.host, () => {
          server.off('error', reject)
          const address = server.address()
          if (!address || typeof address === 'string') {
            reject(new Error('Server did not expose an address'))
            return
          }
          logger.info('SyncSpace backend listening', { host: config.host, port: address.port })
          resolve(address)
        })
      }),
    stop: async () => {
      await realtime.close()
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close((error) => (error ? reject(error) : resolve()))
      })
      await closePool().catch(() => undefined)
    }
  }
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  router: Router,
  config: ServerConfig,
  logger: Logger,
  rawHandlers: RawHttpHandler[]
): Promise<void> {
  const ctx = createRequestContext(request, response)
  const cors = corsHeaders(request)

  try {
    if (request.headers.origin && !isOriginAllowed(request.headers.origin, config.allowedOrigins)) {
      sendResponse(response, json({ code: 'forbidden_origin', message: 'Origin is not allowed' }, 403), cors)
      return
    }

    if (ctx.method === 'OPTIONS') {
      response.writeHead(204, cors)
      response.end()
      return
    }

    for (const handler of rawHandlers) {
      const result = await handler(ctx)
      if (result) {
        sendResponse(response, result, cors)
        return
      }
      if (response.headersSent) return
    }

    const match = router.match(ctx.method, ctx.pathname)
    if (!match) {
      sendResponse(response, json({ code: 'not_found', message: 'Route not found' }, 404), cors)
      return
    }

    ctx.params = match.params
    const result = await match.handler(ctx)
    if (result) sendResponse(response, result, cors)
  } catch (error) {
    if (response.headersSent) return
    if (isHttpError(error)) {
      sendResponse(response, json({ code: error.code, message: error.message }, error.status), cors)
      return
    }
    logger.error('Unhandled HTTP error', { error: error instanceof Error ? error.message : String(error) })
    sendResponse(response, json({ code: 'internal_error', message: '서버 요청 처리 중 문제가 발생했습니다.' }, 500), cors)
  }
}

function corsHeaders(request: IncomingMessage): Record<string, string> {
  const origin = request.headers.origin
  return {
    ...(origin ? { 'access-control-allow-origin': origin } : {}),
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,a2a-version,a2a-extensions'
  }
}
