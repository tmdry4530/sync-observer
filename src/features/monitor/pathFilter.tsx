import type { ActivityEvent } from '../../shared/types/activityEvent'

/**
 * Path-filter helpers shared by the right-pane views (LiveEventFeed, Timeline,
 * InterventionsLog). When a tree node is selected, these views narrow to events
 * whose paths include the selected path or one of its descendants. See
 * .monitor-filetree-spec.md §C.
 */

/** True when the event touches `filter` exactly or any path under it. */
export function matchesPathFilter(event: ActivityEvent, filter: string): boolean {
  const prefix = filter.endsWith('/') ? filter : filter + '/'
  return event.paths.some((p) => p === filter || p.startsWith(prefix))
}

/** Filter a list to events under `filter`; passthrough when no filter is set. */
export function filterEventsByPath(events: ActivityEvent[], filter: string | null): ActivityEvent[] {
  if (!filter) return events
  return events.filter((e) => matchesPathFilter(e, filter))
}

/** Last path segment of the active filter, for the "필터 해제" chip. */
function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}

/** Inline "현재 필터: <name> · 필터 해제" control shown when a filter is active. */
export function PathFilterNotice({
  pathFilter,
  onClear
}: {
  pathFilter: string | null | undefined
  onClear?: (() => void) | undefined
}) {
  if (!pathFilter) return null
  return (
    <div className="monitor-filter-notice" role="status">
      <span className="monitor-filter-label">
        현재 필터: <span className="monitor-filter-path">{basename(pathFilter)}</span>
      </span>
      {onClear ? (
        <button type="button" className="monitor-filter-clear" onClick={onClear}>
          필터 해제
        </button>
      ) : null}
    </div>
  )
}
