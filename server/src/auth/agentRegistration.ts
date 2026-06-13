import type { ServerConfig } from '../config.js'
import type { AgentRegistrationResult, AgentRole, AuthAgentIdentity } from '../types/contracts.js'
import { withTransaction } from '../db/query.js'
import {
  createAgent,
  createAgentToken,
  ensureDefaultAgents,
  getAgentBySlug,
  type AgentWithParticipant
} from '../db/repositories/agentRepository.js'
import { addWorkspaceMember, createWorkspace, getWorkspaceById, setWorkspaceOwner } from '../db/repositories/workspaceRepository.js'
import type { Queryable } from '../db/query.js'
import { newUuid } from '../utils/crypto.js'
import { ALL_AUTH_SCOPES } from './context.js'

const VALID_ROLES: AgentRole[] = ['planner', 'builder', 'reviewer', 'doc_writer', 'orchestrator']

export interface RegisterAgentInput {
  displayName: string
  slug?: string
  role?: AgentRole
  description?: string | null
  color?: string
  workspaceName?: string
  /**
   * When set, the agent JOINS this existing workspace as a member instead of
   * getting a fresh workspace it owns. The caller is responsible for resolving
   * an invite code to a real workspace id before calling.
   */
  joinWorkspaceId?: string
}

/** Pick a slug unique within the target workspace (agents.(workspace_id, slug) is unique). */
async function uniqueInternalSlug(workspaceId: string, base: string, client: Queryable): Promise<string> {
  const root = slugify(base)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`
    const existing = await getAgentBySlug(workspaceId, candidate, client)
    if (!existing) return candidate
  }
  return `${root}-${newUuid().slice(0, 6)}`
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base || 'agent'
}

export function toIdentity(agent: AgentWithParticipant): AuthAgentIdentity {
  return {
    kind: 'internal',
    agentId: agent.id,
    participantId: agent.participant_id,
    workspaceId: agent.workspace_id,
    displayName: agent.display_name,
    slug: agent.slug,
    role: agent.role
  }
}

/**
 * Provision a freshly-registered agent: a workspace it owns, the agent + its
 * participant, an owner membership, the default collaborator roster, and an
 * agent token (the secret) granting all scopes. Returns the secret exactly once.
 */
export async function registerAgent(config: ServerConfig, input: RegisterAgentInput): Promise<AgentRegistrationResult> {
  const displayName = input.displayName.trim().slice(0, 80) || 'Agent'
  const role: AgentRole = input.role && VALID_ROLES.includes(input.role) ? input.role : 'planner'
  const workspaceName = (input.workspaceName?.trim() || `${displayName} Workspace`).slice(0, 120)
  const joinWorkspaceId = input.joinWorkspaceId

  return withTransaction(async (client) => {
    // Join an existing workspace (invite-code path) vs. provision a new one.
    let workspace
    if (joinWorkspaceId) {
      const target = await getWorkspaceById(joinWorkspaceId, client)
      if (!target) throw new Error(`registerAgent: join workspace ${joinWorkspaceId} not found`)
      workspace = target
    } else {
      workspace = await createWorkspace({ name: workspaceName }, client)
    }

    // Slug must be unique within the (possibly pre-populated) target workspace.
    const slug = await uniqueInternalSlug(workspace.id, input.slug ?? displayName, client)
    const agent = await createAgent(
      {
        workspaceId: workspace.id,
        slug,
        displayName,
        role,
        description: input.description ?? null,
        ...(input.color ? { color: input.color } : {})
      },
      client
    )

    if (joinWorkspaceId) {
      // Joining agents are members, not owners; the workspace already has its roster.
      await addWorkspaceMember({ workspaceId: workspace.id, participantId: agent.participant_id, role: 'member' }, client)
    } else {
      await setWorkspaceOwner(workspace.id, agent.participant_id, client)
      await addWorkspaceMember({ workspaceId: workspace.id, participantId: agent.participant_id, role: 'owner' }, client)
      // Seed collaborators; skips the registered agent's slug if it collides.
      await ensureDefaultAgents(workspace.id, client)
    }

    const token = await createAgentToken(
      { agentId: agent.id, scopes: [...ALL_AUTH_SCOPES], pepper: config.agentTokenPepper },
      client
    )

    return {
      credential: { agentId: agent.id, secret: token.token },
      identity: toIdentity(agent),
      // New workspaces are owned by the registrant; joined ones keep their owner.
      workspace: joinWorkspaceId ? workspace : { ...workspace, ownerParticipantId: agent.participant_id }
    }
  })
}
