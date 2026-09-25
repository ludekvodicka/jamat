import { useCallback, useEffect, useRef, useState } from 'react'
import type { IpcResult } from '../../../shared/appClientUiIpc'
import { ErrorText } from '../../../shared/errorText'
import {
  SessionsGroupsState,
  type SessionGroup,
  type SessionGroupAssignment,
  type SessionGroupDefinition,
} from '../../../shared/sessionsGroupsState'

export interface SessionsGroupsPorts {
  /** Which sections this computer has, in the order they are drawn. A person edits them. */
  loadGroupDefinitions(): Promise<IpcResult<readonly SessionGroupDefinition[]>>
  loadGroups(): Promise<IpcResult<readonly SessionGroupAssignment[]>>
  assignGroup(key: string, group: SessionGroup): Promise<IpcResult<boolean>>
  /**
   * Somebody other than this tree wrote an assignment or changed the sections themselves - a fork
   * taking its parent's group, written in the main process, or a save in the settings window. The
   * whole picture is read back rather than patched from the event: a window that missed one still
   * ends up holding what is on disk.
   */
  subscribeGroups(onChanged: () => void): () => void
}

export function useSessionsGroups(ports: SessionsGroupsPorts) {
  const [definitions, setDefinitions] = useState<readonly SessionGroupDefinition[]>(
    () => SessionsGroupsState.defaultsConst,
  )
  const [groups, setGroups] = useState<ReadonlyMap<string, SessionGroup>>(() => new Map())
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const busy = useRef(false)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let disposed = false
    setReady(false)
    void Promise.all([ports.loadGroupDefinitions(), ports.loadGroups()]).then(([known, assigned]) => {
      if (disposed) return
      if (!known.ok) throw new Error(known.error)
      if (!assigned.ok) throw new Error(assigned.error)
      /*
       * An assignment naming a section that no longer exists is dropped HERE as well as by whoever
       * removed the section. The two files are written separately, so a tree that trusted the map
       * would filter such a session out of every section, including the one it falls back to, and
       * the session would simply not be drawn.
       */
      setDefinitions(known.value)
      setGroups(new Map(SessionsGroupsState.pruned(assigned.value, known.value)
        .map(({ key, group }) => [key, group])))
      setReady(true)
      setError(null)
    }).catch((thrown: unknown) => {
      if (!disposed) setError(`Groups could not be read: ${ErrorText.of(thrown)}`)
    })
    return () => { disposed = true }
  }, [ports, revision])

  const reload = useCallback(() => setRevision((value) => value + 1), [])

  useEffect(() => ports.subscribeGroups(reload), [ports, reload])

  const assign = useCallback((key: string, group: SessionGroup): void => {
    if (!ready || busy.current) return
    const next = new Map(groups)
    next.set(key, group)
    busy.current = true
    setSaving(true)
    setError(null)
    void ports.assignGroup(key, group).then((answer) => {
      if (!answer.ok) throw new Error(answer.error)
      if (!answer.value) throw new Error('The client state refused the write.')
      if (mounted.current) setGroups(next)
    }).catch((thrown: unknown) => {
      if (mounted.current) setError(`Groups could not be stored: ${ErrorText.of(thrown)}`)
    }).finally(() => {
      busy.current = false
      if (mounted.current) setSaving(false)
    })
  }, [ports, groups, ready])

  return { definitions, groups, ready, saving, error, assign, reload }
}
