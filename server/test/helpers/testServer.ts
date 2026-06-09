import { createSyncSpaceServer, type SyncSpaceServerHandle, type SyncSpaceServerOptions } from '../../src/http/app.js'
import { readConfig, type ServerConfig } from '../../src/config.js'
import { setPool } from '../../src/db/pool.js'
import type { EmbeddedDatabase } from './embeddedPostgres.js'

export interface TestServer {
  baseUrl: string
  handle: SyncSpaceServerHandle
  cookieJar: CookieJar
  stop(): Promise<void>
}

/** Minimal cookie jar so fetch-based tests can carry the session cookie. */
export class CookieJar {
  private cookies = new Map<string, string>()

  capture(setCookie: string | null): void {
    if (!setCookie) return
    for (const cookie of splitSetCookie(setCookie)) {
      const [pair] = cookie.split(';')
      const index = pair?.indexOf('=') ?? -1
      if (!pair || index < 0) continue
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      if (value === '' ) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }

  header(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')
  }
}

function splitSetCookie(value: string): string[] {
  // Handles the comma inside Expires=... by splitting only on cookie boundaries.
  return value.split(/,(?=\s*[^;=\s]+=)/)
}

export async function startTestServer(
  db: EmbeddedDatabase,
  overrides: Partial<ServerConfig> = {},
  options: Omit<SyncSpaceServerOptions, 'config'> = {}
): Promise<TestServer> {
  const config: ServerConfig = {
    ...readConfig(),
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    databaseUrl: db.connectionString,
    authSecret: 'test-auth-secret-0123456789abcdef',
    agentTokenPepper: 'test-agent-pepper',
    wsAuthMode: 'off',
    docPersistenceMode: 'postgres',
    allowedOrigins: ['*'],
    ...overrides
  }

  // Inject the embedded pool so repositories share the migrated test database.
  setPool(db.pool, { external: true })

  const handle = createSyncSpaceServer({ config, ...options })
  const address = await handle.start()
  const cookieJar = new CookieJar()

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    handle,
    cookieJar,
    stop: () => handle.stop()
  }
}

export interface ApiResponse<T> {
  status: number
  body: T
}

export async function apiRequest<T = unknown>(
  server: TestServer,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; useCookies?: boolean } = {}
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { ...options.headers }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.useCookies !== false) {
    const cookie = server.cookieJar.header()
    if (cookie) headers['cookie'] = cookie
  }

  const response = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
  })

  server.cookieJar.capture(response.headers.get('set-cookie'))
  const text = await response.text()
  const body = text ? (JSON.parse(text) as T) : (undefined as T)
  return { status: response.status, body }
}
