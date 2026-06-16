import type { ChatMessage } from '../../../shared/types/contracts'
import { useAuthStore } from '../../../shared/stores/authStore'
import { formatDisplayName } from '../../../shared/utils/displayName'

export function MessageItem({ message, variant = 'default' }: { message: ChatMessage; variant?: 'default' | 'workbench' }) {
  const identity = useAuthStore((state) => state.identity)
  const isMe =
    identity?.participantId === (message.authorParticipantId ?? message.userId)
  const label = formatDisplayName(message.user?.displayName, `사용자 ${message.userId.slice(0, 4)}`)
  const color = message.user?.color ?? '#8b5cf6'
  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  if (variant === 'workbench') {
    return (
      // Use ONLY ap-wb- classes — the legacy .message-* rules in styles.css give
      // the inner <p> its own surface/primary background, nesting a white (or dark)
      // box inside the Apple bubble that washes the text out in light mode.
      <article className={`ap-wb-msg ${isMe ? 'ap-wb-msg--mine' : ''}`}>
        <div className="ap-wb-msg-meta">
          <span title={message.user?.displayName ?? message.userId}>{label}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={message.createdAt}>{time}</time>
        </div>
        <div className="ap-wb-msg-bubble">
          <p>{message.content}</p>
          {message.status && message.status !== 'sent' ? (
            <span className="ap-wb-pending-chip">{message.status}</span>
          ) : null}
        </div>
      </article>
    )
  }

  return (
    <article className={`message-item ${isMe ? 'message-mine' : 'message-others'}`}>
      <div className="avatar" style={{ backgroundColor: color }} aria-hidden="true">
        {label.slice(0, 1).toUpperCase()}
      </div>
      <div className="message-content-wrapper">
        <header>
          <strong title={message.user?.displayName ?? message.userId}>{label}</strong>
          <time dateTime={message.createdAt}>{time}</time>
        </header>
        <div className="message-bubble">
          <p>{message.content}</p>
          {message.status && message.status !== 'sent' ? <span className="pending-chip">{message.status}</span> : null}
        </div>
      </div>
    </article>
  )
}
