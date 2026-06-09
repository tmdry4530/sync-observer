import type { ServerConfig } from '../config.js'
import { hashToken } from '../utils/crypto.js'
import { queryOne, query } from '../db/query.js'
import type { AgentTokenContext } from './context.js'

interface AgentTokenRow {
  token_id: string
  agent_id: string
  workspace_id: string
  participant_id: string | null
  scopes: string[]
}

/**
 * Resolve a raw agent bearer token to its scoped context. Tokens are stored as
 * peppered SHA-256 hashes; only non-revoked, non-expired tokens resolve.
 */
export async function resolveAgentToken(config: ServerConfig, token: string): Promise<AgentTokenContext | null> {
  const tokenHash = hashToken(token, config.agentTokenPepper)
  const row = await queryOne<AgentTokenRow>(
    `select t.id as token_id, a.id as agent_id, a.workspace_id, p.id as participant_id, t.scopes
     from agent_tokens t
     join agents a on a.id = t.agent_id
     left join participants p on p.agent_id = a.id
     where t.token_hash = $1
       and t.revoked_at is null
       and (t.expires_at is null or t.expires_at > now())`,
    [tokenHash]
  )
  if (!row || !row.participant_id) return null

  void query(`update agent_tokens set last_used_at = now() where id = $1`, [row.token_id]).catch(() => undefined)

  return {
    tokenId: row.token_id,
    agentId: row.agent_id,
    participantId: row.participant_id,
    workspaceId: row.workspace_id,
    scopes: row.scopes ?? []
  }
}
