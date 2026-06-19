import { Link, useParams } from 'react-router-dom'
import { ClipboardList } from 'lucide-react'
import { useWorkspaceMissionsQuery } from '../queries/useWorkspaceMissionsQuery'
import { routes } from '../../../app/router/routes'
import type { WorkspaceMissionSummary } from '../../../shared/types/missions'
import { relativeTime } from '../../../shared/utils/missionTime'
import '../../../styles/apple/mission-list.css'

// ── helpers ──────────────────────────────────────────────────────────────────

function missionTitle(mission: WorkspaceMissionSummary): string {
  if (typeof mission.title === 'string' && mission.title.trim().length > 0) {
    return mission.title.trim()
  }
  return mission.contextId.slice(0, 12)
}

// The 5-stage engineering pipeline the progress bar visualizes.
const PIPELINE_STAGES = ['planning', 'implementation', 'testing', 'review', 'merge'] as const
type SegmentState = 'done' | 'active' | 'pending'

interface MissionPipeline {
  segments: SegmentState[]
  /** 0-based index of the active stage, or -1 when fully complete. */
  activeIndex: number
  statusLabel: string
  statusTone: 'active' | 'done' | 'pending'
}

/**
 * Derive the 5-segment pipeline + status from the REAL mission summary.
 *
 * The list endpoint exposes no explicit stage field, so progress is a
 * monotonic heuristic off `eventCount`: more emitted engineering events ⇒
 * further along the pipeline. This keeps the bar bound to live data instead
 * of hardcoded demo values; swap the derivation here the moment the API
 * surfaces a real stage/pipeline field.
 */
function deriveMissionPipeline(mission: WorkspaceMissionSummary): MissionPipeline {
  const total = PIPELINE_STAGES.length
  const events = Number.isFinite(mission.eventCount) ? Math.max(0, mission.eventCount) : 0

  // ~3 events advance one stage; clamp into [0, total].
  const reached = Math.min(total, Math.floor(events / 3))
  const isComplete = reached >= total
  const activeIndex = isComplete ? -1 : reached

  const segments: SegmentState[] = PIPELINE_STAGES.map((_, i) => {
    if (i < reached) return 'done'
    if (i === activeIndex) return 'active'
    return 'pending'
  })

  if (isComplete) {
    return { segments, activeIndex, statusLabel: '완료', statusTone: 'done' }
  }
  if (activeIndex >= 3) {
    return { segments, activeIndex, statusLabel: '리뷰 중', statusTone: 'active' }
  }
  if (activeIndex >= 1) {
    return { segments, activeIndex, statusLabel: '구현 중', statusTone: 'active' }
  }
  return { segments, activeIndex, statusLabel: '계획 중', statusTone: 'pending' }
}

// ── component ─────────────────────────────────────────────────────────────────

export function MissionList() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { data, isLoading, error } = useWorkspaceMissionsQuery(workspaceId)
  const missions = data?.missions

  if (isLoading && !missions) {
    return (
      <div className="ap-ml-page">
        <div className="ap-ml-card">
          <div className="ap-ml-state" role="status" aria-live="polite">
            <ClipboardList size={28} className="ap-ml-state-icon" aria-hidden="true" />
            <p>미션 목록을 불러오는 중...</p>
          </div>
        </div>
      </div>
    )
  }

  // Keep showing cached data through transient background-poll failures.
  if (error && !missions) {
    return (
      <div className="ap-ml-page">
        <div className="ap-ml-card">
          <div className="ap-ml-state">
            <ClipboardList size={28} className="ap-ml-state-icon" aria-hidden="true" />
            <p className="ap-ml-state-error" role="alert">
              미션 목록을 불러오지 못했습니다.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="ap-ml-page">
      <div className="ap-ml-card" data-screen-label="Mission List">
        <header className="ap-ml-header">
          <ClipboardList size={22} aria-hidden="true" />
          <div>
            <p className="ap-ml-eyebrow">Mission View</p>
            <h1 className="ap-ml-title">미션</h1>
          </div>
          <span className="ap-ml-spectator">관전 모드</span>
        </header>

        {missions && missions.length === 0 ? (
          <div className="ap-ml-state">
            <ClipboardList size={28} className="ap-ml-state-icon" aria-hidden="true" />
            <p>아직 미션이 없습니다 — 에이전트가 작업을 시작하면 여기에 표시됩니다.</p>
          </div>
        ) : (
          <ul className="ap-ml-rows" role="list">
            {(missions ?? []).map((mission) => {
              const pipeline = deriveMissionPipeline(mission)
              return (
                <li key={mission.contextId} className="ap-ml-item">
                  <Link
                    to={routes.mission(workspaceId!, mission.contextId)}
                    className="ap-ml-row"
                  >
                    <div className="ap-ml-main">
                      <div className="ap-ml-name">{missionTitle(mission)}</div>
                      <div
                        className="ap-ml-pipeline"
                        role="img"
                        aria-label={`파이프라인 진행: ${pipeline.statusLabel}`}
                      >
                        {pipeline.segments.map((state, i) => (
                          <span
                            key={PIPELINE_STAGES[i]}
                            className="ap-ml-seg"
                            data-state={state}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="ap-ml-meta">
                      <div className="ap-ml-status" data-tone={pipeline.statusTone}>
                        {pipeline.statusLabel}
                      </div>
                      <div className="ap-ml-submeta">
                        {relativeTime(mission.updatedAt)} · {mission.agentCount}명
                      </div>
                    </div>
                    <span className="ap-ml-id">{mission.contextId.slice(0, 8)}</span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
