import { Link, useParams } from 'react-router-dom'
import { ClipboardList } from 'lucide-react'
import { useWorkspaceMissionsQuery } from '../queries/useWorkspaceMissionsQuery'
import { routes } from '../../../app/router/routes'
import type { WorkspaceMissionSummary } from '../../../shared/types/missions'

// ── helpers ──────────────────────────────────────────────────────────────────

function missionTitle(mission: WorkspaceMissionSummary): string {
  if (typeof mission.title === 'string' && mission.title.trim().length > 0) {
    return mission.title.trim()
  }
  return mission.contextId.slice(0, 12)
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return '방금 전'
  if (mins < 60) return `${mins}분 전`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}시간 전`
  const days = Math.floor(hours / 24)
  return `${days}일 전`
}

// ── component ─────────────────────────────────────────────────────────────────

export function MissionList() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { data, isLoading, error } = useWorkspaceMissionsQuery(workspaceId)
  const missions = data?.missions

  if (isLoading && !missions) {
    return <div className="page-state">미션 목록을 불러오는 중...</div>
  }

  if (error) {
    return (
      <div className="page-state">
        <p className="form-error" role="alert">미션 목록을 불러오지 못했습니다.</p>
      </div>
    )
  }

  return (
    <div className="mission-list-page">
      <header className="mission-list-header">
        <ClipboardList size={20} aria-hidden="true" />
        <div>
          <p className="eyebrow">Mission View</p>
          <h1>미션</h1>
        </div>
      </header>

      {missions && missions.length === 0 ? (
        <div className="mission-list-empty">
          <p>아직 미션이 없습니다 — 에이전트가 작업을 시작하면 여기에 표시됩니다.</p>
        </div>
      ) : (
        <ul className="mission-list" role="list">
          {(missions ?? []).map((mission) => (
            <li key={mission.contextId} className="mission-list-item">
              <Link
                to={routes.mission(workspaceId!, mission.contextId)}
                className="mission-list-row"
              >
                <span className="mission-list-title">{missionTitle(mission)}</span>
                <span className="status-pill connected">
                  {mission.agentCount}명의 에이전트
                </span>
                <span className="mission-list-time">{relativeTime(mission.updatedAt)}</span>
                <span className="mission-list-id">{mission.contextId.slice(0, 8)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
