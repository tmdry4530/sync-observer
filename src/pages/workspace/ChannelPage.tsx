import { useParams } from 'react-router-dom'
import { ChatPanel } from '../../features/chat/components/ChatPanel'

export function ChannelPage() {
  const { workspaceId, channelId } = useParams()
  if (!workspaceId || !channelId) return <div className="page-state">채널 경로가 올바르지 않습니다.</div>
  return <ChatPanel workspaceId={workspaceId} channelId={channelId} readOnly />
}
