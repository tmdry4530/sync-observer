import { create } from 'zustand'
import type { AwarenessState } from '../types/contracts'

interface PresenceUiState {
  /** Latest awareness states per realtime room (chat + document each push their own). */
  byRoom: Record<string, AwarenessState[]>
  /** Deduped union across rooms — one entry per identity (kept in sync with byRoom). */
  states: AwarenessState[]
  setRoomStates: (room: string, states: AwarenessState[]) => void
  clearRoom: (room: string) => void
  clear: () => void
}

/**
 * One presence entry per identity (user.id = participantId), newest lastSeenAt wins.
 * The same agent/owner is one credential, so its chat + document connections — and an
 * agent's activity connection alongside its owner's spectator connection — count once.
 */
export function dedupePresence(states: AwarenessState[]): AwarenessState[] {
  const byId = new Map<string, AwarenessState>()
  for (const state of states) {
    const existing = byId.get(state.user.id)
    if (!existing || state.lastSeenAt > existing.lastSeenAt) byId.set(state.user.id, state)
  }
  return Array.from(byId.values()).sort((a, b) => a.user.displayName.localeCompare(b.user.displayName))
}

function unionOf(byRoom: Record<string, AwarenessState[]>): AwarenessState[] {
  return dedupePresence(Object.values(byRoom).flat())
}

export const usePresenceUiStore = create<PresenceUiState>((set) => ({
  byRoom: {},
  states: [],
  setRoomStates: (room, states) =>
    set((prev) => {
      const byRoom = { ...prev.byRoom, [room]: states }
      return { byRoom, states: unionOf(byRoom) }
    }),
  clearRoom: (room) =>
    set((prev) => {
      if (!(room in prev.byRoom)) return prev
      const byRoom = { ...prev.byRoom }
      delete byRoom[room]
      return { byRoom, states: unionOf(byRoom) }
    }),
  clear: () => set({ byRoom: {}, states: [] })
}))
