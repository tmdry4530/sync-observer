import {
  existsSync,
  readFileSync,
  renameSync,
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { CollectorRule, RuleInput, RuleKind } from './store.js'

/**
 * Plugin rules-file projection (M2 §2).
 *
 * The hermes plugin (hermes-plugin/syncspace_monitor/rules.py) reads its rules
 * from a JSON file at SYNCSPACE_RULES_FILE and hot-reloads on mtime change. Its
 * exact contract is:
 *   {"rules":[{"id","kind":"allow|deny","glob","scope","enabled"}]}
 * Only those five fields are emitted (createdAt/updatedAt are control-plane only).
 *
 * Writes MUST be atomic (temp file + rename) so the plugin — which may read at
 * any moment from another process — never observes a half-written file.
 */

/** The on-disk projection of a single rule (plugin contract — exactly 5 fields). */
export interface PluginRule {
  id: string
  kind: RuleKind
  glob: string
  scope: string
  enabled: boolean
}

interface PluginRulesFile {
  rules: PluginRule[]
}

/** Project a control-plane rule down to the plugin's on-disk shape. */
function toPluginRule(rule: CollectorRule): PluginRule {
  return {
    id: rule.id,
    kind: rule.kind,
    glob: rule.glob,
    scope: rule.scope || 'global',
    enabled: rule.enabled
  }
}

/**
 * Atomically write the rules file in the plugin's exact format.
 * Temp file is created in the same directory so rename is a same-filesystem
 * atomic operation.
 */
export function writeRulesFile(path: string, rules: CollectorRule[]): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const payload: PluginRulesFile = { rules: rules.map(toPluginRule) }
  const data = `${JSON.stringify(payload, null, 2)}\n`
  const tmpPath = join(dir, `.rules.${process.pid}.${Date.now()}.tmp`)
  // fsync the temp file before the rename so the bytes are durably on disk; a
  // crash after rename must never expose an empty/truncated rules file to the
  // plugin (which trusts this file as its security ruleset).
  const fd = openSync(tmpPath, 'w')
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, path)
  // Best-effort dir fsync so the rename itself is durable across a crash. Not all
  // platforms allow opening a directory for fsync; the rename is already atomic
  // for content, so a failure here is non-fatal.
  try {
    const dirFd = openSync(dir, 'r')
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  } catch {
    // directory fsync unsupported (e.g. some platforms) — content rename stands.
  }
}

/**
 * Parse the rules file into RuleInput records for seeding the table. Tolerates a
 * missing or corrupt file by returning []. Invalid rows are skipped (same
 * leniency as the plugin's _coerce_rule).
 */
export function readRulesFile(path: string): RuleInput[] {
  if (!existsSync(path)) return []
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!data || typeof data !== 'object') return []
  const rawRules = (data as { rules?: unknown }).rules
  if (!Array.isArray(rawRules)) return []
  const out: RuleInput[] = []
  for (const item of rawRules) {
    const coerced = coerceRule(item)
    if (coerced) out.push(coerced)
  }
  return out
}

function coerceRule(raw: unknown): RuleInput | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const id = obj.id
  const kind = obj.kind
  const glob = obj.glob
  if (typeof id !== 'string' || id.length === 0) return null
  if (kind !== 'allow' && kind !== 'deny') return null
  if (typeof glob !== 'string' || glob.length === 0) return null
  const scope = typeof obj.scope === 'string' && obj.scope.length > 0 ? obj.scope : 'global'
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : Boolean(obj.enabled ?? true)
  return { id, kind, glob, scope, enabled }
}
