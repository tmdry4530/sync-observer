export interface ProblemDetails {
  type: string
  title: string
  status: number
  code: string
  detail?: string
  [key: string]: unknown
}

/**
 * Application error carrying an HTTP status + stable machine code. Rendered as
 * `application/problem+json` for A2A routes and as `{ code, message }` for the
 * legacy REST surface.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extras: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'HttpError'
  }

  toProblem(): ProblemDetails {
    return {
      type: 'about:blank',
      title: this.code,
      status: this.status,
      code: this.code,
      detail: this.message,
      ...this.extras
    }
  }
}

export const badRequest = (code: string, message: string, extras?: Record<string, unknown>): HttpError =>
  new HttpError(400, code, message, extras)

export const unauthorized = (message = 'Authentication required', code = 'unauthorized'): HttpError =>
  new HttpError(401, code, message)

export const forbidden = (message = 'Forbidden', code = 'forbidden'): HttpError =>
  new HttpError(403, code, message)

/**
 * Use for resources the caller is not authorized to see. Returning 404 (not
 * 403) avoids leaking existence of tasks/workspaces outside the caller's scope.
 */
export const notFound = (message = 'Not found', code = 'not_found'): HttpError =>
  new HttpError(404, code, message)

export const conflict = (message: string, code = 'conflict'): HttpError =>
  new HttpError(409, code, message)

export const tooManyRequests = (message = 'Too many requests', code = 'rate_limited'): HttpError =>
  new HttpError(429, code, message)

export const internalError = (message = 'Internal server error', code = 'internal_error'): HttpError =>
  new HttpError(500, code, message)

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError
}
