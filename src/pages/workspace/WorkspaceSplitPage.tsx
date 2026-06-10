import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { EyeOff } from 'lucide-react'
import { ChatPanel } from '../../features/chat/components/ChatPanel'
import { useChannelsQuery } from '../../features/channel/queries/useChannelsQuery'
import { EditorPanel } from '../../features/editor/components/EditorPanel'
import { useDocumentsQuery } from '../../features/documents/queries/useDocumentsQuery'
import { usePresenceUiStore } from '../../shared/stores/presenceStore'
import { useWorkspaceUiStore } from '../../shared/stores/workspaceUiStore'

export function WorkspaceSplitPage() {
  const { workspaceId, channelId, documentId } = useParams()
  const rememberedChannelId = useWorkspaceUiStore((state) => state.currentChannelId)
  const rememberedDocumentId = useWorkspaceUiStore((state) => state.currentDocumentId)
  const setChannelId = useWorkspaceUiStore((state) => state.setCurrentChannelId)
  const setDocumentId = useWorkspaceUiStore((state) => state.setCurrentDocumentId)
  const presenceCount = usePresenceUiStore((state) => state.states.length)
  const { data: channels = [], isLoading: channelsLoading } = useChannelsQuery(workspaceId)
  const { data: documents = [], isLoading: documentsLoading } = useDocumentsQuery(workspaceId)
  const [bannerDismissed, setBannerDismissed] = useState(() => readHelpDismissed())
  const [chatWidth, setChatWidth] = useState(40)
  const [isDragging, setIsDragging] = useState(false)
  const [activeMobilePane, setActiveMobilePane] = useState<'chat' | 'document'>('chat')

  const preferredChannelId = channelId ?? rememberedChannelId
  const preferredDocumentId = documentId ?? rememberedDocumentId

  const selectedChannel = useMemo(() => {
    if (preferredChannelId) {
      const preferred = channels.find((channel) => channel.id === preferredChannelId)
      if (preferred) return preferred
    }
    return channels[0] ?? null
  }, [channels, preferredChannelId])

  const selectedDocument = useMemo(() => {
    if (preferredDocumentId) {
      const preferred = documents.find((document) => document.id === preferredDocumentId)
      if (preferred) return preferred
    }
    return documents[0] ?? null
  }, [documents, preferredDocumentId])

  const selectedChannelId = selectedChannel?.id ?? null
  const selectedDocumentId = selectedDocument?.id ?? null

  useEffect(() => {
    if (selectedChannelId && selectedChannelId !== rememberedChannelId) setChannelId(selectedChannelId)
  }, [rememberedChannelId, selectedChannelId, setChannelId])

  useEffect(() => {
    if (selectedDocumentId && selectedDocumentId !== rememberedDocumentId) setDocumentId(selectedDocumentId)
  }, [rememberedDocumentId, selectedDocumentId, setDocumentId])

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!isDragging) return
      const container = document.querySelector('.split-workbench')
      if (!container) return
      const rect = container.getBoundingClientRect()
      const newPercentage = ((event.clientX - rect.left) / rect.width) * 100
      if (newPercentage > 24 && newPercentage < 68) setChatWidth(newPercentage)
    }

    const handleMouseUp = () => setIsDragging(false)

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  if (!workspaceId) return <div className="page-state">워크스페이스 경로가 올바르지 않습니다.</div>

  const isLoading = channelsLoading || documentsLoading
  const unifiedStatus = getWorkspaceRealtimeStatus(isLoading)
  const statusLabel = getConnectionStatusLabel(unifiedStatus)

  function dismissWorkbenchHelp() {
    window.localStorage.setItem('syncspace.workbenchHelpDismissed', 'true')
    setBannerDismissed(true)
  }

  return (
    <section className="workspace-canvas" aria-label="채팅과 문서 동시 협업 화면">
      <div className="workbench-commandbar">
        <div className="workbench-commandbar-copy">
          <p className="eyebrow">워크벤치</p>
          <h1>
            {selectedChannel ? `#${selectedChannel.name}` : '채팅'} · {selectedDocument?.title ?? '문서'}
          </h1>
          {!bannerDismissed ? (
            <p>채팅에서 결정하고, 같은 화면의 문서에서 바로 정리하세요.</p>
          ) : null}
        </div>
        <div className="workbench-commandbar-actions">
          <span className={`status-summary ${unifiedStatus}`} aria-label={`${statusLabel}, ${presenceCount}명 접속 중`}>
            <span>{statusLabel}</span>
            <em>{presenceCount}명 접속 중</em>
          </span>
          {!bannerDismissed ? (
            <button className="banner-dismiss-button" onClick={dismissWorkbenchHelp} type="button">
              <EyeOff size={15} />
              안내 숨기기
            </button>
          ) : null}
        </div>
      </div>

      <div className="mobile-pane-switcher" role="tablist" aria-label="모바일 작업 패널 선택">
        <button
          className={activeMobilePane === 'chat' ? 'active' : ''}
          onClick={() => setActiveMobilePane('chat')}
          type="button"
          role="tab"
          aria-selected={activeMobilePane === 'chat'}
        >
          채팅
        </button>
        <button
          className={activeMobilePane === 'document' ? 'active' : ''}
          onClick={() => setActiveMobilePane('document')}
          type="button"
          role="tab"
          aria-selected={activeMobilePane === 'document'}
        >
          문서
        </button>
      </div>

      <div className="split-workbench" style={{ ['--chat-pane-width' as string]: `${chatWidth}%` }}>
        <div className={`split-pane chat-side ${activeMobilePane === 'chat' ? 'mobile-active' : ''}`}>
          {selectedChannelId ? (
            <ChatPanel
              workspaceId={workspaceId}
              channelId={selectedChannelId}
              channelName={selectedChannel?.name}
              hideStatus
              variant="workbench"
              readOnly
            />
          ) : (
            <EmptySplitPane title="채널이 없습니다" copy="에이전트가 첫 채널을 만들면 이곳에서 관전할 수 있습니다." loading={isLoading} />
          )}
        </div>

        <button
          className={`resizer ${isDragging ? 'dragging' : ''}`}
          onMouseDown={() => setIsDragging(true)}
          type="button"
          aria-label="채팅과 문서 패널 너비 조절"
        >
          <span className="resizer-handle" />
        </button>

        <div className={`split-pane doc-side ${activeMobilePane === 'document' ? 'mobile-active' : ''}`}>
          {selectedDocumentId ? (
            <EditorPanel
              workspaceId={workspaceId}
              documentId={selectedDocumentId}
              documentTitle={selectedDocument?.title}
              documents={documents}
              hideStatus
              variant="workbench"
              readOnly
            />
          ) : (
            <EmptySplitPane title="문서가 없습니다" copy="에이전트가 첫 문서를 만들면 이곳에서 관전할 수 있습니다." loading={isLoading} />
          )}
        </div>
      </div>
    </section>
  )
}

type WorkspaceRealtimeStatus = 'idle' | 'connecting' | 'connected' | 'disconnected'

function getWorkspaceRealtimeStatus(isLoading: boolean): WorkspaceRealtimeStatus {
  return isLoading ? 'connecting' : 'connected'
}

function getConnectionStatusLabel(status: WorkspaceRealtimeStatus): string {
  if (status === 'connected') return '실시간 연결 중'
  if (status === 'connecting') return '연결 중'
  if (status === 'disconnected') return '연결 끊김'
  return '연결 대기'
}

function readHelpDismissed(): boolean {
  try {
    return window.localStorage.getItem('syncspace.workbenchHelpDismissed') === 'true'
  } catch {
    return false
  }
}

function EmptySplitPane({ title, copy, loading }: { title: string; copy: string; loading: boolean }) {
  return (
    <div className="empty-split-pane">
      <p className="eyebrow">{loading ? 'LOADING' : 'EMPTY'}</p>
      <h2>{loading ? '불러오는 중...' : title}</h2>
      <p>{loading ? '워크스페이스 항목을 확인하고 있습니다.' : copy}</p>
    </div>
  )
}
