import type { ServerConfig } from '../config.js'
import type { RequestContext } from '../http/context.js'
import { notFound, unauthorized } from '../http/errors.js'
import { resolveAgentToken } from '../auth/agentToken.js'
import { readAuthToken } from '../auth/middleware.js'
import { getMembership } from '../db/repositories/workspaceRepository.js'

export interface A2aPrincipal {
  kind: 'agent'
  participantId: string
  /**
   * The owning IDENTITY's participant — stable across workspaces. Used to
   * authorize and resolve an actable presence in JOINED workspaces. Equals
   * participantId in the home workspace and for remote agents.
   */
  credentialParticipantId: string
  /** The agent credential's HOME workspace (always allowed). */
  workspaceId: string
  agentId: string | null
  remoteAgentId: string | null
  scopes: string[]
}

/** Resolve an A2A caller from an agent credential (bearer token or session cookie). */
export async function resolvePrincipal(ctx: RequestContext, config: ServerConfig): Promise<A2aPrincipal | null> {
  const token = readAuthToken(ctx, config)
  if (!token) return null
  const agent = await resolveAgentToken(config, token)
  if (!agent) return null
  return {
    kind: 'agent',
    participantId: agent.participantId,
    credentialParticipantId: agent.credentialParticipantId,
    workspaceId: agent.workspaceId,
    agentId: agent.agentId,
    remoteAgentId: agent.remoteAgentId,
    scopes: agent.scopes
  }
}

export async function requirePrincipal(ctx: RequestContext, config: ServerConfig): Promise<A2aPrincipal> {
  const principal = await resolvePrincipal(ctx, config)
  if (!principal) throw unauthorized('A2A 호출에는 인증이 필요합니다.', 'unauthorized')
  return principal
}

export function requireScope(principal: A2aPrincipal, scope: string): void {
  if (!principal.scopes.includes(scope)) {
    throw unauthorized('토큰 스코프가 부족합니다.', 'insufficient_scope')
  }
}

/**
 * Confirm the principal may act in `workspaceId`. Access is granted to the
 * credential's HOME workspace OR any workspace the IDENTITY has joined (a
 * workspace_members row keyed by credentialParticipantId). Returns 404 (not 403)
 * for non-members so the existence of out-of-scope workspaces/tasks is never
 * revealed — the cross-workspace IDOR boundary, mirroring
 * requireWorkspaceMember in middleware.ts exactly.
 */
export async function assertWorkspaceAccess(principal: A2aPrincipal, workspaceId: string): Promise<void> {
  // Fast path: the credential's home workspace is always allowed (no extra query).
  if (principal.workspaceId === workspaceId) return
  // Otherwise the identity must have a membership row in the requested workspace.
  const membership = await getMembership(workspaceId, principal.credentialParticipantId)
  if (!membership) throw notFound()
}
