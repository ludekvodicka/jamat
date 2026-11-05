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
  loadShownWhenRemote(): Promise<IpcResult<readonly string[]>>
  setShownWhenRemote(key: string, shown: boolean): Promise<IpcResult<boolean>>
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
  const [shownWhenRemote, setShownWhenRemote] = useState<ReadonlySet<string>>(() => new Set())
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
    void Promise.all([ports.loadGroupDefinitions(), ports.loadGroups(), ports.loadShownWhenRemote()]).then(([known, assigned, shown]) => {
      if (disposed) return
      if (!known.ok) throw new Error(known.error)
      if (!assigned.ok) throw new Error(assigned.error)
      if (!shown.ok) throw new Error(shown.error)
      /*
       * An assignment naming a section that no longer exists is dropped HERE as well as by whoever
       * removed the section. The two files are written separately, so a tree that trusted the map
       * would filter such a session out of every section, including the one it falls back to, and
       * the session would simply not be drawn.
       */
      setDefinitions(known.value)
      setGroups(new Map(SessionsGroupsState.pruned(assigned.value, known.value)
        .map(({ key, group }) => [key, group])))
      setShownWhenRemote(new Set(shown.value))
      setReady(true)
      setError(null)
    }).catch((thrown: unknown) => {
      if (!disposed) setError(`Groups could not be read: ${ErrorText.of(thrown)}`)
    })
    return () => { disposed = true }
  }, [ports, revision])

  const reload = useCallback(() => setRevision((value) => value + 1), [])

  useEffect(() => ports.subscribeGroups(reload), [ports, reload])

  const store = useCallback((write: () => Promise<IpcResult<boolean>>, apply: () => void): void => {
    if (!ready || busy.current) return
    busy.current = true
    setSaving(true)
    setError(null)
    void write().then((answer) => {
      if (!answer.ok) throw new Error(answer.error)
      if (!answer.value) throw new Error('The client state refused the write.')
      if (mounted.current) apply()
    }).catch((thrown: unknown) => {
      if (mounted.current) setError(`Groups could not be stored: ${ErrorText.of(thrown)}`)
    }).finally(() => {
      busy.current = false
      if (mounted.current) setSaving(false)
    })
  }, [ready])

  const assign = useCallback((key: string, group: SessionGroup): void => {
    const current = [...groups].map(([held, heldGroup]) => ({ key: held, group: heldGroup }))
    const next = new Map(SessionsGroupsState.assigned(current, key, group)
      .map((assignment) => [assignment.key, assignment.group]))
    store(() => ports.assignGroup(key, group), () => setGroups(next))
  }, [ports, groups, store])

  const showWhenRemote = useCallback((key: string, shown: boolean): void => {
    const next = new Set(SessionsGroupsState.withShownWhenRemote([...shownWhenRemote], key, shown))
    store(() => ports.setShownWhenRemote(key, shown), () => setShownWhenRemote(next))
  }, [ports, shownWhenRemote, store])

  return { definitions, groups, shownWhenRemote, ready, saving, error, assign, showWhenRemote, reload }
}
