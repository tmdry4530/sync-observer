export type ID = string

export interface UserProfile {
  id: ID
  displayName: string
  avatarUrl: string | null
  color: string
}

export interface Workspace {
  id: ID
  name: string
  ownerId: ID
  inviteCode: string
  createdAt: string
}

export interface WorkspaceMember {
  workspaceId: ID
  userId: ID
  role: 'owner' | 'member'
  joinedAt: string
  user: UserProfile
}

export interface Channel {
  id: ID
  workspaceId: ID
  name: string
  createdBy: ID
  createdAt: string
}

export interface ChatMessage {
  id: ID
  channelId: ID
  userId: ID
  content: string
  createdAt: string
  clientId?: string
  status?: 'sent' | 'pending' | 'failed'
  user?: UserProfile
}

export interface DocumentMeta {
  id: ID
  workspaceId: ID
  title: string
  createdBy: ID
  updatedAt: string
}

export interface PresenceUser {
  id: string
  displayName: string
  avatarUrl: string | null
  color: string
}

export interface AwarenessState {
  user: PresenceUser
  cursor?: {
    anchor: number
    head: number
  }
  mode: 'chat' | 'document'
  lastSeenAt: number
}

export interface AppError {
  code: string
  message: string
  details?: unknown
}

export interface PaginatedChatMessages {
  items: ChatMessage[]
  nextCursor: string | null
}

export type ParticipantType = 'human' | 'agent'

export type AgentRole = 'planner' | 'builder' | 'reviewer' | 'doc_writer' | 'orchestrator'

export type AgentRuntimeStatus =
  | 'idle'
  | 'running'
  | 'waiting_for_input'
  | 'auth_required'
  | 'failed'
  | 'disabled'

export interface ParticipantProfile {
  id: ID
  participantType: ParticipantType
  displayName: string
  avatarUrl: string | null
  color: string
  agentRole?: AgentRole
  agentStatus?: AgentRuntimeStatus
}

export interface AgentProfile {
  id: ID
  workspaceId: ID
  participantId: ID
  slug: string
  displayName: string
  description: string | null
  role: AgentRole
  status: AgentRuntimeStatus
  createdAt: string
  updatedAt: string
}

export interface AuthUser {
  id: ID
  email: string
  displayName: string
  avatarUrl: string | null
  color: string
}

