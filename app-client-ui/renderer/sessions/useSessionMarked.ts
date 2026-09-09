import { useCallback, useSyncExternalStore } from 'react'

import type { SessionsMarksStore } from './sessionsMarksStore'

/**
 * Whether this one session carries something the person has not seen, as a primitive.
 *
 * A boolean is the whole point, the same way `useSessionGlyph` hands back a glyph: React compares it
 * by value, so a mark that moved on some OTHER session re-renders nothing here. A tab holding the
 * view itself would re-draw on every snapshot tick instead.
 */
export function useSessionMarked(store: SessionsMarksStore, sessionId: string): boolean {
  const read = useCallback(() => store.markedOf(sessionId), [store, sessionId])
  return useSyncExternalStore(
    useCallback((listener) => store.subscribe(listener), [store]),
    read,
    read,
  )
}
