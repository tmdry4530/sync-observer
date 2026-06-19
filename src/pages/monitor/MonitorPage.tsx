import { useState } from 'react'
import { LiveEventFeed } from '../../features/monitor/components/LiveEventFeed'
import { Dashboard } from '../../features/monitor/components/Dashboard'
import { Timeline } from '../../features/monitor/components/Timeline'
import { InterventionsLog } from '../../features/monitor/components/InterventionsLog'
import { RulesManager } from '../../features/monitor/components/RulesManager'
import { ManualInterrupt } from '../../features/monitor/components/ManualInterrupt'
import { IdeShell } from '../../features/monitor/components/IdeShell'
import { FileTree } from '../../features/monitor/components/FileTree'
import { useActivityStream } from '../../features/monitor/hooks/useActivityStream'
import { useFileTree } from '../../features/monitor/hooks/useFileTree'
import '../../styles/apple/monitor.css'
import '../../styles/apple/filetree.css'

/**
 * Standalone local monitor page. Lives OUTSIDE the workspace/auth shell — the
 * hermes-monitor pivot has no auth; it's a single-user localhost tool.
 *
 * Layout is an IDE shell: a persistent file-tree sidebar (agent activity overlay)
 * plus the existing six tab panels in the right pane. The live activity stream is
 * opened ONCE here and shared with both the file-tree overlay and the live feed
 * (no double SSE). Selecting a tree node filters the right-pane views by path.
 */

type Tab = 'dashboard' | 'feed' | 'timeline' | 'interventions' | 'rules' | 'interrupt'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'dashboard', label: '대시보드' },
  { id: 'feed', label: '활동' },
  { id: 'timeline', label: '타임라인' },
  { id: 'interventions', label: '개입' },
  { id: 'rules', label: '규칙' },
  { id: 'interrupt', label: '중지' }
]

function readSidebarWidth(): number {
  const raw = Number(localStorage.getItem('monitor-sidebar-width'))
  // Number(null)===0 and Number('garbage')===NaN both fall through to the default.
  // Clamp valid values into IdeShell's [MIN_WIDTH, MAX_WIDTH] = [160, 360] range so
  // a stale/out-of-range stored width can't render an oversized initial sidebar.
  if (!Number.isFinite(raw) || raw <= 0) return 220
  return Math.min(360, Math.max(160, raw))
}

export function MonitorPage() {
  const [tab, setTab] = useState<Tab>('dashboard')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState<number>(readSidebarWidth)

  // Single SSE subscription, shared with the file-tree overlay + the live feed.
  const { events, status } = useActivityStream()
  const fileTree = useFileTree(events)
  const { selectedPath, setSelectedPath } = fileTree

  const openSession = (id: string): void => {
    setSessionId(id)
    setTab('timeline')
  }

  const handleSidebarResize = (w: number): void => {
    setSidebarWidth(w)
    localStorage.setItem('monitor-sidebar-width', String(w))
  }

  const clearFilter = (): void => setSelectedPath(null)

  return (
    <IdeShell
      sidebar={
        <FileTree
          tree={fileTree.tree}
          overlay={fileTree.overlay}
          currentPath={fileTree.currentPath}
          selectedPath={selectedPath}
          onSelect={setSelectedPath}
          capped={fileTree.capped}
          root={fileTree.root}
        />
      }
      sidebarWidth={sidebarWidth}
      onSidebarResize={handleSidebarResize}
    >
      <div className="monitor-page monitor-page--ide">
        <nav className="monitor-tabs" role="tablist" aria-label="모니터 화면">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`monitor-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`monitor-panel-${t.id}`}
              className={`monitor-tab${tab === t.id ? ' monitor-tab--active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div
          id={`monitor-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`monitor-tab-${tab}`}
          className="monitor-panel"
        >
          {tab === 'dashboard' ? <Dashboard onSelectSession={openSession} /> : null}
          {tab === 'feed' ? (
            <LiveEventFeed
              events={events}
              status={status}
              pathFilter={selectedPath}
              onClearFilter={clearFilter}
            />
          ) : null}
          {tab === 'timeline' ? (
            <Timeline
              sessionId={sessionId}
              onSelectSession={setSessionId}
              pathFilter={selectedPath}
              onClearFilter={clearFilter}
            />
          ) : null}
          {tab === 'interventions' ? (
            <InterventionsLog pathFilter={selectedPath} onClearFilter={clearFilter} />
          ) : null}
          {tab === 'rules' ? <RulesManager /> : null}
          {tab === 'interrupt' ? <ManualInterrupt /> : null}
        </div>
      </div>
    </IdeShell>
  )
}
