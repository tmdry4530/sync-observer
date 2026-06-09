import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { getPool } from './pool.js'

export type Queryable = Pick<Pool | PoolClient, 'query'>

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client?: Queryable
): Promise<T[]> {
  const db = client ?? getPool()
  const result = await db.query<T>(text, params as never[])
  return result.rows
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client?: Queryable
): Promise<T | null> {
  const rows = await query<T>(text, params, client)
  return rows[0] ?? null
}

export async function execute(text: string, params: unknown[] = [], client?: Queryable): Promise<number> {
  const db = client ?? getPool()
  const result = await db.query(text, params as never[])
  return result.rowCount ?? 0
}

/**
 * Run `fn` inside a transaction. The provided client is dedicated to the
 * transaction; pass it down to repository helpers so every write in a single
 * task/status/event update commits or rolls back atomically.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
