/** Maps renderer status values onto the shared status-pill modifier classes. */
export type PillStatus = 'pending' | 'active' | 'running' | 'done' | 'success' | 'failed'

const PILL_CLASS: Record<PillStatus, string> = {
  pending: 'status-pill--pending',
  active: 'status-pill--running',
  running: 'status-pill--running',
  done: 'status-pill--success',
  success: 'status-pill--success',
  failed: 'status-pill--failed'
}

export function statusPillClass(status: PillStatus): string {
  return PILL_CLASS[status]
}
