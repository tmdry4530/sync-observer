import { createHash } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { ServerConfig } from '../config.js'
import type { Logger } from '../utils/logger.js'
import type { RawHttpHandler } from '../http/app.js'
import type { RequestContext } from '../http/context.js'
import { badRequest, conflict, HttpError, isHttpError, notFound, tooManyRequests } from '../http/errors.js'
import { json, problem, type HttpResponse } from '../http/response.js'
import { ConcurrencyLimiter, RateLimiter } from '../http/rateLimit.js'
import { buildExtendedAgentCard, buildPublicAgentCard } from './agentCard.js'
import { validateA2aVersion } from './version.js'
import { validateA2aContentType } from './contentType.js'
import { MessageSendSchema, parseOrThrow, PushConfigSchema } from './schemas.js'
import { assertWorkspaceAccess, requirePrincipal, requireScope, type A2aPrincipal } from './a2aAuth.js'
import {
  assembleTask,
  cancelTask,
  createTaskFromMessage,
  sendMessageToExistingTask
} from './taskService.js'
import { getTask, listTasks, type A2aTaskRow } from '../db/repositories/a2aRepository.js'
import { listEvents } from '../db/repositories/a2aRepository.js'
import { getAgentBySlug, ensureDefaultAgents, getAgentByCredentialIdentity, type AgentWithParticipant } from '../db/repositories/agentRepository.js'
import { ensureWorkspaceAgentPresence } from '../auth/agentRegistration.js'
import { getRemoteAgentById } from '../db/repositories/remoteAgentRepository.js'
import { remoteGetTask } from './client.js'
import { bridgeRemoteTaskIntoLocal, buildRemoteTarget } from './remoteBridge.js'
import { verifyRemoteCallbackToken } from './remoteCallback.js'
import { createPushConfig, deletePushConfig, getPushConfig, listPushConfigs } from '../db/repositories/a2aPushRepository.js'
import { writeAuditLog } from '../db/repositories/auditRepository.js'
import { assertSafeWebhookUrl } from './push.js'
import { hashIp, hashToken } from '../utils/crypto.js'
import { mapTaskRowToA2aTask, mapEventRowToStreamResponse } from './mapper.js'
import { isTerminalState, type Part, type StreamResponse, type Task } from './types.js'
import {
  A2aStreamingHub,
  startSse,
  streamResponseEventName,
  writeSseEvent
} from './streaming.js'

export interface A2aHandlerDeps {
  config: ServerConfig
  logger: Logger
  streamingHub: A2aStreamingHub
}

const AGENT_CARD_PATH = '/.well-known/agent-card.json'

// 60 task-creating calls/min per IP; max 5 concurrent SSE streams per IP.
const sendLimiter = new RateLimiter(60_000, 60)
const streamLimiter = new ConcurrencyLimiter(5)
// Inbound remote-agent push callbacks: per-task token-authenticated, generous cap.
const callbackLimiter = new RateLimiter(60_000, 240)

export function isA2aPath(pathname: string): boolean {
  return pathname === AGENT_CARD_PATH || pathname === '/a2a' || pathname.startsWith('/a2a/')
}

export function createA2aHandler(deps: A2aHandlerDeps): RawHttpHandler {
  return async (ctx) => {
    if (!isA2aPath(ctx.pathname)) return null
    try {
      return await dispatch(ctx, deps)
    } catch (error) {
      if (ctx.res.headersSent) return null
      if (isHttpError(error)) return problem(error.toProblem())
      deps.logger.error('A2A handler error', { error: error instanceof Error ? error.message : String(error) })
      return problem({ type: 'about:blank', title: 'internal_error', status: 500, code: 'internal_error', detail: 'Internal server error.' })
    }
  }
}

async function dispatch(ctx: RequestContext, deps: A2aHandlerDeps): Promise<HttpResponse | null> {
  const { pathname, method } = ctx

  if (pathname === AGENT_CARD_PATH) {
    if (method !== 'GET') throw methodNotAllowed()
    return handleAgentCard(ctx, deps.config)
  }

  const segments = pathname.split('/').filter(Boolean) // ['a2a', ...]
  const rest = segments.slice(1)

  if (rest[0] === 'extendedAgentCard') {
    if (method !== 'GET') throw methodNotAllowed()
    await requirePrincipal(ctx, deps.config)
    return json(buildExtendedAgentCard(deps.config))
  }

  if (rest[0] === 'remote-callback') {
    if (method !== 'POST') throw methodNotAllowed()
    return handleRemoteCallback(ctx, deps, decodeURIComponent(rest[1] ?? ''))
  }

  if (rest[0] === 'message:send') {
    if (method !== 'POST') throw methodNotAllowed()
    return handleMessageSend(ctx, deps)
  }

  if (rest[0] === 'message:stream') {
    if (method !== 'POST') throw methodNotAllowed()
    return handleMessageStream(ctx, deps)
  }

  if (rest[0] === 'tasks') {
    return handleTasks(ctx, deps, rest)
  }

  throw notFound('A2A route not found.')
}

// ---------- Agent Card ----------

function handleAgentCard(ctx: RequestContext, config: ServerConfig): HttpResponse {
  const card = buildPublicAgentCard(config)
  const body = JSON.stringify(card)
  const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`
  if (ctx.header('if-none-match') === etag) {
    return { kind: 'empty', status: 304, headers: { etag, 'cache-control': 'public, max-age=300' } }
  }
  return json(card, 200, { 'cache-control': 'public, max-age=300', etag })
}

// ---------- message:send ----------

function readMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function resolveWorkspaceForSend(principal: A2aPrincipal, metadata: Record<string, unknown>): string {
  const requested = typeof metadata.workspaceId === 'string' ? metadata.workspaceId : null
  if (principal.kind === 'agent') {
    // An agent may target a JOINED workspace via metadata.workspaceId; absent
    // that it acts in its home workspace. Either way the caller gates the result
    // through assertWorkspaceAccess before acting.
    const workspaceId = requested ?? principal.workspaceId
    if (!workspaceId) throw notFound()
    return workspaceId
  }
  if (!requested) throw badRequest('missing_workspace', 'metadata.workspaceId is required for session-authenticated calls.')
  return requested
}

/**
 * The agent the principal ACTS THROUGH in `workspaceId`: its presence agent for
 * that workspace (home agent in the home workspace, presence agent in a joined
 * one). Callers MUST have gated `workspaceId` through assertWorkspaceAccess
 * first; a member without a presence yet gets one minted here. Remote principals
 * have no internal presence — returns null.
 */
async function resolveActingAgent(
  workspaceId: string,
  principal: A2aPrincipal
): Promise<AgentWithParticipant | null> {
  if (principal.kind !== 'agent') return null
  const existing = await getAgentByCredentialIdentity(principal.credentialParticipantId, workspaceId)
  if (existing) return existing
  return ensureWorkspaceAgentPresence(principal.credentialParticipantId, workspaceId)
}

async function resolveTargetAgentId(
  workspaceId: string,
  actingAgent: AgentWithParticipant | null,
  metadata: Record<string, unknown>
): Promise<string> {
  const slug = typeof metadata.agentSlug === 'string' ? metadata.agentSlug : null
  if (slug) {
    const agent = await getAgentBySlug(workspaceId, slug)
    if (!agent) throw badRequest('unknown_agent', `No agent with slug '${slug}' in this workspace.`)
    return agent.id
  }
  // No explicit target: the acting agent's own presence in this workspace.
  if (actingAgent) return actingAgent.id

  let planner = await getAgentBySlug(workspaceId, 'planner')
  if (!planner) {
    await ensureDefaultAgents(workspaceId)
    planner = await getAgentBySlug(workspaceId, 'planner')
  }
  if (!planner) throw badRequest('no_agent', 'No target agent available in this workspace.')
  return planner.id
}

interface PreparedSend {
  task: Task
  created: boolean
}

async function prepareSend(ctx: RequestContext, deps: A2aHandlerDeps): Promise<PreparedSend> {
  validateA2aVersion(ctx, deps.config)
  validateA2aContentType(ctx)
  if (!sendLimiter.check(ctx.ip ?? 'unknown')) throw tooManyRequests('요청이 너무 많습니다. 잠시 후 다시 시도해주세요.')
  const principal = await requirePrincipal(ctx, deps.config)
  requireScope(principal, 'task:write')

  const body = parseOrThrow(MessageSendSchema, await ctx.json())
  const message = body.message
  const metadata = readMetadata(message.metadata)

  // Continue an existing task.
  if (message.taskId) {
    const taskRow = await getTask(message.taskId)
    if (!taskRow) throw notFound('Task not found.')
    await assertWorkspaceAccess(principal, taskRow.workspace_id)
    if (isTerminalState(taskRow.status_state)) throw conflict('Task is in a terminal state.', 'task_terminal')
    // Author the continuation as the principal's presence in the task's workspace
    // so authorship stays scoped to that (possibly joined) workspace.
    const actingAgent = await resolveActingAgent(taskRow.workspace_id, principal)
    const task = await sendMessageToExistingTask(taskRow, {
      messageId: message.messageId,
      parts: message.parts as Part[],
      participantId: actingAgent?.participant_id ?? principal.participantId,
      metadata
    })
    if (!task) throw notFound('Task not found.')
    return { task, created: false }
  }

  const workspaceId = resolveWorkspaceForSend(principal, metadata)
  await assertWorkspaceAccess(principal, workspaceId)
  // The agent acts THROUGH its presence in this (possibly joined) workspace; that
  // presence's participant authors the task, so authorship/ownership stay scoped
  // to the workspace instead of the credential's home agent.
  const actingAgent = await resolveActingAgent(workspaceId, principal)
  const agentId = await resolveTargetAgentId(workspaceId, actingAgent, metadata)
  const createdByParticipantId = actingAgent?.participant_id ?? principal.participantId

  const result = await createTaskFromMessage({
    workspaceId,
    agentId,
    createdByParticipantId,
    ...(message.contextId ? { contextId: message.contextId } : {}),
    ...(typeof metadata.channelId === 'string' ? { channelId: metadata.channelId } : {}),
    ...(typeof metadata.documentId === 'string' ? { documentId: metadata.documentId } : {}),
    ...(body.configuration?.acceptedOutputModes ? { acceptedOutputModes: body.configuration.acceptedOutputModes } : {}),
    message: { messageId: message.messageId, parts: message.parts as Part[], role: 'ROLE_USER', metadata }
  })
  return result
}

async function handleMessageSend(ctx: RequestContext, deps: A2aHandlerDeps): Promise<HttpResponse> {
  const { task } = await prepareSend(ctx, deps)
  return json({ task })
}

// ---------- remote-agent push callback (inbound) ----------

/**
 * Inbound notification from a remote agent that one of our proxy tasks changed.
 * Authenticated by the per-task callback token (HMAC of the task id). The body is
 * NOT trusted for state — we re-fetch the authoritative task from the remote and
 * bridge it (idempotent), so a forged/replayed callback can at worst trigger a
 * harmless reconcile of the task it is scoped to. Always 200s to keep the remote's
 * delivery loop simple; the poll fallback covers any missed callback.
 */
async function handleRemoteCallback(ctx: RequestContext, deps: A2aHandlerDeps, taskId: string): Promise<HttpResponse> {
  if (!taskId) throw notFound('A2A route not found.')
  if (!callbackLimiter.check(ctx.ip ?? 'unknown')) throw tooManyRequests('콜백 요청이 너무 많습니다.')

  const raw = await ctx.json().catch(() => null)
  const body = (raw && typeof raw === 'object' ? raw : {}) as { token?: unknown }
  const presented = typeof body.token === 'string' ? body.token : ctx.header('x-a2a-callback-token')
  if (!verifyRemoteCallbackToken(taskId, presented, deps.config)) {
    throw new HttpError(401, 'invalid_callback_token', 'Invalid or missing callback token.')
  }

  const task = await getTask(taskId)
  // Ack unknown/non-remote/terminal tasks without disclosing which case it was.
  if (!task || !task.remote_agent_id || isTerminalState(task.status_state) || !task.external_task_id) {
    return json({ ok: true })
  }
  const remote = await getRemoteAgentById(task.remote_agent_id)
  if (!remote) return json({ ok: true })

  try {
    const remoteTask = await remoteGetTask(buildRemoteTarget(remote), task.external_task_id)
    await bridgeRemoteTaskIntoLocal(task, remote.id, remoteTask, { logger: deps.logger })
  } catch (error) {
    deps.logger.warn('Remote callback reconcile failed', {
      taskId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
  return json({ ok: true })
}

// ---------- message:stream ----------

async function handleMessageStream(ctx: RequestContext, deps: A2aHandlerDeps): Promise<HttpResponse | null> {
  const { task } = await prepareSend(ctx, deps)
  await streamTaskEvents(ctx, deps, task.id, { initialTask: task })
  return null
}

// ---------- tasks/* ----------

async function handleTasks(ctx: RequestContext, deps: A2aHandlerDeps, rest: string[]): Promise<HttpResponse | null> {
  // rest = ['tasks', ...]
  if (rest.length === 1) {
    if (ctx.method !== 'GET') throw methodNotAllowed()
    return handleListTasks(ctx, deps)
  }

  const second = rest[1] ?? ''
  // tasks/{id}:cancel | tasks/{id}:subscribe | tasks/{id}
  if (rest.length === 2) {
    if (second.endsWith(':cancel')) {
      if (ctx.method !== 'POST') throw methodNotAllowed()
      return handleCancelTask(ctx, deps, second.slice(0, -':cancel'.length))
    }
    if (second.endsWith(':subscribe')) {
      if (ctx.method !== 'POST') throw methodNotAllowed()
      return handleSubscribe(ctx, deps, second.slice(0, -':subscribe'.length))
    }
    if (ctx.method !== 'GET') throw methodNotAllowed()
    return handleGetTask(ctx, deps, decodeURIComponent(second))
  }

  // tasks/{id}/pushNotificationConfigs[/{configId}]
  const taskId = decodeURIComponent(second)
  if (rest[2] === 'pushNotificationConfigs') {
    if (rest.length === 3) {
      if (ctx.method === 'POST') return handleCreatePushConfig(ctx, deps, taskId)
      if (ctx.method === 'GET') return handleListPushConfigs(ctx, deps, taskId)
      throw methodNotAllowed()
    }
    if (rest.length === 4) {
      const configId = decodeURIComponent(rest[3] ?? '')
      if (ctx.method === 'GET') return handleGetPushConfig(ctx, deps, taskId, configId)
      if (ctx.method === 'DELETE') return handleDeletePushConfig(ctx, deps, taskId, configId)
      throw methodNotAllowed()
    }
  }
  throw notFound('A2A route not found.')
}

async function loadAuthorizedTask(ctx: RequestContext, deps: A2aHandlerDeps, taskId: string): Promise<A2aTaskRow> {
  const principal = await requirePrincipal(ctx, deps.config)
  requireScope(principal, 'task:read')
  const taskRow = await getTask(taskId)
  if (!taskRow) throw notFound('Task not found.')
  await assertWorkspaceAccess(principal, taskRow.workspace_id)
  return taskRow
}

async function handleListTasks(ctx: RequestContext, deps: A2aHandlerDeps): Promise<HttpResponse> {
  const principal = await requirePrincipal(ctx, deps.config)
  requireScope(principal, 'task:read')

  let workspaceId: string
  if (principal.kind === 'agent') {
    if (!principal.workspaceId) throw notFound()
    workspaceId = principal.workspaceId
  } else {
    const requested = ctx.query.get('workspaceId')
    if (!requested) throw badRequest('missing_workspace', 'workspaceId query parameter is required.')
    await assertWorkspaceAccess(principal, requested)
    workspaceId = requested
  }

  const pageSize = Number.parseInt(ctx.query.get('pageSize') ?? '50', 10)
  const result = await listTasks({
    workspaceId,
    contextId: ctx.query.get('contextId'),
    status: (ctx.query.get('status') as A2aTaskRow['status_state'] | null) ?? null,
    limit: Number.isInteger(pageSize) ? pageSize : 50,
    cursor: ctx.query.get('pageToken')
  })

  return json({
    tasks: result.rows.map((row) => mapTaskRowToA2aTask(row)),
    ...(result.nextCursor ? { nextPageToken: result.nextCursor } : {})
  })
}

async function handleGetTask(ctx: RequestContext, deps: A2aHandlerDeps, taskId: string): Promise<HttpResponse> {
  await loadAuthorizedTask(ctx, deps, taskId)
  const task = await assembleTask(taskId)
  if (!task) throw notFound('Task not found.')
  return json({ task })
}

async function handleCancelTask(ctx: RequestContext, deps: A2aHandlerDeps, taskId: string): Promise<HttpResponse> {
  const principal = await requirePrincipal(ctx, deps.config)
  requireScope(principal, 'task:cancel')
  const taskRow = await getTask(taskId)
  if (!taskRow) throw notFound('Task not found.')
  await assertWorkspaceAccess(principal, taskRow.workspace_id)
  const task = await cancelTask(taskId)
  if (!task) throw notFound('Task not found.')
  return json({ task })
}

async function handleSubscribe(ctx: RequestContext, deps: A2aHandlerDeps, taskId: string): Promise<HttpResponse | null> {
  const taskRow = await loadAuthorizedTask(ctx, deps, taskId)
  if (isTerminalState(taskRow.status_state)) {
    throw conflict('Cannot subscribe to a task in a terminal state.', 'task_terminal')
  }
  await streamTaskEvents(ctx, deps, taskId, {})
  return null
}

// ---------- push notification configs ----------

async function authorizeTaskForPush(
  ctx: RequestContext,
  deps: A2aHandlerDeps,
  taskId: string
): Promise<{ taskRow: A2aTaskRow; principal: A2aPrincipal }> {
  const principal = await requirePrincipal(ctx, deps.config)
  requireScope(principal, 'push:write')
  const taskRow = await getTask(taskId)
  if (!taskRow) throw notFound('Task not found.')
  await assertWorkspaceAccess(principal, taskRow.workspace_id)
  return { taskRow, principal }
}

async function handleCreatePushConfig(ctx: RequestContext, deps: A2aHandlerDeps, taskId: string): Promise<HttpResponse> {
  validateA2aContentType(ctx)
  const { taskRow, principal } = await authorizeTaskForPush(ctx, deps, taskId)
  const body = parseOrThrow(PushConfigSchema, await ctx.json())
  const cfg = body.pushNotificationConfig

  await assertSafeWebhookUrl(cfg.url)
  const configId = cfg.id ?? createHash('sha256').update(`${taskId}:${cfg.url}`).digest('hex').slice(0, 16)
  const credentials = cfg.token ?? cfg.authentication?.credentials ?? null

  const row = await createPushConfig({
    taskId,
    configId,
    url: cfg.url,
    authScheme: 'Bearer',
    authCredentialsHash: credentials ? hashToken(credentials, deps.config.agentTokenPepper) : null,
    ...(cfg.authentication ? { authentication: cfg.authentication } : {})
  })
  await writeAuditLog({
    workspaceId: taskRow.workspace_id,
    actorParticipantId: principal.participantId,
    action: 'a2a.push_config.create',
    resourceType: 'a2a_push_config',
    resourceId: configId,
    metadata: { taskId, url: cfg.url },
    ipHash: hashIp(ctx.ip, deps.config.authSecret),
    userAgent: ctx.header('user-agent')
  })
  return json({ pushNotificationConfig: serializePushConfig(row, taskRow.id) })
}

async function handleListPushConfigs(ctx: RequestContext, deps: A2aHandlerDeps, taskId: string): Promise<HttpResponse> {
  const { taskRow } = await authorizeTaskForPush(ctx, deps, taskId)
  const rows = await listPushConfigs(taskId)
  return json({ pushNotificationConfigs: rows.map((row) => serializePushConfig(row, taskRow.id)) })
}

async function handleGetPushConfig(
  ctx: RequestContext,
  deps: A2aHandlerDeps,
  taskId: string,
  configId: string
): Promise<HttpResponse> {
  const { taskRow } = await authorizeTaskForPush(ctx, deps, taskId)
  const row = await getPushConfig(taskId, configId)
  if (!row) throw notFound('Push notification config not found.')
  return json({ pushNotificationConfig: serializePushConfig(row, taskRow.id) })
}

async function handleDeletePushConfig(
  ctx: RequestContext,
  deps: A2aHandlerDeps,
  taskId: string,
  configId: string
): Promise<HttpResponse> {
  const { taskRow, principal } = await authorizeTaskForPush(ctx, deps, taskId)
  const deleted = await deletePushConfig(taskId, configId)
  if (!deleted) throw notFound('Push notification config not found.')
  await writeAuditLog({
    workspaceId: taskRow.workspace_id,
    actorParticipantId: principal.participantId,
    action: 'a2a.push_config.delete',
    resourceType: 'a2a_push_config',
    resourceId: configId,
    metadata: { taskId },
    ipHash: hashIp(ctx.ip, deps.config.authSecret),
    userAgent: ctx.header('user-agent')
  })
  return { kind: 'empty', status: 204 }
}

function serializePushConfig(row: { config_id: string; url: string; auth_scheme: string }, taskId: string): Record<string, unknown> {
  return { id: row.config_id, taskId, url: row.url, authScheme: row.auth_scheme }
}

// ---------- shared SSE event streaming ----------

async function streamTaskEvents(
  ctx: RequestContext,
  deps: A2aHandlerDeps,
  taskId: string,
  options: { initialTask?: Task }
): Promise<void> {
  const res = ctx.res
  const acquired = streamLimiter.acquire(ctx.ip ?? 'unknown')
  if (!acquired) throw tooManyRequests('동시 스트림 제한을 초과했습니다.', 'too_many_streams')
  const releaseSlot: () => void = acquired
  startSse(res)

  let lastSeq = 0
  let closed = false

  const emit = (response: StreamResponse, seq: number): void => {
    if (closed || seq <= lastSeq) return
    lastSeq = seq
    writeSseEvent(res, streamResponseEventName(response), response)
    if ('statusUpdate' in response && response.statusUpdate.final) {
      finish()
    }
  }

  // Establish the LISTEN connection before catch-up so no event can slip between
  // the historical query and live delivery (the lastSeq guard dedups overlap).
  await deps.streamingHub.ensureListening()
  const unsubscribe = deps.streamingHub.subscribe(taskId, (response, seq) => emit(response, Number(seq)))
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n')
  }, 15_000)

  function finish(): void {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
    releaseSlot()
    res.end()
  }

  ctx.req.on('close', () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
    releaseSlot()
  })

  // For a subscribe (no initialTask) send the current snapshot first.
  if (!options.initialTask) {
    const snapshot = await assembleTask(taskId)
    if (snapshot) writeSseEvent(res, 'message', { task: snapshot })
  }

  // Catch up on events already persisted (covers the worker emitting before
  // the subscriber registered). The lastSeq guard dedups against live events.
  const existing = await listEvents(taskId)
  for (const row of existing) {
    const response = mapEventRowToStreamResponse(row)
    if (response) emit(response, Number(row.seq))
  }
}

function methodNotAllowed(): HttpError {
  return new HttpError(405, 'method_not_allowed', 'Method not allowed for this A2A route.')
}
