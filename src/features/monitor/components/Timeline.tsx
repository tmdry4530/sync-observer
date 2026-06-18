import { useCallback, useEffect } from 'react'
import { fetchSessionEvents, listSessions, type EventsPage, type SessionSummary } from '../collectorClient'
import { usePolledResource } from '../hooks/usePolledResource'
import { ActivityRow } from './activityDisplay'

/**
 * Tool-Call Timeline (M4) — chronological (oldest→newest) tool calls for one
 * session, polled from /api/sessions/:id/events. Reuses ActivityRow so the
 * path-centric rendering matches the live feed. A selector switches sessions;
 * the dashboard can also drive the selection.
 */
const EMPTY_PAGE: EventsPage = { events: [], latestSeq: 0 }

export function Timeline({
  sessionId,
  onSelectSession
}: {
  sessionId: string | null
  onSelectSession: (sessionId: string) => void
}) {
  const sessionsFetcher = useCallback((signal: AbortSignal) => listSessions(signal), [])
  const { data: sessionsData } = usePolledResource<SessionSummary[]>(sessionsFetcher, 5000)
  const sessions = sessionsData ?? []

  // Default to the most-recently-active session once we have one.
  useEffect(() => {
    if (!sessionId && sessions.length > 0) onSelectSession(sessions[0]!.sessionId)
  }, [sessionId, sessions, onSelectSession])

  const eventsFetcher = useCallback(
    (signal: AbortSignal) =>
      sessionId ? fetchSessionEvents(sessionId, 0, signal) : Promise.resolve(EMPTY_PAGE),
    [sessionId]
  )
  const { data, error, loading } = usePolledResource<EventsPage>(eventsFetcher, 2000)
  const events = data?.events ?? []

  return (
    <section className="monitor-timeline-view" aria-label="툴콜 타임라인">
      <header className="monitor-section-head">
        <div>
          <p className="eyebrow">타임라인</p>
          <h2 className="monitor-section-title">툴콜 흐름</h2>
        </div>
        <label className="monitor-field">
          <span className="monitor-field-label">세션</span>
          <select
            className="monitor-input monitor-input--mono"
            value={sessionId ?? ''}
            onChange={(e) => onSelectSession(e.target.value)}
          >
            <option value="" disabled>
              세션 선택…
            </option>
            {sessions.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {s.sessionId} ({s.eventCount})
              </option>
            ))}
          </select>
        </label>
      </header>

      {error ? (
        <p className="monitor-error" role="alert">
          {error}
        </p>
      ) : null}

      {!sessionId ? (
        <p className="monitor-empty">세션을 선택하면 해당 세션의 툴콜 타임라인이 표시됩니다.</p>
      ) : loading && events.length === 0 ? (
        <p className="monitor-muted">타임라인을 불러오는 중…</p>
      ) : events.length === 0 ? (
        <p className="monitor-empty">이 세션에는 아직 활동이 없습니다.</p>
      ) : (
        <ol className="monitor-list">
          {events.map((ev) => (
            <ActivityRow key={ev.eventId} event={ev} showAgent={false} />
          ))}
        </ol>
      )}
    </section>
  )
}
