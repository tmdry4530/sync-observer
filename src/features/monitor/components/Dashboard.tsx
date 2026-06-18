import { useCallback } from 'react'
import { listSessions, type SessionSummary } from '../collectorClient'
import { usePolledResource } from '../hooks/usePolledResource'
import { relativeTime, formatEventTime } from '../../missions/missionTime'

/**
 * Live Agent Dashboard (M4) — one lane per session, most-recently-active first.
 * Polls /api/sessions. Selecting a lane opens that session in the Timeline.
 */
export function Dashboard({ onSelectSession }: { onSelectSession: (sessionId: string) => void }) {
  const fetcher = useCallback((signal: AbortSignal) => listSessions(signal), [])
  const { data, error, loading } = usePolledResource<SessionSummary[]>(fetcher, 3000)
  const sessions = data ?? []

  return (
    <section className="monitor-dashboard" aria-label="에이전트 대시보드">
      <header className="monitor-section-head">
        <div>
          <p className="eyebrow">대시보드</p>
          <h2 className="monitor-section-title">세션</h2>
        </div>
      </header>

      {error ? (
        <p className="monitor-error" role="alert">
          {error}
        </p>
      ) : null}

      {loading && sessions.length === 0 ? (
        <p className="monitor-muted">세션을 불러오는 중…</p>
      ) : sessions.length === 0 ? (
        <p className="monitor-empty">활성 세션이 없습니다. hermes 에이전트가 연결되면 여기에 나타납니다.</p>
      ) : (
        <ul className="monitor-session-grid">
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <button
                type="button"
                className="monitor-session-card"
                onClick={() => onSelectSession(s.sessionId)}
                aria-label={`세션 ${s.sessionId} 타임라인 열기`}
              >
                <span className="monitor-session-agent">{s.agentId}</span>
                <span className="monitor-session-id" title={s.sessionId}>
                  {s.sessionId}
                </span>
                <span className="monitor-session-meta">
                  <span className="monitor-session-count">{s.eventCount}개 활동</span>
                  <time
                    className="monitor-session-time"
                    dateTime={s.lastTs ?? undefined}
                    title={formatEventTime(s.lastTs ?? undefined)}
                  >
                    {s.lastTs ? relativeTime(s.lastTs) : ''}
                  </time>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
