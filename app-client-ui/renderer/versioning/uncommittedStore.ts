import { useCallback, useRef, useSyncExternalStore } from 'react'

import type { RemoteConnectionsSnapshot } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { RemoteSessionSummary } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import type {
  SessionUncommittedEntry,
  SessionUncommittedSnapshot,
} from '../../../lib-orchestrator/sessionUncommitted/sessionUncommitted.types'
import { TerminalTargetCodec } from '../../shared/terminalTarget'
import { SnapshotStore, type SnapshotStorePorts } from '../ipc/snapshotStore'

const noSessions: Readonly<Record<string, SessionUncommittedEntry>> = {}

/**
 * The grey mark of every local session (D12): what each one changed and has not committed. The
 * store publishes only a new revision; a reader of one session gets a new entry object only when
 * that session's entry changed, so a change of another session redraws nothing of it.
 */
export class UncommittedStore extends SnapshotStore<SessionUncommittedSnapshot> {
  constructor(ports: SnapshotStorePorts<SessionUncommittedSnapshot>) { super('The uncommitted session changes', ports) }

  /**
   * The local entries by session id, plus one per outbound remote session that reports files, by its
   * target key. A paired PC sends only the count, so a remote entry has no paths.
   */
  static withRemote(
    local: Readonly<Record<string, SessionUncommittedEntry>>,
    remote: RemoteConnectionsSnapshot | null,
  ): Readonly<Record<string, SessionUncommittedEntry>> {
    let merged: Record<string, SessionUncommittedEntry> | null = null
    for (const endpoint of remote?.outbound ?? [])
      for (const session of endpoint.sessions?.sessions ?? []) {
        const files = (session as Partial<RemoteSessionSummary>).uncommittedFiles
        if (files === undefined) continue
        merged ??= { ...local }
        merged[TerminalTargetCodec.key({ kind: 'remote', remoteEndpointId: endpoint.remoteEndpointId, sessionId: session.sessionId })] = { files, sample: [] }
      }
    return merged ?? local
  }

  /** The tooltip of the grey `*`: the file count, then up to five paths. */
  static titleOf(entry: SessionUncommittedEntry): string {
    return [`Uncommitted session changes: ${entry.files} ${entry.files === 1 ? 'file' : 'files'}`, ...entry.sample].join('\n')
  }

  static same(left: SessionUncommittedEntry | null, right: SessionUncommittedEntry | null): boolean {
    if (left === null || right === null) return left === right
    return left.files === right.files && left.sample.length === right.sample.length
      && left.sample.every((path, index) => path === right.sample[index])
  }
}

/** Every local session's entry, for the tree; the object changes only with the revision. */
export function useUncommittedSessions(store: UncommittedStore): Readonly<Record<string, SessionUncommittedEntry>> {
  const subscribe = useCallback((changed: () => void) => store.subscribe(changed), [store])
  const read = useCallback(() => store.current().snapshot?.sessions ?? noSessions, [store])
  return useSyncExternalStore(subscribe, read, read)
}

/** One session's entry, or null; the same object for as long as its content stays the same. */
export function useSessionUncommitted(store: UncommittedStore, sessionId: string | null): SessionUncommittedEntry | null {
  const last = useRef<{ revision: number | null; sessionId: string | null; entry: SessionUncommittedEntry | null }>(
    { revision: null, sessionId: null, entry: null })
  const subscribe = useCallback((changed: () => void) => store.subscribe(changed), [store])
  const read = useCallback((): SessionUncommittedEntry | null => {
    const snapshot = store.current().snapshot
    const held = last.current
    const revision = snapshot?.revision ?? null
    if (held.revision === revision && held.sessionId === sessionId) return held.entry
    const entry = sessionId === null ? null : snapshot?.sessions[sessionId] ?? null
    last.current = { revision, sessionId, entry: held.sessionId === sessionId && UncommittedStore.same(held.entry, entry) ? held.entry : entry }
    return last.current.entry
  }, [store, sessionId])
  return useSyncExternalStore(subscribe, read, read)
}
