import type { RemoteConnectionsSnapshot } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { RemoteSessionSummary } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import { TerminalTargetCodec } from '../../shared/terminalTarget'
import { useCallback, useRef, useSyncExternalStore } from 'react'

import type { VersioningCommitOpenSessions } from '../../shared/versioningCommit'
import { SnapshotStore, type SnapshotStorePorts } from '../ipc/snapshotStore'

export type CommitOpenReviewSummary = NonNullable<VersioningCommitOpenSessions['reviews']>[number]

export interface SessionCommitOpenState {
  readonly open: boolean
  readonly reviews: readonly CommitOpenReviewSummary[]
}

const emptySetConst: ReadonlySet<string> = new Set()
const emptyReviewsConst: readonly CommitOpenReviewSummary[] = []
const closedSessionCommitStateConst: SessionCommitOpenState = { open: false, reviews: emptyReviewsConst }
const noopSubscribeConst = (): () => void => () => {}

export class CommitOpenStore extends SnapshotStore<VersioningCommitOpenSessions> {
  static sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
    if (left.size !== right.size) return false
    for (const id of left)
      if (!right.has(id)) return false
    return true
  }

  static withRemote(local: ReadonlySet<string>, remote: RemoteConnectionsSnapshot | null): ReadonlySet<string> {
    const ids = new Set(local)
    for (const endpoint of remote?.outbound ?? [])
      for (const session of endpoint.sessions?.sessions ?? [])
        if ((session as Partial<RemoteSessionSummary>).reviewPending === true)
          ids.add(TerminalTargetCodec.key({ kind: 'remote', remoteEndpointId: endpoint.remoteEndpointId, sessionId: session.sessionId }))
    return ids
  }
  constructor(ports: SnapshotStorePorts<VersioningCommitOpenSessions>) { super('The open commit dialogs', ports) }
}

export function useCommitOpen(store: CommitOpenStore): ReadonlySet<string> {
  const cached = useRef<{ snapshot: VersioningCommitOpenSessions | null; ids: ReadonlySet<string> }>({
    snapshot: null,
    ids: emptySetConst,
  })
  return useSyncExternalStore(
    useCallback((listener) => store.subscribe(listener), [store]),
    useCallback(() => {
      const snapshot = store.current().snapshot
      if (snapshot === cached.current.snapshot) return cached.current.ids
      const next = snapshot === null || snapshot.sessionIds.length === 0 ? emptySetConst : new Set(snapshot.sessionIds)
      const stable = CommitOpenStore.sameIds(cached.current.ids, next) ? cached.current.ids : next
      cached.current = { snapshot, ids: stable }
      return stable
    }, [store]),
  )
}

export function useSessionCommitOpen(
  store: CommitOpenStore,
  sessionId: string,
  enabled: boolean,
): SessionCommitOpenState {
  const cached = useRef<{
    snapshot: VersioningCommitOpenSessions | null
    sessionId: string
    key: string
    value: SessionCommitOpenState
  }>({
    snapshot: null,
    sessionId,
    key: '',
    value: closedSessionCommitStateConst,
  })
  return useSyncExternalStore(
    useCallback((listener) => enabled ? store.subscribe(listener) : noopSubscribeConst(), [store, enabled]),
    useCallback(() => {
      if (!enabled) return closedSessionCommitStateConst
      const snapshot = store.current().snapshot
      if (snapshot === cached.current.snapshot && cached.current.sessionId === sessionId)
        return cached.current.value
      const open = snapshot?.sessionIds.includes(sessionId) === true
      const reviews = snapshot?.reviews?.filter((review) => review.sessionId === sessionId) ?? emptyReviewsConst
      const key = open || reviews.length > 0 ? JSON.stringify([open, reviews]) : ''
      if (cached.current.sessionId === sessionId && cached.current.key === key) {
        cached.current = { snapshot, sessionId, key, value: cached.current.value }
        return cached.current.value
      }
      const value: SessionCommitOpenState = !open && reviews.length === 0
        ? closedSessionCommitStateConst
        : { open, reviews }
      cached.current = { snapshot, sessionId, key, value }
      return value
    }, [store, sessionId, enabled]),
  )
}
