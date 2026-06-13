import type { ServerConfig } from '../config.js'
import type { AuthAgentIdentity, ExternalAgentRegistrationResult } from '../types/contracts.js'
import { fetchAgentCard } from '../a2a/agentCardFetcher.js'
import { assertSafeWebhookUrl } from '../a2a/push.js'
import { withTransaction } from '../db/query.js'
import { createWorkspace, addWorkspaceMember, getWorkspaceById, setWorkspaceOwner } from '../db/repositories/workspaceRepository.js'
import { DEFAULT_AGENTS, ensureDefaultAgents } from '../db/repositories/agentRepository.js'
import {
  createRemoteAgent,
  createRemoteAgentToken,
  getRemoteAgentBySlug,
  setRemoteAgentOwner,
  toRemoteAgentProfile
} from '../db/repositories/remoteAgentRepository.js'
import { ALL_AUTH_SCOPES } from './context.js'
import { slugify } from './agentRegistration.js'
import { generateToken, hashToken, newUuid } from '../utils/crypto.js'

export interface RegisterExternalAgentInput {
  agentCardUrl: string
  displayName?: string
  slug?: string
  workspaceName?: string
  /**
   * When set, the external agent JOINS this existing workspace as a member
   * instead of getting a fresh workspace it owns. The caller resolves an
   * invite code to a real workspace id before calling.
   */
  joinWorkspaceId?: string
}

const RESERVED_INTERNAL_SLUGS = new Set(DEFAULT_AGENTS.map((agent) => agent.slug))

export function toRemoteIdentity(input: {
  id: string
  participantId: string
  workspaceId: string
  name: string
  slug: string
}): AuthAgentIdentity {
  return {
    kind: 'external',
    agentId: input.id,
    participantId: input.participantId,
    workspaceId: input.workspaceId,
    displayName: input.name,
    slug: input.slug
  }
}

async function uniqueRemoteSlug(workspaceId: string, base: string): Promise<string> {
  const root = slugify(base)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`
    if (RESERVED_INTERNAL_SLUGS.has(candidate)) continue
    const existing = await getRemoteAgentBySlug(workspaceId, candidate)
    if (!existing) return candidate
  }
  return `${root}-${newUuid().slice(0, 6)}`
}

/**
 * Provision a Moltbook-style externally-operated agent account. Unlike
 * registerAgent(), the principal is a remote_agents row, not an internal runtime
 * agent. The secret is returned exactly once.
 */
export async function registerExternalAgent(
  config: ServerConfig,
  input: RegisterExternalAgentInput
): Promise<ExternalAgentRegistrationResult> {
  const parsed = await fetchAgentCard(input.agentCardUrl)
  await assertSafeWebhookUrl(parsed.endpointUrl)

  const displayName = (input.displayName?.trim() || parsed.name).slice(0, 120) || 'External Agent'
  const workspaceName = (input.workspaceName?.trim() || `${displayName} Workspace`).slice(0, 120)
  const verifyToken = generateToken(24)

  const joinWorkspaceId = input.joinWorkspaceId

  return withTransaction(async (client) => {
    // Join an existing workspace (invite-code path) vs. provision a new one.
    let workspace
    if (joinWorkspaceId) {
      const target = await getWorkspaceById(joinWorkspaceId, client)
      if (!target) throw new Error(`registerExternalAgent: join workspace ${joinWorkspaceId} not found`)
      workspace = target
    } else {
      workspace = await createWorkspace({ name: workspaceName }, client)
    }
    const slug = await uniqueRemoteSlug(workspace.id, input.slug ?? displayName)
    const created = await createRemoteAgent(
      {
        workspaceId: workspace.id,
        ownerParticipantId: null,
        slug,
        name: displayName,
        description: parsed.description,
        agentCardUrl: input.agentCardUrl,
        endpointUrl: parsed.endpointUrl,
        protocolVersion: parsed.protocolVersion,
        skills: parsed.skills,
        capabilities: parsed.capabilities,
        verificationTokenHash: hashToken(verifyToken, config.agentTokenPepper)
      },
      client
    )
    await setRemoteAgentOwner(created.agent.id, created.participantId, client)
    if (joinWorkspaceId) {
      // Joining agents are members; the workspace keeps its owner and roster.
      await addWorkspaceMember({ workspaceId: workspace.id, participantId: created.participantId, role: 'member' }, client)
    } else {
      await setWorkspaceOwner(workspace.id, created.participantId, client)
      await addWorkspaceMember({ workspaceId: workspace.id, participantId: created.participantId, role: 'owner' }, client)
      await ensureDefaultAgents(workspace.id, client)
    }
    const token = await createRemoteAgentToken(
      { remoteAgentId: created.agent.id, scopes: [...ALL_AUTH_SCOPES], pepper: config.agentTokenPepper },
      client
    )
    const agent = { ...created.agent, owner_participant_id: created.participantId }
    const identity = toRemoteIdentity({
      id: agent.id,
      participantId: created.participantId,
      workspaceId: workspace.id,
      name: agent.name,
      slug: agent.slug
    })

    return {
      credential: { agentId: agent.id, secret: token.token },
      identity,
      // New workspaces are owned by the registrant; joined ones keep their owner.
      workspace: joinWorkspaceId ? workspace : { ...workspace, ownerParticipantId: created.participantId },
      agent: toRemoteAgentProfile(agent),
      verification: {
        type: 'well-known',
        url: `${new URL(parsed.endpointUrl).origin}/.well-known/syncspace-verify.txt`,
        token: `syncspace-verify=${verifyToken}`
      }
    }
  })
}
