import type { ServerResponse } from 'node:http'
import type { ProblemDetails } from './errors.js'

export type HttpResponse =
  | { kind: 'json'; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: 'problem'; status: number; problem: ProblemDetails; headers?: Record<string, string> }
  | { kind: 'text'; status: number; body: string; contentType?: string; headers?: Record<string, string> }
  | { kind: 'empty'; status: number; headers?: Record<string, string> }

export function json(body: unknown, status = 200, headers?: Record<string, string>): HttpResponse {
  return { kind: 'json', status, body, ...(headers ? { headers } : {}) }
}

export function problem(details: ProblemDetails, headers?: Record<string, string>): HttpResponse {
  return { kind: 'problem', status: details.status, problem: details, ...(headers ? { headers } : {}) }
}

export function text(body: string, status = 200, contentType = 'text/plain; charset=utf-8'): HttpResponse {
  return { kind: 'text', status, body, contentType }
}

export function noContent(headers?: Record<string, string>): HttpResponse {
  return { kind: 'empty', status: 204, ...(headers ? { headers } : {}) }
}

export function sendResponse(
  res: ServerResponse,
  response: HttpResponse,
  baseHeaders: Record<string, string> = {}
): void {
  const headers = { ...baseHeaders, ...(response.headers ?? {}) }

  switch (response.kind) {
    case 'json':
      res.writeHead(response.status, { ...headers, 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(response.body))
      return
    case 'problem':
      res.writeHead(response.status, { ...headers, 'content-type': 'application/problem+json; charset=utf-8' })
      res.end(JSON.stringify(response.problem))
      return
    case 'text':
      res.writeHead(response.status, { ...headers, 'content-type': response.contentType ?? 'text/plain; charset=utf-8' })
      res.end(response.body)
      return
    case 'empty':
      res.writeHead(response.status, headers)
      res.end()
  }
}
