import type { ServerConfig } from '../../config.js'
import type { Router } from '../router.js'
import { json } from '../response.js'
import { badRequest, notFound } from '../errors.js'
import { requireAgentActor, requireAuth, requireWorkspaceMember } from '../../auth/middleware.js'
import { hashIp } from '../../utils/crypto.js'
import {
  deleteWorkspace,
  getWorkspaceById,
  listWorkspacesForParticipant
} from '../../db/repositories/workspaceRepository.js'
import { createChannel, listChannels } from '../../db/repositories/channelRepository.js'
import { createDocument, listDocuments } from '../../db/repositories/documentRepository.js'
import { getChannelWorkspaceId } from '../../db/repositories/channelRepository.js'
import { listMessages } from '../../db/repositories/messageRepository.js'
import { listWorkspaceParticipants } from '../../db/repositories/participantRepository.js'
import { writeAuditLog } from '../../db/repositories/auditRepository.js'

function requiredString(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw badRequest('missing_field', `${field} 값이 필요합니다.`)
  }
  return value.trim().slice(0, max)
}

export function registerWorkspaceRoutes(router: Router, config: ServerConfig): void {
  router.get('/api/workspaces', async (ctx) => {
    const auth = await requireAuth(ctx, config)
    return json({ workspaces: await listWorkspacesForParticipant(auth.participantId) })
  })

  router.delete('/api/workspaces/:workspaceId', async (ctx) => {
    const workspaceId = ctx.params.workspaceId ?? ''
    const { auth } = await requireWorkspaceMember(ctx, config, workspaceId)
    const workspace = await getWorkspaceById(workspaceId)
    if (!workspace) throw notFound('워크스페이스를 찾을 수 없습니다.')
    await deleteWorkspace(workspaceId)
    await writeAuditLog({
      workspaceId,
      actorParticipantId: auth.participantId,
      action: 'workspace.delete',
      resourceType: 'workspace',
      resourceId: workspaceId,
      ipHash: hashIp(ctx.ip, config.authSecret),
      userAgent: ctx.header('user-agent')
    })
    return json({ workspaceId })
  })

  router.get('/api/workspaces/:workspaceId/channels', async (ctx) => {
    const workspaceId = ctx.params.workspaceId ?? ''
    await requireWorkspaceMember(ctx, config, workspaceId)
    return json({ channels: await listChannels(workspaceId) })
  })

  router.post('/api/workspaces/:workspaceId/channels', async (ctx) => {
    const workspaceId = ctx.params.workspaceId ?? ''
    const { auth } = await requireAgentActor(ctx, config, workspaceId)
    const body = await ctx.json<{ name?: string }>()
    const name = requiredString(body.name, '채널 이름', 80)
    const channel = await createChannel({ workspaceId, name, createdBy: auth.participantId })
    await writeAuditLog({
      workspaceId,
      actorParticipantId: auth.participantId,
      action: 'channel.create',
      resourceType: 'channel',
      resourceId: channel.id,
      ipHash: hashIp(ctx.ip, config.authSecret),
      userAgent: ctx.header('user-agent')
    })
    return json({ channel })
  })

  router.get('/api/workspaces/:workspaceId/documents', async (ctx) => {
    const workspaceId = ctx.params.workspaceId ?? ''
    await requireWorkspaceMember(ctx, config, workspaceId)
    return json({ documents: await listDocuments(workspaceId) })
  })

  router.post('/api/workspaces/:workspaceId/documents', async (ctx) => {
    const workspaceId = ctx.params.workspaceId ?? ''
    const { auth } = await requireAgentActor(ctx, config, workspaceId)
    const body = await ctx.json<{ title?: string }>()
    const title = requiredString(body.title, '문서 제목', 160)
    const document = await createDocument({ workspaceId, title, createdBy: auth.participantId })
    await writeAuditLog({
      workspaceId,
      actorParticipantId: auth.participantId,
      action: 'document.create',
      resourceType: 'document',
      resourceId: document.id,
      ipHash: hashIp(ctx.ip, config.authSecret),
      userAgent: ctx.header('user-agent')
    })
    return json({ document })
  })

  router.get('/api/workspaces/:workspaceId/participants', async (ctx) => {
    const workspaceId = ctx.params.workspaceId ?? ''
    await requireWorkspaceMember(ctx, config, workspaceId)
    return json({ participants: await listWorkspaceParticipants(workspaceId) })
  })

  router.get('/api/channels/:channelId/messages', async (ctx) => {
    const channelId = ctx.params.channelId ?? ''
    const workspaceId = await getChannelWorkspaceId(channelId)
    if (!workspaceId) throw notFound('채널을 찾을 수 없습니다.')
    await requireWorkspaceMember(ctx, config, workspaceId)

    const limit = Number.parseInt(ctx.query.get('limit') ?? '30', 10)
    const cursor = ctx.query.get('cursor')
    const page = await listMessages({ channelId, cursor, limit: Number.isInteger(limit) ? limit : 30 })
    return json(page)
  })
}
