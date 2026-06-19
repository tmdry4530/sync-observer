import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

/**
 * Pure FS scan for the monitor file-tree (GET /api/tree).
 *
 * Computes the Longest-Common-Ancestor of every absolute path the agent has
 * touched (from the events table), caps shallow roots (/, /Users, $HOME, ...)
 * to avoid scanning the whole filesystem, then walks that root with a bounded
 * synchronous scan:
 *   - DEPTH_CAP relative to the root,
 *   - ENTRY_CAP total nodes across the whole tree,
 *   - EXCLUDED_NAMES (node_modules, .git, build dirs, ...) skipped,
 *   - hidden dotfiles skipped,
 *   - symlinks never followed off-root (realpath each entry; reject escapes).
 *
 * The activity-overlay fields (read/write/blocked/...) are NOT computed here —
 * the frontend derives them from the live event stream. This module produces
 * only the structural tree.
 */

export interface TreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: TreeNode[]
}

export interface TreeResult {
  // NOTE: always a string here. The frontend widens this to `string | null` and
  // synthesizes `root: null` on the 404 (no_paths) path — the null only ever
  // originates client-side, so don't "fix" the frontend type to non-null.
  root: string
  tree: TreeNode[]
  scannedAt: string
  capped: boolean
}

const EXCLUDED_NAMES = new Set([
  'node_modules', '.git', 'dist', '.venv', '__pycache__',
  'build', 'target', '.next', 'coverage', '.turbo',
  '.cache', 'out', '.nuxt', '.output', 'vendor'
])

const DEPTH_CAP = 6
const ENTRY_CAP = 400
// Hard ceiling on entries read from a SINGLE directory before we stop reading
// and sort. Bounds the cost of one pathological dir (e.g. a 500k-entry cache the
// exclusion list doesn't cover): without this, readdirSync + sort would walk the
// whole listing on the single-threaded collector before ENTRY_CAP could apply.
// Comfortably above any real project dir; hitting it sets capped=true.
const READ_CAP_PER_DIR = 4000

// Minimum path depth (segments after root '/') before a dir is "non-shallow".
// e.g. /Users/alice/proj has depth 3 on macOS → acceptable.
// /Users or / has depth 0-1 → too shallow.
const MIN_SAFE_DEPTH = 2

/** Compute the longest-common-ancestor of a list of absolute directory paths. */
export function computeLCA(dirs: string[]): string {
  if (dirs.length === 0) throw new Error('no_paths')
  if (dirs.length === 1) return dirs[0]!
  const split = dirs.map((d) => d.split(path.sep))
  let common = split[0]!
  for (let i = 1; i < split.length; i++) {
    const seg = split[i]!
    const next: string[] = []
    for (let j = 0; j < common.length && j < seg.length; j++) {
      if (common[j] === seg[j]) next.push(common[j]!)
      else break
    }
    common = next
  }
  const joined = common.join(path.sep)
  return joined || '/'
}

function pathDepth(p: string): number {
  return p.split(path.sep).filter(Boolean).length
}

export function isShallow(p: string): boolean {
  const HOME = os.homedir()
  const SHALLOW = new Set(['/', '/Users', '/home', '/root', HOME])
  return SHALLOW.has(p) || pathDepth(p) < MIN_SAFE_DEPTH
}

/**
 * Find the deepest directory containing >= 80% of the touched paths and not in
 * the shallow-root list. Returns null when no SAFE (non-shallow) root exists —
 * the caller must refuse to scan rather than fall back to a system dir.
 *
 * Security: the touched paths are agent-reported and thus attacker-influenceable.
 * The earlier `?? dirs[0]` fallback returned the first touched dir with no shallow
 * re-check, so a crafted set like ['/etc','/var','/usr'] resolved to '/etc' and
 * got scanned. We now only ever fall back to the deepest NON-shallow touched dir.
 */
export function findDeepestMajorityRoot(dirs: string[]): string | null {
  const counts = new Map<string, number>()
  for (const d of dirs) {
    // Walk up ancestors, counting each dir that contains this touched path.
    let cur = d
    while (cur !== path.dirname(cur)) {
      counts.set(cur, (counts.get(cur) ?? 0) + 1)
      cur = path.dirname(cur)
    }
  }
  const threshold = Math.ceil(dirs.length * 0.8)
  const candidates = [...counts.entries()]
    .filter(([p, c]) => c >= threshold && !isShallow(p))
    .sort(([a], [b]) => pathDepth(b) - pathDepth(a))
  if (candidates[0]) return candidates[0][0]
  // No majority ancestor is safe. Fall back to the deepest non-shallow touched
  // dir; if every touched dir is itself shallow, there is no safe root.
  const safe = dirs.filter((d) => !isShallow(d)).sort((a, b) => pathDepth(b) - pathDepth(a))
  return safe[0] ?? null
}

/**
 * Collect the distinct touched directories from the events table path arrays.
 * Each absolute path contributes its (realpath-normalized) parent directory.
 * Non-existent write targets fall back to their literal dirname.
 */
export function extractTouchedDirs(pathArrays: string[][]): string[] {
  // Dedup the raw input paths FIRST so we realpathSync each distinct path once.
  // getAllPaths can return the same path across many events; without this we'd do
  // O(total-events × paths) syscalls on every 3s poll.
  const rawPaths = new Set<string>()
  for (const paths of pathArrays) {
    for (const p of paths) {
      if (path.isAbsolute(p)) rawPaths.add(p)
    }
  }
  const dirs = new Set<string>()
  for (const p of rawPaths) {
    try {
      const real = fs.realpathSync(p, { encoding: 'utf8' })
      dirs.add(path.dirname(real))
    } catch {
      // Path doesn't exist yet (e.g. a write target) — use the literal dirname.
      dirs.add(path.dirname(p))
    }
  }
  return [...dirs]
}

export function buildTree(store: { getAllPaths(): string[][] }): TreeResult {
  const pathArrays = store.getAllPaths()
  const dirs = extractTouchedDirs(pathArrays)
  if (dirs.length === 0) {
    const err = new Error('no_paths') as Error & { code: string }
    err.code = 'no_paths'
    throw err
  }

  let root = computeLCA(dirs)
  if (isShallow(root)) {
    const safe = findDeepestMajorityRoot(dirs)
    // Re-assert the guard on the fallback: if no safe non-shallow root exists,
    // refuse to scan rather than walking a system dir like /etc.
    if (safe === null || isShallow(safe)) {
      const err = new Error('no_paths') as Error & { code: string }
      err.code = 'no_paths'
      throw err
    }
    root = safe
  }

  // Verify the root is accessible and normalize it to its realpath so the
  // symlink-escape guard below compares like-for-like.
  try {
    root = fs.realpathSync(root)
  } catch {
    const err = new Error('root_unreadable') as Error & { code: string }
    err.code = 'root_unreadable'
    throw err
  }

  const counter: ScanCounter = { value: 0, capped: false }
  const tree = scanDir(root, root, 0, counter)
  return {
    root,
    tree,
    scannedAt: new Date().toISOString(),
    capped: counter.capped || counter.value >= ENTRY_CAP
  }
}

interface ScanCounter {
  value: number
  capped: boolean
}

/**
 * Read up to READ_CAP_PER_DIR entries from one directory using opendirSync, so a
 * single pathological dir cannot stall the event loop on a huge readdirSync+sort
 * before the per-node ENTRY_CAP applies. Hitting the cap flags `counter.capped`.
 */
function readDirBounded(absDir: string, counter: ScanCounter): fs.Dirent[] {
  let dir: fs.Dir
  try {
    dir = fs.opendirSync(absDir)
  } catch {
    return []
  }
  const entries: fs.Dirent[] = []
  try {
    let ent = dir.readSync()
    while (ent !== null) {
      entries.push(ent)
      if (entries.length >= READ_CAP_PER_DIR) {
        counter.capped = true
        break
      }
      ent = dir.readSync()
    }
  } finally {
    dir.closeSync()
  }
  return entries
}

function scanDir(
  absDir: string,
  root: string,
  depth: number,
  counter: ScanCounter
): TreeNode[] {
  if (depth > DEPTH_CAP || counter.value >= ENTRY_CAP) return []
  const entries = readDirBounded(absDir, counter)

  // Dirs first, then files; alpha within each group.
  entries.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1
    const bDir = b.isDirectory() ? 0 : 1
    if (aDir !== bDir) return aDir - bDir
    return a.name.localeCompare(b.name)
  })

  const nodes: TreeNode[] = []
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  for (const entry of entries) {
    if (counter.value >= ENTRY_CAP) break
    if (entry.name.startsWith('.')) continue // hidden files skipped
    if (EXCLUDED_NAMES.has(entry.name)) continue

    const entryPath = path.join(absDir, entry.name)
    let real: string
    try {
      real = fs.realpathSync(entryPath)
    } catch {
      continue // broken symlink or permission denied
    }

    // Symlink-escape guard: the resolved path must stay within the root. An
    // entry whose realpath points outside root is skipped (not an error).
    if (real !== root && !real.startsWith(rootWithSep)) continue

    // Count only nodes we actually render. A symlink-to-dir reports
    // isDirectory()===false && isFile()===false (Dirent reflects the LINK), so it
    // matches neither branch and is intentionally dropped (symlinks are never
    // descended) — without this placement it would still consume cap budget.
    if (entry.isDirectory()) {
      counter.value++
      const children = scanDir(real, root, depth + 1, counter)
      nodes.push({ name: entry.name, path: real, type: 'dir', children })
    } else if (entry.isFile()) {
      counter.value++
      nodes.push({ name: entry.name, path: real, type: 'file' })
    }
  }
  return nodes
}
