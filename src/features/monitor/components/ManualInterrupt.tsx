import { useState } from 'react'
import { postInterrupt, type InterventionRecord } from '../collectorClient'

/**
 * Manual interrupt (M4 control plane).
 *
 * Records a manual interrupt and broadcasts a synthetic cancelled event so the
 * live feed reflects it immediately. NOTE: binding this to a *running* hermes
 * agent (so the turn actually halts) lands in M5 — until then this is a recorded,
 * broadcast intent, surfaced honestly below. A two-step confirm guards the action.
 */

type Phase = 'idle' | 'confirming' | 'submitting' | 'done' | 'error'

export function ManualInterrupt() {
  const [agentId, setAgentId] = useState('')
  const [reason, setReason] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<InterventionRecord | null>(null)

  const canSubmit = agentId.trim().length > 0

  const submit = async (): Promise<void> => {
    setPhase('submitting')
    setError(null)
    try {
      const intervention = await postInterrupt({
        agentId: agentId.trim(),
        reason: reason.trim() || null
      })
      setResult(intervention)
      setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : '중지 요청에 실패했습니다.')
      setPhase('error')
    }
  }

  const reset = (): void => {
    setPhase('idle')
    setResult(null)
    setError(null)
  }

  return (
    <section className="monitor-interrupt" aria-label="수동 중지">
      <header className="monitor-section-head">
        <div>
          <p className="eyebrow">제어 · 수동 중지</p>
          <h2 className="monitor-section-title">에이전트 중지</h2>
        </div>
      </header>

      <p className="monitor-rules-note">
        규칙으로 막지 못한 위반을 사람이 직접 중지합니다. 현재는 중지를 <strong>기록·브로드캐스트</strong>하며,
        실행 중인 hermes 턴을 실제로 멈추는 결선은 <strong>M5</strong>에서 추가됩니다.
      </p>

      {error ? (
        <p className="monitor-error" role="alert">
          {error}
        </p>
      ) : null}

      {phase === 'done' && result ? (
        <div className="monitor-interrupt-result" role="status">
          <p>
            중지 요청 기록됨 · #{result.id} · <code>{result.agentId}</code>
            {result.message ? ` · ${result.message}` : ''}
          </p>
          <button type="button" className="monitor-btn" onClick={reset}>
            새 중지 요청
          </button>
        </div>
      ) : (
        <div className="monitor-interrupt-form">
          <label className="monitor-field monitor-field--grow">
            <span className="monitor-field-label">대상 agentId</span>
            <input
              className="monitor-input monitor-input--mono"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              placeholder="hermes:abc123"
              disabled={phase === 'submitting'}
            />
          </label>
          <label className="monitor-field monitor-field--grow">
            <span className="monitor-field-label">사유 (선택)</span>
            <input
              className="monitor-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="잘못된 디렉터리 접근"
              disabled={phase === 'submitting'}
            />
          </label>

          {phase === 'confirming' ? (
            <div className="monitor-confirm" role="alertdialog" aria-label="중지 확인">
              <span>
                <code>{agentId.trim()}</code> 을(를) 중지할까요?
              </span>
              <div className="monitor-confirm-actions">
                <button type="button" className="monitor-btn" onClick={() => setPhase('idle')}>
                  취소
                </button>
                <button
                  type="button"
                  className="monitor-btn monitor-btn--danger"
                  onClick={() => void submit()}
                >
                  중지 확인
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="monitor-btn monitor-btn--danger"
              onClick={() => setPhase('confirming')}
              disabled={!canSubmit || phase === 'submitting'}
            >
              {phase === 'submitting' ? '중지 중…' : '중지 요청'}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
