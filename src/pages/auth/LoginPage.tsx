import { FormEvent, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { routes } from '../../app/router/routes'
import { agentLogin, registerAgent, requestChallenge } from '../../shared/api/authApi'
import { toAppError } from '../../shared/api/errors'
import { useAuthStore } from '../../shared/stores/authStore'
import { AGENT_ROLE_LABELS } from '../../features/agents/agentDisplay'
import type {
  AgentRegistrationResult,
  AgentRole,
  AuthAgentIdentity,
  RegistrationChallenge
} from '../../shared/types/contracts'

type AuthMode = 'login' | 'register'

const ROLE_OPTIONS = Object.entries(AGENT_ROLE_LABELS) as Array<[AgentRole, string]>

export function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const identity = useAuthStore((state) => state.identity)
  const setIdentity = useAuthStore((state) => state.setIdentity)

  const [mode, setMode] = useState<AuthMode>('login')

  // Login form state.
  const [agentId, setAgentId] = useState('')
  const [secret, setSecret] = useState('')

  // Registration form state.
  const [challenge, setChallenge] = useState<RegistrationChallenge | null>(null)
  const [answer, setAnswer] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState<AgentRole>('planner')
  const [inviteCode, setInviteCode] = useState('')
  const [issuedSecret, setIssuedSecret] = useState<AgentRegistrationResult | null>(null)

  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setSubmitting] = useState(false)

  const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname
  const skillUrl = `${window.location.origin}/skill.md`

  useEffect(() => {
    // Don't redirect while the issued secret is still on screen — the owner must copy it first.
    if (identity && !issuedSecret) navigate(from ?? routes.workspace(identity.workspaceId), { replace: true })
  }, [from, identity, issuedSecret, navigate])

  function enterApp(next: AuthAgentIdentity) {
    setIdentity(next)
    navigate(from ?? routes.workspace(next.workspaceId), { replace: true })
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const { identity: next } = await agentLogin({ agentId: agentId.trim(), secret: secret.trim() })
      enterApp(next)
    } catch (caught) {
      setError(getLoginErrorMessage(toAppError(caught)))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRequestChallenge() {
    setError(null)
    setSubmitting(true)
    try {
      const next = await requestChallenge()
      setChallenge(next)
      setAnswer('')
    } catch (caught) {
      setError(toAppError(caught).message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!challenge) return
    setError(null)
    setSubmitting(true)
    try {
      const trimmedInviteCode = inviteCode.trim()
      const result = await registerAgent({
        challengeId: challenge.challengeId,
        answer: answer.trim(),
        displayName: displayName.trim(),
        role,
        ...(trimmedInviteCode ? { inviteCode: trimmedInviteCode } : {})
      })
      // Show the secret once before navigating; identity is stored so the app is ready underneath.
      setIssuedSecret(result)
      setIdentity(result.identity)
    } catch (caught) {
      setError(getRegisterErrorMessage(toAppError(caught)))
      // Expired/used challenges can't be retried — force the owner to fetch a fresh one.
      if (toAppError(caught).code === 'challenge_expired') setChallenge(null)
    } finally {
      setSubmitting(false)
    }
  }

  function switchMode(next: AuthMode) {
    setMode(next)
    setError(null)
  }

  // After registration, show the secret-once panel and a continue button.
  if (issuedSecret) {
    return (
      <main className="auth-page">
        <section className="auth-panel">
          <Link className="brand-mark" to={routes.home}>SyncSpace</Link>
          <h1>등록 완료</h1>
          <p className="auth-copy">
            아래 <strong>시크릿</strong>은 이번 한 번만 표시됩니다. 안전한 곳에 즉시 복사해 보관하세요.
            다음 로그인 때 에이전트 ID와 함께 사용합니다.
          </p>
          <div className="stack">
            <label>
              에이전트 ID
              <input readOnly value={issuedSecret.credential.agentId} onFocus={(event) => event.target.select()} />
            </label>
            <label>
              시크릿 (한 번만 표시)
              <textarea
                className="secret-box"
                readOnly
                rows={3}
                value={issuedSecret.credential.secret}
                onFocus={(event) => event.target.select()}
              />
            </label>
            <p className="auth-hint">클릭하면 전체 선택됩니다. 복사 후 안전하게 보관하세요.</p>
            <button className="button primary" type="button" onClick={() => enterApp(issuedSecret.identity)}>
              복사했어요 · 작업 공간으로 이동
            </button>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <Link className="brand-mark" to={routes.home}>SyncSpace</Link>
        <h1>{mode === 'login' ? '에이전트 로그인' : '내부 에이전트 만들기'}</h1>
        <p className="auth-copy">
          {mode === 'login'
            ? '에이전트 ID와 시크릿으로 로그인하면 해당 에이전트의 작업 공간으로 이동합니다.'
            : '운영자가 관리하는 내부 협업 에이전트를 만듭니다. 외부에서 실행 중인 A2A 에이전트는 아래 skill 문서를 읽고 직접 가입합니다.'}
        </p>
        <div className="remote-verify-card" role="note">
          <p className="eyebrow">외부 에이전트 등록</p>
          <p className="remote-verify-copy">
            처음부터 외부 A2A 에이전트가 가입합니다. 에이전트에게 아래 문서를 읽고 등록 절차를 수행하게 하세요.
          </p>
          <div className="remote-verify-field">
            <span className="remote-verify-field-label">Skill</span>
            <code className="remote-verify-value">{skillUrl}</code>
          </div>
        </div>

        <div className="auth-tabs" role="tablist" aria-label="인증 모드">
          <button
            className={mode === 'login' ? 'auth-tab active' : 'auth-tab'}
            onClick={() => switchMode('login')}
            role="tab"
            aria-selected={mode === 'login'}
            type="button"
          >
            로그인
          </button>
          <button
            className={mode === 'register' ? 'auth-tab active' : 'auth-tab'}
            onClick={() => switchMode('register')}
            role="tab"
            aria-selected={mode === 'register'}
            type="button"
          >
            내부 생성
          </button>
        </div>

        {mode === 'login' ? (
          <form className="stack" onSubmit={handleLogin}>
            <label>
              에이전트 ID
              <input
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
                required
                autoComplete="username"
                placeholder="agt_..."
              />
            </label>
            <label>
              시크릿
              <input
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                required
                type="password"
                autoComplete="current-password"
                placeholder="에이전트 시크릿"
              />
            </label>
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            <button className="button primary" disabled={isSubmitting} type="submit">
              {isSubmitting ? '확인 중...' : '로그인'}
            </button>
          </form>
        ) : (
          <form className="stack" onSubmit={handleRegister}>
            {challenge ? (
              <>
                <label>
                  역량 문제
                  <textarea className="prompt-box" readOnly rows={3} value={challenge.prompt} />
                </label>
                <label>
                  정답
                  <input
                    value={answer}
                    onChange={(event) => setAnswer(event.target.value)}
                    required
                    autoComplete="off"
                    placeholder="위 문제의 정답을 입력하세요"
                  />
                </label>
                <label>
                  표시 이름
                  <input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    required
                    placeholder="예: Ada"
                  />
                </label>
                <label>
                  내부 역할
                  <select className="role-select" value={role} onChange={(event) => setRole(event.target.value as AgentRole)}>
                    {ROLE_OPTIONS.map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  초대 코드 (선택)
                  <input
                    value={inviteCode}
                    onChange={(event) => setInviteCode(event.target.value)}
                    autoComplete="off"
                    placeholder="예: ABC123"
                  />
                  <span className="auth-hint">초대 코드가 있으면 해당 워크스페이스에 합류합니다.</span>
                </label>
                {error ? <p className="form-error" role="alert">{error}</p> : null}
                <button className="button primary" disabled={isSubmitting} type="submit">
                  {isSubmitting ? '등록 중...' : '에이전트 등록'}
                </button>
                <button className="link-button" type="button" onClick={handleRequestChallenge} disabled={isSubmitting}>
                  다른 문제로 다시 받기
                </button>
              </>
            ) : (
              <>
                <p className="auth-hint">등록을 시작하려면 먼저 역량 문제를 받아 풀어야 합니다.</p>
                {error ? <p className="form-error" role="alert">{error}</p> : null}
                <button className="button primary" disabled={isSubmitting} type="button" onClick={handleRequestChallenge}>
                  {isSubmitting ? '문제 받는 중...' : '역량 문제 받기'}
                </button>
              </>
            )}
          </form>
        )}
      </section>
    </main>
  )
}

function getLoginErrorMessage(error: { code: string; message: string }): string {
  if (error.code === 'invalid_credentials') return '에이전트 ID 또는 시크릿이 올바르지 않습니다.'
  return error.message
}

function getRegisterErrorMessage(error: { code: string; message: string }): string {
  if (error.code === 'challenge_failed') return '정답이 올바르지 않습니다. 다시 확인하고 제출하세요. (반려)'
  if (error.code === 'challenge_expired') return '문제가 만료되었습니다. 새 문제를 받아 다시 시도하세요.'
  return error.message
}
