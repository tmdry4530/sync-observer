import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { TreeNode } from '../collectorClient'
import type { OverlayMap } from '../hooks/useFileTree'
import { FileTreeNode } from './FileTreeNode'

/**
 * Accessible file tree (see .monitor-filetree-spec.md §C, §E).
 *
 * role=tree with roving tabindex over treeitems and full arrow-key navigation.
 * Expansion is owned here as a `collapsedPaths` set so the flat visible list
 * (used for ArrowUp/Down/Home/End) stays in sync, and so the current file's
 * ancestors can be auto-revealed one-way (removed from collapsedPaths).
 *
 * NOTE: node:path is NOT available in the browser — these are tiny string
 * helpers, not the node module.
 */

/** Last path segment, e.g. "/a/b/c" → "c". */
function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}

/**
 * Ancestor directory paths of `path` between (exclusive) `root` and (exclusive)
 * `path` itself — the dirs that must be expanded to reveal `path`.
 */
function getAncestors(path: string, root: string | null): string[] {
  const out: string[] = []
  let cur = path
  // Walk up by stripping the trailing segment.
  for (;;) {
    const slash = cur.lastIndexOf('/')
    if (slash <= 0) break
    cur = cur.slice(0, slash)
    if (root && (cur === root || !cur.startsWith(root))) break
    out.push(cur)
  }
  return out
}

interface FlatNode {
  node: TreeNode
  depth: number
}

/** Depth-first walk producing only currently-visible nodes (respecting collapse). */
function flatten(tree: TreeNode[], collapsed: ReadonlySet<string>): FlatNode[] {
  const out: FlatNode[] = []
  const walk = (nodes: TreeNode[], depth: number): void => {
    for (const node of nodes) {
      out.push({ node, depth })
      if (node.type === 'dir' && node.children && !collapsed.has(node.path)) {
        walk(node.children, depth + 1)
      }
    }
  }
  walk(tree, 0)
  return out
}

interface FileTreeProps {
  tree: TreeNode[]
  overlay: OverlayMap
  currentPath: string | null
  selectedPath: string | null
  onSelect: (path: string) => void
  capped: boolean
  root: string | null
}

export function FileTree({
  tree,
  overlay,
  currentPath,
  selectedPath,
  onSelect,
  capped,
  root
}: FileTreeProps) {
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set())
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const refs = useRef<Map<string, HTMLDivElement>>(new Map())

  const registerRef = useCallback((path: string, el: HTMLDivElement | null): void => {
    if (el) refs.current.set(path, el)
    else refs.current.delete(path)
  }, [])

  const flat = useMemo(() => flatten(tree, collapsedPaths), [tree, collapsedPaths])

  // Auto-reveal: when currentPath changes, un-collapse its ancestors (one-way).
  useEffect(() => {
    if (!currentPath) return
    const ancestors = getAncestors(currentPath, root)
    if (ancestors.length === 0) return
    setCollapsedPaths((prev) => {
      if (!ancestors.some((a) => prev.has(a))) return prev
      const next = new Set(prev)
      for (const a of ancestors) next.delete(a)
      return next
    })
  }, [currentPath, root])

  // Keep a valid roving-tabindex target. Default to the first visible node.
  useEffect(() => {
    if (flat.length === 0) {
      if (focusedPath !== null) setFocusedPath(null)
      return
    }
    if (focusedPath === null || !flat.some((f) => f.node.path === focusedPath)) {
      setFocusedPath(flat[0]!.node.path)
    }
  }, [flat, focusedPath])

  const toggleExpand = useCallback((path: string): void => {
    setCollapsedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const focusPath = useCallback((path: string): void => {
    setFocusedPath(path)
    refs.current.get(path)?.focus()
  }, [])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, node: TreeNode): void => {
      const idx = flat.findIndex((f) => f.node.path === node.path)
      if (idx < 0) return
      const isDir = node.type === 'dir'
      const collapsed = collapsedPaths.has(node.path)

      switch (event.key) {
        case 'ArrowDown': {
          event.preventDefault()
          const next = flat[Math.min(idx + 1, flat.length - 1)]
          if (next) focusPath(next.node.path)
          break
        }
        case 'ArrowUp': {
          event.preventDefault()
          const prev = flat[Math.max(idx - 1, 0)]
          if (prev) focusPath(prev.node.path)
          break
        }
        case 'ArrowRight': {
          event.preventDefault()
          if (isDir && collapsed) {
            toggleExpand(node.path) // expand
          } else if (isDir) {
            const next = flat[idx + 1] // move to first child
            if (next) focusPath(next.node.path)
          }
          break
        }
        case 'ArrowLeft': {
          event.preventDefault()
          if (isDir && !collapsed) {
            toggleExpand(node.path) // collapse
          } else {
            // Move to parent: nearest preceding node at a shallower depth.
            const myDepth = flat[idx]!.depth
            for (let i = idx - 1; i >= 0; i--) {
              if (flat[i]!.depth < myDepth) {
                focusPath(flat[i]!.node.path)
                break
              }
            }
          }
          break
        }
        case 'Home': {
          event.preventDefault()
          if (flat[0]) focusPath(flat[0].node.path)
          break
        }
        case 'End': {
          event.preventDefault()
          const last = flat[flat.length - 1]
          if (last) focusPath(last.node.path)
          break
        }
        case 'Enter':
        case ' ': {
          event.preventDefault()
          if (isDir) toggleExpand(node.path)
          onSelect(node.path)
          break
        }
        default:
          break
      }
    },
    [flat, collapsedPaths, focusPath, toggleExpand, onSelect]
  )

  return (
    <div className="file-tree" role="tree" aria-label="에이전트 활동 파일 트리">
      {root ? (
        <div className="file-tree-root-label">
          <span className="file-tree-root-name" title={root}>
            {basename(root)}
          </span>
        </div>
      ) : null}

      {tree.length === 0 ? (
        <p className="file-tree-empty" role="note">
          에이전트가 아직 파일을 접근하지 않았습니다.
        </p>
      ) : (
        tree.map((node, i) => (
          <FileTreeNode
            key={node.path}
            node={node}
            overlay={overlay}
            currentPath={currentPath}
            selectedPath={selectedPath}
            onSelect={onSelect}
            collapsedPaths={collapsedPaths}
            onToggleExpand={toggleExpand}
            focusedPath={focusedPath}
            registerRef={registerRef}
            onKeyDown={handleKeyDown}
            depth={0}
            setSize={tree.length}
            posInSet={i + 1}
          />
        ))
      )}

      {capped ? (
        <p className="file-tree-cap-note" role="note">
          트리가 너무 커서 일부 항목이 숨겨졌습니다.
        </p>
      ) : null}
    </div>
  )
}
