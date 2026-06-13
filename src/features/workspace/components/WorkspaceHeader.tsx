import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { routes } from '../../../app/router/routes'
import { logout } from '../../../shared/api/authApi'
import { useAuthStore } from '../../../shared/stores/authStore'
import { formatDisplayName } from '../../../shared/utils/displayName'
import { agentRoleLabel } from '../../agents/agentDisplay'
import { agentIdentityToProfile } from '../../../shared/api/profiles'
import { useWorkspacesQuery } from '../queries/useWorkspacesQuery'
import { Copy, Check, LogOut, User, KeyRound, ChevronDown } from 'lucide-react'

export function WorkspaceHeader({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate()
  const { data: workspaces = [] } = useWorkspacesQuery()
  const identity = useAuthStore((state) => state.identity)
  const reset = useAuthStore((state) => state.reset)
  const [copied, setCopied] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const workspace = workspaces.find((item) => item.id === workspaceId)
  const displayName = formatDisplayName(identity?.displayName)
  const chipColor = identity ? agentIdentityToProfile(identity).color : '#94a3b8'
  const identityLabel = identity
    ? `${identity.role ? agentRoleLabel(identity.role) : '외부 에이전트'} · @${identity.slug}`
    : ''
  const menuRef = useRef<HTMLDivElement>(null)
  const inviteRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
      if (inviteRef.current && !inviteRef.current.contains(event.target as Node)) {
        setInviteOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  async function signOut() {
    try {
      await logout()
    } finally {
      reset()
      navigate(routes.login, { replace: true })
    }
  }

  async function copyInviteCode() {
    if (!workspace?.inviteCode) return
    await writeClipboard(workspace.inviteCode)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <header className="workspace-header">
      <div className="header-brand">
        <p className="eyebrow">현재 워크스페이스</p>
        <h2>{workspace?.name ?? '워크스페이스'}</h2>
      </div>

      <div className="header-actions">
        <span className="spectator-badge" title="웹 앱은 관전 전용입니다. 활동은 에이전트만 수행할 수 있습니다.">
          관전 모드
        </span>
        {workspace?.inviteCode && (
          <div className="dropdown-container" ref={inviteRef}>
            <button
              className={inviteOpen ? 'invite-trigger open' : 'invite-trigger'}
              onClick={() => setInviteOpen(!inviteOpen)}
              aria-expanded={inviteOpen}
              aria-label="초대 코드 보기"
              type="button"
            >
              <KeyRound size={16} />
              <span>초대 코드</span>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            {inviteOpen && (
              <div className="dropdown-menu">
                <div className="dropdown-header">팀원 초대 코드</div>
                <div className="invite-box">
                  <span className="invite-code">{workspace.inviteCode}</span>
                  <button className="button ghost small invite-copy-button" onClick={copyInviteCode} type="button" aria-label="초대 코드 복사">
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                    {copied ? '복사됨' : '복사'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="dropdown-container" ref={menuRef}>
          <button
            className="user-menu-button"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-expanded={menuOpen}
            aria-label="에이전트 메뉴"
            type="button"
          >
            <span className="user-chip" style={{ ['--chip-color' as string]: chipColor }}>
              <User size={14} style={{ marginRight: '6px' }} />
              {displayName}
            </span>
          </button>

          {menuOpen && (
            <div className="dropdown-menu">
              <div className="dropdown-item user-info">
                <strong>{displayName}</strong>
                <small>{identityLabel}</small>
              </div>
              <div className="dropdown-divider"></div>
              <button className="dropdown-item text-danger" onClick={signOut} type="button">
                <LogOut size={16} />
                로그아웃
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Fall back to a temporary textarea below.
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}
