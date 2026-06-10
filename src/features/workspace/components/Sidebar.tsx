import { Link } from 'react-router-dom'
import { ChevronLeft, LayoutGrid, PanelLeftOpen, X } from 'lucide-react'
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
    <aside className={isCollapsed ? 'sidebar collapsed' : 'sidebar'}>
      <div className="sidebar-brand">
        <Link className="brand-lockup" to={routes.workspace(workspaceId)} onClick={onMobileClose}>
          <span className="brand-icon" aria-hidden="true">S</span>
          <span className="brand-wordmark">SyncSpace</span>
        </Link>
        {onMobileClose ? (
          <button className="mobile-sidebar-close" onClick={onMobileClose} type="button" aria-label="사이드바 닫기">
            <X size={18} />
            닫기
          </button>
        ) : null}
        <button className="collapse-button" onClick={toggleCollapsed} type="button" aria-label={isCollapsed ? '사이드바 펼치기' : '사이드바 접기'}>
          {isCollapsed ? <PanelLeftOpen size={18} /> : <ChevronLeft size={18} />}
          <span>{isCollapsed ? '펼치기' : '접기'}</span>
        </button>
      </div>
      <div className="sidebar-content">
        <div className="sidebar-section sidebar-home">
          <Link aria-label="워크스페이스 홈" className="sidebar-workspace-link" title="워크스페이스" to={routes.workspace(workspaceId)} onClick={onMobileClose}>
            <LayoutGrid aria-hidden="true" size={16} />
            <span className="nav-label">워크스페이스</span>
          </Link>
        </div>
        <div className="sidebar-section sidebar-section--channels">
          <div className="sidebar-section-header">
            <p className="eyebrow">채널</p>
          </div>
          <ChannelList workspaceId={workspaceId} onNavigate={onMobileClose} />
        </div>
        <div className="sidebar-section sidebar-section--documents">
          <div className="sidebar-section-header">
            <p className="eyebrow">문서</p>
          </div>
          <DocumentList workspaceId={workspaceId} onNavigate={onMobileClose} />
        </div>
      </div>
    </aside>
  )
}
