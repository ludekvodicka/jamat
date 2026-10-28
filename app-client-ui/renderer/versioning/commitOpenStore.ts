import type { RemoteConnectionsSnapshot } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { RemoteSessionSummary } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import { TerminalTargetCodec } from '../../shared/terminalTarget'
import { useMemo } from 'react'

import type { VersioningCommitOpenSessions } from '../../shared/versioningCommit'
import { SnapshotStore, type SnapshotStorePorts } from '../ipc/snapshotStore'
import { useSnapshotStore } from '../views/sessionsTree/useSessionsSnapshot'

export class CommitOpenStore extends SnapshotStore<VersioningCommitOpenSessions> {
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
  const { snapshot } = useSnapshotStore(store)
  return useMemo(() => new Set(snapshot?.sessionIds ?? []), [snapshot])
}
