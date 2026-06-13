/**
 * Demo mission seeder — illustrative demo data, no real tool execution.
 *
 * All events carry `demo: true` to make it unambiguous that these payloads
 * describe a fictional engineering story. No actual code runs, no real git
 * operations occur, and no test suite is executed.
 */
import { createTaskFromMessage } from '../a2a/taskService.js'
import { appendEvent } from '../db/repositories/a2aRepository.js'
import { parseEngineeringEvent } from '../a2a/engineeringEvents.js'
import type { EngineeringEvent } from '../a2a/engineeringEvents.js'

export interface SeedDemoMissionInput {
  workspaceId: string
  agentId: string
  createdByParticipantId: string
}

export interface SeedDemoMissionResult {
  taskId: string
  contextId: string
}

/** ISO timestamp helper — adds `offsetMs` to a fixed base so events are ordered. */
function ts(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString()
}

function validateEvent(payload: unknown, step: number): EngineeringEvent {
  const parsed = parseEngineeringEvent(payload)
  if (!parsed) {
    throw new Error(`Demo mission: step ${step} payload failed parseEngineeringEvent validation: ${JSON.stringify(payload)}`)
  }
  return parsed
}

/**
 * The 12-step payment-module story, in chronological order.  Every pipeline
 * stage that starts also ends (except `merge`, which the story deliberately
 * leaves active: "PR 머지 대기 중"), so the stepper tells the full
 * fail → fix → pass arc instead of freezing mid-flight.
 */
function buildStory(base: number): unknown[] {
  return [
    // ── Step 1 ── orchestrator kicks off planning ─────────────────────────────
    {
      kind: 'agent_status',
      timestamp: ts(base, 0),
      agentId: 'orchestrator',
      role: 'orchestrator',
      status: 'working',
      currentAction: '태스크 분석 및 에이전트 배정 중',
      demo: true
    },
    {
      kind: 'pipeline_stage',
      timestamp: ts(base, 1_000),
      stage: 'planning',
      status: 'active',
      startedAt: ts(base, 1_000),
      demo: true
    },

    // ── Step 2 ── planner finishes planning ───────────────────────────────────
    {
      kind: 'agent_status',
      timestamp: ts(base, 30_000),
      agentId: 'planner',
      role: 'planner',
      status: 'done',
      currentAction: '구현 계획 작성 완료',
      demo: true
    },
    {
      kind: 'pipeline_stage',
      timestamp: ts(base, 31_000),
      stage: 'planning',
      status: 'done',
      endedAt: ts(base, 31_000),
      summary: 'PaymentService + 라우터 추가, 테스트 3개 작성',
      demo: true
    },

    // ── Step 3 ── builder starts implementation, first file edit ──────────────
    {
      kind: 'pipeline_stage',
      timestamp: ts(base, 60_000),
      stage: 'implementation',
      status: 'active',
      startedAt: ts(base, 60_000),
      demo: true
    },
    {
      kind: 'agent_status',
      timestamp: ts(base, 61_000),
      agentId: 'builder',
      role: 'builder',
      status: 'working',
      currentAction: 'server/src/payment.ts 파일 생성 중',
      path: 'server/src/payment.ts',
      demo: true
    },
    {
      kind: 'file_edit',
      timestamp: ts(base, 90_000),
      agentId: 'builder',
      path: 'server/src/payment.ts',
      unifiedDiff: [
        '--- /dev/null',
        '+++ b/server/src/payment.ts',
        '@@ -0,0 +1,28 @@',
        '+import { query } from \'./db/query.js\'',
        '+',
        '+export interface Payment {',
        '+  id: string',
        '+  orderId: string',
        '+  amount: number',
        '+  currency: string',
        '+  status: \'pending\' | \'completed\' | \'failed\'',
        '+  createdAt: string',
        '+}',
        '+',
        '+export async function createPayment(',
        '+  input: { orderId: string; amount: number; currency: string }',
        '+): Promise<Payment> {',
        '+  const rows = await query<Payment>(',
        '+    `insert into payments (order_id, amount, currency, status)',
        '+     values ($1, $2, $3, \'pending\')',
        '+     returning *`,',
        '+    [input.orderId, input.amount, input.currency]',
        '+  )',
        '+  const row = rows[0]',
        '+  if (!row) throw new Error(\'Failed to create payment\')',
        '+  return row',
        '+}',
        '+',
        '+export async function getPayment(id: string): Promise<Payment | null> {',
        '+  const rows = await query<Payment>(`select * from payments where id = $1`, [id])',
        '+  return rows[0] ?? null',
        '+'
      ].join('\n'),
      additions: 28,
      deletions: 0,
      summary: 'PaymentService 초기 구현 — createPayment + getPayment',
      demo: true
    },

    // ── Step 4 ── tester runs tests (first run fails) ─────────────────────────
    {
      kind: 'pipeline_stage',
      timestamp: ts(base, 120_000),
      stage: 'testing',
      status: 'active',
      startedAt: ts(base, 120_000),
      demo: true
    },
    {
      kind: 'agent_status',
      timestamp: ts(base, 121_000),
      agentId: 'tester',
      role: 'tester',
      status: 'working',
      currentAction: '테스트 실행 중',
      demo: true
    },
    {
      kind: 'command_run',
      timestamp: ts(base, 150_000),
      agentId: 'tester',
      command: 'pnpm --filter server test',
      cwd: '/workspace',
      status: 'failed',
      exitCode: 1,
      stdoutTail: [
        ' FAIL  server/test/payment.test.ts',
        '  ● createPayment › amount이 0일 때 에러를 던진다',
        '',
        'Test Suites: 1 failed, 4 passed, 5 total',
        'Tests:       1 failed, 12 passed, 13 total'
      ].join('\n'),
      stderrTail: 'Error: expected amount > 0 but received 0',
      startedAt: ts(base, 121_000),
      endedAt: ts(base, 150_000),
      demo: true
    },

    // ── Step 5 ── test_result (failed) ────────────────────────────────────────
    {
      kind: 'test_result',
      timestamp: ts(base, 151_000),
      agentId: 'tester',
      suite: 'server/test/payment.test.ts',
      status: 'failed',
      passed: 12,
      failed: 1,
      durationMs: 2340,
      failures: [
        {
          name: 'createPayment › amount이 0일 때 에러를 던진다',
          message: 'Expected function to throw an error with message matching /amount must be positive/ but it did not throw'
        }
      ],
      demo: true
    },

    // ── Step 6 ── builder reads failure ───────────────────────────────────────
    {
      kind: 'agent_status',
      timestamp: ts(base, 180_000),
      agentId: 'builder',
      role: 'builder',
      status: 'working',
      currentAction: '테스트 실패 원인 분석 중',
      path: 'server/src/payment.ts',
      demo: true
    },

    // ── Step 7 ── builder patches the fix ─────────────────────────────────────
    {
      kind: 'file_edit',
      timestamp: ts(base, 210_000),
      agentId: 'builder',
      path: 'server/src/payment.ts',
      unifiedDiff: [
        '--- a/server/src/payment.ts',
        '+++ b/server/src/payment.ts',
        '@@ -13,6 +13,9 @@ export async function createPayment(',
        ' ): Promise<Payment> {',
        '+  if (input.amount <= 0) {',
        '+    throw new Error(\'amount must be positive\')',
        '+  }',
        '   const rows = await query<Payment>('
      ].join('\n'),
      additions: 3,
      deletions: 0,
      summary: 'amount > 0 유효성 검사 추가',
      demo: true
    },

    // ── Step 8 ── review stage opens; reviewer leaves a warning comment ───────
    {
      kind: 'pipeline_stage',
      timestamp: ts(base, 239_000),
      stage: 'review',
      status: 'active',
      startedAt: ts(base, 239_000),
      demo: true
    },
    {
      kind: 'review_comment',
      timestamp: ts(base, 240_000),
      agentId: 'reviewer',
      reviewerId: 'reviewer',
      path: 'server/src/payment.ts',
      lineStart: 18,
      lineEnd: 22,
      severity: 'warn',
      comment: '널 체크 누락: rows[0]가 undefined일 때 createPayment가 빈 에러를 던집니다. 명시적 메시지로 교체하세요.',
      demo: true
    },

    // ── Step 9 ── builder addresses the review comment ────────────────────────
    {
      kind: 'file_edit',
      timestamp: ts(base, 270_000),
      agentId: 'builder',
      path: 'server/src/payment.ts',
      unifiedDiff: [
        '--- a/server/src/payment.ts',
        '+++ b/server/src/payment.ts',
        '@@ -21,7 +21,7 @@ export async function createPayment(',
        '   )',
        '-  const row = rows[0]',
        '-  if (!row) throw new Error(\'Failed to create payment\')',
        '+  const row = rows[0]',
        '+  if (!row) throw new Error(\'createPayment: DB가 행을 반환하지 않았습니다\')',
        '   return row'
      ].join('\n'),
      additions: 2,
      deletions: 2,
      summary: '명시적 오류 메시지로 null 가드 개선',
      demo: true
    },
    {
      kind: 'agent_status',
      timestamp: ts(base, 271_000),
      agentId: 'builder',
      role: 'builder',
      status: 'working',
      currentAction: '리뷰 코멘트 반영 완료',
      path: 'server/src/payment.ts',
      demo: true
    },
    {
      kind: 'pipeline_stage',
      timestamp: ts(base, 272_000),
      stage: 'implementation',
      status: 'done',
      endedAt: ts(base, 272_000),
      summary: '리뷰 반영 포함 구현 완료',
      demo: true
    },

    // ── Step 10 ── all tests pass ─────────────────────────────────────────────
    {
      kind: 'command_run',
      timestamp: ts(base, 300_000),
      agentId: 'tester',
      command: 'pnpm --filter server test',
      cwd: '/workspace',
      status: 'success',
      exitCode: 0,
      stdoutTail: [
        ' PASS  server/test/payment.test.ts',
        '',
        'Test Suites: 5 passed, 5 total',
        'Tests:       13 passed, 13 total',
        'Time:        2.1 s'
      ].join('\n'),
      startedAt: ts(base, 272_000),
      endedAt: ts(base, 300_000),
      demo: true
    },
    {
      kind: 'test_result',
      timestamp: ts(base, 301_000),
      agentId: 'tester',
      suite: 'server/test/payment.test.ts',
      status: 'passed',
      passed: 13,
      failed: 0,
      durationMs: 2100,
      demo: true
    },
    {
      kind: 'pipeline_stage',
      timestamp: ts(base, 302_000),
      stage: 'testing',
      status: 'done',
      endedAt: ts(base, 302_000),
      summary: '13개 테스트 모두 통과',
      demo: true
    },

    // ── Step 11 ── reviewer approves; review stage closes ─────────────────────
    {
      kind: 'review_comment',
      timestamp: ts(base, 330_000),
      agentId: 'reviewer',
      reviewerId: 'reviewer',
      path: 'server/src/payment.ts',
      lineStart: 1,
      severity: 'info',
      comment: 'LGTM — 유효성 검사 및 에러 메시지 모두 적절합니다. 머지 승인합니다.',
      verdict: 'approve',
      demo: true
    },
    {
      kind: 'pipeline_stage',
      timestamp: ts(base, 331_000),
      stage: 'review',
      status: 'done',
      endedAt: ts(base, 331_000),
      summary: 'LGTM — 머지 승인',
      demo: true
    },

    // ── Step 12 ── merge: PR opened + orchestrator wraps up (merge stays active:
    //               the story intentionally ends "PR 머지 대기 중") ─────────────
    {
      kind: 'pipeline_stage',
      timestamp: ts(base, 360_000),
      stage: 'merge',
      status: 'active',
      startedAt: ts(base, 360_000),
      demo: true
    },
    {
      kind: 'vcs_event',
      timestamp: ts(base, 361_000),
      agentId: 'orchestrator',
      action: 'pr_opened',
      branch: 'feature/payments',
      prUrl: 'https://github.com/example/syncspace/pull/42',
      summary: 'feat: 결제 모듈 추가 (PaymentService + 라우터 + 테스트 13개 통과)',
      demo: true
    },
    {
      kind: 'agent_status',
      timestamp: ts(base, 362_000),
      agentId: 'orchestrator',
      role: 'orchestrator',
      status: 'done',
      currentAction: 'PR #42 머지 대기 중 — ready for merge',
      demo: true
    }
  ]
}

/**
 * Create a seeded DEMO mission whose engineering events tell a coherent 12-step
 * payment-module feature story.  All events go through the real appendEvent path
 * so the existing Mission View renders them identically to live agent output.
 *
 * Pass `enqueue: false` so the worker never picks up this illustrative task.
 */
export async function seedDemoMission(input: SeedDemoMissionInput): Promise<SeedDemoMissionResult> {
  const { workspaceId, agentId, createdByParticipantId } = input

  // Create the demo task — enqueue:false so no worker picks it up.
  const { task } = await createTaskFromMessage({
    workspaceId,
    agentId,
    createdByParticipantId,
    title: 'DEMO · 결제 모듈 추가',
    message: {
      messageId: `demo-mission-init-${Date.now()}`,
      parts: [{ text: '결제 모듈을 서버에 추가하고 테스트를 통과시켜 주세요.' }],
      role: 'ROLE_USER'
    },
    enqueue: false
  })

  const taskId = task.id
  const contextId = task.contextId
  // Base time: 1 hour ago, events spaced ~30 s apart so they look natural.
  const base = Date.now() - 60 * 60 * 1000

  // Validate-then-persist; eventType derives from the PARSED kind, so the
  // stored enum value can never disagree with payload.kind.
  for (const [index, payload] of buildStory(base).entries()) {
    const parsed = validateEvent(payload, index + 1)
    await appendEvent({
      taskId,
      contextId,
      eventType: parsed.kind,
      payload: payload as Record<string, unknown>,
      visibleToUser: true
    })
  }

  return { taskId, contextId }
}
