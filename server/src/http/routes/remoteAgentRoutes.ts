import type { ServerConfig } from '../../config.js'
import type { Router } from '../router.js'
import type { RequestContext } from '../context.js'
import { json } from '../response.js'
import { badRequest, forbidden, notFound, tooManyRequests, HttpError } from '../errors.js'
import { RateLimiter } from '../rateLimit.js'
import { assertAgentActor, requireAuth } from '../../auth/middleware.js'
import { slugify } from '../../auth/agentRegistration.js'
import { generateToken, hashToken, hashIp, newUuid } from '../../utils/crypto.js'
import { assertSafeWebhookUrl } from '../../a2a/push.js'
import { fetchAgentCard, fetchWellKnownVerification, RemoteFetchError } from '../../a2a/agentCardFetcher.js'
import {
  createRemoteAgent,
  deleteRemoteAgent,
  getRemoteAgentById,
  getRemoteAgentBySlug,
  listRemoteAgents,
  setHealthStatus,
  setVerificationStatus,
  toRemoteAgentProfile,
  type RemoteAgentRow
} from '../../db/repositories/remoteAgentRepository.js'
import { createTaskFromMessage } from '../../a2a/taskService.js'
import { writeAuditLog } from '../../db/repositories/auditRepository.js'

const registerLimiter = new RateLimiter(60_000, 5)
const verifyLimiter = new RateLimiter(60_000, 10)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function mapFetchError(error: unknown): never {
  if (error instanceof RemoteFetchError) throw badRequest(error.code, error.message)
  if (error instanceof HttpError) throw error
  throw badRequest('remote_fetch_failed', error instanceof Error ? error.message : String(error))
}

async function uniqueSlug(workspaceId: string, base: string): Promise<string> {
  const root = slugify(base)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`
    const existing = await getRemoteAgentBySlug(workspaceId, candidate)
    if (!existing) return candidate
  }
  return `${root}-${newUuid().slice(0, 6)}`
}

function parseVerifyToken(text: string): string | null {
  const match = text.match(/syncspace-verify=([A-Za-z0-9_-]+)/)
  return match?.[1] ?? null
}

/** Load a remote agent and assert it belongs to the caller's workspace (404 otherwise). */
async function loadOwnedRemoteAgent(
  ctx: RequestContext,
  config: ServerConfig,
  id: string,
  requireOwner: boolean
): Promise<{ remote: RemoteAgentRow; participantId: string; workspaceId: string }> {
  const auth = await requireAuth(ctx, config)
  const remote = await getRemoteAgentById(id)
  if (!remote || remote.workspace_id !== auth.workspaceId) throw notFound('원격 에이전트를 찾을 수 없습니다.')
  if (requireOwner && remote.owner_participant_id !== auth.participantId) {
    throw forbidden('이 원격 에이전트를 관리할 권한이 없습니다.')
  }
  return { remote, participantId: auth.participantId, workspaceId: auth.workspaceId }
}

export function registerRemoteAgentRoutes(router: Router, config: ServerConfig): void {
  // Register an external agent by its Agent Card URL (pending verification).
  router.post('/api/agent-directory/register', async (ctx) => {
    const auth = await requireAuth(ctx, config)
    if (!registerLimiter.check(ctx.ip ?? 'unknown')) throw tooManyRequests('잠시 후 다시 시도해주세요.')
    const body = await ctx.json<{ agentCardUrl?: string }>()
    if (!body.agentCardUrl) throw badRequest('missing_fields', 'agentCardUrl이 필요합니다.')

    let parsed
    try {
      parsed = await fetchAgentCard(body.agentCardUrl)
      await assertSafeWebhookUrl(parsed.endpointUrl) // the call target must also be a safe public host
    } catch (error) {
      mapFetchError(error)
    }

    const slug = await uniqueSlug(auth.workspaceId, parsed.name)
    const token = generateToken(24)
    const created = await createRemoteAgent({
      workspaceId: auth.workspaceId,
      ownerParticipantId: auth.participantId,
      slug,
      name: parsed.name,
      description: parsed.description,
      agentCardUrl: body.agentCardUrl,
      endpointUrl: parsed.endpointUrl,
      protocolVersion: parsed.protocolVersion,
      skills: parsed.skills,
      capabilities: parsed.capabilities,
      verificationTokenHash: hashToken(token, config.agentTokenPepper)
    })
    await writeAuditLog({
      workspaceId: auth.workspaceId,
      actorParticipantId: auth.participantId,
      action: 'remote_agent.register',
      resourceType: 'remote_agent',
      resourceId: created.agent.id,
      metadata: { endpointUrl: parsed.endpointUrl },
      ipHash: hashIp(ctx.ip, config.authSecret),
      userAgent: ctx.header('user-agent')
    }).catch(() => undefined)

    return json({
      id: created.agent.id,
      slug: created.agent.slug,
      status: created.agent.verification_status,
      verification: {
        type: 'well-known',
        url: `${new URL(parsed.endpointUrl).origin}/.well-known/syncspace-verify.txt`,
        token: `syncspace-verify=${token}`
      }
    })
  })

  // Run the ownership check by fetching the well-known token from the endpoint origin.
  router.post('/api/agent-directory/:id/verify', async (ctx) => {
    if (!verifyLimiter.check(ctx.ip ?? 'unknown')) throw tooManyRequests('잠시 후 다시 시도해주세요.')
    const { remote, participantId, workspaceId } = await loadOwnedRemoteAgent(ctx, config, ctx.params.id ?? '', true)

    let found: string | null
    try {
      found = parseVerifyToken(await fetchWellKnownVerification(remote.endpoint_url))
    } catch (error) {
      mapFetchError(error)
    }

    const ok = Boolean(found && remote.verification_token_hash && hashToken(found, config.agentTokenPepper) === remote.verification_token_hash)
    if (!ok) {
      throw new HttpError(422, 'verification_failed', '검증 토큰이 일치하지 않습니다. .well-known 파일을 확인하세요.')
    }
    await setVerificationStatus(remote.id, 'verified')
    await writeAuditLog({
      workspaceId,
      actorParticipantId: participantId,
      action: 'remote_agent.verified',
      resourceType: 'remote_agent',
      resourceId: remote.id,
      ipHash: hashIp(ctx.ip, config.authSecret),
      userAgent: ctx.header('user-agent')
    }).catch(() => undefined)
    return json({ id: remote.id, status: 'verified' })
  })

  router.get('/api/agent-directory', async (ctx) => {
    const auth = await requireAuth(ctx, config)
    const rows = await listRemoteAgents(auth.workspaceId)
    return json({ remoteAgents: rows.map(toRemoteAgentProfile) })
  })

  // Fetch one remote agent by id OR slug (within the caller's workspace).
  router.get('/api/agent-directory/:id', async (ctx) => {
    const auth = await requireAuth(ctx, config)
    const idOrSlug = ctx.params.id ?? ''
    const remote = UUID_RE.test(idOrSlug)
      ? await getRemoteAgentById(idOrSlug)
      : await getRemoteAgentBySlug(auth.workspaceId, idOrSlug)
    if (!remote || remote.workspace_id !== auth.workspaceId) throw notFound('원격 에이전트를 찾을 수 없습니다.')
    return json({ remoteAgent: toRemoteAgentProfile(remote) })
  })

  router.post('/api/agent-directory/:id/health-check', async (ctx) => {
    const { remote } = await loadOwnedRemoteAgent(ctx, config, ctx.params.id ?? '', false)
    let healthy = false
    try {
      await fetchAgentCard(remote.agent_card_url)
      healthy = true
    } catch {
      healthy = false
    }
    await setHealthStatus(remote.id, healthy ? 'healthy' : 'unhealthy')
    return json({ id: remote.id, healthStatus: healthy ? 'healthy' : 'unhealthy' })
  })

  router.delete('/api/agent-directory/:id', async (ctx) => {
    const { remote, participantId, workspaceId } = await loadOwnedRemoteAgent(ctx, config, ctx.params.id ?? '', true)
    await deleteRemoteAgent(remote.id)
    await writeAuditLog({
      workspaceId,
      actorParticipantId: participantId,
      action: 'remote_agent.delete',
      resourceType: 'remote_agent',
      resourceId: remote.id,
      ipHash: hashIp(ctx.ip, config.authSecret),
      userAgent: ctx.header('user-agent')
    }).catch(() => undefined)
    return json({ id: remote.id })
  })

  // Invoke a verified remote agent — creates a local proxy task driven by the remote worker.
  router.post('/api/agent-directory/:id/invoke', async (ctx) => {
    const { remote, participantId, workspaceId } = await loadOwnedRemoteAgent(ctx, config, ctx.params.id ?? '', false)
    assertAgentActor(await requireAuth(ctx, config)) // humans spectate; only agents invoke
    if (remote.verification_status !== 'verified') {
      throw badRequest('not_verified', '검증되지 않은 원격 에이전트는 호출할 수 없습니다.')
    }
    const body = await ctx.json<{ content?: string; channelId?: string }>()
    const content = typeof body.content === 'string' ? body.content.trim() : ''
    if (!content) throw badRequest('missing_content', '요청 내용이 필요합니다.')

    const result = await createTaskFromMessage({
      workspaceId,
      remoteAgentId: remote.id,
      createdByParticipantId: participantId,
      ...(body.channelId ? { channelId: body.channelId } : {}),
      message: { messageId: newUuid(), parts: [{ text: content }], role: 'ROLE_USER' }
    })
    return json({ task: result.task })
  })
}
