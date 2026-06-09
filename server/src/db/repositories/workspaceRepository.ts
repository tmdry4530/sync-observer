import type { Workspace } from '../../types/contracts.js'
import { query, queryOne, withTransaction } from '../query.js'
import type { Queryable } from '../query.js'
import { getHumanParticipantByUserId } from './participantRepository.js'

interface WorkspaceRow {
  id: string
  name: string
  owner_id: string
  invite_code: string
  created_at: string
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    inviteCode: row.invite_code,
    createdAt: row.created_at
  }
}

const WORKSPACE_COLUMNS = `id, name, owner_id, invite_code, created_at`

export async function listWorkspacesForUser(userId: string, client?: Queryable): Promise<Workspace[]> {
  const rows = await query<WorkspaceRow>(
    `select ${WORKSPACE_COLUMNS.split(',').map((c) => `w.${c.trim()}`).join(', ')}
     from workspaces w
     join workspace_members wm on wm.workspace_id = w.id
     where wm.user_id = $1
     order by w.created_at asc`,
    [userId],
    client
  )
  return rows.map(toWorkspace)
}

export async function getWorkspaceById(id: string, client?: Queryable): Promise<Workspace | null> {
  const row = await queryOne<WorkspaceRow>(`select ${WORKSPACE_COLUMNS} from workspaces where id = $1`, [id], client)
  return row ? toWorkspace(row) : null
}

export interface MembershipRow {
  role: string
  member_role: string | null
  participant_id: string | null
}

export async function getMembership(
  workspaceId: string,
  userId: string,
  client?: Queryable
): Promise<MembershipRow | null> {
  return queryOne<MembershipRow>(
    `select role, member_role, participant_id from workspace_members where workspace_id = $1 and user_id = $2`,
    [workspaceId, userId],
    client
  )
}

export async function createWorkspace(input: { name: string; ownerId: string }): Promise<Workspace> {
  const rows = await query<WorkspaceRow>(
    `insert into workspaces (name, owner_id) values ($1, $2) returning ${WORKSPACE_COLUMNS}`,
    [input.name, input.ownerId]
  )
  const row = rows[0]
  if (!row) throw new Error('Failed to create workspace')
  return toWorkspace(row)
}

export async function joinWorkspaceByInviteCode(input: { inviteCode: string; userId: string }): Promise<Workspace | null> {
  return withTransaction(async (client) => {
    const workspace = await queryOne<WorkspaceRow>(
      `select ${WORKSPACE_COLUMNS} from workspaces where upper(invite_code) = upper($1)`,
      [input.inviteCode],
      client
    )
    if (!workspace) return null

    const participant = await getHumanParticipantByUserId(input.userId, client)
    await query(
      `insert into workspace_members (workspace_id, user_id, role, member_role, participant_id)
       values ($1, $2, 'member', 'member', $3)
       on conflict (workspace_id, user_id) do nothing`,
      [workspace.id, input.userId, participant?.id ?? null],
      client
    )
    return toWorkspace(workspace)
  })
}

export async function deleteWorkspace(workspaceId: string, client?: Queryable): Promise<void> {
  await query(`delete from workspaces where id = $1`, [workspaceId], client)
}
