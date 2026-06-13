import { z } from 'zod'

// ---------- Common fields ----------

const CommonFields = {
  kind: z.string(),
  timestamp: z.string(),
  demo: z.boolean().optional()
}

// ---------- Per-kind schemas ----------

const AgentStatusSchema = z.object({
  ...CommonFields,
  kind: z.literal('agent_status'),
  agentId: z.string(),
  role: z.string(),
  status: z.string(),
  currentAction: z.string(),
  path: z.string().optional()
})

const PipelineStageSchema = z.object({
  ...CommonFields,
  kind: z.literal('pipeline_stage'),
  agentId: z.string().optional(),
  stage: z.enum(['planning', 'implementation', 'testing', 'review', 'merge']),
  status: z.enum(['pending', 'active', 'done', 'failed']),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  summary: z.string().optional()
})

const FileEditSchema = z.object({
  ...CommonFields,
  kind: z.literal('file_edit'),
  agentId: z.string(),
  path: z.string(),
  unifiedDiff: z.string(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  summary: z.string()
})

const CommandRunSchema = z.object({
  ...CommonFields,
  kind: z.literal('command_run'),
  agentId: z.string(),
  command: z.string(),
  cwd: z.string().optional(),
  status: z.enum(['running', 'success', 'failed']),
  exitCode: z.number().optional(),
  stdoutTail: z.string().optional(),
  stderrTail: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional()
})

const TestResultSchema = z.object({
  ...CommonFields,
  kind: z.literal('test_result'),
  agentId: z.string(),
  suite: z.string(),
  status: z.enum(['passed', 'failed']),
  passed: z.number().optional(),
  failed: z.number().optional(),
  durationMs: z.number().optional(),
  failures: z
    .array(
      z.object({
        name: z.string(),
        message: z.string().optional()
      })
    )
    .optional()
})

const ReviewCommentSchema = z.object({
  ...CommonFields,
  kind: z.literal('review_comment'),
  agentId: z.string(),
  reviewerId: z.string().optional(),
  path: z.string(),
  lineStart: z.number().optional(),
  lineEnd: z.number().optional(),
  severity: z.enum(['info', 'warn', 'error']),
  comment: z.string(),
  verdict: z.enum(['approve', 'request_changes']).optional()
})

const VcsEventSchema = z.object({
  ...CommonFields,
  kind: z.literal('vcs_event'),
  agentId: z.string(),
  action: z.enum(['branch_created', 'commit', 'pr_opened']),
  branch: z.string().optional(),
  commitSha: z.string().optional(),
  // http(s) only: this value becomes a clickable link in the Mission View.
  prUrl: z.string().regex(/^https?:\/\//i, 'prUrl must be an http(s) URL').optional(),
  summary: z.string().optional()
})

// ---------- Discriminated union ----------

export const EngineeringEventSchema = z.discriminatedUnion('kind', [
  AgentStatusSchema,
  PipelineStageSchema,
  FileEditSchema,
  CommandRunSchema,
  TestResultSchema,
  ReviewCommentSchema,
  VcsEventSchema
])

export type EngineeringEvent = z.infer<typeof EngineeringEventSchema>
export type EngineeringEventKind = EngineeringEvent['kind']

export const ENGINEERING_EVENT_TYPES = [
  'agent_status',
  'pipeline_stage',
  'file_edit',
  'command_run',
  'test_result',
  'review_comment',
  'vcs_event'
] as const satisfies readonly EngineeringEventKind[]

export function isEngineeringEventType(t: string): t is EngineeringEventKind {
  return (ENGINEERING_EVENT_TYPES as readonly string[]).includes(t)
}

export function parseEngineeringEvent(value: unknown): EngineeringEvent | null {
  const result = EngineeringEventSchema.safeParse(value)
  return result.success ? result.data : null
}
