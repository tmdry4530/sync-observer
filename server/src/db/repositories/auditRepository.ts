import { query } from '../query.js'
import type { Queryable } from '../query.js'

export interface AuditLogInput {
  workspaceId?: string | null
  actorParticipantId?: string | null
  action: string
  resourceType: string
  resourceId?: string | null
  metadata?: Record<string, unknown>
  ipHash?: string | null
  userAgent?: string | null
}

export async function writeAuditLog(input: AuditLogInput, client?: Queryable): Promise<void> {
  await query(
    `insert into audit_logs
       (workspace_id, actor_participant_id, action, resource_type, resource_id, metadata, ip_hash, user_agent)
     values ($1, $2, $3, $4, $5, coalesce($6::jsonb, '{}'::jsonb), $7, $8)`,
    [
      input.workspaceId ?? null,
      input.actorParticipantId ?? null,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.ipHash ?? null,
      input.userAgent ?? null
    ],
    client
  )
}
