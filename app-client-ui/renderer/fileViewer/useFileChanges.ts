import { useCallback, useEffect, useRef, useState } from 'react'

import { IpcFailure } from '../ipc/ipcFailure'

import type {
  FileChangeGroup,
  FileChangesSnapshot,
  FileChangesVcsId,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { FileChangesViewModel } from './fileViewerPanel.types'

export function useFileChanges(sessionId: string, enabled = true): FileChangesViewModel {
  const [snapshot, setSnapshot] = useState<FileChangesSnapshot | null>(null)
  const [groups, setGroups] = useState<readonly FileChangeGroup[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [preferredVcs, setPreferredVcs] = useState<FileChangesVcsId | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  const reload = useCallback(async (requested?: FileChangesVcsId | null): Promise<void> => {
    const selected = requested === undefined ? preferredVcs : requested
    const current = ++generation.current
    if (requested !== undefined) setPreferredVcs(requested)
    setLoading(true)
    setError(null)
    const answer = await window.appClient.fileChanges.list(sessionId, selected)
    if (current !== generation.current) return
    setLoading(false)
    const refusal = IpcFailure.of(answer)
    if (refusal !== null) {
      setError(refusal)
      return
    }
    if (!answer.ok || !answer.value.ok) return
    setSnapshot(answer.value.value)
    setGroups(answer.value.value.history.groups)
    setNextCursor(answer.value.value.history.nextCursor)
  }, [preferredVcs, sessionId])

  useEffect(() => {
    if (enabled) void reload(null)
    else setLoading(false)
    // Belt to `reload`'s braces. When this effect runs again its own `++generation` already retires
    // whatever was in flight, so what this adds is the plain unmount - where React makes a late
    // setState a silent no-op anyway. Kept because the rule of the file is "a later ask wins" and
    // this is the one path that used to rely on somebody else enforcing it.
    return () => { generation.current += 1 }
  }, [enabled, sessionId])

  const loadMore = useCallback(async (): Promise<void> => {
    if (!snapshot || !nextCursor || loadingMore) return
    // A page belongs to the snapshot it was asked of - cursors are kept per snapshot - so a reload
    // that lands first makes this answer meaningless. Appended anyway, it mixed two snapshots' groups
    // into one list and installed the old snapshot's cursor, after which the next Load older changes
    // answered `invalid-cursor` and paging was dead until the next reload.
    const current = generation.current
    setLoadingMore(true)
    const answer = await window.appClient.fileChanges.history(snapshot.snapshotId, nextCursor)
    if (current !== generation.current) return
    setLoadingMore(false)
    const refusal = IpcFailure.of(answer)
    if (refusal !== null) {
      setError(refusal)
      return
    }
    if (!answer.ok || !answer.value.ok) return
    const page = answer.value.value
    setGroups((current) => {
      const existing = new Set(current.map((group) => group.groupId))
      return [...current, ...page.groups.filter((group) => !existing.has(group.groupId))]
    })
    setNextCursor(page.nextCursor)
  }, [loadingMore, nextCursor, snapshot])

  return {
    snapshot,
    groups,
    nextCursor,
    preferredVcs,
    loading,
    loadingMore,
    error,
    reload,
    loadMore,
  }
}
