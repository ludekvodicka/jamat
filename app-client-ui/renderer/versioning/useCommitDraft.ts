import { useCallback, useEffect, useRef, useState } from 'react'

import type { VersioningCommitDraftDto, VersioningCommitOpenResult, VersioningReviewEdit } from '../../shared/versioningCommit'
import { IpcSnapshotReader } from '../ipc/ipcSnapshotReader'
import type { PanelSplitCommitItem } from '../widgets/tabs/panelSplit'
import { ReviewActivationReceipts } from './reviewActivationReceipts'
import { CommitDraftBuffer } from './commitDraftBuffer'
import { CommitPaneChannel, type CommitPaneChannelLoss, type CommitPanePorts } from './commitPanePorts'

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

export function useCommitDraft(sessionId: string, item: PanelSplitCommitItem, ports: CommitPanePorts, reviewOnly?: boolean): {
  draft: VersioningCommitDraftDto | null
  error: string | null
  setMessage(message: string): void
  refresh(): void
  sync(): Promise<void>
  conflict: VersioningCommitDraftDto | null
  /** The review this pane held when the conflict was found, so a comparison shows what changed since. */
  conflictHeld: VersioningCommitDraftDto | null
  /** This pane holds message text the source has not accepted. */
  unsent: boolean
  reloadEdits(): void
  keepEdits(): void
  saveRepositoryMessage(root: string, message: string): Promise<VersioningCommitDraftDto | null>
  saveSelection(snapshotId: string, fileIds: readonly string[]): Promise<VersioningCommitDraftDto | null>
  /** Saves the selection for an approval, and says when the channel, not the source, refused it. */
  reviewSelection(snapshotId: string, fileIds: readonly string[]): Promise<{ draft: VersioningCommitDraftDto | null; lost: CommitPaneChannelLoss | null }>
} {
  const [draft, setDraft] = useState<VersioningCommitDraftDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [conflict, setConflictState] = useState<{ current: VersioningCommitDraftDto | null; held: VersioningCommitDraftDto | null }>({ current: null, held: null })
  const setConflict = useCallback((current: VersioningCommitDraftDto | null, held: VersioningCommitDraftDto | null = null): void => setConflictState({ current, held }), [])
  const source = useRef<VersioningCommitDraftDto | null>(null)
  const generation = useRef(0)
  const edits = useRef(Promise.resolve())
  const blocked = useRef(false)
  const localMessage = useRef<string | null>(null)
  const localSource = useRef<VersioningCommitDraftDto['messageSource']>('person-local')
  const reader = useRef<IpcSnapshotReader<VersioningCommitDraftDto | null> | null>(null)
  const acceptSnapshot = useRef<((value: VersioningCommitDraftDto | null) => void) | null>(null)
  const identity = JSON.stringify([ports.identity ?? 'local', sessionId, item.reviewId ?? item.key])
  const persistBuffer = useCallback((message: string | null) => {
    try { CommitDraftBuffer.write(identity, message); setStorageError(null) }
    catch (error) { setStorageError(`Your text is held in this pane but could not be saved locally: ${String(error)}`) }
  }, [identity])
  const heldIdentity = useRef(identity)
  const { vcs, scopeRoot } = item
  const pathsKey = JSON.stringify(item.paths)
  useEffect(() => {
    generation.current++
    let disposed = false
    let projected = false
    let stop: (() => void) | undefined
    if (heldIdentity.current !== identity) {
      source.current = null
      localMessage.current = null
      blocked.current = false
      setConflict(null)
      setEditError(null)
      heldIdentity.current = identity
    }
    try {
      const saved = CommitDraftBuffer.read(identity)
      if (saved !== null) { localMessage.current = saved.message; localSource.current = saved.source }
    }
    catch (error) { setStorageError(`Local unsent text could not be read: ${String(error)}`) }
    setDraft(null)
    setError(null)
    const open = async (): Promise<VersioningCommitOpenResult> => {
      const result = await ports.versioning.openDraft(sessionId, vcs, scopeRoot || null, item.paths, item.reviewId, reviewOnly ? true : undefined)
      return result.ok ? result.value : { ok: false, code: 'unknown-session', detail: result.error }
    }
    const lease = CommitDraftLeases.acquire(JSON.stringify([identity, ports.generation ?? 0, vcs, scopeRoot, pathsKey, reviewOnly === true]), open,
      (id) => { void ports.versioning.closeCommit(id) })
    void lease.opening.then((answer) => {
      if (disposed) return
      if (!answer.ok) { setError(answer.detail); return }
      let draftId = answer.value.draftId
      lease.setDraftId(draftId)
      const accept = (value: VersioningCommitDraftDto | null): void => {
        if (disposed) return
        if (value === null || source.current?.draftId === value.draftId && source.current.epoch === value.epoch && source.current.revision > value.revision) return
        if (!projected && item.openId) {
          projected = true
          try {
            if (ReviewActivationReceipts.consume(identity, item.openId))
              void ports.projectReview?.(value, item.key, item.openId).catch((error: unknown) => ports.reportError(String(error)))
          } catch (error) { ports.reportError(`Review activation could not be saved: ${String(error)}`) }
        }
        if (!blocked.current && localMessage.current !== null && value.message !== localMessage.current && (!source.current || source.current.epoch !== value.epoch)) {
          blocked.current = true
          setConflict(value, source.current)
          setEditError('The source reconnected. Compare your unsent text with the restored review.')
        }
        source.current = value
        if (value.message === localMessage.current) { localMessage.current = null; persistBuffer(null) }
        setDraft((held) => held !== null && held.draftId === value.draftId && held.epoch === value.epoch && held.revision > value.revision
          ? held : { ...value, message: localMessage.current ?? value.message, messageSource: localMessage.current === null ? value.messageSource : localSource.current })
      }
      acceptSnapshot.current = accept
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
      }, accept, setError)
      reader.current = next
      stop = next.start()
    }).catch((error: unknown) => { if (!disposed) setError(String(error)) })
    return () => {
      disposed = true
      stop?.()
      reader.current = null
      acceptSnapshot.current = null
      lease.release()
    }
  }, [sessionId, identity, item.reviewId, item.openId, vcs, scopeRoot, pathsKey, ports, reviewOnly])

  const sync = useCallback((): Promise<void> => {
    const savedGeneration = generation.current
    const pending = edits.current.then(async () => {
      const held = source.current
      if (!held || savedGeneration !== generation.current) return
      const answer = await ports.versioning.readCommit(held.draftId)
      if (savedGeneration !== generation.current) return
      if (!answer.ok) throw new Error(answer.error)
      if (answer.value === null) throw new Error('The commit review is no longer available')
      acceptSnapshot.current?.(answer.value)
    })
    edits.current = pending.catch((error: unknown) => { setError(String(error)) })
    return pending
  }, [ports])

  const attempt = useCallback(async (change: Pick<VersioningReviewEdit, 'message' | 'selection' | 'messageSource' | 'repositoryMessage'>)
    : Promise<{ draft: VersioningCommitDraftDto | null; lost: CommitPaneChannelLoss | null }> => {
    const savedGeneration = generation.current
    const held = source.current
    if (heldIdentity.current !== identity) return { draft: null, lost: null }
    if (!held || blocked.current) return { draft: null, lost: null }
    const edit = ports.versioning.editCommit
    if (!edit || !held.epoch) {
      if (change.message !== undefined) {
        const answer = await ports.versioning.setCommitMessage(held.draftId, change.message)
        if (!answer.ok || !answer.value) { setEditError(answer.ok ? 'The commit message could not be saved' : answer.error); return { draft: null, lost: null } }
      }
      return { draft: held, lost: null }
    }
    const answer = await edit({ draftId: held.draftId, epoch: held.epoch, expectedRevision: held.revision, ...change })
    if (savedGeneration !== generation.current) return { draft: null, lost: null }
    // The channel answered for the source (UA1-J12-3): nothing proves the review changed, so the
    // next edit finds out; a real change arrives as the source's own refusal below.
    const lost = CommitPaneChannel.lossOf(answer)
    if (lost !== null) { setEditError(answer.ok ? null : answer.error); return { draft: null, lost } }
    if (!answer.ok) { blocked.current = true; setConflict(source.current, held); setEditError(answer.error); return { draft: null, lost: null } }
    if (!answer.value.ok) {
      blocked.current = true
      setConflict(answer.value.current ?? source.current, held)
      setEditError(answer.value.detail)
      return { draft: null, lost: null }
    }
    source.current = answer.value.value
    if (change.message === localMessage.current) { localMessage.current = null; persistBuffer(null) }
    setDraft({ ...answer.value.value, message: localMessage.current ?? answer.value.value.message, messageSource: localMessage.current === null ? answer.value.value.messageSource : localSource.current })
    setEditError(null)
    return { draft: answer.value.value, lost: null }
  }, [ports, identity, persistBuffer])
  const save = useCallback(async (change: Parameters<typeof attempt>[0]) => (await attempt(change)).draft, [attempt])
  const setMessage = useCallback((message: string) => {
    localMessage.current = message
    localSource.current = 'person-local'
    setDraft((value) => value === null ? null : { ...value, message, messageSource: 'person-local', editedByPerson: true })
    persistBuffer(message)
    edits.current = edits.current.then(async () => { await save({ message }); reader.current?.refresh() })
      .catch((error: unknown) => { setError(String(error)) })
  }, [save, persistBuffer])
  const saveRepositoryMessage = useCallback(async (root: string, message: string) => {
    const result = edits.current.then(() => save({ repositoryMessage: { root, message } }))
    edits.current = result.then(() => undefined, (error: unknown) => { setError(String(error)) })
    return result
  }, [save])
  const saveSelection = useCallback(async (snapshotId: string, fileIds: readonly string[]) => {
    const result = edits.current.then(() => save({ selection: { snapshotId, fileIds } }))
    edits.current = result.then(() => undefined, (error: unknown) => { setError(String(error)) })
    return result
  }, [save])
  const reviewSelection = useCallback(async (snapshotId: string, fileIds: readonly string[]) => {
    const result = edits.current.then(() => attempt({ selection: { snapshotId, fileIds } }))
    edits.current = result.then(() => undefined, (error: unknown) => { setError(String(error)) })
    return result
  }, [attempt])
  const keepEdits = (): void => {
    if (localMessage.current === null) return
    const message = localMessage.current
    blocked.current = false
    setConflict(null)
    setEditError(null)
    edits.current = edits.current.then(async () => {
      await save({ message, ...localSource.current === 'restored-draft' ? { messageSource: 'restored-draft' as const } : {} })
      reader.current?.refresh()
    }).catch((error: unknown) => { setError(String(error)) })
  }
  const reloadEdits = (): void => {
    persistBuffer(null)
    localMessage.current = null
    blocked.current = false
    setConflict(null)
    setEditError(null)
    setError(null)
    if (source.current) setDraft(source.current)
    reader.current?.refresh()
  }
  return { draft, error: storageError ?? editError ?? error, setMessage, conflict: conflict.current, conflictHeld: conflict.held, unsent: localMessage.current !== null,
    reloadEdits, keepEdits, saveSelection, reviewSelection, saveRepositoryMessage, sync, refresh: () => reader.current?.refresh() }
}
