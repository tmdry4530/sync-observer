import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ActivityAction, ActivityEvent, ActivityStatus } from '../../../shared/types/activityEvent'
import { fetchTree, type TreeNode, type TreeResponse } from '../collectorClient'
import { usePolledResource } from './usePolledResource'

/**
 * File-tree activity overlay (see .monitor-filetree-spec.md §B–C).
 *
 * Polls GET /api/tree every 3s for the directory structure, then merges the live
 * activity event stream into a Map<absPath, NodeState> overlay that decays back to
 * idle after 8s. The "current" file (most recently touched) is derived separately.
 *
 * The overlay is rebuilt from scratch on every events change (useMemo) rather than
 * incrementally: useActivityStream caps + drops old events, so a full recompute is
 * the only way to stay consistent. The decay timer mutates a ref and triggers at
 * most one re-render per second (guarded by a `changed` flag).
 */

export type NodeActivityKind =
  | 'idle'
  | 'read'
  | 'write' // write or edit
  | 'grep' // grep or glob or search
  | 'bash'
  | 'blocked' // status === 'blocked' || 'cancelled'
  | 'current' // most recently touched file (at most one at a time)

export interface NodeState {
  kind: NodeActivityKind
  lastTs: number // Date.now()-equivalent of the last event ts
  count: number // cumulative touch count this session
  blocked: boolean // ever blocked/cancelled
  started: boolean // has an unresolved 'started' event
}

/** Map key = absolute path (from event.paths or tree.path). */
export type OverlayMap = Map<string, NodeState>

const MAX_EVENTS = 1000 // mirror useActivityStream's cap
const DECAY_MS = 8000
const POLL_MS = 3000

function actionToKind(action: ActivityAction, status: ActivityStatus): NodeActivityKind {
  if (status === 'blocked' || status === 'cancelled') return 'blocked'
  switch (action) {
    case 'read':
      return 'read'
    case 'edit':
    case 'write':
      return 'write'
    case 'grep':
    case 'glob':
    case 'search':
      return 'grep'
    case 'bash':
      return 'bash'
    default:
      return 'idle'
  }
}

function applyEvent(map: OverlayMap, event: ActivityEvent): void {
  const ts = new Date(event.ts).getTime()
  const safeTs = Number.isFinite(ts) ? ts : Date.now()
  const kind = actionToKind(event.action, event.status)
  for (const p of event.paths) {
    const prev = map.get(p)
    map.set(p, {
      kind,
      lastTs: safeTs,
      count: (prev?.count ?? 0) + 1,
      blocked: (prev?.blocked ?? false) || kind === 'blocked',
      started: event.status === 'started'
    })
  }
}

/** Rebuild the overlay from the (capped) events list. */
function recomputeOverlay(events: ActivityEvent[]): OverlayMap {
  const map: OverlayMap = new Map()
  const slice = events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events
  for (const ev of slice) applyEvent(map, ev)
  return map
}

/** The single most-recently-touched file path, or null. */
function findCurrentPath(map: OverlayMap): string | null {
  let best: string | null = null
  let bestTs = 0
  for (const [p, state] of map) {
    if (state.lastTs > bestTs) {
      bestTs = state.lastTs
      best = p
    }
  }
  return best
}

export interface FileTreeState {
  root: string | null
  tree: TreeNode[]
  overlay: OverlayMap
  currentPath: string | null
  loading: boolean
  error: string | null
  capped: boolean
  selectedPath: string | null
  setSelectedPath: (p: string | null) => void
}

export function useFileTree(events: ActivityEvent[]): FileTreeState {
  const fetcher = useCallback((signal: AbortSignal) => fetchTree(signal), [])
  const { data, error, loading, reload } = usePolledResource<TreeResponse>(fetcher, POLL_MS)

  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  // A 1s "decay tick" so the overlay (and the dir-summary memos keyed on its
  // identity) recompute as nodes age out — without mutating a cached Map in place
  // (the earlier in-place-mutation version left the `overlay` reference unchanged
  // on decay, so dir summaries never recomputed) and without a setState-from-
  // derived sync effect (that looped when `events` changed reference each render).
  const [decayTick, setDecayTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setDecayTick((t) => (t + 1) % 1_000_000), 1000)
    return () => clearInterval(timer)
  }, [])

  // Overlay is a pure function of (events, now): rebuild from the capped event
  // list, then idle-out any node older than DECAY_MS (blocked nodes never decay).
  // The decayTick dep drives the periodic recompute, yielding a fresh Map each
  // second so consumers (and FileTreeNode's child-kind memo) update on decay.
  const overlay = useMemo(() => {
    const map = recomputeOverlay(events)
    const now = Date.now()
    for (const [p, state] of map) {
      if (state.kind !== 'idle' && !state.blocked && now - state.lastTs > DECAY_MS) {
        map.set(p, { ...state, kind: 'idle' })
      }
    }
    return map
  }, [events, decayTick])

  const currentPath = useMemo(() => findCurrentPath(overlay), [overlay])

  // When a touched path falls outside the current scanned root, the tree is stale —
  // trigger an immediate out-of-cycle refetch instead of waiting for the 3s poll.
  const root = data?.root ?? null
  useEffect(() => {
    if (!currentPath) return
    if (root === null) {
      reload()
      return
    }
    const rootWithSep = root.endsWith('/') ? root : root + '/'
    if (currentPath !== root && !currentPath.startsWith(rootWithSep)) reload()
  }, [currentPath, root, reload])

  return {
    root,
    tree: data?.tree ?? [],
    overlay,
    currentPath,
    loading,
    error,
    capped: data?.capped ?? false,
    selectedPath,
    setSelectedPath
  }
}

// ---------------------------------------------------------------------------
// Directory-summary helper (shared with FileTreeNode rendering).
// A directory's effective kind = highest-priority kind among recursive children.
// ---------------------------------------------------------------------------

export const KIND_PRIORITY: Record<NodeActivityKind, number> = {
  blocked: 6,
  current: 5,
  write: 4,
  read: 3,
  grep: 2,
  bash: 1,
  idle: 0
}

/** Highest-priority activity kind among a node's recursive children (dir summary). */
export function computeChildKind(node: TreeNode, overlay: OverlayMap): NodeActivityKind {
  if (node.type !== 'dir' || !node.children || node.children.length === 0) return 'idle'
  let best: NodeActivityKind = 'idle'
  for (const child of node.children) {
    const direct = overlay.get(child.path)?.kind ?? 'idle'
    const childKind = child.type === 'dir' ? computeChildKind(child, overlay) : 'idle'
    const candidate = KIND_PRIORITY[childKind] > KIND_PRIORITY[direct] ? childKind : direct
    if (KIND_PRIORITY[candidate] > KIND_PRIORITY[best]) best = candidate
  }
  return best
}
