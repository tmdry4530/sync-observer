/** Shared time formatting for the missions feature. */

/** Korean coarse relative time ('방금 전', 'N분 전', …). */
export function relativeTime(iso: string | undefined): string {
  if (!iso) return ''
  const diffMs = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(diffMs)) return ''
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return '방금 전'
  if (mins < 60) return `${mins}분 전`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}시간 전`
  return `${Math.floor(hours / 24)}일 전`
}

/** ko-KR absolute timestamp with an invalid-date guard (no 'Invalid Date' UI). */
export function formatEventTime(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('ko-KR')
}

/**
 * The instant an event claims to have happened: the payload timestamp when
 * present (real for live emits, crafted for the seeded demo story), falling
 * back to the DB row's created_at (insertion instant).
 */
export function eventDisplayTime(payloadTimestamp: string | undefined, createdAt: string): string {
  return payloadTimestamp || createdAt
}
