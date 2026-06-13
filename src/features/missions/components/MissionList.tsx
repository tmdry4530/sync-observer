import { Link, useParams } from 'react-router-dom'
import { ClipboardList } from 'lucide-react'
import { useWorkspaceMissionsQuery } from '../queries/useWorkspaceMissionsQuery'
import { routes } from '../../../app/router/routes'
import type { WorkspaceMissionSummary } from '../../../shared/types/missions'
import { relativeTime } from '../missionTime'

// ── helpers ──────────────────────────────────────────────────────────────────

function missionTitle(mission: WorkspaceMissionSummary): string {
  if (typeof mission.title === 'string' && mission.title.trim().length > 0) {
    return mission.title.trim()
  }
  return mission.contextId.slice(0, 12)
}

// ── component ─────────────────────────────────────────────────────────────────

export function MissionList() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { data, isLoading, error } = useWorkspaceMissionsQuery(workspaceId)
  const missions = data?.missions

  if (isLoading && !missions) {
    return <div className="page-state">미션 목록을 불러오는 중...</div>
  }

  // Keep showing cached data through transient background-poll failures.
  if (error && !missions) {
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
