import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildTree,
  computeLCA,
  extractTouchedDirs,
  findDeepestMajorityRoot,
  isShallow,
  type TreeNode
} from '../tree.js'
import { createCollectorServer, type CollectorServerHandle } from '../server.js'
import { readCollectorConfig } from '../config.js'
import { Router } from '../../http/router.js'
import { createCollectorStore } from '../store.js'
import { createEventHub } from '../hub.js'
import { registerCollectorRoutes } from '../routes.js'
import type { RequestContext } from '../../http/context.js'
import { isHttpError } from '../../http/errors.js'
import type { ActivityEvent } from '../activityEvent.js'

function s(...parts: string[]): string {
  return sep + parts.join(sep)
}

function validEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    v: 1,
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    ts: new Date().toISOString(),
    agentId: 'hermes:a',
    agentKind: 'hermes',
    sessionId: 'sess-1',
    taskId: null,
    turnId: null,
    action: 'read',
    tool: 'read_file',
    paths: ['/Users/me/project/config.ts'],
    status: 'success',
    cwd: '/Users/me/project',
    gitBranch: 'main',
    correlationId: 'corr-1',
    summary: 'read config.ts',
    detail: null,
    visibleToUser: true,
    ...overrides
  }
}

/** Flatten the tree into a set of basenames for easy membership assertions. */
function names(tree: TreeNode[]): Set<string> {
  const out = new Set<string>()
  const walk = (nodes: TreeNode[]): void => {
    for (const n of nodes) {
      out.add(n.name)
      if (n.children) walk(n.children)
    }
  }
  walk(tree)
  return out
}

function findNode(tree: TreeNode[], name: string): TreeNode | undefined {
  for (const n of tree) {
    if (n.name === name) return n
    if (n.children) {
      const found = findNode(n.children, name)
      if (found) return found
    }
  }
  return undefined
}

function maxDepth(tree: TreeNode[], depth = 1): number {
  let max = tree.length > 0 ? depth : 0
  for (const n of tree) {
    if (n.children && n.children.length > 0) {
      max = Math.max(max, maxDepth(n.children, depth + 1))
    }
  }
  return max
}

describe('computeLCA', () => {
  it('single path returns itself', () => {
    expect(computeLCA([s('Users', 'alice', 'proj')])).toBe(s('Users', 'alice', 'proj'))
  })

  it('two sibling dirs return their parent', () => {
    expect(computeLCA([s('Users', 'alice', 'proj', 'src'), s('Users', 'alice', 'proj', 'test')])).toBe(
      s('Users', 'alice', 'proj')
    )
  })

  it('unrelated paths return the common ancestor', () => {
    expect(computeLCA([s('Users', 'alice', 'a'), s('Users', 'alice', 'b', 'c')])).toBe(s('Users', 'alice'))
  })

  it('paths sharing only the FS root collapse to "/"', () => {
    expect(computeLCA([s('Users', 'alice'), s('opt', 'thing')])).toBe(sep)
  })

  it('empty array throws no_paths', () => {
    expect(() => computeLCA([])).toThrow('no_paths')
  })
})

describe('isShallow / findDeepestMajorityRoot', () => {
  it('/Users is shallow', () => {
    expect(isShallow('/Users')).toBe(true)
  })

  it('the home dir is shallow', () => {
    expect(isShallow(homedir())).toBe(true)
  })

  it('the FS root "/" is shallow', () => {
    expect(isShallow('/')).toBe(true)
  })

  it('/Users/alice/proj is NOT shallow', () => {
    expect(isShallow(s('Users', 'alice', 'proj'))).toBe(false)
  })

  it('fallback selects the deepest dir covering >= 80% of paths', () => {
    // 5 touched dirs: 4 under proj/, 1 elsewhere → proj covers 80%.
    const dirs = [
      s('Users', 'alice', 'proj', 'src'),
      s('Users', 'alice', 'proj', 'src', 'deep'),
      s('Users', 'alice', 'proj', 'test'),
      s('Users', 'alice', 'proj', 'docs'),
      s('Users', 'alice', 'other')
    ]
    expect(findDeepestMajorityRoot(dirs)).toBe(s('Users', 'alice', 'proj'))
  })

  it('returns null when every touched dir is shallow (no safe root)', () => {
    // Security: ['/etc','/var','/usr'] must NOT resolve to a system dir.
    expect(findDeepestMajorityRoot(['/etc', '/var', '/usr'])).toBeNull()
  })

  it('never falls back to a shallow system dir even when one is in the mix', () => {
    // No 80% majority ancestor exists, so the fallback engages — and it must pick
    // a deep non-shallow dir, never '/etc'. This closes the bypass where the old
    // `?? dirs[0]` returned the first touched dir with no shallow re-check.
    const root = findDeepestMajorityRoot([
      '/etc',
      s('Users', 'alice', 'proj', 'a'),
      s('Users', 'bob', 'proj', 'b')
    ])
    expect(root).not.toBe('/etc')
    expect(root).not.toBeNull()
    expect(isShallow(root!)).toBe(false)
  })
})

describe('extractTouchedDirs', () => {
  it('drops relative paths and dedups parents of absolute paths', () => {
    const dirs = extractTouchedDirs([
      [s('Users', 'me', 'proj', 'a.ts'), 'relative/skip.ts'],
      [s('Users', 'me', 'proj', 'b.ts')]
    ])
    // Non-existent paths fall back to literal dirname; both share proj.
    expect(dirs).toEqual([s('Users', 'me', 'proj')])
  })
})

describe('buildTree with a real tmp fixture dir', () => {
  let dir: string
  let root: string

  beforeEach(() => {
    // realpath because macOS /tmp → /private/tmp; buildTree realpaths the root,
    // so the touched paths must resolve to the same place.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tree-fixture-')))
    root = dir
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1\n')
    writeFileSync(join(dir, 'package.json'), '{}\n')
    // Excluded dirs (must not appear).
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'node_modules', 'leaked.js'), '//\n')
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: x\n')
    // Hidden dotfile (must be skipped).
    writeFileSync(join(dir, '.env'), 'SECRET=1\n')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function storeFor(pathArrays: string[][]): { getAllPaths(): string[][] } {
    return { getAllPaths: () => pathArrays }
  }

  it('returns { root, tree, scannedAt, capped } with the nested structure', () => {
    const result = buildTree(storeFor([[join(root, 'src', 'index.ts')], [join(root, 'package.json')]]))
    expect(result.root).toBe(root)
    expect(typeof result.scannedAt).toBe('string')
    expect(() => new Date(result.scannedAt).toISOString()).not.toThrow()
    expect(result.capped).toBe(false)

    const src = findNode(result.tree, 'src')
    expect(src?.type).toBe('dir')
    expect(src?.path).toBe(join(root, 'src'))
    const index = findNode(result.tree, 'index.ts')
    expect(index?.type).toBe('file')
    expect(index?.path).toBe(join(root, 'src', 'index.ts'))
    expect(names(result.tree).has('package.json')).toBe(true)
  })

  it('excludes node_modules and .git', () => {
    const result = buildTree(storeFor([[join(root, 'src', 'index.ts')]]))
    const all = names(result.tree)
    expect(all.has('node_modules')).toBe(false)
    expect(all.has('.git')).toBe(false)
    expect(all.has('leaked.js')).toBe(false)
  })

  it('skips hidden dotfiles', () => {
    const result = buildTree(storeFor([[join(root, 'src', 'index.ts')]]))
    expect(names(result.tree).has('.env')).toBe(false)
  })

  it('respects ENTRY_CAP → sets capped=true', () => {
    const bulk = join(dir, 'bulk')
    mkdirSync(bulk)
    for (let i = 0; i < 410; i++) {
      writeFileSync(join(bulk, `f${i}.txt`), '\n')
    }
    const result = buildTree(storeFor([[join(bulk, 'f0.txt')]]))
    expect(result.capped).toBe(true)
  })

  it('respects DEPTH_CAP (does not descend past 6 levels below root)', () => {
    // Build root/d1/d2/.../d8 with a marker file at the bottom.
    let cur = dir
    for (let i = 1; i <= 8; i++) {
      cur = join(cur, `d${i}`)
      mkdirSync(cur)
    }
    writeFileSync(join(cur, 'deep.txt'), '\n')
    // Touch a file at the fixture ROOT so the LCA stays at `root` (otherwise the
    // single deep path would pull the root down and reset the depth count).
    const result = buildTree(storeFor([[join(root, 'package.json')]]))
    // The deepest marker file lives 9 levels below root → beyond DEPTH_CAP=6,
    // so it must be absent. scanDir bails when depth > DEPTH_CAP (6), so the
    // last rendered level is depth 6 → at most 7 visible levels below the root.
    expect(names(result.tree).has('deep.txt')).toBe(false)
    expect(names(result.tree).has('d8')).toBe(false)
    // DEPTH_CAP=6 → at most 7 (cap + 1) visible levels below the root.
    expect(maxDepth(result.tree)).toBeLessThanOrEqual(7)
  })

  it('symlink escape returns an empty subtree (not an error)', () => {
    // A symlink whose target is OUTSIDE the root must be skipped entirely.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'tree-outside-')))
    writeFileSync(join(outside, 'secret.txt'), 'do not leak\n')
    try {
      symlinkSync(outside, join(dir, 'escape'))
      // Two touched paths under the fixture root keep the LCA at `root`, so the
      // escape symlink (a child of root) is actually scanned and then rejected.
      const result = buildTree(
        storeFor([[join(root, 'src', 'index.ts')], [join(root, 'package.json')]])
      )
      const all = names(result.tree)
      expect(all.has('escape')).toBe(false)
      expect(all.has('secret.txt')).toBe(false)
      // The rest of the tree is intact.
      expect(all.has('src')).toBe(true)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('throws no_paths when the store has no usable paths', () => {
    expect(() => buildTree(storeFor([[], ['relative/only.ts']]))).toThrow('no_paths')
  })

  it('refuses to scan when all touched paths sit in shallow system dirs', () => {
    // Non-existent paths → literal dirnames /etc, /var, /usr (all shallow). The
    // LCA collapses to '/', the fallback finds no safe root → no_paths, so a
    // crafted shallow-path set can never make the collector scan /etc.
    expect(() =>
      buildTree(
        storeFor([
          ['/etc/syncspace_nonexistent_xyz'],
          ['/var/syncspace_nonexistent_xyz'],
          ['/usr/syncspace_nonexistent_xyz']
        ])
      )
    ).toThrow('no_paths')
  })
})

describe('GET /api/tree integration', () => {
  let server: CollectorServerHandle
  let baseUrl: string
  let dir: string
  let fixture: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tree-server-'))
    fixture = realpathSync(mkdtempSync(join(tmpdir(), 'tree-proj-')))
    mkdirSync(join(fixture, 'src'))
    writeFileSync(join(fixture, 'src', 'index.ts'), 'export const x = 1\n')
    writeFileSync(join(fixture, 'README.md'), '# hi\n')

    server = createCollectorServer({
      config: readCollectorConfig({
        SYNCSPACE_COLLECTOR_PORT: '0',
        SYNCSPACE_DB_PATH: join(dir, 'collector.db'),
        SYNCSPACE_RULES_FILE: join(dir, 'rules.json')
      })
    })
    const address = (await server.start()) as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
    rmSync(fixture, { recursive: true, force: true })
  })

  it('returns 404 { code: no_paths } when the store has no events', async () => {
    const res = await fetch(`${baseUrl}/api/tree`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      code: 'no_paths',
      message: '에이전트가 아직 파일을 접근하지 않았습니다.'
    })
  })

  it('returns 200 with a nested tree after ingesting an event whose path is inside a tmp fixture', async () => {
    // Touch one nested + one root-level path so the LCA resolves to `fixture`
    // (a single nested path would pull the root down to `fixture/src`).
    await fetch(`${baseUrl}/ingest/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        validEvent({
          eventId: 'tree-1',
          paths: [join(fixture, 'src', 'index.ts'), join(fixture, 'README.md')]
        })
      )
    })

    const res = await fetch(`${baseUrl}/api/tree`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      root: string
      tree: TreeNode[]
      scannedAt: string
      capped: boolean
    }
    expect(body.root).toBe(fixture)
    expect(body.capped).toBe(false)
    expect(typeof body.scannedAt).toBe('string')

    const src = findNode(body.tree, 'src')
    expect(src?.type).toBe('dir')
    const index = findNode(body.tree, 'index.ts')
    expect(index).toMatchObject({
      name: 'index.ts',
      path: join(fixture, 'src', 'index.ts'),
      type: 'file'
    })
    expect(names(body.tree).has('README.md')).toBe(true)
  })

  it('rejects an off-loopback caller with 403 not_loopback', async () => {
    // We cannot bind a real off-host client in a unit test, so invoke the
    // matched handler directly with a fabricated non-loopback context.
    const router = new Router()
    const store = createCollectorStore(':memory:')
    const hub = createEventHub()
    registerCollectorRoutes(router, { store, hub, rulesFilePath: ':memory:', allowedOrigins: ['*'] })

    const headers: Record<string, string> = {}
    const ctx: RequestContext = {
      req: { socket: { remoteAddress: '203.0.113.7' }, headers, on: () => undefined } as never,
      res: { writeHead: () => undefined, end: () => undefined, write: () => undefined, on: () => undefined } as never,
      method: 'GET',
      url: new URL('http://127.0.0.1/api/tree'),
      pathname: '/api/tree',
      query: new URLSearchParams(),
      params: {},
      cookies: {},
      ip: '203.0.113.7',
      auth: null,
      rawBody: async () => Buffer.alloc(0),
      json: async () => ({}) as never,
      header: (name: string) => headers[name.toLowerCase()] ?? null
    }

    const match = router.match('GET', '/api/tree')!
    await expect(async () => match.handler(ctx)).rejects.toSatisfy((err: unknown) => {
      return isHttpError(err) && err.code === 'not_loopback' && err.status === 403
    })
    store.close()
  })
})
