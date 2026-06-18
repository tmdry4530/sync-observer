import { useEffect, useRef, useState } from 'react'
import {
  listRules,
  replaceRules,
  type MonitorRule,
  type RuleDraft,
  type RuleKind
} from '../collectorClient'

/**
 * Rules management (M4 control plane).
 *
 * Edits a working draft and saves the WHOLE set via POST /control/rules
 * (replace-all). The collector re-projects the table to the plugin rules file,
 * so a saved deny rule is enforced by the hermes plugin on its next mtime check.
 * Default policy is allow + denylist (Q6), so deny rules are the security levers.
 */

type SaveState = 'idle' | 'loading' | 'saving' | 'saved' | 'error'

function toDraft(rule: MonitorRule): RuleDraft {
  return { id: rule.id, kind: rule.kind, glob: rule.glob, scope: rule.scope, enabled: rule.enabled }
}

function blankRule(): RuleDraft {
  return { id: '', kind: 'deny', glob: '', scope: 'global', enabled: true }
}

export function RulesManager() {
  const [draft, setDraft] = useState<RuleDraft[]>([])
  const [state, setState] = useState<SaveState>('loading')
  const [error, setError] = useState<string | null>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = async (): Promise<void> => {
    setState('loading')
    setError(null)
    try {
      const rules = await listRules()
      setDraft(rules.map(toDraft))
      setState('idle')
    } catch (e) {
      setError(e instanceof Error ? e.message : '규칙을 불러오지 못했습니다.')
      setState('error')
    }
  }

  useEffect(() => {
    void load()
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current)
    }
  }, [])

  const update = (index: number, patch: Partial<RuleDraft>): void => {
    setDraft((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }
  const addRow = (): void => setDraft((prev) => [...prev, blankRule()])
  const removeRow = (index: number): void => setDraft((prev) => prev.filter((_, i) => i !== index))

  const validate = (): string | null => {
    const ids = new Set<string>()
    for (const r of draft) {
      if (!r.id.trim()) return '모든 규칙에 id가 필요합니다.'
      if (ids.has(r.id.trim())) return `중복된 규칙 id: ${r.id}`
      ids.add(r.id.trim())
      if (!r.glob.trim()) return `규칙 "${r.id}"에 glob 경로가 필요합니다.`
    }
    return null
  }

  const save = async (): Promise<void> => {
    const invalid = validate()
    if (invalid) {
      setError(invalid)
      setState('error')
      return
    }
    setState('saving')
    setError(null)
    try {
      const saved = await replaceRules(
        draft.map((r) => ({ ...r, id: r.id.trim(), glob: r.glob.trim(), scope: r.scope.trim() || 'global' }))
      )
      setDraft(saved.map(toDraft))
      setState('saved')
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setState('idle'), 2500)
    } catch (e) {
      setError(e instanceof Error ? e.message : '규칙 저장에 실패했습니다.')
      setState('error')
    }
  }

  return (
    <section className="monitor-rules" aria-label="경로 규칙 관리">
      <header className="monitor-section-head">
        <div>
          <p className="eyebrow">제어 · 규칙</p>
          <h2 className="monitor-section-title">경로 규칙</h2>
        </div>
        <div className="monitor-rules-actions">
          <button type="button" className="monitor-btn" onClick={addRow}>
            규칙 추가
          </button>
          <button
            type="button"
            className="monitor-btn monitor-btn--reset"
            onClick={() => void load()}
            disabled={state === 'saving' || state === 'loading'}
          >
            되돌리기
          </button>
          <button
            type="button"
            className="monitor-btn monitor-btn--primary"
            onClick={() => void save()}
            disabled={state === 'saving' || state === 'loading'}
          >
            {state === 'saving' ? '저장 중…' : '저장'}
          </button>
        </div>
      </header>

      <p className="monitor-rules-note">
        기본 정책은 <strong>허용</strong>입니다. <strong>deny</strong> 규칙이 차단 레버이며, 저장 즉시
        플러그인 규칙 파일로 투영되어 hermes가 다음 검사 때 적용합니다.
      </p>

      {error ? (
        <p className="monitor-error" role="alert">
          {error}
        </p>
      ) : null}
      {state === 'saved' ? (
        <p className="monitor-saved" role="status">
          저장됨 · 플러그인 파일로 투영됨
        </p>
      ) : null}

      {state === 'loading' ? (
        <p className="monitor-muted">규칙을 불러오는 중…</p>
      ) : draft.length === 0 ? (
        <p className="monitor-empty">
          아직 규칙이 없습니다. ‘규칙 추가’로 민감 경로(예: <code>~/.ssh/**</code>) 차단 규칙을 만드세요.
        </p>
      ) : (
        <ul className="monitor-rule-list">
          {draft.map((rule, i) => (
            <li key={i} className="monitor-rule-row">
              <label className="monitor-field">
                <span className="monitor-field-label">id</span>
                <input
                  className="monitor-input"
                  value={rule.id}
                  onChange={(e) => update(i, { id: e.target.value })}
                  placeholder="ssh-block"
                />
              </label>
              <label className="monitor-field">
                <span className="monitor-field-label">종류</span>
                <select
                  className="monitor-input"
                  value={rule.kind}
                  onChange={(e) => update(i, { kind: e.target.value as RuleKind })}
                >
                  <option value="deny">deny (차단)</option>
                  <option value="allow">allow (허용)</option>
                </select>
              </label>
              <label className="monitor-field monitor-field--grow">
                <span className="monitor-field-label">glob 경로</span>
                <input
                  className="monitor-input monitor-input--mono"
                  value={rule.glob}
                  onChange={(e) => update(i, { glob: e.target.value })}
                  placeholder="/Users/me/.ssh/**"
                />
              </label>
              <label className="monitor-field">
                <span className="monitor-field-label">scope</span>
                <input
                  className="monitor-input monitor-input--mono"
                  value={rule.scope}
                  onChange={(e) => update(i, { scope: e.target.value })}
                  placeholder="global"
                />
              </label>
              <label className="monitor-toggle">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(e) => update(i, { enabled: e.target.checked })}
                />
                <span>활성</span>
              </label>
              <button
                type="button"
                className="monitor-btn monitor-btn--danger"
                onClick={() => removeRow(i)}
                aria-label={`규칙 ${rule.id || i + 1} 삭제`}
              >
                삭제
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
