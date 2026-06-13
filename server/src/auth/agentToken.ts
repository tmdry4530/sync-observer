import type { ServerConfig } from '../config.js'
import { hashToken } from '../utils/crypto.js'
import { queryOne, query } from '../db/query.js'
import type { AgentTokenContext } from './context.js'

interface AgentTokenRow {
  token_id: string
  agent_id: string
  slug: string
  workspace_id: string
  participant_id: string | null
  credential_participant_id: string | null
  display_name: string | null
  scopes: string[]
}

interface RemoteAgentTokenRow {
  token_id: string
  remote_agent_id: string
  workspace_id: string
  participant_id: string | null
  display_name: string | null
  slug: string
  scopes: string[]
}

/**
 * Resolve a raw agent bearer token to its scoped context. Tokens are stored as
 * peppered SHA-256 hashes; only non-revoked, non-expired tokens resolve.
 */
export async function resolveAgentToken(config: ServerConfig, token: string): Promise<AgentTokenContext | null> {
  const tokenHash = hashToken(token, config.agentTokenPepper)
  const row = await queryOne<AgentTokenRow>(
    `select t.id as token_id, a.id as agent_id, a.slug, a.workspace_id, p.id as participant_id,
            a.credential_participant_id, p.display_name, t.scopes
     from agent_tokens t
     join agents a on a.id = t.agent_id
     left join participants p on p.agent_id = a.id
     where t.token_hash = $1
       and t.revoked_at is null
       and (t.expires_at is null or t.expires_at > now())`,
    [tokenHash]
  )
  if (row?.participant_id) {
    void query(`update agent_tokens set last_used_at = now() where id = $1`, [row.token_id]).catch(() => undefined)

    return {
      principalType: 'internal_agent',
      tokenId: row.token_id,
      agentId: row.agent_id,
      remoteAgentId: null,
      participantId: row.participant_id,
      // The owning identity; falls back to the agent's own participant for any
      // pre-backfill row (defensive — the 0021 backfill makes this always set).
      credentialParticipantId: row.credential_participant_id ?? row.participant_id,
      workspaceId: row.workspace_id,
      displayName: row.display_name ?? 'Agent',
      slug: row.slug,
      scopes: row.scopes ?? [],
      // Default actor; HTTP middleware downgrades to 'human' for cookie sessions.
      actor: 'agent'
    }
  }

  const remote = await queryOne<RemoteAgentTokenRow>(
    `select t.id as token_id, r.id as remote_agent_id, r.workspace_id, p.id as participant_id,
            p.display_name, r.slug, t.scopes
     from remote_agent_tokens t
     join remote_agents r on r.id = t.remote_agent_id
     left join participants p on p.remote_agent_id = r.id
     where t.token_hash = $1
       and t.revoked_at is null
       and (t.expires_at is null or t.expires_at > now())`,
    [tokenHash]
  )
  if (!remote?.participant_id) return null

  void query(`update remote_agent_tokens set last_used_at = now() where id = $1`, [remote.token_id]).catch(() => undefined)

  return {
    principalType: 'remote_agent',
    tokenId: remote.token_id,
    agentId: null,
    remoteAgentId: remote.remote_agent_id,
    participantId: remote.participant_id,
    // Remote agents are pinned to their single workspace; the credential identity
    // is simply the remote participant itself (no multi-workspace presence).
    credentialParticipantId: remote.participant_id,
    workspaceId: remote.workspace_id,
    displayName: remote.display_name ?? 'Remote Agent',
    slug: remote.slug,
    scopes: remote.scopes ?? [],
    actor: 'agent'
  }
}
