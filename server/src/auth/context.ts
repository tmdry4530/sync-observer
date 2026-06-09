export interface SessionContext {
  sessionId: string
  userId: string
  participantId: string
  email: string
  displayName: string
}

export interface AgentTokenContext {
  tokenId: string
  agentId: string
  participantId: string
  workspaceId: string
  scopes: string[]
}

export type AuthScope =
  | 'task:read'
  | 'task:write'
  | 'task:cancel'
  | 'push:write'
  | 'card:read'
