import { useCallback, useMemo, useSyncExternalStore } from 'react'

import type {
  SessionsSnapshot,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SnapshotStore, SnapshotStoreState } from '../../ipc/snapshotStore'

export interface SessionsSnapshotHandle extends SnapshotStoreState<SessionsSnapshot> {
  refresh(): void
}

export interface SnapshotStoreHandle<T extends { revision: number }> extends SnapshotStoreState<T> {
  refresh(): void
}

/**
 * A React view over the one sessions store owned by this document. The reader, revision and Retry
 * state live in the store, so every consumer observes the same snapshot object and failure.
 */
export function useSessionsSnapshot(
  store: SnapshotStore<SessionsSnapshot>,
): SessionsSnapshotHandle {
  return useSnapshotStore(store)
}

/**
 * `subscribed: false` keeps the last read without listening: a component that shows nothing of the
 * store at the moment does not re-render on each of its changes, and reads afresh once it listens.
 */
export function useSnapshotStore<T extends { revision: number }>(
  store: SnapshotStore<T>,
  subscribed = true,
): SnapshotStoreHandle<T> {
  const subscribe = useCallback((onChanged: () => void) => subscribed ? store.subscribe(onChanged) : () => {}, [store, subscribed])
  const current = useCallback(() => store.current(), [store])
  const state = useSyncExternalStore(subscribe, current, current)
  const refresh = useCallback(() => store.refresh(), [store])
  return useMemo(() => ({ ...state, refresh }), [state, refresh])
}
