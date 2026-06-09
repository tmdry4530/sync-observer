import { query, queryOne } from '../query.js'
import type { Queryable } from '../query.js'

export interface AuthSessionRow {
  id: string
  user_id: string
  session_token_hash: string
  expires_at: string
  created_at: string
  last_seen_at: string | null
  revoked_at: string | null
}

export interface CreateSessionInput {
  userId: string
  tokenHash: string
  expiresAt: Date
  userAgent?: string | null
  ipHash?: string | null
}

export async function createSession(input: CreateSessionInput, client?: Queryable): Promise<AuthSessionRow> {
  const rows = await query<AuthSessionRow>(
    `insert into auth_sessions (user_id, session_token_hash, expires_at, user_agent, ip_hash)
     values ($1, $2, $3, $4, $5)
     returning id, user_id, session_token_hash, expires_at, created_at, last_seen_at, revoked_at`,
    [input.userId, input.tokenHash, input.expiresAt.toISOString(), input.userAgent ?? null, input.ipHash ?? null],
    client
  )
  const session = rows[0]
  if (!session) throw new Error('Failed to create session')
  return session
}

export async function findValidSessionByTokenHash(tokenHash: string, client?: Queryable): Promise<AuthSessionRow | null> {
  return queryOne<AuthSessionRow>(
    `select id, user_id, session_token_hash, expires_at, created_at, last_seen_at, revoked_at
     from auth_sessions
     where session_token_hash = $1
       and revoked_at is null
       and expires_at > now()`,
    [tokenHash],
    client
  )
}

export async function touchSession(sessionId: string, client?: Queryable): Promise<void> {
  await query(`update auth_sessions set last_seen_at = now() where id = $1`, [sessionId], client)
}

export async function revokeSession(tokenHash: string, client?: Queryable): Promise<void> {
  await query(
    `update auth_sessions set revoked_at = now() where session_token_hash = $1 and revoked_at is null`,
    [tokenHash],
    client
  )
}

export async function revokeAllUserSessions(userId: string, client?: Queryable): Promise<void> {
  await query(`update auth_sessions set revoked_at = now() where user_id = $1 and revoked_at is null`, [userId], client)
}
