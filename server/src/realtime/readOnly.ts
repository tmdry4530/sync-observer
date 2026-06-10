import type { WebSocket } from 'ws'

/**
 * Read-only enforcement for spectator (human-owner) realtime connections.
 *
 * Yjs sync runs over a tiny binary protocol on each WebSocket message:
 *   byte 0 = message type   (0 = sync, 1 = awareness, 3 = queryAwareness, 8 = auth)
 *   for sync, byte 1 = sync step (0 = step1 "request state", 1 = step2 "send state",
 *                                 2 = update "live edit")
 * All these type/step ids are < 128, so they occupy a single varint byte and can be
 * read positionally without a full decoder.
 *
 * A read-only client may REQUEST state (sync step1) and exchange awareness/presence,
 * but its step2 and update messages (the writes) are dropped. Server→client traffic
 * is never filtered, so a spectator still receives the full live document and chat.
 */

const MESSAGE_SYNC = 0
const SYNC_STEP1 = 0

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data // Buffer is a Uint8Array
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) {
    // ws may deliver a fragmented binary frame as an array of Buffers.
    const first = data[0]
    return first instanceof Uint8Array ? first : null
  }
  return null
}

/** True when a spectator is allowed to send this inbound message (reads/presence only). */
export function isReadOnlyAllowed(data: unknown): boolean {
  const bytes = toBytes(data)
  if (!bytes || bytes.length === 0) return true
  if (bytes[0] !== MESSAGE_SYNC) return true // awareness / queryAwareness / auth — read-safe
  // Sync: only step1 (state request) is a read; step2 + update are writes.
  return bytes[1] === SYNC_STEP1
}

/**
 * Make a socket read-only by wrapping the `message` listener the Yjs server attaches
 * inside setupWSConnection: write messages from this connection are silently dropped
 * before the Yjs handler ever applies them to the shared document. MUST be called
 * BEFORE setupWSConnection so the wrap is in place when its listener registers.
 */
export function makeSocketReadOnly(socket: WebSocket): void {
  const originalOn = socket.on.bind(socket)
  socket.on = ((event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'message') {
      return originalOn('message', (...args: unknown[]) => {
        if (isReadOnlyAllowed(args[0])) listener(...args)
      })
    }
    return originalOn(event as 'message', listener as never)
  }) as typeof socket.on
}
