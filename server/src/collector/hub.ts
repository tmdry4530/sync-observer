import { EventEmitter } from 'node:events'
import type { ActivityEvent } from './activityEvent.js'

/**
 * In-process fan-out for ingested events (M2 §3).
 *
 * SSE clients (and any future poller) subscribe here; ingest publishes here.
 * A small ring buffer retains the most recent events so a freshly-connected SSE
 * client without a Last-Event-ID still gets recent context without re-querying
 * the store. The store remains the durable source of truth — this is best-effort
 * live delivery only.
 */

export type EventListener = (event: ActivityEvent) => void

export interface EventHub {
  publish(event: ActivityEvent): void
  subscribe(listener: EventListener): () => void
  /** Snapshot of the recent-events ring buffer (oldest → newest). */
  recent(): ActivityEvent[]
}

const RING_CAPACITY = 200
const CHANNEL = 'event'

export function createEventHub(): EventHub {
  const emitter = new EventEmitter()
  // Many SSE clients may attach; lift the default 10-listener warning cap.
  emitter.setMaxListeners(0)
  const ring: ActivityEvent[] = []

  const publish = (event: ActivityEvent): void => {
    ring.push(event)
    if (ring.length > RING_CAPACITY) ring.shift()
    // Isolate subscribers: a throwing listener (e.g. an SSE write to a socket
    // that closed in the race before its 'close' handler unsubscribed) must not
    // abort fan-out to the other subscribers, and must never propagate into the
    // publisher (the ingest handler, which has already durably persisted the
    // event). Emit over a snapshot with a per-listener guard. Live delivery is
    // best-effort; the store stays the durable source of truth.
    for (const listener of emitter.listeners(CHANNEL) as EventListener[]) {
      try {
        listener(event)
      } catch {
        // swallow — best-effort live delivery only.
      }
    }
  }

  const subscribe = (listener: EventListener): (() => void) => {
    emitter.on(CHANNEL, listener)
    return () => {
      emitter.off(CHANNEL, listener)
    }
  }

  const recent = (): ActivityEvent[] => [...ring]

  return { publish, subscribe, recent }
}
