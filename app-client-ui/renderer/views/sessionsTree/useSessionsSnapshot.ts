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

export function useSnapshotStore<T extends { revision: number }>(
  store: SnapshotStore<T>,
): SnapshotStoreHandle<T> {
  const subscribe = useCallback((onChanged: () => void) => store.subscribe(onChanged), [store])
  const current = useCallback(() => store.current(), [store])
  const state = useSyncExternalStore(subscribe, current, current)
  const refresh = useCallback(() => store.refresh(), [store])
  return useMemo(() => ({ ...state, refresh }), [state, refresh])
}
