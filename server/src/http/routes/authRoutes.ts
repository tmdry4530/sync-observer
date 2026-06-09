import type { ServerConfig } from '../../config.js'
import type { Router } from '../router.js'
import { json } from '../response.js'
import { badRequest, forbidden } from '../errors.js'
import { authenticateUser, registerUser, toAuthUser } from '../../auth/appAuth.js'
import { destroySession, issueSession } from '../../auth/session.js'
import { optionalSession, requireSession, readSessionToken } from '../../auth/middleware.js'
import { buildSessionClearCookie, buildSessionSetCookie } from '../../auth/cookies.js'
import { findUserById, toAuthUser as rowToAuthUser } from '../../db/repositories/userRepository.js'

function registrationAllowed(config: ServerConfig): boolean {
  return config.nodeEnv !== 'production' || process.env.AUTH_ALLOW_OPEN_REGISTRATION === 'true'
}

export function registerAuthRoutes(router: Router, config: ServerConfig): void {
  router.post('/api/auth/register', async (ctx) => {
    if (!registrationAllowed(config)) throw forbidden('회원가입이 비활성화되어 있습니다.', 'registration_disabled')
    const body = await ctx.json<{ email?: string; password?: string; displayName?: string; color?: string }>()
    if (!body.email || !body.password) throw badRequest('missing_fields', '이메일과 비밀번호가 필요합니다.')

    const { user, userId } = await registerUser({
      email: body.email,
      password: body.password,
      ...(body.displayName ? { displayName: body.displayName } : {}),
      ...(body.color ? { color: body.color } : {})
    })
    const session = await issueSession(config, userId, { userAgent: ctx.header('user-agent'), ip: ctx.ip })
    return json({ user }, 200, { 'set-cookie': buildSessionSetCookie(config, session.token, session.expiresAt) })
  })

  router.post('/api/auth/login', async (ctx) => {
    const body = await ctx.json<{ email?: string; password?: string }>()
    if (!body.email || !body.password) throw badRequest('missing_fields', '이메일과 비밀번호가 필요합니다.')

    const user = await authenticateUser(body.email, body.password)
    const session = await issueSession(config, user.id, { userAgent: ctx.header('user-agent'), ip: ctx.ip })
    return json({ user: toAuthUser(user) }, 200, {
      'set-cookie': buildSessionSetCookie(config, session.token, session.expiresAt)
    })
  })

  router.post('/api/auth/logout', async (ctx) => {
    const token = readSessionToken(ctx, config)
    if (token) await destroySession(config, token)
    return json({ ok: true }, 200, { 'set-cookie': buildSessionClearCookie(config) })
  })

  router.get('/api/auth/me', async (ctx) => {
    const session = await optionalSession(ctx, config)
    if (!session) return json({ user: null }, 200)
    const user = await findUserById(session.userId)
    return json({ user: user ? rowToAuthUser(user) : null }, 200)
  })

  router.post('/api/auth/refresh', async (ctx) => {
    const session = await requireSession(ctx, config)
    const issued = await issueSession(config, session.userId, { userAgent: ctx.header('user-agent'), ip: ctx.ip })
    const oldToken = readSessionToken(ctx, config)
    if (oldToken) await destroySession(config, oldToken)
    const user = await findUserById(session.userId)
    return json({ user: user ? rowToAuthUser(user) : null }, 200, {
      'set-cookie': buildSessionSetCookie(config, issued.token, issued.expiresAt)
    })
  })
}
