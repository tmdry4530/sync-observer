import type { Channel } from '../../types/contracts.js'
import { query, queryOne } from '../query.js'
import type { Queryable } from '../query.js'

interface ChannelRow {
  id: string
  workspace_id: string
  name: string
  created_by: string
  created_at: string
}

function toChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at
  }
}

const CHANNEL_COLUMNS = `id, workspace_id, name, created_by, created_at`

export async function listChannels(workspaceId: string, client?: Queryable): Promise<Channel[]> {
  const rows = await query<ChannelRow>(
    `select ${CHANNEL_COLUMNS} from channels where workspace_id = $1 order by created_at asc`,
    [workspaceId],
    client
  )
  return rows.map(toChannel)
}

export async function getChannelById(id: string, client?: Queryable): Promise<Channel | null> {
  const row = await queryOne<ChannelRow>(`select ${CHANNEL_COLUMNS} from channels where id = $1`, [id], client)
  return row ? toChannel(row) : null
}

export async function getChannelWorkspaceId(channelId: string, client?: Queryable): Promise<string | null> {
  const row = await queryOne<{ workspace_id: string }>(
    `select workspace_id from channels where id = $1`,
    [channelId],
    client
  )
  return row?.workspace_id ?? null
}

export async function createChannel(
  input: { workspaceId: string; name: string; createdBy: string },
  client?: Queryable
): Promise<Channel> {
  const rows = await query<ChannelRow>(
    `insert into channels (workspace_id, name, created_by) values ($1, $2, $3) returning ${CHANNEL_COLUMNS}`,
    [input.workspaceId, input.name, input.createdBy],
    client
  )
  const row = rows[0]
  if (!row) throw new Error('Failed to create channel')
  return toChannel(row)
}
