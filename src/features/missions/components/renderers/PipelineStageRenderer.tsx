import type { PipelineStageEvent } from '../../../../shared/types/engineeringEvents'
import { formatEventTime } from '../../missionTime'
import { RawInspect } from './RawInspect'
import { statusPillClass } from './statusPill'

interface Props {
  event: PipelineStageEvent
}

export function PipelineStageRenderer({ event }: Props) {
  return (
    <div className="renderer-pipeline-stage">
      <div className="pipeline-detail-card">
        <div className="pipeline-detail-row">
          <span className="pipeline-detail-label">Stage</span>
          <span className="pipeline-detail-value">{event.stage}</span>
        </div>
        <div className="pipeline-detail-row">
          <span className="pipeline-detail-label">Status</span>
          <span className={`status-pill ${statusPillClass(event.status)}`}>{event.status}</span>
        </div>
        {event.summary && (
          <div className="pipeline-detail-row">
            <span className="pipeline-detail-label">Summary</span>
            <span className="pipeline-detail-value">{event.summary}</span>
          </div>
        )}
        {event.startedAt && (
          <div className="pipeline-detail-row">
            <span className="pipeline-detail-label">Started</span>
            <time className="pipeline-detail-value" dateTime={event.startedAt}>
              {formatEventTime(event.startedAt)}
            </time>
          </div>
        )}
        {event.endedAt && (
          <div className="pipeline-detail-row">
            <span className="pipeline-detail-label">Ended</span>
            <time className="pipeline-detail-value" dateTime={event.endedAt}>
              {formatEventTime(event.endedAt)}
            </time>
          </div>
        )}
      </div>
      <RawInspect event={event} />
    </div>
  )
}
