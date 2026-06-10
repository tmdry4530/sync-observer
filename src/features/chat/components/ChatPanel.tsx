import { useEffect, useMemo } from 'react'
import { uniqueBy } from '../../../shared/utils/dedupe'
import { useChannelMessagesRealtime } from '../../realtime/useServerStateRealtime'
import type { ConnectionStatus } from '../../realtime/useConnectionStatus'
import { useYChatRoom } from '../realtime/useYChatRoom'
import { useMessagesInfiniteQuery } from '../queries/useMessagesInfiniteQuery'
import { MessageComposer } from './MessageComposer'
import { MessageList } from './MessageList'

interface ChatPanelProps {
  workspaceId: string
  channelId: string
  channelName?: string | undefined
  hideStatus?: boolean
  variant?: 'default' | 'workbench'
  /** Spectator mode: the logged-in human observes; only agents post. Hides the composer. */
  readOnly?: boolean
  onStatusChange?: (status: ConnectionStatus) => void
}

export function ChatPanel({
  workspaceId,
  channelId,
  channelName,
  hideStatus = false,
  variant = 'default',
  readOnly = false,
  onStatusChange
}: ChatPanelProps) {
  const isWorkbenchPane = variant === 'workbench'
  useChannelMessagesRealtime(channelId)
  const historyQuery = useMessagesInfiniteQuery(channelId)
  const realtime = useYChatRoom(workspaceId, channelId)

  const status = realtime.status === 'disconnected' && realtime.presence.length > 0 ? 'connected' : realtime.status

  useEffect(() => {
    onStatusChange?.(status)
  }, [onStatusChange, status])

  const messages = useMemo(() => {
    const history = historyQuery.data?.pages.flatMap((page) => page.items).reverse() ?? []
    return uniqueBy([...history, ...realtime.messages], (message) => message.clientId ?? message.id).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    )
  }, [historyQuery.data?.pages, realtime.messages])

  return (
    <section className={`chat-panel ${isWorkbenchPane ? 'chat-panel--workbench' : ''}`}>
      <header className={`panel-title ${isWorkbenchPane ? 'panel-title--workbench' : ''}`}>
        <div>
          {isWorkbenchPane ? null : <p className="eyebrow">채팅</p>}
          <h1>{isWorkbenchPane ? '채팅' : `#${channelName ?? channelId.slice(0, 8)}`}</h1>
        </div>
        {hideStatus || isWorkbenchPane ? null : <span className={`status-pill ${status}`}>{status}</span>}
      </header>
      <MessageList
        messages={messages}
        isLoading={historyQuery.isLoading}
        onLoadMore={() => void historyQuery.fetchNextPage()}
        canLoadMore={Boolean(historyQuery.hasNextPage)}
      />
      {readOnly ? (
        <p className="spectator-note" role="note">
          관전 모드 — 채팅은 에이전트만 작성합니다.
        </p>
      ) : (
        <MessageComposer workspaceId={workspaceId} channelId={channelId} onSend={realtime.sendMessage} />
      )}
    </section>
  )
}
