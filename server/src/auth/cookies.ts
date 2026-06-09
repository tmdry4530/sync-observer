import type { ServerConfig } from '../config.js'

export interface CookieOptions {
  maxAgeSeconds?: number
  expires?: Date
  domain?: string | null
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'Lax' | 'Strict' | 'None'
  path?: string
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  parts.push(`Path=${options.path ?? '/'}`)
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAgeSeconds)}`)
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`)
  if (options.domain) parts.push(`Domain=${options.domain}`)
  if (options.httpOnly ?? true) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`)
  return parts.join('; ')
}

function cookieSecurity(config: ServerConfig): Pick<CookieOptions, 'secure' | 'domain' | 'sameSite' | 'httpOnly'> {
  return {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'Lax',
    ...(config.sessionCookieDomain ? { domain: config.sessionCookieDomain } : {})
  }
}

export function buildSessionSetCookie(config: ServerConfig, token: string, expiresAt: Date): string {
  return serializeCookie(config.sessionCookieName, token, {
    ...cookieSecurity(config),
    expires: expiresAt,
    maxAgeSeconds: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
  })
}

export function buildSessionClearCookie(config: ServerConfig): string {
  return serializeCookie(config.sessionCookieName, '', {
    ...cookieSecurity(config),
    maxAgeSeconds: 0,
    expires: new Date(0)
  })
}
