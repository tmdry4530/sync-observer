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

export interface AuthTokenSource {
  token: string
  /** 'cookie' = web session (human owner) · 'bearer' = M2M/A2A (the agent itself). */
  via: 'cookie' | 'bearer'
}

/**
 * The agent secret can arrive in the session cookie (web login) or a bearer header
 * (M2M / A2A). The transport determines the actor: a cookie is the human owner
 * viewing the web app (read-only spectator); a bearer is the agent acting.
 */
export function readAuthTokenSource(ctx: RequestContext, config: ServerConfig): AuthTokenSource | null {
  const cookie = ctx.cookies[config.sessionCookieName]
  if (cookie) return { token: cookie, via: 'cookie' }
  const bearer = readBearerToken(ctx)
  if (bearer) return { token: bearer, via: 'bearer' }
  return null
}

/** The auth credential is the agent secret, carried in the session cookie or a bearer header. */
export function readAuthToken(ctx: RequestContext, config: ServerConfig): string | null {
  return readAuthTokenSource(ctx, config)?.token ?? null
}

export async function optionalAuth(ctx: RequestContext, config: ServerConfig): Promise<AuthContext | null> {
  if (ctx.auth) return ctx.auth
  const source = readAuthTokenSource(ctx, config)
  if (!source) return null
  if (!config.databaseUrl || !config.agentTokenPepper) return null
  const auth = await resolveAgentToken(config, source.token)
  // A cookie-carried credential is the owner spectating via the web app; only a
  // bearer credential is the agent acting. This is the read-only spectator gate.
  if (auth) auth.actor = source.via === 'cookie' ? 'human' : 'agent'
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

/**
 * Reject human (web-session) callers: only an agent acting via Bearer/A2A may
 * perform workspace activity (create channels/documents, invoke, cancel, and chat
 * /document edits over the realtime socket). A logged-in human is a read-only
 * spectator of the channels their agent belongs to.
 */
export function assertAgentActor(auth: AuthContext): void {
  if (auth.actor !== 'agent') {
    throw forbidden(
      '인간 사용자는 관전만 가능합니다. 채널·문서·채팅 등 활동은 에이전트만 수행할 수 있습니다.',
      'spectator_read_only'
    )
  }
}

/** Authorize the caller for a workspace AND require they are an acting agent (not a spectator). */
export async function requireAgentActor(
  ctx: RequestContext,
  config: ServerConfig,
  workspaceId: string
): Promise<{ auth: AuthContext }> {
  const { auth } = await requireWorkspaceMember(ctx, config, workspaceId)
  assertAgentActor(auth)
  return { auth }
}
