import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { startEmbeddedDatabase, type EmbeddedDatabase } from './helpers/embeddedPostgres.js'
import { setPool } from '../src/db/pool.js'
import { createLogger } from '../src/utils/logger.js'
import { registerAgentFixture } from './helpers/agentFixture.js'
import { createChannel } from '../src/db/repositories/channelRepository.js'
import { createDocument } from '../src/db/repositories/documentRepository.js'
import { createPostgresMessagePersistenceAdapter } from '../src/persistence/messagePersistencePg.js'
import { createChatRoomPersistenceHooks, CHAT_MESSAGES_ARRAY } from '../src/realtime/chatRoom.js'
import { PostgresDocStorage } from '../src/realtime/docPersistence.js'

let db: EmbeddedDatabase

beforeAll(async () => {
  db = await startEmbeddedDatabase()
  setPool(db.pool, { external: true })
}, 90_000)

afterAll(async () => {
  await db?.stop()
})

describe('realtime persistence (Postgres)', () => {
  it('persists chat messages authored by an agent participant', async () => {
    const reg = await registerAgentFixture({ displayName: 'Msg Agent', slug: 'msg-agent' })
    const workspaceId = reg.identity.workspaceId
    const participantId = reg.identity.participantId
    const channel = await createChannel({ workspaceId, name: 'general', createdBy: participantId })

    const adapter = createPostgresMessagePersistenceAdapter()
    const persisted = await adapter.persistMessage({
      channelId: channel.id,
      authorParticipantId: participantId,
      content: 'hello world',
      clientId: 'client-1',
      authorType: 'agent'
    })
    expect(persisted.content).toBe('hello world')

    const row = await db.pool.query<{ author_participant_id: string | null; author_type: string }>(
      `select author_participant_id, author_type from messages where id = $1`,
      [persisted.id]
    )
    expect(row.rows[0]?.author_participant_id).toBe(participantId)
    expect(row.rows[0]?.author_type).toBe('agent')

    // Idempotent on (channel_id, client_id).
    const again = await adapter.persistMessage({
      channelId: channel.id,
      authorParticipantId: participantId,
      content: 'hello world',
      clientId: 'client-1',
      authorType: 'agent'
    })
    expect(again.id).toBe(persisted.id)

    const list = await adapter.listMessages({ channelId: channel.id, limit: 10 })
    expect(list.items).toHaveLength(1)
    expect(list.items[0]?.user?.displayName).toBe('Msg Agent')
  })

  it('persists and restores a Yjs document snapshot from Postgres', async () => {
    const reg = await registerAgentFixture({ displayName: 'Doc Agent', slug: 'doc-agent' })
    const workspaceId = reg.identity.workspaceId
    const document = await createDocument({ workspaceId, title: 'Spec', createdBy: reg.identity.participantId })
    const roomName = `doc:${workspaceId}:${document.id}`

    const source = new Y.Doc()
    source.getText('content').insert(0, 'Persisted in Postgres')
    const update = Y.encodeStateAsUpdate(source)

    const backend = new PostgresDocStorage(createLogger('silent'))
    await backend.write(roomName, update)

    const restoredUpdate = await backend.read(roomName)
    expect(restoredUpdate).not.toBeNull()

    const target = new Y.Doc()
    Y.applyUpdate(target, restoredUpdate!)
    expect(target.getText('content').toString()).toBe('Persisted in Postgres')

    // A second write bumps the version (upsert).
    source.getText('content').insert(source.getText('content').length, '!')
    await backend.write(roomName, Y.encodeStateAsUpdate(source))
    const versionRow = await db.pool.query<{ version: string }>(
      `select version from yjs_document_snapshots where room_name = $1`,
      [roomName]
    )
    expect(Number(versionRow.rows[0]?.version)).toBeGreaterThanOrEqual(2)
  })
})

describe('realtime chat authorship enforcement', () => {
  it('persists WS messages with the authenticated connection identity, ignoring spoofed authorship', async () => {
    const attacker = await registerAgentFixture({ displayName: 'Attacker Agent', slug: 'attacker-agent' })
    const victim = await registerAgentFixture({ displayName: 'Victim Agent', slug: 'victim-agent' })
    const workspaceId = attacker.identity.workspaceId
    const channel = await createChannel({
      workspaceId,
      name: 'sec-channel',
      createdBy: attacker.identity.participantId
    })
    const otherChannel = await createChannel({
      workspaceId,
      name: 'sec-other',
      createdBy: attacker.identity.participantId
    })
    const roomName = `chat:${workspaceId}:${channel.id}`

    const adapter = createPostgresMessagePersistenceAdapter()
    const hooks = createChatRoomPersistenceHooks(adapter, createLogger('silent'))
    // Stands in for the authenticated WebSocket: y-websocket applies client
    // updates with the connection object as Yjs transaction origin.
    const conn = {}
    hooks.registerConnection(conn, {
      participantId: attacker.identity.participantId,
      agentId: attacker.identity.agentId,
      authorType: 'agent',
      spectator: false
    })

    const ydoc = new Y.Doc()
    hooks.bind(roomName, ydoc)

    const spoofedId = randomUUID()
    ydoc.transact(() => {
      ydoc.getArray(CHAT_MESSAGES_ARRAY).push([
        {
          id: spoofedId,
          channelId: otherChannel.id, // cross-channel injection attempt
          content: 'forged authorship',
          clientId: 'spoof-1',
          authorParticipantId: victim.identity.participantId, // impersonation attempt
          authorType: 'agent',
          agentId: victim.identity.agentId, // forged internal-agent attribution
          metadata: { source: 'remote_agent' } // forged provenance
        }
      ])
    }, conn)
    await hooks.flush(roomName, ydoc)

    const row = await db.pool.query<{
      channel_id: string
      author_participant_id: string | null
      author_type: string
      agent_id: string | null
      metadata: Record<string, unknown>
    }>(
      `select channel_id, author_participant_id, author_type, agent_id, metadata from messages where id = $1`,
      [spoofedId]
    )
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0]?.channel_id).toBe(channel.id)
    expect(row.rows[0]?.author_participant_id).toBe(attacker.identity.participantId)
    expect(row.rows[0]?.author_type).toBe('agent')
    expect(row.rows[0]?.agent_id).toBe(attacker.identity.agentId)
    expect(row.rows[0]?.metadata).toEqual({})
  })

  it('drops WS messages whose inserts did not come from an authenticated connection', async () => {
    const reg = await registerAgentFixture({ displayName: 'Bystander Agent', slug: 'bystander-agent' })
    const workspaceId = reg.identity.workspaceId
    const channel = await createChannel({ workspaceId, name: 'sec-noauth', createdBy: reg.identity.participantId })
    const roomName = `chat:${workspaceId}:${channel.id}`

    const adapter = createPostgresMessagePersistenceAdapter()
    const hooks = createChatRoomPersistenceHooks(adapter, createLogger('silent'))

    const ydoc = new Y.Doc()
    hooks.bind(roomName, ydoc)

    const messageId = randomUUID()
    // No transaction origin: the insert is not attributable to any connection.
    ydoc.getArray(CHAT_MESSAGES_ARRAY).push([
      {
        id: messageId,
        channelId: channel.id,
        content: 'unattributed message',
        clientId: 'noauth-1',
        authorParticipantId: reg.identity.participantId,
        authorType: 'agent'
      }
    ])
    await hooks.flush(roomName, ydoc)

    const row = await db.pool.query(`select id from messages where id = $1`, [messageId])
    expect(row.rows).toHaveLength(0)
  })
})
