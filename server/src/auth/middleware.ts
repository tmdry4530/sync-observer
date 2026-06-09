import type { ServerConfig } from '../config.js'
import type { RequestContext } from '../http/context.js'
import { forbidden, notFound, unauthorized } from '../http/errors.js'
import { getMembership, type MembershipRow } from '../db/repositories/workspaceRepository.js'
import { resolveSession } from './session.js'
import type { AgentTokenContext, AuthScope, SessionContext } from './context.js'
import { resolveAgentToken } from './agentToken.js'

const ROLE_RANK: Record<string, number> = { viewer: 0, member: 1, admin: 2, owner: 3 }

export function readBearerToken(ctx: RequestContext): string | null {
  const header = ctx.header('authorization')
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim() || null
  return null
}

export function readSessionToken(ctx: RequestContext, config: ServerConfig): string | null {
  return ctx.cookies[config.sessionCookieName] ?? readBearerToken(ctx)
}

export async function optionalSession(ctx: RequestContext, config: ServerConfig): Promise<SessionContext | null> {
  if (ctx.session) return ctx.session
  const token = readSessionToken(ctx, config)
  if (!token) return null
  const session = await resolveSession(config, token)
  ctx.session = session
  return session
}

export async function requireSession(ctx: RequestContext, config: ServerConfig): Promise<SessionContext> {
  const session = await optionalSession(ctx, config)
  if (!session) throw unauthorized('로그인이 필요합니다.', 'missing_session')
  return session
}

/**
 * Confirm the session user is a member of the workspace with at least
 * `minimumRole`. Returns 404 (not 403) for non-members so existence of the
 * workspace is not leaked.
 */
export async function requireWorkspaceMember(
  ctx: RequestContext,
  config: ServerConfig,
  workspaceId: string,
  minimumRole: 'viewer' | 'member' | 'admin' | 'owner' = 'member'
): Promise<{ session: SessionContext; membership: MembershipRow }> {
  const session = await requireSession(ctx, config)
  const membership = await getMembership(workspaceId, session.userId)
  if (!membership) throw notFound('워크스페이스를 찾을 수 없습니다.')

  const effectiveRole = membership.member_role ?? membership.role
  if ((ROLE_RANK[effectiveRole] ?? -1) < (ROLE_RANK[minimumRole] ?? 99)) {
    throw forbidden('이 작업을 수행할 권한이 없습니다.')
  }
  return { session, membership }
}

export async function requireAgentToken(
  ctx: RequestContext,
  config: ServerConfig,
  scope: AuthScope
): Promise<AgentTokenContext> {
  if (ctx.agentToken && ctx.agentToken.scopes.includes(scope)) return ctx.agentToken
  const token = readBearerToken(ctx)
  if (!token) throw unauthorized('에이전트 토큰이 필요합니다.', 'missing_agent_token')

  const resolved = await resolveAgentToken(config, token)
  if (!resolved) throw unauthorized('유효하지 않은 에이전트 토큰입니다.', 'invalid_agent_token')
  if (!resolved.scopes.includes(scope)) throw forbidden('토큰 스코프가 부족합니다.', 'insufficient_scope')

  ctx.agentToken = resolved
  return resolved
}
