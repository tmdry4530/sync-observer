import type { TestResultEvent } from '../../../../shared/types/engineeringEvents'
import { RawInspect } from './RawInspect'

interface Props {
  event: TestResultEvent
}

export function TestResultRenderer({ event }: Props) {
  const passed = event.passed ?? 0
  const failed = event.failed ?? 0
  const total = passed + failed
  const hasFailed = event.status === 'failed'

  return (
    <div className="renderer-test-result">
      <div className={`test-result-banner test-result-banner--${event.status}`}>
        <span className="test-result-status-icon">{hasFailed ? '✗' : '✓'}</span>
        <div className="test-result-banner-body">
          <span className="test-result-suite">{event.suite}</span>
          <span className="test-result-verdict">{hasFailed ? 'FAILED' : 'PASSED'}</span>
        </div>
      </div>
      <div className="test-result-stats">
        {total > 0 && (
          <>
            <span className="test-stat test-stat--pass">{passed} passed</span>
            {failed > 0 && <span className="test-stat test-stat--fail">{failed} failed</span>}
          </>
        )}
        {event.durationMs != null && (
          <span className="test-stat test-stat--duration">{event.durationMs} ms</span>
        )}
      </div>
      {event.failures && event.failures.length > 0 && (
        <ul className="event-detail-failures">
          {event.failures.map((f, i) => (
            <li key={i}>
              <strong>{f.name}</strong>
              {f.message ? <p>{f.message}</p> : null}
            </li>
          ))}
        </ul>
      )}
      <RawInspect event={event} />
    </div>
  )
}
