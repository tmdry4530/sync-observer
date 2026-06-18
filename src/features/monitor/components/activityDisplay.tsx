import {
  getIntervention,
  type ActivityAction,
  type ActivityEvent,
  type ActivityStatus
} from '../../../shared/types/activityEvent'
import { relativeTime, formatEventTime } from '../../missions/missionTime'

/**
 * Shared presentation for one ActivityEvent — used by both the Live Feed and the
 * Tool-Call Timeline so the action/status vocabulary and the path-centric row
 * stay identical across views. Status is conveyed as TEXT, never colour alone.
 */

export const ACTION_ICON: Record<ActivityAction, string> = {
  read: '📖',
  edit: '✏️',
  write: '📝',
  grep: '🔎',
  glob: '🗂️',
  bash: '▶',
  search: '🔍',
  task: '🤖',
  other: '•'
}

export const ACTION_LABEL: Record<ActivityAction, string> = {
  read: '읽기',
  edit: '편집',
  write: '쓰기',
  grep: '내용검색',
  glob: '파일탐색',
  bash: '명령',
  search: '검색',
  task: '하위작업',
  other: '기타'
}

export const STATUS_LABEL: Record<ActivityStatus, string> = {
  started: '진행',
  success: '완료',
  error: '오류',
  blocked: '차단됨',
  cancelled: '중지됨'
}

export const STATUS_PILL: Record<ActivityStatus, string> = {
  started: 'status-pill--running',
  success: 'status-pill--success',
  error: 'status-pill--failed',
  blocked: 'status-pill--failed',
  cancelled: 'status-pill--failed'
}

export function isIntervention(ev: ActivityEvent): boolean {
  return ev.status === 'blocked' || ev.status === 'cancelled'
}

/** One activity row. `showAgent` is false in per-session views (redundant there). */
export function ActivityRow({ event, showAgent = true }: { event: ActivityEvent; showAgent?: boolean }) {
  const intervention = getIntervention(event)
  const blocked = isIntervention(event)

  return (
    <li className={`monitor-row${blocked ? ' monitor-row--intervention' : ''}`}>
      <span className="monitor-row-icon" aria-hidden="true">
        {ACTION_ICON[event.action]}
      </span>

      <div className="monitor-row-body">
        <div className="monitor-row-head">
          <span className="monitor-row-action">{ACTION_LABEL[event.action]}</span>
          <span className="monitor-row-tool" title={`tool: ${event.tool}`}>
            {event.tool}
          </span>
          <span className={`status-pill ${STATUS_PILL[event.status]}`}>{STATUS_LABEL[event.status]}</span>
        </div>

        {event.paths.length > 0 ? (
          <ul className="monitor-row-paths" aria-label="대상 경로">
            {event.paths.map((p, i) => (
              <li key={`${event.eventId}-${i}`} className="monitor-row-path" title={p}>
                {p}
              </li>
            ))}
          </ul>
        ) : (
          <p className="monitor-row-nopath">{event.summary ?? '경로 정보 없음'}</p>
        )}

        {intervention ? (
          <p className="monitor-row-intervention-note">
            {intervention.trigger === 'manual' ? '수동' : '자동'} 개입
            {intervention.ruleId ? ` · 규칙 ${intervention.ruleId}` : ''}
            {intervention.message ? ` · ${intervention.message}` : ''}
          </p>
        ) : null}
      </div>

      <div className="monitor-row-meta">
        {showAgent ? (
          <span className="monitor-row-agent" title={`agent: ${event.agentId}`}>
            {event.agentId}
          </span>
        ) : null}
        <time className="monitor-row-time" dateTime={event.ts} title={formatEventTime(event.ts)}>
          {relativeTime(event.ts)}
        </time>
      </div>
    </li>
  )
}
