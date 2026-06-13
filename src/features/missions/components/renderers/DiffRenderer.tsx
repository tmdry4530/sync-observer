import type { FileEditEvent } from '../../../../shared/types/engineeringEvents'
import { RawInspect } from './RawInspect'

interface DiffLine {
  type: 'added' | 'removed' | 'hunk' | 'context' | 'blank'
  content: string
}

function parseDiff(raw: string): DiffLine[] {
  if (!raw || raw.trim() === '') return []
  return raw.split('\n').map((line): DiffLine => {
    if (line.startsWith('+') && !line.startsWith('+++')) return { type: 'added', content: line }
    if (line.startsWith('-') && !line.startsWith('---')) return { type: 'removed', content: line }
    if (line.startsWith('@@')) return { type: 'hunk', content: line }
    if (line.trim() === '') return { type: 'blank', content: line }
    return { type: 'context', content: line }
  })
}

interface Props {
  event: FileEditEvent
}

export function DiffRenderer({ event }: Props) {
  const lines = parseDiff(event.unifiedDiff ?? '')
  const additions = event.additions ?? 0
  const deletions = event.deletions ?? 0

  return (
    <div className="renderer-file-edit">
      <div className="diff-file-header">
        <span className="diff-file-path">{event.path}</span>
        <div className="diff-counts">
          {additions > 0 && <span className="diff-count diff-count--add">+{additions}</span>}
          {deletions > 0 && <span className="diff-count diff-count--del">-{deletions}</span>}
        </div>
      </div>
      {event.summary && <p className="renderer-summary">{event.summary}</p>}
      {lines.length === 0 ? (
        <p className="renderer-empty">통합 diff 없음</p>
      ) : (
        <div className="diff-view" role="region" aria-label="unified diff">
          {lines.map((line, i) => (
            <div
              key={i}
              className={`diff-line diff-line--${line.type}`}
              aria-hidden={line.type === 'blank'}
            >
              <span className="diff-line-content">{line.content}</span>
            </div>
          ))}
        </div>
      )}
      <RawInspect event={event} />
    </div>
  )
}
