import { useCallback, useRef, useSyncExternalStore } from 'react'

import type {
  RemoteConnectionsSnapshot,
} from '../../../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type {
  SessionInfo,
  SessionsSnapshot,
} from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { type TerminalTarget, TerminalTargetCodec } from '../../../../shared/terminalTarget'
import type { SnapshotStore } from '../../../ipc/snapshotStore'

/**
 * This session's record, as the panel drawing it sees it.
 *
 * **The value is kept while its CONTENT is unchanged**, which is the whole of why it is not a bare
 * `find`. A snapshot is deserialized fresh on every revision, so every session in it is a new object
 * even when nothing about it moved - and a snapshot's revision moves whenever ANY session's activity
 * does. Every open terminal panel therefore re-rendered whenever any other session changed, which is
 * every couple of seconds in a window holding a dozen working agents.
 *
 * Content is compared by serializing one record - a few hundred bytes - which is the same trick
 * `SessionsTreeModel.withIdentity` uses for tree nodes, and it cannot fall out of step with the
 * fields a panel happens to read the way a hand-written field list would.
 */
export function useTerminalSessionInfo(
  local: SnapshotStore<SessionsSnapshot>,
  remote: SnapshotStore<RemoteConnectionsSnapshot>,
  target: TerminalTarget,
): SessionInfo | null {
  const endpointId = TerminalTargetCodec.endpointOf(target)
  const sessionId = target.sessionId
  const kept = useRef<{ info: SessionInfo; shape: string } | null>(null)
  const read = useCallback((): SessionInfo | null => {
    const found = endpointId === null
      ? local.current().snapshot?.sessions
        .find((session) => session.sessionId === sessionId) ?? null
      : remote.current().snapshot?.outbound
        .find((entry) => entry.remoteEndpointId === endpointId)
        ?.sessions?.sessions.find((session) => session.sessionId === sessionId) ?? null
    if (found === null) {
      kept.current = null
      return null
    }
    const shape = JSON.stringify(found)
    if (kept.current?.shape === shape) return kept.current.info
    kept.current = { info: found, shape }
    return found
  }, [local, remote, endpointId, sessionId])
  const subscribe = useCallback((listener: () => void) => {
    const offLocal = local.subscribe(listener)
    const offRemote = remote.subscribe(listener)
    return () => {
      offLocal()
      offRemote()
    }
  }, [local, remote])
  return useSyncExternalStore(subscribe, read, read)
}
