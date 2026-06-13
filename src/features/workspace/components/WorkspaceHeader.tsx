import { useState, useRef, useEffect, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { routes } from '../../../app/router/routes'
import { logout } from '../../../shared/api/authApi'
import { useAuthStore } from '../../../shared/stores/authStore'
import { formatDisplayName } from '../../../shared/utils/displayName'
import { agentRoleLabel } from '../../agents/agentDisplay'
import { agentIdentityToProfile } from '../../../shared/api/profiles'
import { useWorkspacesQuery } from '../queries/useWorkspacesQuery'
import { useJoinWorkspaceMutation } from '../queries/useJoinWorkspaceMutation'
import { useRotateInviteCodeMutation } from '../queries/useRotateInviteCodeMutation'
import { Copy, Check, LogOut, User, KeyRound, ChevronDown, LogIn, RefreshCw } from 'lucide-react'

export function WorkspaceHeader({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate()
  const { data: workspaces = [] } = useWorkspacesQuery()
  const identity = useAuthStore((state) => state.identity)
  const reset = useAuthStore((state) => state.reset)
  const [copied, setCopied] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [joinFormOpen, setJoinFormOpen] = useState(false)
  const [joinCode, setJoinCode] = useState('')
  const [joinError, setJoinError] = useState<string | null>(null)
  const [rotateError, setRotateError] = useState<string | null>(null)
  const joinMutation = useJoinWorkspaceMutation()
  const rotateMutation = useRotateInviteCodeMutation()
  const workspace = workspaces.find((item) => item.id === workspaceId)
  const displayName = formatDisplayName(identity?.displayName)
  const chipColor = identity ? agentIdentityToProfile(identity).color : '#94a3b8'
  const identityLabel = identity
    ? `${identity.role ? agentRoleLabel(identity.role) : '외부 에이전트'} · @${identity.slug}`
    : ''
  const menuRef = useRef<HTMLDivElement>(null)
  const inviteRef = useRef<HTMLDivElement>(null)
  const workspaceMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
      if (inviteRef.current && !inviteRef.current.contains(event.target as Node)) {
        setInviteOpen(false)
      }
      if (workspaceMenuRef.current && !workspaceMenuRef.current.contains(event.target as Node)) {
        setWorkspaceMenuOpen(false)
      }
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        setInviteOpen(false)
        setWorkspaceMenuOpen(false)
        setJoinFormOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [])

  function closeWorkspaceMenu() {
    setWorkspaceMenuOpen(false)
    setJoinFormOpen(false)
    setJoinCode('')
    setJoinError(null)
  }

  function selectWorkspace(targetId: string) {
    closeWorkspaceMenu()
    if (targetId !== workspaceId) {
      navigate(routes.workspace(targetId))
    }
  }

  async function submitJoinCode(event: FormEvent) {
    event.preventDefault()
    const code = joinCode.trim()
    if (!code || joinMutation.isPending) return
    setJoinError(null)
    try {
      const result = await joinMutation.mutateAsync(code)
      closeWorkspaceMenu()
      navigate(routes.workspace(result.workspace.id))
    } catch (error) {
      setJoinError(error instanceof Error ? error.message : '초대 코드로 합류하지 못했습니다.')
    }
  }

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

  async function rotateInviteCode() {
    if (rotateMutation.isPending) return
    setRotateError(null)
    try {
      // The shown code refreshes via the workspaces list invalidation.
      await rotateMutation.mutateAsync(workspaceId)
    } catch (error) {
      setRotateError(error instanceof Error ? error.message : '코드 재발급에 실패했습니다.')
    }
  }

  return (
    <header className="workspace-header">
      <div className="header-brand">
        <p className="eyebrow">현재 워크스페이스</p>
        <div className="dropdown-container" ref={workspaceMenuRef}>
          <button
            className={workspaceMenuOpen ? 'workspace-switch-trigger open' : 'workspace-switch-trigger'}
            onClick={() => (workspaceMenuOpen ? closeWorkspaceMenu() : setWorkspaceMenuOpen(true))}
            aria-expanded={workspaceMenuOpen}
            aria-haspopup="true"
            aria-label="워크스페이스 전환"
            type="button"
          >
            <h2>{workspace?.name ?? '워크스페이스'}</h2>
            <ChevronDown size={16} aria-hidden="true" />
          </button>

          {workspaceMenuOpen && (
            <div className="dropdown-menu workspace-switch-menu">
              <div className="dropdown-header">워크스페이스</div>
              {workspaces.map((item) => {
                const active = item.id === workspaceId
                return (
                  <button
                    key={item.id}
                    className={active ? 'dropdown-item workspace-switch-item active' : 'dropdown-item workspace-switch-item'}
                    onClick={() => selectWorkspace(item.id)}
                    type="button"
                    aria-current={active ? 'true' : undefined}
                  >
                    <span className="workspace-switch-name">{item.name}</span>
                    {active && <Check size={16} aria-hidden="true" />}
                  </button>
                )
              })}
              <div className="dropdown-divider"></div>
              {joinFormOpen ? (
                <form className="workspace-join-form" onSubmit={submitJoinCode}>
                  <input
                    className="workspace-join-input"
                    value={joinCode}
                    onChange={(event) => setJoinCode(event.target.value)}
                    placeholder="초대 코드"
                    aria-label="초대 코드"
                    autoFocus
                  />
                  <button
                    className="button primary small"
                    type="submit"
                    disabled={joinMutation.isPending || joinCode.trim().length === 0}
                  >
                    {joinMutation.isPending ? '합류 중…' : '합류'}
                  </button>
                  {joinError && <p className="workspace-join-error">{joinError}</p>}
                </form>
              ) : (
                <button
                  className="dropdown-item"
                  onClick={() => {
                    setJoinFormOpen(true)
                    setJoinError(null)
                  }}
                  type="button"
                >
                  <LogIn size={16} aria-hidden="true" />
                  초대 코드로 합류
                </button>
              )}
            </div>
          )}
        </div>
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
              aria-haspopup="true"
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
                <button
                  className="button ghost small invite-rotate-button"
                  onClick={rotateInviteCode}
                  type="button"
                  disabled={rotateMutation.isPending}
                  aria-label="초대 코드 재발급"
                >
                  <RefreshCw size={16} aria-hidden="true" />
                  {rotateMutation.isPending ? '재발급 중…' : '코드 재발급'}
                </button>
                {rotateError && <p className="workspace-join-error">{rotateError}</p>}
              </div>
            )}
          </div>
        )}

        <div className="dropdown-container" ref={menuRef}>
          <button
            className="user-menu-button"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-expanded={menuOpen}
            aria-haspopup="true"
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
                {/* The active credential — so it's obvious WHICH agent you're
                    signed in as (a different agent sees different workspaces). */}
                {identity?.agentId ? <small className="user-info-id">로그인: {identity.agentId.slice(0, 8)}…</small> : null}
              </div>
              <div className="dropdown-divider"></div>
              <button className="dropdown-item" onClick={signOut} type="button">
                <LogIn size={16} />
                다른 에이전트로 로그인
              </button>
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
