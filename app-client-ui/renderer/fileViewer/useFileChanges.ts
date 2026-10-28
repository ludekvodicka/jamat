import { useCallback, useEffect, useRef, useState } from 'react'

import type { AppClientUiBridge } from '../../shared/appClientUiIpc'
import { IpcFailure } from '../ipc/ipcFailure'

import type {
  FileChangeGroup,
  FileChangesSnapshot,
  FileChangesVcsId,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { FileChangesViewModel } from './fileViewerPanel.types'

export function useFileChanges(sessionId: string, ports: Pick<AppClientUiBridge['fileChanges'], 'list' | 'history'> | null, enabled = true): FileChangesViewModel {
  const [snapshot, setSnapshot] = useState<FileChangesSnapshot | null>(null)
  const [groups, setGroups] = useState<readonly FileChangeGroup[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [preferredVcs, setPreferredVcs] = useState<FileChangesVcsId | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const loadedGroups = useRef(0)
  const previousContext = useRef({ sessionId, ports })

  const reload = useCallback(async (requested?: FileChangesVcsId | null): Promise<FileChangesSnapshot | null> => {
    if (!ports) { setLoading(false); setError('Changes are unavailable for this session.'); return null }
    const selected = requested === undefined ? preferredVcs : requested
    const depth = requested === undefined ? loadedGroups.current : 0
    const current = ++generation.current
    if (requested !== undefined) setPreferredVcs(requested)
    setLoading(true)
    setLoadingMore(false)
    setError(null)
    const answer = await ports.list(sessionId, selected)
    if (current !== generation.current) return null
    const refusal = IpcFailure.of(answer)
    if (refusal !== null) {
      setLoading(false)
      setError(refusal)
      return null
    }
    if (!answer.ok || !answer.value.ok) { setLoading(false); return null }
    let fresh = answer.value.value
    while (fresh.history.groups.length < depth && fresh.history.nextCursor !== null) {
      const page = await ports.history(fresh.snapshotId, fresh.history.nextCursor)
      if (current !== generation.current) return null
      const failure = IpcFailure.of(page)
      if (failure !== null) { setLoading(false); setError(failure); return null }
      if (!page.ok || !page.value.ok) { setLoading(false); return null }
      fresh = { ...fresh, history: { groups: [...fresh.history.groups, ...page.value.value.groups], nextCursor: page.value.value.nextCursor } }
    }
    loadedGroups.current = fresh.history.groups.length
    setLoading(false)
    setSnapshot(fresh)
    setGroups(fresh.history.groups)
    setNextCursor(fresh.history.nextCursor)
    return fresh
  }, [preferredVcs, sessionId, ports])

  useEffect(() => {
    if (previousContext.current.sessionId !== sessionId || previousContext.current.ports !== ports) {
      setSnapshot(null); setGroups([]); setNextCursor(null); loadedGroups.current = 0
      previousContext.current = { sessionId, ports }
    }
    if (enabled) void reload(null)
    else setLoading(false)
    // Belt to `reload`'s braces. When this effect runs again its own `++generation` already retires
    // whatever was in flight, so what this adds is the plain unmount - where React makes a late
    // setState a silent no-op anyway. Kept because the rule of the file is "a later ask wins" and
    // this is the one path that used to rely on somebody else enforcing it.
    return () => { generation.current += 1 }
  }, [enabled, sessionId, ports])

  const loadMore = useCallback(async (): Promise<void> => {
    if (!ports || !snapshot || !nextCursor || loadingMore) return
    // A page belongs to the snapshot it was asked of - cursors are kept per snapshot - so a reload
    // that lands first makes this answer meaningless. Appended anyway, it mixed two snapshots' groups
    // into one list and installed the old snapshot's cursor, after which the next Load older changes
    // answered `invalid-cursor` and paging was dead until the next reload.
    const current = generation.current
    setLoadingMore(true)
    const answer = await ports.history(snapshot.snapshotId, nextCursor)
    if (current !== generation.current) return
    setLoadingMore(false)
    if (answer.ok && !answer.value.ok && answer.value.code === 'snapshot-expired') { await reload(); return }
    const refusal = IpcFailure.of(answer)
    if (refusal !== null) {
      setError(refusal)
      return
    }
    if (!answer.ok || !answer.value.ok) return
    const page = answer.value.value
    setGroups((current) => {
      const existing = new Set(current.map((group) => group.groupId))
      const next = [...current, ...page.groups.filter((group) => !existing.has(group.groupId))]
      loadedGroups.current = next.length
      return next
    })
    setNextCursor(page.nextCursor)
  }, [loadingMore, nextCursor, snapshot, ports, reload])

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
