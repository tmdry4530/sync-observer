import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * Configuration for the LOCAL hermes-monitor collector + control plane (M2).
 *
 * This is a deliberately tiny, pg-free config: the collector persists to
 * node:sqlite and must boot with DATABASE_URL unset. Unlike the legacy Railway
 * backend (config.ts → host defaults to 0.0.0.0), the collector ALWAYS binds
 * the loopback interface — it is a single-user local tool and the ingest /
 * control surface must never be reachable off-host.
 */

export interface CollectorConfig {
  /** Fixed to 127.0.0.1 — loopback only, never overridable. */
  host: string
  /** Defaults to 8787 to match the plugin's DEFAULT_COLLECTOR_URL. */
  port: number
  /** sqlite database file path (its parent dir is created on read). */
  dbPath: string
  /** Plugin rules JSON file (env SYNCSPACE_RULES_FILE). The control plane projects here. */
  rulesFilePath: string
  /** Origins permitted on the (browser-driven) read + control surface. */
  allowedOrigins: string[]
}

const DEFAULT_PORT = 8787
const DEFAULT_DB_PATH = './.syncspace/collector.db'
const DEFAULT_RULES_FILE = './.syncspace/rules.json'
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
]

export function readCollectorConfig(env: NodeJS.ProcessEnv = process.env): CollectorConfig {
  const port = parsePort(env.SYNCSPACE_COLLECTOR_PORT, DEFAULT_PORT)
  const dbPath = resolve(nonEmpty(env.SYNCSPACE_DB_PATH) ?? DEFAULT_DB_PATH)
  const rulesFilePath = resolve(nonEmpty(env.SYNCSPACE_RULES_FILE) ?? DEFAULT_RULES_FILE)
  const allowedOrigins = parseList(env.ALLOWED_ORIGINS, DEFAULT_ALLOWED_ORIGINS)

  // Ensure the db directory exists so DatabaseSync can open the file.
  mkdirSync(dirname(dbPath), { recursive: true })

  return {
    host: '127.0.0.1',
    port,
    dbPath,
    rulesFilePath,
    allowedOrigins
  }
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid SYNCSPACE_COLLECTOR_PORT value: ${value}`)
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
