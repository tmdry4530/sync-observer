import { useActivityStream, type StreamStatus } from '../hooks/useActivityStream'
import { ActivityRow } from './activityDisplay'

/**
 * Live Agent Activity feed — the M4 vertical slice.
 *
 * Renders the collector's live ActivityEvent stream (SSE, polling fallback),
 * newest first. Row rendering is shared with the Tool-Call Timeline via
 * ActivityRow. This is an observe + controlled-intervention surface: spectators
 * read, they do not author agent content.
 */

const CONNECTION_LABEL: Record<StreamStatus, string> = {
  connecting: '연결 중…',
  live: '실시간',
  polling: '폴링',
  error: '연결 끊김'
}

export function LiveEventFeed() {
  const { events, status } = useActivityStream()
  // Newest first for a live feed.
  const ordered = [...events].reverse()

  return (
    <section className="monitor-feed" aria-label="에이전트 활동 라이브 피드">
      <header className="monitor-feed-header">
        <div>
          <p className="eyebrow">라이브</p>
          <h1 className="monitor-feed-title">에이전트 활동</h1>
        </div>
        <span className={`monitor-conn monitor-conn--${status}`} role="status" aria-live="polite">
          <span className="monitor-conn-dot" aria-hidden="true" />
          {CONNECTION_LABEL[status]}
        </span>
      </header>

      {ordered.length === 0 ? (
        <p className="monitor-empty">
          아직 관찰된 활동이 없습니다. hermes 에이전트가 작업을 시작하면 여기에 표시됩니다.
        </p>
      ) : (
        <ol className="monitor-list">
          {ordered.map((ev) => (
            <ActivityRow key={ev.eventId} event={ev} />
          ))}
        </ol>
      )}
    </section>
  )
}
