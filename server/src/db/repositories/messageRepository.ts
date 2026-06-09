import type { ChatMessage, PaginatedChatMessages, ParticipantType, UserProfile } from '../../types/contracts.js'
import { query, queryOne } from '../query.js'
import type { Queryable } from '../query.js'

export interface PersistMessageInput {
  id?: string
  channelId: string
  content: string
  clientId?: string | null
  createdAt?: string
  authorParticipantId: string
  authorType: ParticipantType
  userId?: string | null
  agentId?: string | null
  a2aMessageId?: string | null
  metadata?: Record<string, unknown>
}

export interface ListMessagesInput {
  channelId: string
  cursor?: string | null
  limit: number
}

interface MessageRow {
  id: string
  channel_id: string
  user_id: string | null
  content: string
  client_id: string | null
  created_at: string
  author_participant_id: string | null
  author_type: ParticipantType
  agent_id: string | null
  metadata: Record<string, unknown>
  author_display_name: string | null
  author_avatar_url: string | null
  author_color: string | null
}

const MESSAGE_SELECT = `
  m.id,
  m.channel_id,
  m.user_id,
  m.content,
  m.client_id,
  m.created_at,
  m.author_participant_id,
  m.author_type,
  m.agent_id,
  m.metadata,
  p.display_name as author_display_name,
  p.avatar_url as author_avatar_url,
  p.color as author_color
`

function toChatMessage(row: MessageRow): ChatMessage {
  const author: UserProfile | undefined = row.author_display_name
    ? {
        id: row.author_participant_id ?? row.id,
        displayName: row.author_display_name,
        avatarUrl: row.author_avatar_url,
        color: row.author_color ?? '#64748b'
      }
    : undefined
  return {
    id: row.id,
    channelId: row.channel_id,
    userId: row.user_id ?? row.author_participant_id ?? '',
    content: row.content,
    createdAt: row.created_at,
    ...(row.client_id ? { clientId: row.client_id } : {}),
    status: 'sent',
    ...(author ? { user: author } : {})
  }
}

function clampLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) return 50
  return Math.min(limit, 100)
}

export async function persistMessage(input: PersistMessageInput, client?: Queryable): Promise<ChatMessage> {
  const insert = await query<MessageRow>(
    `with inserted as (
       insert into messages (id, channel_id, user_id, content, client_id, created_at,
                             author_participant_id, author_type, agent_id, a2a_message_id, metadata)
       values (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, coalesce($6::timestamptz, now()),
               $7, $8, $9, $10, coalesce($11::jsonb, '{}'::jsonb))
       on conflict (channel_id, client_id) where client_id is not null do nothing
       returning *
     )
     select ${MESSAGE_SELECT}
     from inserted m
     left join participants p on p.id = m.author_participant_id`,
    [
      input.id ?? null,
      input.channelId,
      input.userId ?? null,
      input.content,
      input.clientId ?? null,
      input.createdAt ?? null,
      input.authorParticipantId,
      input.authorType,
      input.agentId ?? null,
      input.a2aMessageId ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null
    ],
    client
  )

  const row = insert[0]
  if (row) return toChatMessage(row)

  // Conflict on (channel_id, client_id): return the already-persisted row.
  if (input.clientId) {
    const existing = await queryOne<MessageRow>(
      `select ${MESSAGE_SELECT} from messages m
       left join participants p on p.id = m.author_participant_id
       where m.channel_id = $1 and m.client_id = $2`,
      [input.channelId, input.clientId],
      client
    )
    if (existing) return toChatMessage(existing)
  }

  throw new Error('Failed to persist chat message')
}

export async function listMessages(input: ListMessagesInput, client?: Queryable): Promise<PaginatedChatMessages> {
  const limit = clampLimit(input.limit)
  const params: unknown[] = [input.channelId, limit + 1]
  let cursorClause = ''
  if (input.cursor) {
    params.push(input.cursor)
    cursorClause = `and m.created_at < $3`
  }

  const rows = await query<MessageRow>(
    `select ${MESSAGE_SELECT}
     from messages m
     left join participants p on p.id = m.author_participant_id
     where m.channel_id = $1 ${cursorClause}
     order by m.created_at desc, m.id desc
     limit $2`,
    params,
    client
  )

  const pageRows = rows.slice(0, limit)
  const nextCursor = rows.length > limit ? pageRows.at(-1)?.created_at ?? null : null
  return {
    items: pageRows.map(toChatMessage),
    nextCursor
  }
}
