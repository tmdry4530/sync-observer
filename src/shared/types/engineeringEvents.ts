/**
 * Frontend mirror of server/src/a2a/engineeringEvents.ts
 * DO NOT import server code — this file is the canonical frontend copy.
 */

export type PipelineStage = 'planning' | 'implementation' | 'testing' | 'review' | 'merge'
export type PipelineStageStatus = 'pending' | 'active' | 'done' | 'failed'

export interface AgentStatusEvent {
  kind: 'agent_status'
  agentId: string
  timestamp: string
  demo?: boolean
  role: string
  status: string
  currentAction: string
  path?: string
}

export interface PipelineStageEvent {
  kind: 'pipeline_stage'
  agentId?: string
  timestamp: string
  demo?: boolean
  stage: PipelineStage
  status: PipelineStageStatus
  startedAt?: string
  endedAt?: string
  summary?: string
}

export interface FileEditEvent {
  kind: 'file_edit'
  agentId: string
  timestamp: string
  demo?: boolean
  path: string
  unifiedDiff: string
  additions?: number
  deletions?: number
  summary: string
}

export interface CommandRunEvent {
  kind: 'command_run'
  agentId: string
  timestamp: string
  demo?: boolean
  command: string
  cwd?: string
  status: 'running' | 'success' | 'failed'
  exitCode?: number
  stdoutTail?: string
  stderrTail?: string
  startedAt?: string
  endedAt?: string
}

export interface TestResultEvent {
  kind: 'test_result'
  agentId: string
  timestamp: string
  demo?: boolean
  suite: string
  status: 'passed' | 'failed'
  passed?: number
  failed?: number
  durationMs?: number
  failures?: Array<{ name: string; message?: string }>
}

export interface ReviewCommentEvent {
  kind: 'review_comment'
  agentId: string
  timestamp: string
  demo?: boolean
  reviewerId?: string
  path: string
  lineStart?: number
  lineEnd?: number
  severity: 'info' | 'warn' | 'error'
  comment: string
  verdict?: 'approve' | 'request_changes'
}

export interface VcsEvent {
  kind: 'vcs_event'
  agentId: string
  timestamp: string
  demo?: boolean
  action: 'branch_created' | 'commit' | 'pr_opened'
  branch?: string
  commitSha?: string
  prUrl?: string
  summary?: string
}

export type EngineeringEvent =
  | AgentStatusEvent
  | PipelineStageEvent
  | FileEditEvent
  | CommandRunEvent
  | TestResultEvent
  | ReviewCommentEvent
  | VcsEvent

export type EngineeringEventKind = EngineeringEvent['kind']

export const ENGINEERING_EVENT_KINDS: readonly EngineeringEventKind[] = [
  'agent_status',
  'pipeline_stage',
  'file_edit',
  'command_run',
  'test_result',
  'review_comment',
  'vcs_event'
] as const

export function isEngineeringEventKind(k: string): k is EngineeringEventKind {
  return (ENGINEERING_EVENT_KINDS as readonly string[]).includes(k)
}

const PIPELINE_STAGES: readonly string[] = ['planning', 'implementation', 'testing', 'review', 'merge']
const PIPELINE_STAGE_STATUSES: readonly string[] = ['pending', 'active', 'done', 'failed']

/** Required string fields per kind, beyond the common `timestamp`. */
const REQUIRED_STRINGS: Record<EngineeringEventKind, readonly string[]> = {
  agent_status: ['agentId', 'role', 'status', 'currentAction'],
  pipeline_stage: [],
  file_edit: ['agentId', 'path', 'unifiedDiff', 'summary'],
  command_run: ['agentId', 'command'],
  test_result: ['agentId', 'suite'],
  review_comment: ['agentId', 'path', 'comment'],
  vcs_event: ['agentId']
}

/** Required enum-valued fields per kind (field name → allowed values). */
const REQUIRED_ENUMS: Partial<
  Record<EngineeringEventKind, ReadonlyArray<readonly [string, readonly string[]]>>
> = {
  pipeline_stage: [
    ['stage', PIPELINE_STAGES],
    ['status', PIPELINE_STAGE_STATUSES]
  ],
  command_run: [['status', ['running', 'success', 'failed']]],
  test_result: [['status', ['passed', 'failed']]],
  review_comment: [['severity', ['info', 'warn', 'error']]],
  vcs_event: [['action', ['branch_created', 'commit', 'pr_opened']]]
}

/**
 * Safely parse an unknown payload as an EngineeringEvent.
 * Returns null if the payload is missing required fields, so renderers can
 * dereference required fields without crashing the whole Mission View on one
 * malformed row (the repository does not validate payloads on insert).
 */
export function parseEngineeringEvent(value: unknown): EngineeringEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const obj = value as Record<string, unknown>
  const kind = obj.kind
  if (typeof kind !== 'string' || !isEngineeringEventKind(kind)) return null
  if (typeof obj.timestamp !== 'string') return null
  for (const field of REQUIRED_STRINGS[kind]) {
    if (typeof obj[field] !== 'string') return null
  }
  for (const [field, values] of REQUIRED_ENUMS[kind] ?? []) {
    const v = obj[field]
    if (typeof v !== 'string' || !values.includes(v)) return null
  }
  return obj as unknown as EngineeringEvent
}
