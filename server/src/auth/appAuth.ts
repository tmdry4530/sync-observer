import type { AuthUser } from '../types/contracts.js'
import { badRequest, conflict, unauthorized } from '../http/errors.js'
import { hashPassword, verifyPassword } from '../utils/crypto.js'
import {
  createUserWithParticipant,
  findUserByEmail,
  toAuthUser,
  type AppUserRow
} from '../db/repositories/userRepository.js'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD_LENGTH = 8

export interface RegisterInput {
  email: string
  password: string
  displayName?: string
  color?: string
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export async function registerUser(input: RegisterInput): Promise<{ user: AuthUser; userId: string }> {
  const email = normalizeEmail(input.email)
  if (!EMAIL_PATTERN.test(email)) throw badRequest('invalid_email', '이메일 형식이 올바르지 않습니다.')
  if (typeof input.password !== 'string' || input.password.length < MIN_PASSWORD_LENGTH) {
    throw badRequest('weak_password', `비밀번호는 최소 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`)
  }

  const existing = await findUserByEmail(email)
  if (existing) throw conflict('이미 가입된 이메일입니다.', 'email_taken')

  const displayName = (input.displayName?.trim() || email.split('@')[0] || 'SyncSpace User').slice(0, 80)
  const passwordHash = await hashPassword(input.password)
  const created = await createUserWithParticipant({
    email,
    displayName,
    passwordHash,
    ...(input.color ? { color: input.color } : {})
  })

  return { user: toAuthUser(created.user), userId: created.user.id }
}

export async function authenticateUser(email: string, password: string): Promise<AppUserRow> {
  const normalized = normalizeEmail(email)
  const user = await findUserByEmail(normalized)
  // Always run a hash comparison to keep timing uniform whether or not the user exists.
  const ok = await verifyPassword(password, user?.password_hash ?? null)
  if (!user || user.disabled_at || !ok) {
    throw unauthorized('이메일 또는 비밀번호가 올바르지 않습니다.', 'invalid_credentials')
  }
  return user
}

export { toAuthUser }
