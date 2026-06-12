import { useMissionDetailQuery } from '../queries/useMissionDetailQuery'
import type { MissionDetailResponse, MissionEvent } from '../../../shared/types/missions'
import type { TaskEvent } from '../../../shared/types/contracts'
import {
  type EngineeringEvent,
  type PipelineStageEvent,
  type AgentStatusEvent,
  parseEngineeringEvent,
  isEngineeringEventKind
} from '../../../shared/types/engineeringEvents'

export interface EngineeringMissionEvent extends TaskEvent {
  engineeringEvent: EngineeringEvent
}

/** @deprecated use EngineeringMissionEvent — kept for backward compat with existing renderers */
export type EngineeringTaskEvent = EngineeringMissionEvent

export interface MissionData {
  detail: MissionDetailResponse
  /** All engineering events in seq order */
  engineeringEvents: EngineeringMissionEvent[]
  /** Latest pipeline_stage per stage name */
  pipelineStages: Map<string, PipelineStageEvent>
  /** Latest agent_status per agentId */
  agentRoster: Map<string, AgentStatusEvent>
}

function missionEventToTaskEvent(ev: MissionEvent): TaskEvent {
  return {
    seq: ev.seq,
    type: ev.type,
    createdAt: ev.createdAt,
    payload: ev.payload
  }
}

function unwrapEvent(ev: TaskEvent): EngineeringEvent | null {
  if (!isEngineeringEventKind(ev.type)) return null
  const payload = ev.payload as Record<string, unknown> | null
  if (!payload) return null
  // Payload shape: { engineeringEvent: <EngineeringEvent> }
  const inner = payload['engineeringEvent'] ?? payload
  return parseEngineeringEvent(inner)
}

function deriveMissionData(detail: MissionDetailResponse): MissionData {
  const engineeringEvents: EngineeringMissionEvent[] = []
  const pipelineStages = new Map<string, PipelineStageEvent>()
  const agentRoster = new Map<string, AgentStatusEvent>()

  for (const mev of detail.events) {
    const ev = missionEventToTaskEvent(mev)
    const eng = unwrapEvent(ev)
    if (!eng) continue
    engineeringEvents.push({ ...ev, engineeringEvent: eng })

    if (eng.kind === 'pipeline_stage') {
      // Keep latest (highest seq) per stage
      pipelineStages.set(eng.stage, eng)
    }
    if (eng.kind === 'agent_status') {
      agentRoster.set(eng.agentId, eng)
    }
  }

  return { detail, engineeringEvents, pipelineStages, agentRoster }
}

export function useMissionQuery(contextId: string | null | undefined) {
  const query = useMissionDetailQuery(contextId)
  const missionData = query.data ? deriveMissionData(query.data) : null
  return { ...query, missionData }
}
