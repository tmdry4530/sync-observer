import type { ServerConfig } from '../../config.js'
import type { Router } from '../router.js'
import { json } from '../response.js'
import { badRequest, notFound } from '../errors.js'
import { newUuid } from '../../utils/crypto.js'
import { requireAgentActor, requireWorkspaceMember } from '../../auth/middleware.js'
import {
  ensureDefaultAgents,
  getAgentByCredentialIdentity,
  getAgentById,
  listAgents,
  toAgentProfile
} from '../../db/repositories/agentRepository.js'
import { getTask, listEvents, listTasks } from '../../db/repositories/a2aRepository.js'
import { resolveAgentByMention } from '../../agents/resolver.js'
import { mapTaskRowToA2aTask, mapEventRowToStreamResponse } from '../../a2a/mapper.js'
import { assembleTask, cancelTask, createTaskFromMessage } from '../../a2a/taskService.js'

export function registerAgentRoutes(router: Router, config: ServerConfig): void {
  // List agents for a workspace (seeding the default roster on first access).
  router.get('/api/workspaces/:workspaceId/agents', async (ctx) => {
    const workspaceId = ctx.params.workspaceId ?? ''
    await requireWorkspaceMember(ctx, config, workspaceId)
    await ensureDefaultAgents(workspaceId)
    const agents = await listAgents(workspaceId)
    return json({ agents: agents.map(toAgentProfile) })
  })

  // List A2A tasks for a workspace (AgentRail / task list).
  router.get('/api/workspaces/:workspaceId/tasks', async (ctx) => {
    const workspaceId = ctx.params.workspaceId ?? ''
    await requireWorkspaceMember(ctx, config, workspaceId)
    const pageSize = Number.parseInt(ctx.query.get('pageSize') ?? '50', 10)
    const result = await listTasks({
      workspaceId,
      status: null,
      limit: Number.isInteger(pageSize) ? pageSize : 50,
      cursor: ctx.query.get('pageToken')
    })
    return json({
      tasks: result.rows.map((row) => mapTaskRowToA2aTask(row)),
      ...(result.nextCursor ? { nextPageToken: result.nextCursor } : {})
    })
  })

  // Invoke an agent (the mention -> task flow). The session user is the author.
  router.post('/api/agents/:agentId/invoke', async (ctx) => {
    const agentId = ctx.params.agentId ?? ''
    const agent = await getAgentById(agentId)
    if (!agent) throw notFound('에이전트를 찾을 수 없습니다.')
    const { auth } = await requireAgentActor(ctx, config, agent.workspace_id)

    const body = await ctx.json<{ content?: string; channelId?: string; documentId?: string; contextId?: string }>()
    const content = typeof body.content === 'string' ? body.content.trim() : ''
    if (!content) throw badRequest('missing_content', '요청 내용이 필요합니다.')

    // Author as the caller's presence in this (possibly joined) workspace.
    const acting = await getAgentByCredentialIdentity(auth.credentialParticipantId, agent.workspace_id)
    const result = await createTaskFromMessage({
      workspaceId: agent.workspace_id,
      agentId: agent.id,
      createdByParticipantId: acting?.participant_id ?? auth.participantId,
      ...(body.channelId ? { channelId: body.channelId } : {}),
      ...(body.documentId ? { documentId: body.documentId } : {}),
      ...(body.contextId ? { contextId: body.contextId } : {}),
      message: { messageId: newUuid(), parts: [{ text: content }], role: 'ROLE_USER' }
    })
    return json({ task: result.task })
  })

  // Unified @mention invoke: server resolves slug → internal (wins) or remote agent,
  // enforces remote gating (verified + healthy), and routes to the right task pipeline.
  router.post('/api/workspaces/:workspaceId/invoke', async (ctx) => {
    const workspaceId = ctx.params.workspaceId ?? ''
    const { auth } = await requireAgentActor(ctx, config, workspaceId)
    const body = await ctx.json<{ slug?: string; content?: string; channelId?: string; documentId?: string }>()
    const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : ''
    const content = typeof body.content === 'string' ? body.content.trim() : ''
    if (!slug) throw badRequest('missing_slug', '에이전트 슬러그가 필요합니다.')
    if (!content) throw badRequest('missing_content', '요청 내용이 필요합니다.')

    const resolved = await resolveAgentByMention(workspaceId, slug)
    if (!resolved) throw notFound('해당 슬러그의 에이전트를 찾을 수 없습니다.')
    if (resolved.kind === 'remote') {
      if (resolved.agent.verification_status !== 'verified') throw badRequest('not_verified', '검증되지 않은 원격 에이전트는 호출할 수 없습니다.')
      if (resolved.agent.health_status === 'unhealthy') throw badRequest('unhealthy', '비정상 상태의 원격 에이전트는 호출할 수 없습니다.')
    }

    const message = { messageId: newUuid(), parts: [{ text: content }], role: 'ROLE_USER' as const }
    // Author as the caller's presence in this (possibly joined) workspace.
    const acting = await getAgentByCredentialIdentity(auth.credentialParticipantId, workspaceId)
    const common = {
      workspaceId,
      createdByParticipantId: acting?.participant_id ?? auth.participantId,
      ...(body.channelId ? { channelId: body.channelId } : {}),
      ...(body.documentId ? { documentId: body.documentId } : {}),
      message
    }
    const result =
      resolved.kind === 'internal'
        ? await createTaskFromMessage({ ...common, agentId: resolved.agent.id })
        : await createTaskFromMessage({ ...common, remoteAgentId: resolved.agent.id })
    return json({ task: result.task, kind: resolved.kind })
  })

  // Task detail: status + artifacts + history + visible event timeline.
  router.get('/api/tasks/:taskId', async (ctx) => {
    const taskId = ctx.params.taskId ?? ''
    const taskRow = await getTask(taskId)
    if (!taskRow) throw notFound('태스크를 찾을 수 없습니다.')
    await requireWorkspaceMember(ctx, config, taskRow.workspace_id)

    const task = await assembleTask(taskId)
    const events = await listEvents(taskId)
    return json({
      task,
      events: events
        .filter((event) => event.visible_to_user)
        .map((event) => ({ seq: event.seq, type: event.event_type, createdAt: event.created_at, payload: mapEventRowToStreamResponse(event) }))
    })
  })

  // Cancel a task from the UI.
  router.post('/api/tasks/:taskId/cancel', async (ctx) => {
    const taskId = ctx.params.taskId ?? ''
    const taskRow = await getTask(taskId)
    if (!taskRow) throw notFound('태스크를 찾을 수 없습니다.')
    await requireAgentActor(ctx, config, taskRow.workspace_id)
    const task = await cancelTask(taskId)
    return json({ task })
  })
}
