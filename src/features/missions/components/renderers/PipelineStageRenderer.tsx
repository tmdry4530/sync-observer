import type { PipelineStageEvent } from '../../../../shared/types/engineeringEvents'
import { formatEventTime } from '../../../../shared/utils/missionTime'
import { RawInspect } from './RawInspect'
import { statusPillClass, type PillStatus } from './statusPill'

interface Props {
  event: PipelineStageEvent
}

// Reuse the shared status→pill mapping, but render with the Apple `ap-md-pill`
// vocabulary by swapping the class prefix (status-pill-- → ap-md-pill--).
function ap_md_pillClass(status: PillStatus): string {
  return statusPillClass(status).replace('status-pill--', 'ap-md-pill--')
}

export function PipelineStageRenderer({ event }: Props) {
  return (
    <div className="renderer-pipeline-stage">
      <div className="ap-md-card">
        <div className="ap-md-kv">
          <span className="ap-md-kv-label">Stage</span>
          <span className="ap-md-kv-value">{event.stage}</span>
        </div>
        <div className="ap-md-kv">
          <span className="ap-md-kv-label">Status</span>
          <span className={`ap-md-pill ${ap_md_pillClass(event.status)}`}>{event.status}</span>
        </div>
        {event.summary && (
          <div className="ap-md-kv">
            <span className="ap-md-kv-label">Summary</span>
            <span className="ap-md-kv-value">{event.summary}</span>
          </div>
        )}
        {event.startedAt && (
          <div className="ap-md-kv">
            <span className="ap-md-kv-label">Started</span>
            <time className="ap-md-kv-value" dateTime={event.startedAt}>
              {formatEventTime(event.startedAt)}
            </time>
          </div>
        )}
        {event.endedAt && (
          <div className="ap-md-kv">
            <span className="ap-md-kv-label">Ended</span>
            <time className="ap-md-kv-value" dateTime={event.endedAt}>
              {formatEventTime(event.endedAt)}
            </time>
          </div>
        )}
      </div>
      <RawInspect event={event} />
    </div>
  )
}
