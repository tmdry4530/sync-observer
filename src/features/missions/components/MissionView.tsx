import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useMissionQuery } from '../hooks/useMissionQuery'
import { PipelineStepper } from './PipelineStepper'
import { AgentRoster } from './AgentRoster'
import { MissionTimeline } from './MissionTimeline'
import { EventDetail } from './EventDetail'
import { routes } from '../../../app/router/routes'

export function MissionView() {
  const { workspaceId, contextId } = useParams<{ workspaceId: string; contextId: string }>()
  const { missionData, isLoading, error } = useMissionQuery(contextId ?? null)
  const [selectedSeq, setSelectedSeq] = useState<string | null>(null)

  const selectedEvent =
    selectedSeq != null
      ? (missionData?.engineeringEvents.find((ev) => ev.seq === selectedSeq) ?? null)
      : null

  if (isLoading && !missionData) {
    return <div className="page-state">미션 데이터를 불러오는 중...</div>
  }

  // Only surface the error page when there is nothing to show — a transient
  // failed background poll must not wipe a populated view.
  if (error && !missionData) {
    return (
      <div className="page-state">
        <p className="form-error" role="alert">
          미션을 불러오지 못했습니다.
        </p>
      </div>
    )
  }

  const missionTitle =
    missionData?.detail.tasks[0]?.title ??
    (missionData?.detail.mission.contextId.slice(0, 12) ?? contextId)

  const backHref = workspaceId ? routes.workspace(workspaceId) : routes.workspaces

  return (
    <div className="mission-view">
      {/* Top bar */}
      <header className="mission-topbar">
        <Link to={backHref} className="mission-back-link" aria-label="워크스페이스로 돌아가기">
          <ArrowLeft size={16} />
          <span>워크스페이스</span>
        </Link>
        <div className="mission-topbar-title">
          <p className="eyebrow">Mission View</p>
          <h1>{missionTitle}</h1>
        </div>
      </header>

      {/* Three-column layout */}
      <div className="mission-layout">
        {/* LEFT — pipeline + roster */}
        <aside className="mission-left" aria-label="파이프라인 및 에이전트">
          <PipelineStepper stages={missionData?.pipelineStages ?? new Map()} />
          <AgentRoster
            roster={missionData?.agentRoster ?? new Map()}
            agents={missionData?.detail.agents ?? []}
          />
        </aside>

        {/* CENTER — selected event detail (work surface) */}
        <main className="mission-center" aria-label="작업 서피스">
          <EventDetail event={selectedEvent} />
        </main>

        {/* RIGHT — timeline */}
        <aside className="mission-right" aria-label="타임라인">
          <MissionTimeline
            events={missionData?.engineeringEvents ?? []}
            selectedSeq={selectedSeq}
            onSelect={setSelectedSeq}
          />
        </aside>
      </div>
    </div>
  )
}
