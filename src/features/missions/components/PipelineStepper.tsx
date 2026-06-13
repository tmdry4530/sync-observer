import type { PipelineStageEvent, PipelineStage, PipelineStageStatus } from '../../../shared/types/engineeringEvents'

const STAGE_ORDER: PipelineStage[] = ['planning', 'implementation', 'testing', 'review', 'merge']

const STAGE_LABELS: Record<PipelineStage, string> = {
  planning: '계획',
  implementation: '구현',
  testing: '테스트',
  review: '리뷰',
  merge: '병합'
}

const STATUS_CLASS: Record<PipelineStageStatus, string> = {
  pending: 'pipeline-stage--pending',
  active: 'pipeline-stage--active',
  done: 'pipeline-stage--done',
  failed: 'pipeline-stage--failed'
}

interface PipelineStepperProps {
  stages: Map<string, PipelineStageEvent>
}

export function PipelineStepper({ stages }: PipelineStepperProps) {
  // Render only the stages that actually have a rolled-up event, in canonical
  // order. The worker never emits testing/merge for real missions, so defaulting
  // missing stages to 'pending' would leave them perpetually pending; the demo
  // emits all five and still renders complete.
  const presentStages = STAGE_ORDER.filter((stage) => stages.has(stage))

  return (
    <section className="mission-pipeline" aria-label="파이프라인 단계">
      <p className="eyebrow">파이프라인</p>
      {presentStages.length === 0 ? (
        <p className="pipeline-stage-empty">아직 단계 없음</p>
      ) : (
        <ol className="pipeline-stage-list">
          {presentStages.map((stage, idx) => {
            const ev = stages.get(stage)
            const status: PipelineStageStatus = ev?.status ?? 'pending'
            return (
              <li key={stage} className={`pipeline-stage ${STATUS_CLASS[status]}`}>
                <span className="pipeline-stage-index">{idx + 1}</span>
                <span className="pipeline-stage-label">{STAGE_LABELS[stage]}</span>
                {ev?.summary ? <span className="pipeline-stage-summary">{ev.summary}</span> : null}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
