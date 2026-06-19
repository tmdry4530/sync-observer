import type { ActivityEvent } from '../../../shared/types/activityEvent'
import { useActivityStream, type StreamStatus } from '../hooks/useActivityStream'
import { filterEventsByPath, PathFilterNotice } from '../pathFilter'
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

interface LiveEventFeedProps {
  /** Lifted stream — when provided, this component does NOT open its own SSE. */
  events?: ActivityEvent[]
  status?: StreamStatus
  pathFilter?: string | null
  onClearFilter?: () => void
}

export function LiveEventFeed(props: LiveEventFeedProps) {
  // Avoid double-SSE: only self-subscribe when the parent did not lift the stream.
  if (props.events && props.status) {
    return (
      <LiveEventFeedView
        events={props.events}
        status={props.status}
        pathFilter={props.pathFilter ?? null}
        onClearFilter={props.onClearFilter}
      />
    )
  }
  return (
    <SelfStreamingFeed pathFilter={props.pathFilter ?? null} onClearFilter={props.onClearFilter} />
  )
}

function SelfStreamingFeed({
  pathFilter,
  onClearFilter
}: {
  pathFilter: string | null
  onClearFilter?: (() => void) | undefined
}) {
  const { events, status } = useActivityStream()
  return (
    <LiveEventFeedView
      events={events}
      status={status}
      pathFilter={pathFilter}
      onClearFilter={onClearFilter}
    />
  )
}

function LiveEventFeedView({
  events,
  status,
  pathFilter,
  onClearFilter
}: {
  events: ActivityEvent[]
  status: StreamStatus
  pathFilter: string | null
  onClearFilter?: (() => void) | undefined
}) {
  // Newest first for a live feed.
  const ordered = [...filterEventsByPath(events, pathFilter)].reverse()

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

      <PathFilterNotice pathFilter={pathFilter} onClear={onClearFilter} />

      {ordered.length === 0 ? (
        <p className="monitor-empty">
          {pathFilter
            ? '선택한 경로와 관련된 활동이 없습니다.'
            : '아직 관찰된 활동이 없습니다. hermes 에이전트가 작업을 시작하면 여기에 표시됩니다.'}
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
