import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  FileChangesWorkingTreeSnapshot,
  FileChangesWorkingTreeSource,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { IpcFailure } from '../ipc/ipcFailure'
import type { FileChangesWorkingTreeViewModel } from './fileViewerPanel.types'

interface WorkingTreeReading {
  sessionId: string
  snapshot: FileChangesWorkingTreeSnapshot | null
  loading: boolean
  error: string | null
}

interface LatestWorkingTreeSnapshot {
  sessionId: string
  snapshot: FileChangesWorkingTreeSnapshot
}

export function useWorkingTreeChanges(
  sessionId: string,
  enabled: boolean,
  requiredSource?: FileChangesWorkingTreeSource,
): FileChangesWorkingTreeViewModel {
  const [selected, setSelected] = useState<FileChangesWorkingTreeSource | null>(null)
  const [readings, setReadings] = useState<Record<string, WorkingTreeReading>>({})
  const generations = useRef(new Map<string, number>())
  const desired = useRef(new Set<string>())
  const latestSnapshot = useRef<LatestWorkingTreeSnapshot | null>(null)

  const read = useCallback(async (
    source: FileChangesWorkingTreeSource | null,
  ): Promise<void> => {
    const key = UseWorkingTreeChanges.keyOf(sessionId, source)
    const current = (generations.current.get(key) ?? 0) + 1
    generations.current.set(key, current)
    setReadings((value) => ({
      ...value,
      [key]: {
        sessionId,
        snapshot: value[key]?.snapshot
          ?? (latestSnapshot.current?.sessionId === sessionId
            ? latestSnapshot.current.snapshot
            : null),
        loading: true,
        error: null,
      },
    }))
    const answer = await window.appClient.fileChanges.workingTree(sessionId, source)
    if (generations.current.get(key) !== current || !desired.current.has(key)) return
    const refusal = IpcFailure.of(answer)
    if (refusal !== null) {
      setReadings((value) => ({
        ...value,
        [key]: {
          sessionId,
          snapshot: value[key]?.snapshot ?? null,
          loading: false,
          error: refusal,
        },
      }))
      return
    }
    if (!answer.ok) return
    const result = answer.value
    if (!result.ok) {
      const detail = result.detail
      setReadings((value) => ({
        ...value,
        [key]: {
          sessionId,
          snapshot: value[key]?.snapshot ?? null,
          loading: false,
          error: detail,
        },
      }))
      return
    }
    const snapshot = result.value
    latestSnapshot.current = { sessionId, snapshot }
    setReadings((value) => ({
      ...value,
      [key]: { sessionId, snapshot, loading: false, error: null },
    }))
  }, [sessionId])

  const desiredKey = JSON.stringify({ sessionId, enabled, selected, requiredSource: requiredSource ?? null })
  useEffect(() => {
    const sources = new Map<string, FileChangesWorkingTreeSource | null>()
    if (enabled) sources.set(UseWorkingTreeChanges.keyOf(sessionId, selected), selected)
    if (requiredSource !== undefined)
      sources.set(UseWorkingTreeChanges.keyOf(sessionId, requiredSource), requiredSource)
    const previous = desired.current
    const next = new Set(sources.keys())
    desired.current = next
    // A sidebar tab switch changes membership, not the sources in the intersection. Re-reading the
    // active split source would mint a new snapshot id and reload an otherwise unchanged diff.
    for (const key of previous) {
      if (!next.has(key))
        generations.current.set(key, (generations.current.get(key) ?? 0) + 1)
    }
    setReadings((value) => Object.fromEntries(
      Object.entries(value).filter(([key]) => next.has(key)),
    ))
    for (const [key, source] of sources) {
      if (!previous.has(key)) void read(source)
    }
  }, [desiredKey, read])

  useEffect(() => () => {
    for (const key of desired.current)
      generations.current.set(key, (generations.current.get(key) ?? 0) + 1)
    desired.current.clear()
  }, [])

  const selectedKey = UseWorkingTreeChanges.keyOf(sessionId, selected)
  const current = readings[selectedKey]
  const required = requiredSource === undefined
    ? undefined
    : readings[UseWorkingTreeChanges.keyOf(sessionId, requiredSource)]
  const snapshots = useMemo(() => {
    // A contextual sidebar read can resolve to the split's explicit source. Keep the split's
    // existing snapshot first so showing the sidebar cannot replace its live diff target.
    const readingsInPriority = required === undefined
      ? Object.values(readings)
      : [required, ...Object.values(readings).filter((reading) => reading !== required)]
    const sources = new Set<FileChangesWorkingTreeSource | null>()
    return readingsInPriority.flatMap((reading) => {
      if (reading.sessionId !== sessionId || reading.snapshot === null) return []
      const source = reading.snapshot.source.selected
      if (sources.has(source)) return []
      sources.add(source)
      return [reading.snapshot]
    })
  }, [readings, required, sessionId])
  const snapshot = current?.snapshot ?? null
  return {
    snapshot,
    snapshots,
    selectedSource: selected ?? snapshot?.source.selected ?? null,
    loading: enabled && (current?.loading ?? true),
    error: current?.error ?? null,
    requiredLoading: requiredSource !== undefined && (required?.loading ?? true),
    requiredError: required?.error
      ?? (required?.snapshot?.source.selected !== requiredSource
        ? required?.snapshot?.source.fallbackReason ?? null
        : null),
    select: setSelected,
    reload: () => read(selected),
    snapshotFor: (source) => snapshots.find((item) => item.source.selected === source) ?? null,
  }
}

class UseWorkingTreeChanges {
  static keyOf(sessionId: string, source: FileChangesWorkingTreeSource | null): string {
    return JSON.stringify([sessionId, source])
  }
}
