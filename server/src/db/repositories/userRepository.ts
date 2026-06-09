import type { AuthUser } from '../../types/contracts.js'
import { query, queryOne, withTransaction } from '../query.js'
import type { Queryable } from '../query.js'

export interface AppUserRow {
  id: string
  email: string
  display_name: string
  avatar_url: string | null
  color: string
  password_hash: string | null
  email_verified_at: string | null
  disabled_at: string | null
  created_at: string
  updated_at: string
}

export function toAuthUser(row: AppUserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    color: row.color
  }
}

const USER_COLUMNS = `id, email, display_name, avatar_url, color, password_hash, email_verified_at, disabled_at, created_at, updated_at`

export async function findUserByEmail(email: string, client?: Queryable): Promise<AppUserRow | null> {
  return queryOne<AppUserRow>(
    `select ${USER_COLUMNS} from app_users where lower(email) = lower($1)`,
    [email],
    client
  )
}

export async function findUserById(id: string, client?: Queryable): Promise<AppUserRow | null> {
  return queryOne<AppUserRow>(`select ${USER_COLUMNS} from app_users where id = $1`, [id], client)
}

export interface CreateUserInput {
  email: string
  displayName: string
  passwordHash: string | null
  color?: string
  avatarUrl?: string | null
  id?: string
}

export interface CreatedUser {
  user: AppUserRow
  participantId: string
}

/** Create an app user and its human participant atomically. */
export async function createUserWithParticipant(input: CreateUserInput): Promise<CreatedUser> {
  return withTransaction(async (client) => {
    const inserted = await query<AppUserRow>(
      `insert into app_users (id, email, display_name, color, avatar_url, password_hash)
       values (coalesce($1, gen_random_uuid()), $2, $3, coalesce($4, '#64748b'), $5, $6)
       returning ${USER_COLUMNS}`,
      [input.id ?? null, input.email, input.displayName, input.color ?? null, input.avatarUrl ?? null, input.passwordHash],
      client
    )
    const user = inserted[0]
    if (!user) throw new Error('Failed to create app user')

    const participant = await query<{ id: string }>(
      `insert into participants (participant_type, user_id, display_name, avatar_url, color)
       values ('human', $1, $2, $3, $4)
       returning id`,
      [user.id, user.display_name, user.avatar_url, user.color],
      client
    )
    const participantId = participant[0]?.id
    if (!participantId) throw new Error('Failed to create human participant')

    return { user, participantId }
  })
}

export async function setUserPassword(userId: string, passwordHash: string, client?: Queryable): Promise<void> {
  await query(`update app_users set password_hash = $2 where id = $1`, [userId, passwordHash], client)
}
