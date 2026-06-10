import type { ServerConfig } from '../config.js'
import type { RequestContext } from '../http/context.js'
import { forbidden, notFound, unauthorized } from '../http/errors.js'
import type { AuthContext, AuthScope } from './context.js'
import { resolveAgentToken } from './agentToken.js'

export function readBearerToken(ctx: RequestContext): string | null {
  const header = ctx.header('authorization')
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim() || null
  return null
}

/** The auth credential is the agent secret, carried in the session cookie or a bearer header. */
export function readAuthToken(ctx: RequestContext, config: ServerConfig): string | null {
  return ctx.cookies[config.sessionCookieName] ?? readBearerToken(ctx)
}

export async function optionalAuth(ctx: RequestContext, config: ServerConfig): Promise<AuthContext | null> {
  if (ctx.auth) return ctx.auth
  const token = readAuthToken(ctx, config)
  if (!token) return null
  if (!config.databaseUrl || !config.agentTokenPepper) return null
  const auth = await resolveAgentToken(config, token)
  ctx.auth = auth
  return auth
}

export async function requireAuth(ctx: RequestContext, config: ServerConfig): Promise<AuthContext> {
  const auth = await optionalAuth(ctx, config)
  if (!auth) throw unauthorized('로그인이 필요합니다.', 'missing_auth')
  return auth
}

/**
 * Authorize the caller for a workspace. An agent belongs to exactly one
 * workspace (its working environment); access is granted only to that workspace.
 * Returns 404 (not 403) for mismatches so other workspaces are never revealed.
 * `minimumRole` is accepted for call-site compatibility — the agent is the owner
 * of its own environment, so no finer role gating applies.
 */
export async function requireWorkspaceMember(
  ctx: RequestContext,
  config: ServerConfig,
  workspaceId: string,
  _minimumRole: 'viewer' | 'member' | 'admin' | 'owner' = 'member'
): Promise<{ auth: AuthContext }> {
  const auth = await requireAuth(ctx, config)
  if (auth.workspaceId !== workspaceId) throw notFound('워크스페이스를 찾을 수 없습니다.')
  return { auth }
}

export async function requireScope(ctx: RequestContext, config: ServerConfig, scope: AuthScope): Promise<AuthContext> {
  const auth = await requireAuth(ctx, config)
  if (!auth.scopes.includes(scope)) throw forbidden('토큰 스코프가 부족합니다.', 'insufficient_scope')
  return auth
}
