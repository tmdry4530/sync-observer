import type { AgentStatusEvent } from '../../../shared/types/engineeringEvents'
import type { MissionAgentSummary } from '../../../shared/types/missions'

interface AgentRosterProps {
  roster: Map<string, AgentStatusEvent>
  /** Agent profiles from the mission API — joins payload agentIds to display names. */
  agents: MissionAgentSummary[]
}

/**
 * Live emits put the agent's DB id in the payload, which is a UUID — join it
 * to the API's agent profiles for a readable name.  Demo payloads use story
 * slugs ('orchestrator', …) that have no profile and read fine as-is.
 */
function displayName(agentId: string, profile: MissionAgentSummary | undefined): string {
  if (profile) return profile.displayName || profile.slug
  return agentId.length > 10 ? `${agentId.slice(0, 10)}…` : agentId
}

export function AgentRoster({ roster, agents }: AgentRosterProps) {
  const statuses = Array.from(roster.values())
  const profileById = new Map(agents.map((agent) => [agent.agentId, agent]))

  return (
    <section className="mission-roster" aria-label="에이전트 로스터">
      <p className="eyebrow">에이전트</p>
      {statuses.length === 0 ? (
        <p className="mission-empty-note">아직 에이전트 상태가 없습니다.</p>
      ) : (
        <ul className="roster-list">
          {statuses.map((agent) => (
            <li key={agent.agentId} className="roster-row">
              <div className="roster-row-header">
                <span className="roster-agent-id" title={agent.agentId}>
                  {displayName(agent.agentId, profileById.get(agent.agentId))}
                </span>
                <span className={`roster-status roster-status--${agent.status}`}>{agent.status}</span>
              </div>
              <span className="roster-role">{agent.role}</span>
              <span className="roster-action">{agent.currentAction}</span>
              {agent.demo ? <span className="demo-badge">demo</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
