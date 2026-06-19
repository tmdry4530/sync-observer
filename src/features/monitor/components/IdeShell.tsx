import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode
} from 'react'

/**
 * IDE-shell layout (see .monitor-filetree-spec.md "IDE SHELL CSS").
 *
 * CSS grid: [sidebar] [1px resizer] [main]. The resizer drags the sidebar
 * between MIN..MAX px; the width is held in a ref during the drag and committed
 * to state only on pointerup (avoids a re-render per pixel). Keyboard resize
 * nudges by 10px / jumps to min/max. On mobile the sidebar becomes a slide-over
 * drawer toggled by a hamburger and dismissed via backdrop tap or Escape.
 */

const MIN_WIDTH = 160
const MAX_WIDTH = 360
const KEY_STEP = 10

function clampWidth(w: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w))
}

interface IdeShellProps {
  sidebar: ReactNode
  sidebarWidth: number
  onSidebarResize: (w: number) => void
  children: ReactNode
}

export function IdeShell({ sidebar, sidebarWidth, onSidebarResize, children }: IdeShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [liveWidth, setLiveWidth] = useState(sidebarWidth)
  const draggingRef = useRef(false)

  // Keep the live width in sync when the committed width changes externally.
  useEffect(() => {
    if (!draggingRef.current) setLiveWidth(sidebarWidth)
  }, [sidebarWidth])

  const startResize = useCallback(
    (e: PointerEvent<HTMLDivElement>): void => {
      e.preventDefault()
      draggingRef.current = true
      const handle = e.currentTarget
      handle.setPointerCapture(e.pointerId)

      const onMove = (ev: globalThis.PointerEvent): void => {
        if (!draggingRef.current) return
        setLiveWidth(clampWidth(ev.clientX))
      }
      const onUp = (ev: globalThis.PointerEvent): void => {
        draggingRef.current = false
        const committed = clampWidth(ev.clientX)
        setLiveWidth(committed)
        onSidebarResize(committed)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [onSidebarResize]
  )

  const handleResizerKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): void => {
      let next: number | null = null
      switch (e.key) {
        case 'ArrowLeft':
          next = clampWidth(sidebarWidth - KEY_STEP)
          break
        case 'ArrowRight':
          next = clampWidth(sidebarWidth + KEY_STEP)
          break
        case 'Home':
          next = MIN_WIDTH
          break
        case 'End':
          next = MAX_WIDTH
          break
        default:
          return
      }
      e.preventDefault()
      setLiveWidth(next)
      onSidebarResize(next)
    },
    [sidebarWidth, onSidebarResize]
  )

  // Close the mobile drawer on Escape.
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  return (
    <div
      className="ide-shell"
      style={{ '--sidebar-w': `${liveWidth}px` } as CSSProperties}
    >
      <button
        type="button"
        className="ide-drawer-toggle"
        aria-label="파일 트리 열기"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
      >
        ☰ 파일 트리
      </button>

      {drawerOpen ? (
        <div
          className="ide-drawer-backdrop"
          aria-hidden="true"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}

      <aside
        className={`ide-sidebar${drawerOpen ? ' ide-sidebar--open' : ''}`}
        aria-label="파일 트리"
      >
        {sidebar}
      </aside>

      <div
        className="ide-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={sidebarWidth}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-label="사이드바 너비 조절"
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={handleResizerKey}
      />

      <main className="ide-main">{children}</main>
    </div>
  )
}
