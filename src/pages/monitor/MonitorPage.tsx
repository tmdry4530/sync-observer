import { useState } from 'react'
import { LiveEventFeed } from '../../features/monitor/components/LiveEventFeed'
import { Dashboard } from '../../features/monitor/components/Dashboard'
import { Timeline } from '../../features/monitor/components/Timeline'
import { InterventionsLog } from '../../features/monitor/components/InterventionsLog'
import { RulesManager } from '../../features/monitor/components/RulesManager'
import { ManualInterrupt } from '../../features/monitor/components/ManualInterrupt'
import '../../styles/apple/monitor.css'

/**
 * Standalone local monitor page. Lives OUTSIDE the workspace/auth shell — the
 * hermes-monitor pivot has no auth; it's a single-user localhost tool.
 *
 * Tabs group observation (대시보드 / 활동 / 타임라인 / 개입) from the control
 * plane (규칙 / 중지). The selected session is lifted here so the dashboard can
 * open a session straight into the timeline.
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

export function MonitorPage() {
  const [tab, setTab] = useState<Tab>('dashboard')
  const [sessionId, setSessionId] = useState<string | null>(null)

  const openSession = (id: string): void => {
    setSessionId(id)
    setTab('timeline')
  }

  return (
    <main className="monitor-page">
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
        {tab === 'feed' ? <LiveEventFeed /> : null}
        {tab === 'timeline' ? <Timeline sessionId={sessionId} onSelectSession={setSessionId} /> : null}
        {tab === 'interventions' ? <InterventionsLog /> : null}
        {tab === 'rules' ? <RulesManager /> : null}
        {tab === 'interrupt' ? <ManualInterrupt /> : null}
      </div>
    </main>
  )
}
