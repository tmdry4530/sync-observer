import type { AgentProfile, AgentRole, AgentRuntimeStatus } from '../../types/contracts.js'
import { generateToken, hashToken } from '../../utils/crypto.js'
import { query, queryOne, withTransaction } from '../query.js'
import type { Queryable } from '../query.js'

export interface AgentRow {
  id: string
  workspace_id: string
  slug: string
  display_name: string
  description: string | null
  role: AgentRole
  status: AgentRuntimeStatus
  model_provider: string | null
  model_name: string | null
  system_policy: Record<string, unknown>
  agent_card: Record<string, unknown>
  /**
   * The IDENTITY (a participant) that owns/acts through this agent. For a
   * self-owning agent it equals this agent's own participant; for a presence
   * agent (an existing identity joined into another workspace) it is the joining
   * identity's home participant. Nullable only transiently / on identity delete.
   */
  credential_participant_id: string | null
  created_at: string
  updated_at: string
}

export interface AgentWithParticipant extends AgentRow {
  participant_id: string
}

const AGENT_SELECT = `
  a.id, a.workspace_id, a.slug, a.display_name, a.description, a.role, a.status,
  a.model_provider, a.model_name, a.system_policy, a.agent_card,
  a.credential_participant_id, a.created_at, a.updated_at,
  p.id as participant_id
`

export function toAgentProfile(row: AgentWithParticipant): AgentProfile {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    participantId: row.participant_id,
    slug: row.slug,
    displayName: row.display_name,
    description: row.description,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function listAgents(workspaceId: string, client?: Queryable): Promise<AgentWithParticipant[]> {
  return query<AgentWithParticipant>(
    `select ${AGENT_SELECT}
     from agents a
     join participants p on p.agent_id = a.id
     where a.workspace_id = $1
     order by a.created_at asc`,
    [workspaceId],
    client
  )
}

export async function getAgentById(id: string, client?: Queryable): Promise<AgentWithParticipant | null> {
  return queryOne<AgentWithParticipant>(
    `select ${AGENT_SELECT} from agents a join participants p on p.agent_id = a.id where a.id = $1`,
    [id],
    client
  )
}

export async function getAgentBySlug(
  workspaceId: string,
  slug: string,
  client?: Queryable
): Promise<AgentWithParticipant | null> {
  return queryOne<AgentWithParticipant>(
    `select ${AGENT_SELECT} from agents a join participants p on p.agent_id = a.id
     where a.workspace_id = $1 and a.slug = $2`,
    [workspaceId, slug],
    client
  )
}

export interface CreateAgentInput {
  workspaceId: string
  slug: string
  displayName: string
  role: AgentRole
  description?: string | null
  color?: string
  modelProvider?: string | null
  modelName?: string | null
  systemPolicy?: Record<string, unknown>
  agentCard?: Record<string, unknown>
  /**
   * The owning identity (participant) for this agent. Omit for a self-owning
   * agent (defaults to the just-created participant); set it to make this a
   * PRESENCE agent acted through an existing identity in another workspace.
   */
  credentialParticipantId?: string
}

/** Create an agent and its agent participant atomically. */
export async function createAgent(input: CreateAgentInput, outerClient?: Queryable): Promise<AgentWithParticipant> {
  const run = async (client: Queryable): Promise<AgentWithParticipant> => {
    const agentRows = await query<AgentRow>(
      `insert into agents (workspace_id, slug, display_name, description, role, model_provider, model_name, system_policy, agent_card)
       values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::jsonb, '{}'::jsonb), coalesce($9::jsonb, '{}'::jsonb))
       returning *`,
      [
        input.workspaceId,
        input.slug,
        input.displayName,
        input.description ?? null,
        input.role,
        input.modelProvider ?? null,
        input.modelName ?? null,
        input.systemPolicy ? JSON.stringify(input.systemPolicy) : null,
        input.agentCard ? JSON.stringify(input.agentCard) : null
      ],
      client
    )
    const agent = agentRows[0]
    if (!agent) throw new Error('Failed to create agent')

    const participantRows = await query<{ id: string }>(
      `insert into participants (participant_type, agent_id, display_name, color)
       values ('agent', $1, $2, $3)
       returning id`,
      [agent.id, agent.display_name, input.color ?? '#0ea5e9'],
      client
    )
    const participantId = participantRows[0]?.id
    if (!participantId) throw new Error('Failed to create agent participant')

    // Stamp the owning identity. A self-owning agent points at its own
    // participant; a presence agent points at the joining identity's participant.
    const credentialParticipantId = input.credentialParticipantId ?? participantId
    await query(
      `update agents set credential_participant_id = $1 where id = $2`,
      [credentialParticipantId, agent.id],
      client
    )

    return { ...agent, credential_participant_id: credentialParticipantId, participant_id: participantId }
  }
  return outerClient ? run(outerClient) : withTransaction(run)
}

/**
 * Resolve the agent that the given IDENTITY (a participant) acts through in a
 * specific workspace. Returns the identity's home agent in its home workspace,
 * or its presence agent in a joined workspace, or null if it has no presence
 * there yet. (credential_participant_id, workspace_id) is unique, so at most one.
 */
export async function getAgentByCredentialIdentity(
  credentialParticipantId: string,
  workspaceId: string,
  client?: Queryable
): Promise<AgentWithParticipant | null> {
  return queryOne<AgentWithParticipant>(
    `select ${AGENT_SELECT} from agents a join participants p on p.agent_id = a.id
     where a.credential_participant_id = $1 and a.workspace_id = $2`,
    [credentialParticipantId, workspaceId],
    client
  )
}

export async function updateAgentStatus(
  agentId: string,
  status: AgentRuntimeStatus,
  client?: Queryable
): Promise<void> {
  await query(`update agents set status = $2, updated_at = now() where id = $1`, [agentId, status], client)
}

/** Mint an agent token, returning the raw secret once. Only the hash is stored. */
export async function createAgentToken(
  input: { agentId: string; scopes: string[]; pepper: string | null; expiresAt?: Date },
  client?: Queryable
): Promise<{ id: string; token: string }> {
  const token = generateToken(32)
  const tokenHash = hashToken(token, input.pepper)
  const rows = await query<{ id: string }>(
    `insert into agent_tokens (agent_id, token_hash, scopes, expires_at)
     values ($1, $2, $3::text[], $4)
     returning id`,
    [input.agentId, tokenHash, input.scopes, input.expiresAt ? input.expiresAt.toISOString() : null],
    client
  )
  const id = rows[0]?.id
  if (!id) throw new Error('Failed to create agent token')
  return { id, token }
}

export interface DefaultAgentSpec {
  slug: string
  displayName: string
  role: AgentRole
  description: string
  color: string
}

export const DEFAULT_AGENTS: DefaultAgentSpec[] = [
  { slug: 'planner', displayName: 'Planner', role: 'planner', description: '요구사항과 구현 계획을 작성합니다.', color: '#7c3aed' },
  { slug: 'builder', displayName: 'Builder', role: 'builder', description: '계획을 바탕으로 변경안을 제안합니다.', color: '#0891b2' },
  { slug: 'reviewer', displayName: 'Reviewer', role: 'reviewer', description: '보안/권한/리스크를 검토합니다.', color: '#dc2626' },
  { slug: 'doc', displayName: 'DocWriter', role: 'doc_writer', description: '문서에 결과를 정리합니다.', color: '#16a34a' },
  { slug: 'orchestrator', displayName: 'Orchestrator', role: 'orchestrator', description: '에이전트 협업을 조율합니다.', color: '#ea580c' }
]

/** Ensure the default agent roster exists for a workspace (idempotent). */
export async function ensureDefaultAgents(workspaceId: string, client?: Queryable): Promise<AgentWithParticipant[]> {
  const result: AgentWithParticipant[] = []
  for (const spec of DEFAULT_AGENTS) {
    const existing = await getAgentBySlug(workspaceId, spec.slug, client)
    if (existing) {
      result.push(existing)
      continue
    }
    result.push(
      await createAgent(
        {
          workspaceId,
          slug: spec.slug,
          displayName: spec.displayName,
          role: spec.role,
          description: spec.description,
          color: spec.color
        },
        client
      )
    )
  }
  return result
}
