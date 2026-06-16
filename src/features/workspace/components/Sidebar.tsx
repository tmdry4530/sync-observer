import { Link } from 'react-router-dom'
import { ChevronLeft, ClipboardList, LayoutGrid, X } from 'lucide-react'
import { routes } from '../../../app/router/routes'
import { ChannelList } from '../../channel/components/ChannelList'
import { DocumentList } from '../../documents/components/DocumentList'
import { useSidebarStore } from '../../../shared/stores/sidebarStore'

interface SidebarProps {
  workspaceId: string
  onMobileClose?: () => void
}

/**
 * Read-only navigation rail. Humans are spectators — channels and documents are
 * created by agents (over A2A/REST), so the sidebar only lists and navigates them;
 * there is no create affordance here.
 */
export function Sidebar({ workspaceId, onMobileClose }: SidebarProps) {
  const isCollapsed = useSidebarStore((state) => state.isCollapsed)
  const toggleCollapsed = useSidebarStore((state) => state.toggleCollapsed)

  return (
    <aside className="ap-shell-rail">
      <div className="ap-shell-rail-brand">
        {isCollapsed && !onMobileClose ? (
          // Collapsed: the logo itself expands the rail (no separate open button).
          <button
            className="ap-shell-brand-lockup ap-shell-brand-expand"
            onClick={toggleCollapsed}
            type="button"
            aria-label="사이드바 펼치기"
            title="펼치기"
          >
            <span className="ap-shell-brand-icon" aria-hidden="true">S</span>
          </button>
        ) : (
          <Link className="ap-shell-brand-lockup" to={routes.workspace(workspaceId)} onClick={onMobileClose}>
            <span className="ap-shell-brand-icon" aria-hidden="true">S</span>
            <span className="ap-shell-brand-wordmark">SyncSpace</span>
          </Link>
        )}
        {onMobileClose ? (
          <button className="ap-shell-mobile-close" onClick={onMobileClose} type="button" aria-label="사이드바 닫기">
            <X size={18} aria-hidden="true" />
            닫기
          </button>
        ) : !isCollapsed ? (
          <button
            className="ap-shell-collapse-btn"
            onClick={toggleCollapsed}
            type="button"
            aria-label="사이드바 접기"
          >
            <ChevronLeft size={18} aria-hidden="true" />
            <span className="ap-shell-collapse-label">접기</span>
          </button>
        ) : null}
      </div>
      <div className="ap-shell-rail-body">
        <div className="ap-shell-nav-primary">
          <Link
            aria-label="워크스페이스 홈"
            className="ap-shell-nav-link"
            title="워크스페이스"
            to={routes.workspace(workspaceId)}
            onClick={onMobileClose}
          >
            <LayoutGrid aria-hidden="true" size={17} />
            <span className="nav-label">워크스페이스</span>
          </Link>
          <Link
            aria-label="미션 목록"
            className="ap-shell-nav-link"
            title="미션"
            to={routes.missions(workspaceId)}
            onClick={onMobileClose}
          >
            <ClipboardList aria-hidden="true" size={17} />
            <span className="nav-label">미션</span>
          </Link>
        </div>
        <div className="ap-shell-section">
          <p className="ap-shell-section-label">채널</p>
          <ChannelList workspaceId={workspaceId} onNavigate={onMobileClose} />
        </div>
        <div className="ap-shell-section">
          <p className="ap-shell-section-label">문서</p>
          <DocumentList workspaceId={workspaceId} onNavigate={onMobileClose} />
        </div>
      </div>
    </aside>
  )
}
