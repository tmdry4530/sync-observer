import type { IncomingMessage } from 'node:http'
import type { ServerConfig } from '../config.js'
import type { RealtimeRoute } from '../realtime/roomNames.js'
import type { ParticipantType } from '../types/contracts.js'
import type { Logger } from '../utils/logger.js'
import { parseCookies } from '../http/context.js'
import { resolveAgentToken } from './agentToken.js'

export interface RealtimeAuthContext {
  request: IncomingMessage
  route: RealtimeRoute
}

/**
 * Authenticated identity bound to a realtime connection at upgrade time.
 * Persistence paths must derive message authorship from this — never from
 * client-controlled Yjs document content.
 */
export interface RealtimeConnectionIdentity {
  participantId: string
  agentId: string | null
  authorType: ParticipantType
  /**
   * True when the credential arrived in the web session cookie — the human owner
   * spectating. Such a connection is read-only: inbound Yjs document/chat writes
   * are dropped. A bearer-token connection (the agent acting) is read-write.
   */
  spectator: boolean
}

export interface RealtimeAuthResult {
  ok: boolean
  userId?: string
  identity?: RealtimeConnectionIdentity
  reason?: string
}

export interface RealtimeAuthorizer {
  authorize(context: RealtimeAuthContext): Promise<RealtimeAuthResult>
}

export class AllowAllRealtimeAuthorizer implements RealtimeAuthorizer {
  async authorize(): Promise<RealtimeAuthResult> {
    return { ok: true }
  }
}

/**
 * App-owned realtime authorization: resolves the agent credential (session
 * cookie / bearer token / ?token=) and confirms it belongs to the room's
 * workspace before allowing the WebSocket upgrade.
 */
export class AgentRealtimeAuthorizer implements RealtimeAuthorizer {
  constructor(
    private readonly config: ServerConfig,
    private readonly logger: Logger
  ) {}

  async authorize(context: RealtimeAuthContext): Promise<RealtimeAuthResult> {
    const source = readRealtimeTokenSource(context.request, this.config)
    if (!source) return { ok: false, reason: 'missing_credential' }

    try {
      const agent = await resolveAgentToken(this.config, source.token)
      if (!agent) return { ok: false, reason: 'invalid_credential' }
      if (agent.workspaceId !== context.route.workspaceId) return { ok: false, reason: 'not_workspace_member' }
      const principalId = agent.agentId ?? agent.remoteAgentId
      return {
        ok: true,
        ...(principalId ? { userId: principalId } : {}),
        // resolveAgentToken only resolves agent-owned participants, so the
        // authenticated author type is always 'agent'. A cookie credential is the
        // human owner spectating (read-only); a bearer is the agent acting.
        identity: {
          participantId: agent.participantId,
          agentId: agent.agentId,
          authorType: 'agent',
          spectator: source.via === 'cookie'
        }
      }
    } catch (error) {
      this.logger.warn('Realtime authorization failed', {
        workspaceId: context.route.workspaceId,
        error: error instanceof Error ? error.message : String(error)
      })
      return { ok: false, reason: 'authorization_error' }
    }
  }
}

export function createRealtimeAuthorizer(config: ServerConfig, logger: Logger): RealtimeAuthorizer {
  if (config.wsAuthMode === 'off') return new AllowAllRealtimeAuthorizer()
  return new AgentRealtimeAuthorizer(config, logger)
}

interface RealtimeTokenSource {
  token: string
  via: 'cookie' | 'bearer'
}

/** Cookie (web session = human spectator) wins lookup order over bearer (agent). */
function readRealtimeTokenSource(request: IncomingMessage, config: ServerConfig): RealtimeTokenSource | null {
  const cookies = parseCookies(request.headers.cookie)
  const cookieToken = cookies[config.sessionCookieName]
  if (cookieToken) return { token: cookieToken, via: 'cookie' }
  const access = getAccessToken(request)
  if (access) return { token: access, via: 'bearer' }
  return null
}

export function getAccessToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim() || null
  }

  const protocolHeader = request.headers['sec-websocket-protocol']
  const protocolToken = Array.isArray(protocolHeader)
    ? protocolHeader.find((item) => item.startsWith('bearer,'))
    : protocolHeader?.startsWith('bearer,')
      ? protocolHeader
      : undefined
  if (protocolToken) {
    const [, token] = protocolToken.split(',', 2)
    return token?.trim() || null
  }

  try {
    const url = new URL(request.url ?? '/', 'http://syncspace.local')
    return url.searchParams.get('token') ?? url.searchParams.get('access_token')
  } catch {
    return null
  }
}
