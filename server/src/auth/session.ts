import type { ServerConfig } from '../config.js'
import { generateToken, hashIp, hashToken } from '../utils/crypto.js'
import { findUserById } from '../db/repositories/userRepository.js'
import { getHumanParticipantByUserId } from '../db/repositories/participantRepository.js'
import {
  createSession,
  findValidSessionByTokenHash,
  revokeSession,
  touchSession
} from '../db/repositories/sessionRepository.js'
import type { SessionContext } from './context.js'

export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

export interface IssuedSession {
  token: string
  expiresAt: Date
}

export async function issueSession(
  config: ServerConfig,
  userId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {}
): Promise<IssuedSession> {
  const token = generateToken(32)
  const tokenHash = hashToken(token, config.authSecret)
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await createSession({
    userId,
    tokenHash,
    expiresAt,
    userAgent: meta.userAgent ?? null,
    ipHash: hashIp(meta.ip, config.authSecret)
  })
  return { token, expiresAt }
}

export async function resolveSession(config: ServerConfig, token: string): Promise<SessionContext | null> {
  const tokenHash = hashToken(token, config.authSecret)
  const session = await findValidSessionByTokenHash(tokenHash)
  if (!session) return null

  const user = await findUserById(session.user_id)
  if (!user || user.disabled_at) return null

  const participant = await getHumanParticipantByUserId(user.id)
  if (!participant) return null

  void touchSession(session.id).catch(() => undefined)

  return {
    sessionId: session.id,
    userId: user.id,
    participantId: participant.id,
    email: user.email,
    displayName: user.display_name
  }
}

export async function destroySession(config: ServerConfig, token: string): Promise<void> {
  const tokenHash = hashToken(token, config.authSecret)
  await revokeSession(tokenHash)
}
