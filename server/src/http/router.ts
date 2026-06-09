import type { HttpResponse } from './response.js'
import type { RequestContext } from './context.js'

export type RouteHandler = (ctx: RequestContext) => Promise<HttpResponse | void> | HttpResponse | void

type Segment = { kind: 'literal'; value: string } | { kind: 'param'; name: string }

interface Route {
  method: string
  segments: Segment[]
  handler: RouteHandler
}

export interface RouteMatch {
  handler: RouteHandler
  params: Record<string, string>
}

function compile(pattern: string): Segment[] {
  return pattern
    .split('/')
    .filter(Boolean)
    .map((part) => (part.startsWith(':') ? { kind: 'param', name: part.slice(1) } : { kind: 'literal', value: part }))
}

function splitPath(pathname: string): string[] {
  return pathname
    .split('/')
    .filter(Boolean)
    .map((part) => decodeSegment(part))
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Minimal method + `:param` router for the REST surface. A2A's colon-verb
 * endpoints are matched separately in `a2a/routes.ts`.
 */
export class Router {
  private readonly routes: Route[] = []

  add(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({ method: method.toUpperCase(), segments: compile(pattern), handler })
    return this
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.add('GET', pattern, handler)
  }

  post(pattern: string, handler: RouteHandler): this {
    return this.add('POST', pattern, handler)
  }

  put(pattern: string, handler: RouteHandler): this {
    return this.add('PUT', pattern, handler)
  }

  patch(pattern: string, handler: RouteHandler): this {
    return this.add('PATCH', pattern, handler)
  }

  delete(pattern: string, handler: RouteHandler): this {
    return this.add('DELETE', pattern, handler)
  }

  match(method: string, pathname: string): RouteMatch | null {
    const parts = splitPath(pathname)
    const upperMethod = method.toUpperCase()

    for (const route of this.routes) {
      if (route.method !== upperMethod) continue
      if (route.segments.length !== parts.length) continue

      const params: Record<string, string> = {}
      let matched = true
      for (let i = 0; i < route.segments.length; i += 1) {
        const segment = route.segments[i]
        const part = parts[i]
        if (!segment || part === undefined) {
          matched = false
          break
        }
        if (segment.kind === 'literal') {
          if (segment.value !== part) {
            matched = false
            break
          }
        } else {
          params[segment.name] = part
        }
      }

      if (matched) return { handler: route.handler, params }
    }

    return null
  }

  /** True when the path matches a registered pattern under any method. */
  hasPath(pathname: string): boolean {
    const parts = splitPath(pathname)
    return this.routes.some((route) => {
      if (route.segments.length !== parts.length) return false
      return route.segments.every((segment, i) => segment.kind === 'param' || segment.value === parts[i])
    })
  }
}
