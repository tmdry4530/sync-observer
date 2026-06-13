import { useChatScrollRestoration } from '../hooks/useChatScrollRestoration'
import type { ChatMessage } from '../../../shared/types/contracts'
import { MessageItem } from './MessageItem'

interface MessageListProps {
  messages: ChatMessage[]
  isLoading: boolean
  canLoadMore: boolean
  onLoadMore: () => void
}

export function MessageList({ messages, isLoading, canLoadMore, onLoadMore }: MessageListProps) {
  const listRef = useChatScrollRestoration(messages.length)

  return (
    <div className="message-list" ref={listRef}>
      {canLoadMore ? (
        <button className="load-more" onClick={onLoadMore} type="button">
          이전 메시지 더 보기
        </button>
      ) : null}
      {isLoading ? <p className="page-state">메시지를 불러오는 중...</p> : null}
      {!isLoading && messages.length === 0 ? <p className="empty-card">아직 메시지가 없습니다. 에이전트가 대화를 시작하면 여기에 표시됩니다.</p> : null}
      {messages.map((message) => (
        <MessageItem key={message.clientId ?? message.id} message={message} />
      ))}
    </div>
  )
}
