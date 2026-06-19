import type { EngineeringMissionEvent } from '../hooks/useMissionQuery'
import type { EngineeringEvent } from '../../../shared/types/engineeringEvents'
import { eventDisplayTime, formatEventTime } from '../../../shared/utils/missionTime'
import { DiffRenderer } from './renderers/DiffRenderer'
import { CommandRenderer } from './renderers/CommandRenderer'
import { TestResultRenderer } from './renderers/TestResultRenderer'
import { ReviewCommentRenderer } from './renderers/ReviewCommentRenderer'
import { VcsEventRenderer } from './renderers/VcsEventRenderer'
import { AgentStatusRenderer } from './renderers/AgentStatusRenderer'
import { PipelineStageRenderer } from './renderers/PipelineStageRenderer'

function renderEventBody(eng: EngineeringEvent) {
  switch (eng.kind) {
    case 'agent_status':
      return <AgentStatusRenderer event={eng} />
    case 'pipeline_stage':
      return <PipelineStageRenderer event={eng} />
    case 'file_edit':
      return <DiffRenderer event={eng} />
    case 'command_run':
      return <CommandRenderer event={eng} />
    case 'test_result':
      return <TestResultRenderer event={eng} />
    case 'review_comment':
      return <ReviewCommentRenderer event={eng} />
    case 'vcs_event':
      return <VcsEventRenderer event={eng} />
    default:
      return <pre className="ap-md-raw-block">{JSON.stringify(eng, null, 2)}</pre>
  }
}

interface EventDetailProps {
  event: EngineeringMissionEvent | null
}

export function EventDetail({ event }: EventDetailProps) {
  if (!event) {
    return (
      <section
        className="mission-event-detail ap-md-detail ap-md-detail--empty"
        aria-label="이벤트 상세"
      >
        <p className="mission-empty-note ap-md-empty">타임라인에서 이벤트를 선택하세요.</p>
      </section>
    )
  }

  const eng = event.engineeringEvent
  const displayTime = eventDisplayTime(eng.timestamp, event.createdAt)
  return (
    <section className="mission-event-detail ap-md-detail" aria-label="이벤트 상세">
      <header className="ap-md-detail-head">
        <span className="ap-md-detail-eyebrow">
          {eng.kind.replace(/_/g, ' ')}
          {eng.demo ? <span className="demo-badge ap-md-demo">demo</span> : null}
          <time className="ap-md-detail-time" dateTime={displayTime} title={displayTime}>
            {formatEventTime(displayTime)}
          </time>
        </span>
        <span className="ap-md-detail-seq">#{event.seq}</span>
      </header>
      <div className="ap-md-detail-body">{renderEventBody(eng)}</div>
    </section>
  )
}
