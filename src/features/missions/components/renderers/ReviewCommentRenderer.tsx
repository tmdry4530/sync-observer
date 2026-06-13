import type { ReviewCommentEvent } from '../../../../shared/types/engineeringEvents'
import { RawInspect } from './RawInspect'

interface Props {
  event: ReviewCommentEvent
}

const SEVERITY_CLASS: Record<ReviewCommentEvent['severity'], string> = {
  info: 'severity-pill--info',
  warn: 'severity-pill--warn',
  error: 'severity-pill--error'
}

const VERDICT_CLASS: Record<NonNullable<ReviewCommentEvent['verdict']>, string> = {
  approve: 'verdict-badge--approve',
  request_changes: 'verdict-badge--request'
}

const VERDICT_LABEL: Record<NonNullable<ReviewCommentEvent['verdict']>, string> = {
  approve: 'approve',
  request_changes: 'request changes'
}

export function ReviewCommentRenderer({ event }: Props) {
  const lineRange =
    event.lineStart != null
      ? event.lineEnd != null && event.lineEnd !== event.lineStart
        ? `${event.lineStart}–${event.lineEnd}`
        : `${event.lineStart}`
      : null

  return (
    <div className="renderer-review-comment">
      <div className="review-card">
        <div className="review-card-header">
          <div className="review-card-location">
            <span className="review-file-path">{event.path}</span>
            {lineRange && <span className="review-line-range">:{lineRange}</span>}
          </div>
          <div className="review-card-badges">
            <span className={`severity-pill ${SEVERITY_CLASS[event.severity]}`}>
              {event.severity}
            </span>
            {event.verdict && (
              <span className={`verdict-badge ${VERDICT_CLASS[event.verdict]}`}>
                {VERDICT_LABEL[event.verdict]}
              </span>
            )}
          </div>
        </div>
        <p className="review-comment-text">{event.comment}</p>
      </div>
      <RawInspect event={event} />
    </div>
  )
}
