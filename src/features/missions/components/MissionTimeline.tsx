import type { EngineeringMissionEvent } from '../hooks/useMissionQuery'
import type { EngineeringEventKind } from '../../../shared/types/engineeringEvents'
import { eventDisplayTime, relativeTime } from '../../../shared/utils/missionTime'

const KIND_ICON: Record<EngineeringEventKind, string> = {
  agent_status: '🤖',
  pipeline_stage: '🔷',
  file_edit: '📝',
  command_run: '▶',
  test_result: '✓',
  review_comment: '💬',
  vcs_event: '🔀'
}

const KIND_LABEL: Record<EngineeringEventKind, string> = {
  agent_status: 'agent',
  pipeline_stage: 'stage',
  file_edit: 'file',
  command_run: 'cmd',
  test_result: 'test',
  review_comment: 'review',
  vcs_event: 'vcs'
}

function summariseEvent(ev: EngineeringMissionEvent): string {
  const eng = ev.engineeringEvent
  switch (eng.kind) {
    case 'agent_status':
      return `${eng.role} — ${eng.currentAction}`
    case 'pipeline_stage':
      return `${eng.stage} → ${eng.status}${eng.summary ? ` (${eng.summary})` : ''}`
    case 'file_edit':
      return eng.summary || eng.path
    case 'command_run':
      return `${eng.command} [${eng.status}]`
    case 'test_result':
      return `${eng.suite} — ${eng.status}${eng.passed != null ? ` (${eng.passed} passed)` : ''}`
    case 'review_comment':
      return `${eng.severity}: ${eng.comment.slice(0, 60)}`
    case 'vcs_event':
      return eng.summary ?? eng.action
    default:
      return ev.type
  }
}

interface MissionTimelineProps {
  events: EngineeringMissionEvent[]
  selectedSeq: string | null
  onSelect: (seq: string) => void
}

export function MissionTimeline({ events, selectedSeq, onSelect }: MissionTimelineProps) {
  return (
    <section className="mission-timeline" aria-label="이벤트 타임라인">
      <p className="eyebrow ap-md-eyebrow">타임라인</p>
      {events.length === 0 ? (
        <p className="mission-empty-note ap-md-empty">표시할 엔지니어링 이벤트가 없습니다.</p>
      ) : (
        <ol className="ap-md-timeline-list">
          {events.map((ev) => {
            const eng = ev.engineeringEvent
            const displayTime = eventDisplayTime(eng.timestamp, ev.createdAt)
            const isSelected = ev.seq === selectedSeq
            return (
              <li
                key={ev.seq}
                className={`ap-md-timeline-row${isSelected ? ' ap-md-timeline-row--selected' : ''}`}
                onClick={() => onSelect(ev.seq)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(ev.seq)
                  }
                }}
                aria-pressed={isSelected}
              >
                <span className="ap-md-timeline-icon" aria-hidden="true">
                  {KIND_ICON[eng.kind]}
                </span>
                <div className="ap-md-timeline-body">
                  <span className="ap-md-timeline-kind">{KIND_LABEL[eng.kind]}</span>
                  <span className="ap-md-timeline-summary">{summariseEvent(ev)}</span>
                </div>
                <div className="ap-md-timeline-meta">
                  {eng.demo ? <span className="demo-badge ap-md-demo">demo</span> : null}
                  <time className="ap-md-timeline-time" dateTime={displayTime} title={displayTime}>
                    {relativeTime(displayTime)}
                  </time>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
