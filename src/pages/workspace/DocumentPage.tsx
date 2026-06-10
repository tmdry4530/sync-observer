import { useParams } from 'react-router-dom'
import { EditorPanel } from '../../features/editor/components/EditorPanel'
import { useDocumentsQuery } from '../../features/documents/queries/useDocumentsQuery'

export function DocumentPage() {
  const { workspaceId, documentId } = useParams()
  const { data: documents = [] } = useDocumentsQuery(workspaceId)
  const documentTitle = documents.find((document) => document.id === documentId)?.title

  if (!workspaceId || !documentId) return <div className="page-state">문서 경로가 올바르지 않습니다.</div>
  return <EditorPanel workspaceId={workspaceId} documentId={documentId} documentTitle={documentTitle} documents={documents} readOnly />
}
