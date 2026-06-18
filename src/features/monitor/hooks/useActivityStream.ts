import { useEffect, useRef, useState } from 'react'
import type { ActivityEvent } from '../../../shared/types/activityEvent'
import { parseActivityEvent } from '../../../shared/types/activityEvent'
import { fetchEventsSince, streamUrl } from '../collectorClient'

/**
 * Live activity stream from the local collector (M4 vertical slice).
 *
 * Primary transport is SSE (GET /api/stream); on any SSE error we fall back to
 * 1.5s polling of GET /api/events?since=seq (the documented baseline). Events
 * are de-duplicated by eventId (SSE replay + a poll can overlap) and the list is
 * capped so a long-running session can't grow memory without bound.
 */

export type StreamStatus = 'connecting' | 'live' | 'polling' | 'error'

export interface ActivityStream {
  events: ActivityEvent[]
  status: StreamStatus
  latestSeq: number
}

const MAX_EVENTS = 1000
const POLL_INTERVAL_MS = 1500

export function useActivityStream(): ActivityStream {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [status, setStatus] = useState<StreamStatus>('connecting')
  const [latestSeq, setLatestSeq] = useState(0)

  // Mutable cross-render state (not part of render output).
  const seqRef = useRef(0)
  const seenRef = useRef<Set<string>>(new Set())
  const esRef = useRef<EventSource | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stoppedRef = useRef(false)

  useEffect(() => {
    stoppedRef.current = false

    const appendMany = (incoming: ActivityEvent[]): void => {
      if (incoming.length === 0) return
      const fresh = incoming.filter((e) => !seenRef.current.has(e.eventId))
      if (fresh.length === 0) return
      for (const e of fresh) seenRef.current.add(e.eventId)
      setEvents((prev) => {
        const next = [...prev, ...fresh]
        // Cap memory: keep the most recent MAX_EVENTS, and forget the dropped ids
        // so they can re-enter if the collector ever re-sends them.
        if (next.length > MAX_EVENTS) {
          const dropped = next.splice(0, next.length - MAX_EVENTS)
          for (const e of dropped) seenRef.current.delete(e.eventId)
        }
        return next
      })
    }

    const advanceSeq = (seq: number): void => {
      if (Number.isFinite(seq) && seq > seqRef.current) {
        seqRef.current = seq
        setLatestSeq(seq)
      }
    }

    const stopPolling = (): void => {
      if (pollRef.current !== null) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }

    const startPolling = (): void => {
      if (pollRef.current !== null || stoppedRef.current) return
      setStatus('polling')
      const tick = async (): Promise<void> => {
        try {
          const page = await fetchEventsSince(seqRef.current)
          if (stoppedRef.current) return
          appendMany(page.events)
          advanceSeq(page.latestSeq)
        } catch {
          if (!stoppedRef.current) setStatus('error')
        }
      }
      void tick()
      pollRef.current = setInterval(() => void tick(), POLL_INTERVAL_MS)
    }

    const startSse = (): void => {
      if (typeof EventSource === 'undefined') {
        startPolling()
        return
      }
      let es: EventSource
      try {
        es = new EventSource(streamUrl(seqRef.current))
      } catch {
        startPolling()
        return
      }
      esRef.current = es

      es.addEventListener('open', () => {
        if (!stoppedRef.current) setStatus('live')
      })
      es.addEventListener('activity', (raw) => {
        const msg = raw as MessageEvent<string>
        const parsed = parseActivityEvent(safeJson(msg.data))
        if (parsed) appendMany([parsed])
        const seq = Number(msg.lastEventId)
        if (Number.isFinite(seq)) advanceSeq(seq)
      })
      es.addEventListener('error', () => {
        // SSE failed (collector down, or browser dropped the stream). Close it and
        // fall back to polling, which also surfaces 'error' if the host is gone.
        es.close()
        if (esRef.current === es) esRef.current = null
        if (!stoppedRef.current) startPolling()
      })
    }

    startSse()

    return () => {
      stoppedRef.current = true
      esRef.current?.close()
      esRef.current = null
      stopPolling()
    }
  }, [])

  return { events, status, latestSeq }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
