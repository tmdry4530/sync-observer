import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { LogLevel } from './utils/logger.js'

export type RealtimeAuthMode = 'off' | 'agent'
export type DocPersistenceMode = 'file' | 'postgres'
export type AgentRuntimeMode = 'mock' | 'live'

export interface ServerConfig {
  nodeEnv: string
  host: string
  port: number
  allowedOrigins: string[]
  wsAuthMode: RealtimeAuthMode
  supabaseUrl: string | null
  supabaseServiceRoleKey: string | null
  logLevel: LogLevel
  databaseUrl: string | null
  authSecret: string | null
  sessionCookieName: string
  sessionCookieDomain: string | null
  agentTokenPepper: string | null
  publicAppUrl: string | null
  a2aVersion: string
  a2aInterfaceUrl: string
  a2aAgentCardUrl: string | null
  docPersistenceMode: DocPersistenceMode
  trustProxy: boolean
  agentRuntimeMode: AgentRuntimeMode
  modelProvider: string
  anthropicApiKey: string | null
  anthropicModel: string
  agentLiveMaxTokens: number
  agentLiveTimeoutMs: number
  strictReadyChecks: boolean
}

const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000', 'http://127.0.0.1:3000']

loadLocalEnvFiles()

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnv = env.NODE_ENV?.trim() || 'development'
  const host = env.HOST?.trim() || '0.0.0.0'
  const port = parsePort(env.PORT, 1234)
  const allowedOrigins = parseList(env.ALLOWED_ORIGINS, DEFAULT_ALLOWED_ORIGINS)
  const supabaseUrl = readFirstEnv(env, ['SUPABASE_URL', 'VITE_SUPABASE_URL'])
  const supabaseServiceRoleKey = readFirstEnv(env, ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY', 'SERVICE_ROLE_KEY'])
  const wsAuthMode = parseAuthMode(env.WS_AUTH_MODE, nodeEnv)
  const logLevel = parseLogLevel(env.LOG_LEVEL)
  const databaseUrl = readFirstEnv(env, ['DATABASE_URL', 'POSTGRES_URL'])
  const authSecret = readFirstEnv(env, ['AUTH_SECRET'])
  const sessionCookieName = nonEmpty(env.SESSION_COOKIE_NAME) ?? 'syncspace_session'
  const sessionCookieDomain = readFirstEnv(env, ['SESSION_COOKIE_DOMAIN'])
  const agentTokenPepper = readFirstEnv(env, ['AGENT_TOKEN_PEPPER'])
  const publicAppUrl = readFirstEnv(env, ['PUBLIC_APP_URL'])
  const a2aVersion = nonEmpty(env.A2A_VERSION) ?? '1.0'
  const a2aInterfaceUrl = (nonEmpty(env.A2A_INTERFACE_URL) ?? `${publicAppUrl ?? 'http://localhost:1234'}/a2a`).replace(/\/$/, '')
  const a2aAgentCardUrl = readFirstEnv(env, ['A2A_AGENT_CARD_URL'])
  const docPersistenceMode = parseDocPersistenceMode(env.SYNCSPACE_DOC_PERSISTENCE_MODE, databaseUrl)
  // Trust X-Forwarded-For only behind a known proxy (Railway/Caddy terminate it).
  const trustProxy = env.TRUST_PROXY ? env.TRUST_PROXY.trim().toLowerCase() === 'true' : nodeEnv === 'production'
  const agentRuntimeMode = parseAgentRuntimeMode(env.AGENT_RUNTIME_MODE)
  const modelProvider = (nonEmpty(env.MODEL_PROVIDER) ?? 'anthropic').toLowerCase()
  const anthropicApiKey = readFirstEnv(env, ['ANTHROPIC_API_KEY'])
  const anthropicModel = nonEmpty(env.ANTHROPIC_MODEL) ?? 'claude-sonnet-4-6'
  const agentLiveMaxTokens = parsePositiveInt(env.AGENT_LIVE_MAX_TOKENS, 4096)
  const agentLiveTimeoutMs = parsePositiveInt(env.AGENT_LIVE_TIMEOUT_MS, 60_000)
  const strictReadyChecks = parseBoolean(env.STRICT_READY_CHECKS, false)

  assertAgentAuthConfig(wsAuthMode, { databaseUrl, agentTokenPepper })
  assertAgentRuntimeConfig(agentRuntimeMode, modelProvider, anthropicApiKey)

  return {
    nodeEnv,
    host,
    port,
    allowedOrigins,
    wsAuthMode,
    supabaseUrl,
    supabaseServiceRoleKey,
    logLevel,
    databaseUrl,
    authSecret,
    sessionCookieName,
    sessionCookieDomain,
    agentTokenPepper,
    publicAppUrl,
    a2aVersion,
    a2aInterfaceUrl,
    a2aAgentCardUrl,
    docPersistenceMode,
    trustProxy,
    agentRuntimeMode,
    modelProvider,
    anthropicApiKey,
    anthropicModel,
    agentLiveMaxTokens,
    agentLiveTimeoutMs,
    strictReadyChecks
  }
}

function parseAgentRuntimeMode(value: string | undefined): AgentRuntimeMode {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'live') return 'live'
  // Mock is the safe operational default; opt into live explicitly.
  return 'mock'
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

/**
 * In live mode the configured model provider must be usable. We fail fast at boot
 * rather than silently falling back to mock, which would hide an outage.
 */
function assertAgentRuntimeConfig(mode: AgentRuntimeMode, provider: string, anthropicApiKey: string | null): void {
  if (mode !== 'live') return
  if (provider === 'anthropic' && !anthropicApiKey) {
    throw new Error('AGENT_RUNTIME_MODE=live with MODEL_PROVIDER=anthropic requires ANTHROPIC_API_KEY.')
  }
  if (provider !== 'anthropic') {
    throw new Error(`AGENT_RUNTIME_MODE=live: unsupported MODEL_PROVIDER "${provider}" (only "anthropic" is implemented).`)
  }
}

function parseDocPersistenceMode(value: string | undefined, databaseUrl: string | null): DocPersistenceMode {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'file' || normalized === 'postgres') return normalized
  // Default to postgres when a database is configured, otherwise fall back to file storage.
  return databaseUrl ? 'postgres' : 'file'
}

function assertAgentAuthConfig(
  wsAuthMode: RealtimeAuthMode,
  config: { databaseUrl: string | null; agentTokenPepper: string | null }
): void {
  if (wsAuthMode !== 'agent') return
  const missing = [
    config.databaseUrl ? null : 'DATABASE_URL',
    config.agentTokenPepper ? null : 'AGENT_TOKEN_PEPPER'
  ].filter(Boolean)
  if (missing.length > 0) {
    throw new Error(
      `WS_AUTH_MODE=agent is enabled, but the backend process is missing: ${missing.join(', ')}.`
    )
  }
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function readFirstEnv(env: NodeJS.ProcessEnv, keys: string[]): string | null {
  for (const key of keys) {
    const value = nonEmpty(env[key])
    if (value) return value
  }
  return null
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid PORT value: ${value}`)
  }
  return parsed
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  const parsed = value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  return parsed && parsed.length > 0 ? parsed : fallback
}

function parseAuthMode(value: string | undefined, nodeEnv: string): RealtimeAuthMode {
  const normalized = value?.trim().toLowerCase()
  // Agent-credential auth is the production default.
  if (!normalized) return nodeEnv === 'production' ? 'agent' : 'off'
  if (normalized === 'off') return 'off'
  // Accept legacy 'session'/'supabase' values as the agent-credential mode.
  if (normalized === 'agent' || normalized === 'session' || normalized === 'supabase') return 'agent'
  throw new Error(`Invalid WS_AUTH_MODE value: ${value}`)
}

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return 'info'
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error' || normalized === 'silent') {
    return normalized
  }
  throw new Error(`Invalid LOG_LEVEL value: ${value}`)
}

export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return true
  if (allowedOrigins.includes('*')) return true
  return allowedOrigins.includes(origin)
}

export function hasSupabaseAdminConfig(config: ServerConfig): boolean {
  return Boolean(config.supabaseUrl && config.supabaseServiceRoleKey)
}

export function hasDatabaseConfig(config: ServerConfig): boolean {
  return Boolean(config.databaseUrl)
}


function loadLocalEnvFiles(): void {
  const candidates = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')]
  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue
    for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const separatorIndex = trimmed.indexOf('=')
      if (separatorIndex <= 0) continue
      const key = trimmed.slice(0, separatorIndex).trim()
      const rawValue = trimmed.slice(separatorIndex + 1).trim()
      if (!key || process.env[key] !== undefined) continue
      process.env[key] = unquoteEnvValue(rawValue)
    }
  }
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}
