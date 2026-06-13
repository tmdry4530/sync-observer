/**
 * Frontend types for the Mission View endpoints.
 * Mirrors the backend response shapes exactly — no server imports.
 */

// ── Mission Detail  GET /api/missions/:contextId ──────────────────────────────

export interface MissionSummaryMeta {
  contextId: string
  workspaceId: string
  channelId: string | null
  createdAt: string
}

/** One event in the context-scoped engineering timeline. */
export interface MissionEvent {
  /** a2a_task_events.seq is a Postgres bigint — serialized as a STRING on the wire. */
  seq: string
  taskId: string
  type: string
  createdAt: string
  payload: Record<string, unknown> | null
}

export interface MissionTaskSummary {
  taskId: string
  agentId: string | null
  statusState: string
  title: string | null
  createdAt: string
}

export interface MissionAgentSummary {
  agentId: string
  slug: string
  displayName: string
  role: string
}

export interface MissionDetailResponse {
  mission: MissionSummaryMeta
  events: MissionEvent[]
  tasks: MissionTaskSummary[]
  agents: MissionAgentSummary[]
}

// ── Mission List  GET /api/workspaces/:workspaceId/missions ────────────────────

export interface WorkspaceMissionSummary {
  contextId: string
  channelId: string | null
  title: string | null
  agentCount: number
  eventCount: number
  updatedAt: string
  createdAt: string
}

export interface WorkspaceMissionsResponse {
  missions: WorkspaceMissionSummary[]
}
