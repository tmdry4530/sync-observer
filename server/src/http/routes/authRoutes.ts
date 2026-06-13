import type { ServerConfig } from '../../config.js'
import type { AgentRole } from '../../types/contracts.js'
import type { Router } from '../router.js'
import type { RequestContext } from '../context.js'
import { json } from '../response.js'
import { badRequest, forbidden, HttpError, serviceUnavailable, tooManyRequests, unauthorized } from '../errors.js'
import { RateLimiter } from '../rateLimit.js'
import { optionalAuth, requireAuth } from '../../auth/middleware.js'
import { buildSessionClearCookie, buildSessionSetCookie } from '../../auth/cookies.js'
import { generateChallenge, hashAnswer, isAnswerCorrect } from '../../auth/challenge.js'
import { registerAgent, toIdentity } from '../../auth/agentRegistration.js'
import { registerExternalAgent, toRemoteIdentity } from '../../auth/remoteAgentRegistration.js'
import { RemoteFetchError } from '../../a2a/agentCardFetcher.js'
import { createChallenge, consumeChallenge, findUsableChallenge } from '../../db/repositories/challengeRepository.js'
import { getAgentById } from '../../db/repositories/agentRepository.js'
import { getRemoteAgentById } from '../../db/repositories/remoteAgentRepository.js'
import { getWorkspaceByInviteCode } from '../../db/repositories/workspaceRepository.js'
import { resolveAgentToken } from '../../auth/agentToken.js'
import { writeAuditLog } from '../../db/repositories/auditRepository.js'
import { hashIp } from '../../utils/crypto.js'

const CHALLENGE_TTL_MS = 1000 * 60 * 10 // 10 minutes
const SESSION_COOKIE_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

// 10 logins/min per IP+agent; 5 registrations + 10 challenges/min per IP.
const loginLimiter = new RateLimiter(60_000, 10)
const registerLimiter = new RateLimiter(60_000, 5)
const challengeLimiter = new RateLimiter(60_000, 10)

function mapRegistrationError(error: unknown): never {
  if (error instanceof RemoteFetchError) throw badRequest(error.code, error.message)
  if (error instanceof HttpError) throw error
  throw error
}

function registrationAllowed(config: ServerConfig): boolean {
  return config.nodeEnv !== 'production' || process.env.AUTH_ALLOW_OPEN_REGISTRATION === 'true'
}

function externalRegistrationAllowed(config: ServerConfig): boolean {
  return (
    config.nodeEnv !== 'production' ||
    process.env.AUTH_ALLOW_OPEN_REGISTRATION === 'true' ||
    process.env.AUTH_ALLOW_EXTERNAL_AGENT_REGISTRATION === 'true'
  )
}

function assertAgentCredentialStore(config: ServerConfig): void {
  const missing = [
    config.databaseUrl ? null : 'DATABASE_URL',
    config.agentTokenPepper ? null : 'AGENT_TOKEN_PEPPER'
  ].filter(Boolean)
  if (missing.length === 0) return
  throw serviceUnavailable(
    `Agent credential auth is not configured. Missing: ${missing.join(', ')}.`,
    'agent_auth_not_configured',
    { missing }
  )
}

function cookieExpiry(): Date {
  return new Date(Date.now() + SESSION_COOKIE_TTL_MS)
}

async function issueRegistrationChallenge(config: ServerConfig) {
  const generated = generateChallenge()
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS)
  const row = await createChallenge({
    template: generated.template,
    prompt: generated.prompt,
    answerHash: hashAnswer(generated.answer, config.agentTokenPepper),
    expiresAt
  })
  return { challengeId: row.id, prompt: generated.prompt, expiresAt: expiresAt.toISOString() }
}

/**
 * Resolve an optional invite code to a workspace id the new agent should JOIN.
 * Returns undefined when no code is supplied (→ fresh workspace); throws 400
 * when a code is supplied but matches no workspace.
 */
async function resolveJoinWorkspaceId(inviteCode: unknown): Promise<string | undefined> {
  if (typeof inviteCode !== 'string' || !inviteCode.trim()) return undefined
  const workspace = await getWorkspaceByInviteCode(inviteCode)
  if (!workspace) throw badRequest('invalid_invite_code', '유효하지 않은 초대 코드입니다.')
  return workspace.id
}

async function assertSolvedChallenge(
  ctx: RequestContext,
  config: ServerConfig,
  challengeId: string,
  answer: string
): Promise<void> {
  const challenge = await findUsableChallenge(challengeId)
  if (!challenge) throw badRequest('challenge_expired', '챌린지가 만료되었거나 이미 사용되었습니다. 새 챌린지를 요청하세요.')

  const correct = isAnswerCorrect(answer, challenge.answer_hash, config.agentTokenPepper)
  if (!correct) {
    await consumeChallenge(challenge.id, false)
    await writeAuditLog({
      action: 'agent.registration_rejected',
      resourceType: 'agent_registration',
      resourceId: challenge.id,
      ipHash: hashIp(ctx.ip, config.authSecret),
      userAgent: ctx.header('user-agent')
    }).catch(() => undefined)
    throw new HttpError(422, 'challenge_failed', '챌린지 정답이 올바르지 않습니다. 등록이 반려되었습니다.')
  }

  await consumeChallenge(challenge.id, true)
}

export function registerAuthRoutes(router: Router, config: ServerConfig): void {
  // Step 1 of registration: request a capability challenge.
  router.post('/api/agents/register/challenge', async (ctx) => {
    if (!registrationAllowed(config)) throw forbidden('에이전트 등록이 비활성화되어 있습니다.', 'registration_disabled')
    assertAgentCredentialStore(config)
    if (!challengeLimiter.check(ctx.ip ?? 'unknown')) throw tooManyRequests('잠시 후 다시 시도해주세요.')

    return json(await issueRegistrationChallenge(config))
  })

  // Public external-agent signup: mirrors the Moltbook pattern where an agent
  // reads /skill.md, solves a capability gate, and registers itself by Agent Card.
  router.post('/api/v1/agents/register/challenge', async (ctx) => {
    if (!externalRegistrationAllowed(config)) throw forbidden('외부 에이전트 등록이 비활성화되어 있습니다.', 'registration_disabled')
    assertAgentCredentialStore(config)
    if (!challengeLimiter.check(ctx.ip ?? 'unknown')) throw tooManyRequests('잠시 후 다시 시도해주세요.')
    return json(await issueRegistrationChallenge(config))
  })

  router.post('/api/v1/agents/register', async (ctx) => {
    if (!externalRegistrationAllowed(config)) throw forbidden('외부 에이전트 등록이 비활성화되어 있습니다.', 'registration_disabled')
    assertAgentCredentialStore(config)
    if (!registerLimiter.check(ctx.ip ?? 'unknown')) throw tooManyRequests('잠시 후 다시 시도해주세요.')

    const body = await ctx.json<{
      challengeId?: string
      answer?: string
      agentCardUrl?: string
      displayName?: string
      slug?: string
      workspaceName?: string
      inviteCode?: string
    }>()
    if (!body.challengeId || typeof body.answer !== 'string' || !body.agentCardUrl) {
      throw badRequest('missing_fields', 'challengeId, answer, agentCardUrl이 필요합니다.')
    }

    const joinWorkspaceId = await resolveJoinWorkspaceId(body.inviteCode)
    await assertSolvedChallenge(ctx, config, body.challengeId, body.answer)
    let result
    try {
      result = await registerExternalAgent(config, {
        agentCardUrl: body.agentCardUrl,
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(body.slug ? { slug: body.slug } : {}),
        ...(body.workspaceName ? { workspaceName: body.workspaceName } : {}),
        ...(joinWorkspaceId ? { joinWorkspaceId } : {})
      })
    } catch (error) {
      mapRegistrationError(error)
    }
    await writeAuditLog({
      workspaceId: result.workspace.id,
      actorParticipantId: result.identity.participantId,
      action: 'remote_agent.self_registered',
      resourceType: 'remote_agent',
      resourceId: result.credential.agentId,
      metadata: { agentCardUrl: body.agentCardUrl },
      ipHash: hashIp(ctx.ip, config.authSecret),
      userAgent: ctx.header('user-agent')
    }).catch(() => undefined)

    return json(result, 200, {
      'set-cookie': buildSessionSetCookie(config, result.credential.secret, cookieExpiry())
    })
  })

  router.get('/api/v1/agents/status', async (ctx) => {
    const auth = await requireAuth(ctx, config)
    if (auth.principalType === 'remote_agent' && auth.remoteAgentId) {
      const agent = await getRemoteAgentById(auth.remoteAgentId)
      if (!agent) throw unauthorized('에이전트를 찾을 수 없습니다.', 'invalid_credentials')
      return json({
        status: agent.verification_status,
        identity: toRemoteIdentity({
          id: agent.id,
          participantId: auth.participantId,
          workspaceId: agent.workspace_id,
          name: agent.name,
          slug: agent.slug
        })
      })
    }
    if (auth.agentId) {
      const agent = await getAgentById(auth.agentId)
      return json({ status: 'internal', identity: agent ? toIdentity(agent) : null })
    }
    return json({ status: 'unknown', identity: null })
  })

  // Step 2: submit the answer + agent metadata. Correct → register & issue secret.
  router.post('/api/agents/register', async (ctx) => {
    if (!registrationAllowed(config)) throw forbidden('에이전트 등록이 비활성화되어 있습니다.', 'registration_disabled')
    assertAgentCredentialStore(config)
    if (!registerLimiter.check(ctx.ip ?? 'unknown')) throw tooManyRequests('잠시 후 다시 시도해주세요.')

    const body = await ctx.json<{
      challengeId?: string
      answer?: string
      displayName?: string
      slug?: string
      role?: AgentRole
      description?: string
      inviteCode?: string
    }>()
    if (!body.challengeId || typeof body.answer !== 'string') {
      throw badRequest('missing_fields', 'challengeId와 answer가 필요합니다.')
    }
    if (!body.displayName || !body.displayName.trim()) {
      throw badRequest('missing_fields', '에이전트 표시 이름(displayName)이 필요합니다.')
    }

    const joinWorkspaceId = await resolveJoinWorkspaceId(body.inviteCode)
    await assertSolvedChallenge(ctx, config, body.challengeId, body.answer)
    const result = await registerAgent(config, {
      displayName: body.displayName,
      ...(body.slug ? { slug: body.slug } : {}),
      ...(body.role ? { role: body.role } : {}),
      ...(body.description ? { description: body.description } : {}),
      ...(joinWorkspaceId ? { joinWorkspaceId } : {})
    })
    await writeAuditLog({
      workspaceId: result.workspace.id,
      actorParticipantId: result.identity.participantId,
      action: 'agent.registered',
      resourceType: 'agent',
      resourceId: result.credential.agentId,
      ipHash: hashIp(ctx.ip, config.authSecret),
      userAgent: ctx.header('user-agent')
    }).catch(() => undefined)

    return json(result, 200, {
      'set-cookie': buildSessionSetCookie(config, result.credential.secret, cookieExpiry())
    })
  })

  // Owner login with the agent credential (agentId + secret).
  router.post('/api/auth/agent-login', async (ctx) => {
    assertAgentCredentialStore(config)
    const body = await ctx.json<{ agentId?: string; secret?: string }>()
    if (!body.agentId || !body.secret) throw badRequest('missing_fields', 'agentId와 secret이 필요합니다.')
    if (!loginLimiter.check(`${ctx.ip ?? 'unknown'}:${body.agentId}`)) {
      throw tooManyRequests('로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.')
    }

    const resolved = await resolveAgentToken(config, body.secret)
    const resolvedPrincipalId = resolved?.agentId ?? resolved?.remoteAgentId ?? null
    if (!resolved || resolvedPrincipalId !== body.agentId) {
      await writeAuditLog({
        action: 'auth.login_failed',
        resourceType: 'auth',
        resourceId: body.agentId,
        ipHash: hashIp(ctx.ip, config.authSecret),
        userAgent: ctx.header('user-agent')
      }).catch(() => undefined)
      throw unauthorized('에이전트 ID 또는 시크릿이 올바르지 않습니다.', 'invalid_credentials')
    }

    const identity =
      resolved.principalType === 'internal_agent' && resolved.agentId
        ? await getAgentById(resolved.agentId).then((agent) => (agent ? toIdentity(agent) : null))
        : resolved.remoteAgentId
          ? await getRemoteAgentById(resolved.remoteAgentId).then((agent) =>
              agent
                ? toRemoteIdentity({
                    id: agent.id,
                    participantId: resolved.participantId,
                    workspaceId: agent.workspace_id,
                    name: agent.name,
                    slug: agent.slug
                  })
                : null
            )
          : null
    if (!identity) throw unauthorized('에이전트를 찾을 수 없습니다.', 'invalid_credentials')
    await writeAuditLog({
      workspaceId: identity.workspaceId,
      actorParticipantId: identity.participantId,
      action: 'auth.login',
      resourceType: 'auth',
      resourceId: identity.agentId,
      ipHash: hashIp(ctx.ip, config.authSecret),
      userAgent: ctx.header('user-agent')
    }).catch(() => undefined)

    return json({ identity }, 200, {
      'set-cookie': buildSessionSetCookie(config, body.secret, cookieExpiry())
    })
  })

  router.post('/api/auth/logout', async (_ctx) => {
    // The credential is the agent secret itself; logout only clears the browser
    // cookie (the secret is not revoked, since the agent still uses it for M2M).
    return json({ ok: true }, 200, { 'set-cookie': buildSessionClearCookie(config) })
  })

  router.get('/api/auth/me', async (ctx) => {
    const auth = await optionalAuth(ctx, config)
    if (!auth) return json({ identity: null }, 200)
    if (auth.principalType === 'internal_agent' && auth.agentId) {
      const agent = await getAgentById(auth.agentId)
      return json({ identity: agent ? toIdentity(agent) : null }, 200)
    }
    if (auth.remoteAgentId) {
      const agent = await getRemoteAgentById(auth.remoteAgentId)
      return json({
        identity: agent
          ? toRemoteIdentity({
              id: agent.id,
              participantId: auth.participantId,
              workspaceId: agent.workspace_id,
              name: agent.name,
              slug: agent.slug
            })
          : null
      }, 200)
    }
    return json({ identity: null }, 200)
  })
}
