import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { TreeNode } from '../collectorClient'
import {
  computeChildKind,
  type NodeActivityKind,
  type OverlayMap
} from '../hooks/useFileTree'

/**
 * One recursive tree node (see .monitor-filetree-spec.md §C, §D).
 *
 * Activity state is read from the overlay map (direct touch) and from the
 * directory-summary helper (highest-priority child kind). Expansion is fully
 * controlled by the parent FileTree (a `collapsedPaths` set is the single source
 * of truth) so the parent can compute the flat visible list for arrow-key
 * navigation and drive one-way auto-reveal of the current file's ancestors.
 * Keyboard handling is delegated to the parent.
 */

const KIND_KR: Record<NodeActivityKind, string> = {
  idle: '',
  read: '읽기',
  write: '쓰기',
  grep: '검색',
  bash: '명령',
  blocked: '차단됨',
  current: '현재 파일'
}

/** Text glyphs only (no emoji) for stable cross-platform rendering. */
function fileIcon(name: string): string {
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return '⟨/⟩'
    case 'json':
      return '{ }'
    case 'md':
      return '¶'
    case 'css':
      return '#'
    case 'py':
      return '🐍'
    case 'sh':
      return '$'
    default:
      return '◻'
  }
}

const BLOCKED_STALE_MS = 30_000

export interface FileTreeNodeProps {
  node: TreeNode
  overlay: OverlayMap
  currentPath: string | null
  selectedPath: string | null
  onSelect: (path: string) => void
  /** Dir paths that are collapsed (single source of truth, owned by FileTree). */
  collapsedPaths: ReadonlySet<string>
  onToggleExpand: (path: string) => void
  /** The path that currently owns tabIndex=0 (roving tabindex). */
  focusedPath: string | null
  registerRef: (path: string, el: HTMLDivElement | null) => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, node: TreeNode) => void
  depth: number
  setSize: number
  posInSet: number
}

export function FileTreeNode({
  node,
  overlay,
  currentPath,
  selectedPath,
  onSelect,
  collapsedPaths,
  onToggleExpand,
  focusedPath,
  registerRef,
  onKeyDown,
  depth,
  setSize,
  posInSet
}: FileTreeNodeProps) {
  const isDir = node.type === 'dir'
  const expanded = isDir && !collapsedPaths.has(node.path)

  const childKind = useMemo(() => computeChildKind(node, overlay), [node, overlay])
  const directState = overlay.get(node.path)
  const baseKind = directState?.kind ?? (childKind !== 'idle' ? childKind : 'idle')
  const isCurrent = node.path === currentPath
  const isSelected = node.path === selectedPath
  const isBlocked = (directState?.blocked ?? false) || baseKind === 'blocked'
  const effectiveKind: NodeActivityKind = isCurrent ? 'current' : baseKind
  const count = directState?.count ?? 0

  const stale = isBlocked && directState != null && Date.now() - directState.lastTs > BLOCKED_STALE_MS

  // Flash when a node transitions idle → active.
  const prevKindRef = useRef<NodeActivityKind>('idle')
  const [flash, setFlash] = useState(false)
  useEffect(() => {
    if (prevKindRef.current === 'idle' && baseKind !== 'idle') {
      setFlash(true)
      const t = setTimeout(() => setFlash(false), 600)
      prevKindRef.current = baseKind
      return () => clearTimeout(t)
    }
    prevKindRef.current = baseKind
    return undefined
  }, [baseKind])

  const handleRef = (el: HTMLDivElement | null): void => registerRef(node.path, el)

  const handleClick = (): void => {
    if (isDir) onToggleExpand(node.path)
    onSelect(node.path)
  }

  const kindClass = `file-tree-node--${effectiveKind}`
  const flashClass = flash ? ' file-tree-node--flash' : ''
  const selectedClass = isSelected ? ' file-tree-node--selected' : ''
  const srStatus = isCurrent ? KIND_KR.current : effectiveKind !== 'idle' ? KIND_KR[effectiveKind] : ''

  return (
    <>
      <div
        ref={handleRef}
        role="treeitem"
        aria-expanded={isDir ? expanded : undefined}
        aria-selected={isSelected}
        aria-level={depth + 1}
        aria-setsize={setSize}
        aria-posinset={posInSet}
        aria-label={`${node.name}${isBlocked ? ', 차단됨' : ''}${isCurrent ? ', 현재 파일' : ''}`}
        className={`file-tree-node ${kindClass}${selectedClass}${flashClass}`}
        data-stale={stale ? 'true' : undefined}
        style={{ '--depth': depth } as CSSProperties}
        tabIndex={focusedPath === node.path ? 0 : -1}
        onClick={handleClick}
        onKeyDown={(e) => onKeyDown(e, node)}
      >
        {depth > 0 ? <span className="file-tree-node-indent" aria-hidden="true" /> : null}
        <span className="file-tree-node-chevron" aria-hidden="true">
          {isDir ? (expanded ? '▾' : '▸') : ''}
        </span>
        <span className="file-tree-node-icon" aria-hidden="true">
          {isDir ? (expanded ? '📂' : '📁') : fileIcon(node.name)}
        </span>
        <span className="file-tree-node-name">{node.name}</span>
        {count > 0 ? (
          <span className="file-tree-node-badge" aria-label={`${count}회 접근`}>
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
        {isBlocked ? (
          <span className="file-tree-node-blocked-icon" aria-label="차단됨">
            🚫
          </span>
        ) : null}
        <span className="sr-only">{srStatus}</span>
      </div>

      {isDir && expanded && node.children && node.children.length > 0 ? (
        <div role="group">
          {node.children.map((child, i) => (
            <FileTreeNode
              key={child.path}
              node={child}
              overlay={overlay}
              currentPath={currentPath}
              selectedPath={selectedPath}
              onSelect={onSelect}
              collapsedPaths={collapsedPaths}
              onToggleExpand={onToggleExpand}
              focusedPath={focusedPath}
              registerRef={registerRef}
              onKeyDown={onKeyDown}
              depth={depth + 1}
              setSize={node.children!.length}
              posInSet={i + 1}
            />
          ))}
        </div>
      ) : null}
    </>
  )
}
