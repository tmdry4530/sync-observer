import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentTokenContext, SessionContext } from '../auth/context.js'
import { badRequest } from './errors.js'

const MAX_BODY_BYTES = 1024 * 1024 // 1 MiB

export interface RequestContext {
  req: IncomingMessage
  res: ServerResponse
  method: string
  url: URL
  pathname: string
  query: URLSearchParams
  params: Record<string, string>
  cookies: Record<string, string>
  ip: string | null
  /** Populated by requireSession middleware. */
  session: SessionContext | null
  /** Populated by requireAgentToken middleware. */
  agentToken: AgentTokenContext | null
  rawBody(): Promise<Buffer>
  json<T = unknown>(): Promise<T>
  header(name: string): string | null
}

export function createRequestContext(req: IncomingMessage, res: ServerResponse): RequestContext {
  const url = new URL(req.url ?? '/', 'http://syncspace.local')
  let bodyPromise: Promise<Buffer> | null = null

  const rawBody = (): Promise<Buffer> => {
    bodyPromise ??= readBody(req)
    return bodyPromise
  }

  return {
    req,
    res,
    method: (req.method ?? 'GET').toUpperCase(),
    url,
    pathname: url.pathname,
    query: url.searchParams,
    params: {},
    cookies: parseCookies(req.headers.cookie),
    ip: readClientIp(req),
    session: null,
    agentToken: null,
    rawBody,
    json: async <T = unknown>(): Promise<T> => {
      const buffer = await rawBody()
      if (buffer.length === 0) return {} as T
      try {
        return JSON.parse(buffer.toString('utf8')) as T
      } catch {
        throw badRequest('invalid_json', 'Request body is not valid JSON.')
      }
    },
    header: (name: string): string | null => {
      const value = req.headers[name.toLowerCase()]
      if (Array.isArray(value)) return value[0] ?? null
      return value ?? null
    }
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(badRequest('payload_too_large', 'Request body is too large.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=')
    if (index < 0) continue
    const name = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (!name) continue
    out[name] = decodeCookieValue(value)
  }
  return out
}

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function readClientIp(req: IncomingMessage): string | null {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]?.trim() ?? null
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0].split(',')[0]?.trim() ?? null
  }
  return req.socket.remoteAddress ?? null
}
