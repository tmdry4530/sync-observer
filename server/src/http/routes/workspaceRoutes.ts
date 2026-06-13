import type { ServerConfig } from '../../config.js'
import type { Router } from '../router.js'
import { json } from '../response.js'
import { badRequest, notFound } from '../errors.js'
import { requireAgentActor, requireAuth, requireWorkspaceMember } from '../../auth/middleware.js'
import { ensureWorkspaceAgentPresence } from '../../auth/agentRegistration.js'
import { hashIp } from '../../utils/crypto.js'
import {
  addWorkspaceMember,
  deleteWorkspace,
  getWorkspaceByInviteCode,
  getWorkspaceById,
  listWorkspacesForParticipant,
  rotateInviteCode
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

  // Join an existing workspace by invite code under the CALLER's identity (reuses
  // its participant — no new credential), so one identity can belong to and
  // switch between many workspaces. Authenticated; a spectator may join too
  // (joining is an identity action, not workspace activity).
  router.post('/api/workspaces/join', async (ctx) => {
    const auth = await requireAuth(ctx, config)
    const body = await ctx.json<{ inviteCode?: string }>()
    const code = typeof body.inviteCode === 'string' ? body.inviteCode.trim() : ''
    if (!code) throw badRequest('missing_invite_code', '초대 코드가 필요합니다.')
    const workspace = await getWorkspaceByInviteCode(code)
    if (!workspace) throw badRequest('invalid_invite_code', '유효하지 않은 초대 코드입니다.')
    await addWorkspaceMember({ workspaceId: workspace.id, participantId: auth.participantId, role: 'member' })
    // Give the joining identity an actable presence agent in this workspace so it
    // can be @mentioned and run tasks here (not just read). Idempotent; awaited so
    // a failure surfaces as a 500 rather than a silent half-join.
    await ensureWorkspaceAgentPresence(auth.credentialParticipantId, workspace.id)
    await writeAuditLog({
      workspaceId: workspace.id,
      actorParticipantId: auth.participantId,
      action: 'workspace.join',
      resourceType: 'workspace',
      resourceId: workspace.id,
      ipHash: hashIp(ctx.ip, config.authSecret),
      userAgent: ctx.header('user-agent')
    }).catch(() => undefined)
    return json({ workspace })
  })

  // Regenerate the invite code. A member may rotate it (workspace management is
  // acceptable in the observe-only model); the old code stops resolving at once.
  router.post('/api/workspaces/:workspaceId/invite-code/rotate', async (ctx) => {
    const workspaceId = ctx.params.workspaceId ?? ''
    const { auth } = await requireWorkspaceMember(ctx, config, workspaceId)
    const inviteCode = await rotateInviteCode(workspaceId)
    await writeAuditLog({
      workspaceId,
      actorParticipantId: auth.participantId,
      action: 'workspace.invite_code_rotate',
      resourceType: 'workspace',
      resourceId: workspaceId,
      ipHash: hashIp(ctx.ip, config.authSecret),
      userAgent: ctx.header('user-agent')
    }).catch(() => undefined)
    return json({ inviteCode })
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
