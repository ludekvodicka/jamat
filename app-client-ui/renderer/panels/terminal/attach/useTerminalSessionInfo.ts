import { useCallback, useSyncExternalStore } from 'react'

import type {
  RemoteConnectionsSnapshot,
} from '../../../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type {
  SessionInfo,
  SessionsSnapshot,
} from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { type TerminalTarget, TerminalTargetCodec } from '../../../../shared/terminalTarget'
import type { SnapshotStore } from '../../../ipc/snapshotStore'

export function useTerminalSessionInfo(
  local: SnapshotStore<SessionsSnapshot>,
  remote: SnapshotStore<RemoteConnectionsSnapshot>,
  target: TerminalTarget,
): SessionInfo | null {
  const endpointId = TerminalTargetCodec.endpointOf(target)
  const sessionId = target.sessionId
  const read = useCallback((): SessionInfo | null => {
    if (endpointId === null)
      return local.current().snapshot?.sessions
        .find((session) => session.sessionId === sessionId) ?? null
    return remote.current().snapshot?.outbound
      .find((entry) => entry.remoteEndpointId === endpointId)
      ?.sessions?.sessions.find((session) => session.sessionId === sessionId) ?? null
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
