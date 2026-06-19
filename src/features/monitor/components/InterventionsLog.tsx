import { useCallback } from 'react'
import { listInterventions, type InterventionRecord } from '../collectorClient'
import { usePolledResource } from '../hooks/usePolledResource'
import { PathFilterNotice } from '../pathFilter'
import { relativeTime, formatEventTime } from '../../missions/missionTime'

/**
 * Interventions log (M4) — the audit trail of every block / interrupt, polled
 * from /api/interventions. Auto (rule-driven) and manual interventions both land
 * here so an operator can see exactly what was stopped, when, and why.
 */

const MODE_LABEL: Record<string, string> = {
  block: '차단(pre-block)',
  interrupt: '중지(interrupt)',
  kill: '강제종료(kill)'
}

export function InterventionsLog({
  pathFilter,
  onClearFilter
}: {
  pathFilter?: string | null
  onClearFilter?: () => void
} = {}) {
  const fetcher = useCallback((signal: AbortSignal) => listInterventions(200, signal), [])
  const { data, error, loading } = usePolledResource<InterventionRecord[]>(fetcher, 3000)
  const all = data ?? []
  // Narrow to interventions whose target path is the selected node or under it,
  // matching the cross-pane filter semantics in pathFilter.ts.
  const records = pathFilter
    ? all.filter((r) => {
        if (!r.targetPath) return false
        const prefix = pathFilter.endsWith('/') ? pathFilter : pathFilter + '/'
        return r.targetPath === pathFilter || r.targetPath.startsWith(prefix)
      })
    : all

  return (
    <section className="monitor-interventions" aria-label="개입 로그">
      <header className="monitor-section-head">
        <div>
          <p className="eyebrow">개입 로그</p>
          <h2 className="monitor-section-title">차단·중지 이력</h2>
        </div>
      </header>

      {error ? (
        <p className="monitor-error" role="alert">
          {error}
        </p>
      ) : null}

      <PathFilterNotice pathFilter={pathFilter ?? null} onClear={onClearFilter} />

      {loading && all.length === 0 ? (
        <p className="monitor-muted">개입 이력을 불러오는 중…</p>
      ) : records.length === 0 ? (
        <p className="monitor-empty">
          {pathFilter
            ? '선택한 경로와 관련된 차단·중지 이력이 없습니다.'
            : '아직 차단되거나 중지된 작업이 없습니다.'}
        </p>
      ) : (
        <ol className="monitor-list">
          {records.map((r) => (
            <li key={r.id} className="monitor-row monitor-row--intervention">
              <span className="monitor-row-icon" aria-hidden="true">
                ⛔
              </span>
              <div className="monitor-row-body">
                <div className="monitor-row-head">
                  <span className="monitor-row-action">{MODE_LABEL[r.mode] ?? r.mode}</span>
                  <span className={`status-pill ${r.trigger === 'manual' ? 'status-pill--running' : 'status-pill--failed'}`}>
                    {r.trigger === 'manual' ? '수동' : '자동'}
                  </span>
                  {r.ruleId ? <span className="monitor-row-tool">규칙 {r.ruleId}</span> : null}
                </div>
                <p className="monitor-row-nopath">
                  {r.message ?? '(사유 없음)'}
                  {r.sessionId ? ` · 세션 ${r.sessionId}` : ''}
                </p>
              </div>
              <div className="monitor-row-meta">
                <span className="monitor-row-agent" title={`agent: ${r.agentId}`}>
                  {r.agentId}
                </span>
                <time className="monitor-row-time" dateTime={r.ts} title={formatEventTime(r.ts)}>
                  {relativeTime(r.ts)}
                </time>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
