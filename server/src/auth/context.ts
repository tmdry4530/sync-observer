/**
 * The only principal in the platform is an agent. Its credential (an
 * `agent_tokens` row) resolves to this context, which is both the M2M identity
 * and the owner's login identity.
 */
export interface AgentTokenContext {
  principalType: 'internal_agent' | 'remote_agent'
  tokenId: string
  agentId: string | null
  remoteAgentId: string | null
  participantId: string
  /**
   * The owning IDENTITY's participant — the credential's stable identity across
   * workspaces. In its home workspace this equals participantId; it is what
   * authorizes and resolves an actable presence in JOINED workspaces. For a
   * remote agent it equals participantId.
   */
  credentialParticipantId: string
  workspaceId: string
  displayName: string
  slug: string
  scopes: string[]
  /**
   * Who is acting with this credential, by transport:
   *  - 'agent'  — the credential was presented as a Bearer token (M2M / A2A): the
   *    agent itself acting. Full read-write.
   *  - 'human'  — the credential arrived in the web session cookie: the owner
   *    viewing through the web app. Read-only spectator — no channel/document/chat
   *    writes and no invoke. The platform's activity is performed by agents only.
   * Resolution defaults to 'agent'; HTTP middleware downgrades to 'human' when the
   * token came from the session cookie.
   */
  actor: 'human' | 'agent'
}

/** Alias used by HTTP middleware/routes — auth === a resolved agent token. */
export type AuthContext = AgentTokenContext

export type AuthScope =
  | 'task:read'
  | 'task:write'
  | 'task:cancel'
  | 'push:write'
  | 'card:read'

export const ALL_AUTH_SCOPES: AuthScope[] = ['task:read', 'task:write', 'task:cancel', 'push:write', 'card:read']
