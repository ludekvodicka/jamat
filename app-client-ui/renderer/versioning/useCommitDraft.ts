import { useCallback, useEffect, useRef, useState } from 'react'

import type { VersioningCommitDraftDto, VersioningCommitOpenResult } from '../../shared/versioningCommit'
import { IpcSnapshotReader } from '../ipc/ipcSnapshotReader'
import type { PanelSplitCommitItem } from '../widgets/tabs/panelSplit'
import type { CommitPanePorts } from './commitPanePorts'

interface DraftLease {
  users: Set<object>
  opening: Promise<VersioningCommitOpenResult>
  draftId: string | null
}

class CommitDraftLeases {
  private static readonly held = new Map<string, DraftLease>()

  static acquire(key: string, open: () => DraftLease['opening'], close: (draftId: string) => void): {
    opening: DraftLease['opening']; setDraftId(id: string): void; release(): void
  } {
    const lease = CommitDraftLeases.held.get(key) ?? { users: new Set<object>(), opening: open(), draftId: null }
    CommitDraftLeases.held.set(key, lease)
    const user = {}
    lease.users.add(user)
    return {
      opening: lease.opening,
      setDraftId: (id) => { lease.draftId = id },
      release: () => {
        lease.users.delete(user)
        // StrictMode remounts in the same turn; two panels in one window also share one main owner.
        queueMicrotask(() => {
          if (lease.users.size !== 0 || CommitDraftLeases.held.get(key) !== lease) return
          CommitDraftLeases.held.delete(key)
          void lease.opening.then((answer) => { if (answer.ok) close(lease.draftId ?? answer.value.draftId) }).catch(() => undefined)
        })
      },
    }
  }
}

export function useCommitDraft(sessionId: string, item: PanelSplitCommitItem, ports: CommitPanePorts): {
  draft: VersioningCommitDraftDto | null
  error: string | null
  setMessage(message: string): void
  refresh(): void
} {
  const [draft, setDraft] = useState<VersioningCommitDraftDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const localMessage = useRef<string | null>(null)
  const reader = useRef<IpcSnapshotReader<VersioningCommitDraftDto | null> | null>(null)
  const { vcs, scopeRoot } = item
  useEffect(() => {
    let disposed = false
    let stop: (() => void) | undefined
    localMessage.current = null
    setDraft(null)
    setError(null)
    const open = async (): Promise<VersioningCommitOpenResult> => {
      const result = await ports.versioning.openDraft(sessionId, vcs, scopeRoot || null)
      return result.ok ? result.value : { ok: false, code: 'unknown-session', detail: result.error }
    }
    const lease = CommitDraftLeases.acquire(JSON.stringify([sessionId, vcs, scopeRoot]), open,
      (id) => { void ports.versioning.closeCommit(id) })
    void lease.opening.then((answer) => {
      if (disposed) return
      if (!answer.ok) { setError(answer.detail); return }
      let draftId = answer.value.draftId
      lease.setDraftId(draftId)
      const next = new IpcSnapshotReader<VersioningCommitDraftDto | null>({
        subject: 'Commit dialog',
        read: async () => {
          const answer = await ports.versioning.readCommit(draftId)
          if (!answer.ok || answer.value !== null) return answer
          const reopened = await open()
          if (!reopened.ok) return { ok: false, error: reopened.detail }
          draftId = reopened.value.draftId
          lease.setDraftId(draftId)
          return ports.versioning.readCommit(draftId)
        },
        subscribe: ports.subscribe,
        reportError: ports.reportError,
      }, (value) => {
        if (value === null) return
        if (value.message === localMessage.current) localMessage.current = null
        setDraft((held) => held !== null && held.draftId === value.draftId && held.revision > value.revision
          ? held : { ...value, message: localMessage.current ?? value.message })
      }, setError)
      reader.current = next
      stop = next.start()
    }).catch((error: unknown) => { if (!disposed) setError(String(error)) })
    return () => {
      disposed = true
      stop?.()
      reader.current = null
      lease.release()
    }
  }, [sessionId, vcs, scopeRoot, ports])

  const draftId = draft?.draftId
  const setMessage = useCallback((message: string) => {
    if (draftId === undefined) return
    localMessage.current = message
    setDraft((value) => value === null ? null : { ...value, message, editedByPerson: true })
    void ports.versioning.setCommitMessage(draftId, message).then((answer) => {
      if (!answer.ok) setError(answer.error)
      else if (!answer.value) setError('The commit message could not be saved')
      reader.current?.refresh()
    })
  }, [draftId, ports])
  return { draft, error, setMessage, refresh: () => reader.current?.refresh() }
}
