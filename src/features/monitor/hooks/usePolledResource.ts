import { useEffect, useRef, useState } from 'react'

/**
 * Generic poll-on-interval fetch for the read-only monitor views (dashboard,
 * timeline, interventions log). Fetches on mount, refreshes every `intervalMs`,
 * exposes a manual `reload`, and aborts in-flight requests on unmount/refetch.
 *
 * Pass a `fetcher` wrapped in useCallback so its identity is stable across
 * renders except when its real inputs (e.g. a selected session id) change.
 */
export interface PolledResource<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
}

export function usePolledResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  intervalMs = 3000
): PolledResource<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const stoppedRef = useRef(false)

  useEffect(() => {
    stoppedRef.current = false
    let controller = new AbortController()

    const run = async (): Promise<void> => {
      controller.abort()
      controller = new AbortController()
      try {
        const result = await fetcher(controller.signal)
        if (stoppedRef.current) return
        setData(result)
        setError(null)
      } catch (e) {
        if (stoppedRef.current || controller.signal.aborted) return
        setError(e instanceof Error ? e.message : '데이터를 불러오지 못했습니다.')
      } finally {
        if (!stoppedRef.current) setLoading(false)
      }
    }

    void run()
    const timer = setInterval(() => void run(), intervalMs)

    return () => {
      stoppedRef.current = true
      controller.abort()
      clearInterval(timer)
    }
  }, [fetcher, intervalMs, nonce])

  return { data, error, loading, reload: () => setNonce((n) => n + 1) }
}
