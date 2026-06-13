import { useMemo } from 'react'
import { useMissionDetailQuery } from '../queries/useMissionDetailQuery'
import type { MissionDetailResponse, MissionEvent } from '../../../shared/types/missions'
import {
  type EngineeringEvent,
  type PipelineStageEvent,
  type PipelineStageStatus,
  type AgentStatusEvent,
  parseEngineeringEvent,
  isEngineeringEventKind
} from '../../../shared/types/engineeringEvents'

/** A mission timeline event with its decoded engineering payload (taskId preserved). */
export interface EngineeringMissionEvent extends MissionEvent {
  engineeringEvent: EngineeringEvent
}

export interface MissionData {
  detail: MissionDetailResponse
  /** All engineering events in seq order */
  engineeringEvents: EngineeringMissionEvent[]
  /** Rolled-up pipeline_stage per stage name (see deriveMissionData) */
  pipelineStages: Map<string, PipelineStageEvent>
  /** Latest agent_status per agentId */
  agentRoster: Map<string, AgentStatusEvent>
}

function unwrapEvent(ev: MissionEvent): EngineeringEvent | null {
  if (!isEngineeringEventKind(ev.type)) return null
  const payload = ev.payload
  if (!payload) return null
  // Payload shape: { engineeringEvent: <EngineeringEvent> }
  const inner = payload['engineeringEvent'] ?? payload
  return parseEngineeringEvent(inner)
}

// One mission spans N tasks, and several roles map to the same stage — a
// stage's display state must not be whatever task happened to emit last.
// Roll up the latest event PER TASK, then pick by severity precedence.
const STATUS_PRECEDENCE: Record<PipelineStageStatus, number> = {
  failed: 3,
  active: 2,
  done: 1,
  pending: 0
}

function deriveMissionData(detail: MissionDetailResponse): MissionData {
  const engineeringEvents: EngineeringMissionEvent[] = []
  const stageByTask = new Map<string, Map<string, PipelineStageEvent>>()
  const agentRoster = new Map<string, AgentStatusEvent>()

  for (const mev of detail.events) {
    const eng = unwrapEvent(mev)
    if (!eng) continue
    engineeringEvents.push({ ...mev, engineeringEvent: eng })

    if (eng.kind === 'pipeline_stage') {
      // Latest per (stage, task); seq order makes the map overwrite correct.
      const perTask = stageByTask.get(eng.stage) ?? new Map<string, PipelineStageEvent>()
      perTask.set(mev.taskId, eng)
      stageByTask.set(eng.stage, perTask)
    }
    if (eng.kind === 'agent_status') {
      agentRoster.set(eng.agentId, eng)
    }
  }

  const pipelineStages = new Map<string, PipelineStageEvent>()
  for (const [stage, perTask] of stageByTask) {
    let winner: PipelineStageEvent | null = null
    for (const ev of perTask.values()) {
      if (!winner || STATUS_PRECEDENCE[ev.status] > STATUS_PRECEDENCE[winner.status]) {
        winner = ev
      }
    }
    if (winner) pipelineStages.set(stage, winner)
  }

  return { detail, engineeringEvents, pipelineStages, agentRoster }
}

export function useMissionQuery(contextId: string | null | undefined) {
  const query = useMissionDetailQuery(contextId)
  // Memoized so children keep stable identities across poll ticks that
  // return unchanged data (TanStack preserves query.data identity).
  const missionData = useMemo(
    () => (query.data ? deriveMissionData(query.data) : null),
    [query.data]
  )
  return { missionData, isLoading: query.isLoading, error: query.error }
}
