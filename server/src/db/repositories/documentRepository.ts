import type { DocumentMeta } from '../../types/contracts.js'
import { query, queryOne } from '../query.js'
import type { Queryable } from '../query.js'

interface DocumentRow {
  id: string
  workspace_id: string
  title: string
  created_by: string
  updated_at: string
}

function toDocument(row: DocumentRow): DocumentMeta {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    createdBy: row.created_by,
    updatedAt: row.updated_at
  }
}

const DOCUMENT_COLUMNS = `id, workspace_id, title, created_by, updated_at`

export async function listDocuments(workspaceId: string, client?: Queryable): Promise<DocumentMeta[]> {
  const rows = await query<DocumentRow>(
    `select ${DOCUMENT_COLUMNS} from documents where workspace_id = $1 order by updated_at desc`,
    [workspaceId],
    client
  )
  return rows.map(toDocument)
}

export async function getDocumentById(id: string, client?: Queryable): Promise<DocumentMeta | null> {
  const row = await queryOne<DocumentRow>(`select ${DOCUMENT_COLUMNS} from documents where id = $1`, [id], client)
  return row ? toDocument(row) : null
}

export async function getDocumentWorkspaceId(documentId: string, client?: Queryable): Promise<string | null> {
  const row = await queryOne<{ workspace_id: string }>(
    `select workspace_id from documents where id = $1`,
    [documentId],
    client
  )
  return row?.workspace_id ?? null
}

export async function createDocument(
  input: { workspaceId: string; title: string; createdBy: string },
  client?: Queryable
): Promise<DocumentMeta> {
  const rows = await query<DocumentRow>(
    `insert into documents (workspace_id, title, created_by) values ($1, $2, $3) returning ${DOCUMENT_COLUMNS}`,
    [input.workspaceId, input.title, input.createdBy],
    client
  )
  const row = rows[0]
  if (!row) throw new Error('Failed to create document')
  return toDocument(row)
}

export async function touchDocument(documentId: string, client?: Queryable): Promise<void> {
  await query(`update documents set updated_at = now() where id = $1`, [documentId], client)
}
