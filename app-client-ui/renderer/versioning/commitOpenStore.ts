import { useMemo } from 'react'

import type { VersioningCommitOpenSessions } from '../../shared/versioningCommit'
import { SnapshotStore, type SnapshotStorePorts } from '../ipc/snapshotStore'
import { useSnapshotStore } from '../views/sessionsTree/useSessionsSnapshot'

export class CommitOpenStore extends SnapshotStore<VersioningCommitOpenSessions> {
  constructor(ports: SnapshotStorePorts<VersioningCommitOpenSessions>) { super('The open commit dialogs', ports) }
}

export function useCommitOpen(store: CommitOpenStore): ReadonlySet<string> {
  const { snapshot } = useSnapshotStore(store)
  return useMemo(() => new Set(snapshot?.sessionIds ?? []), [snapshot])
}
