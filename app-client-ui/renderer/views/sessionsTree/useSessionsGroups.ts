import { useCallback, useEffect, useRef, useState } from 'react'
import type { IpcResult } from '../../../shared/appClientUiIpc'
import { ErrorText } from '../../../shared/errorText'
import type { SessionGroup, SessionGroupAssignment } from '../../../shared/sessionsGroupsState'

export interface SessionsGroupsPorts {
  loadGroups(): Promise<IpcResult<readonly SessionGroupAssignment[]>>
  assignGroup(key: string, group: SessionGroup): Promise<IpcResult<boolean>>
  /**
   * Somebody other than this tree wrote an assignment - today a fork taking its parent's group,
   * written in the main process. The whole map is read back rather than patched from the event: a
   * window that missed one still ends up holding what is on disk.
   */
  subscribeGroups(onChanged: () => void): () => void
}

export function useSessionsGroups(ports: SessionsGroupsPorts) {
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
    void ports.loadGroups().then((answer) => {
      if (disposed) return
      if (!answer.ok) throw new Error(answer.error)
      setGroups(new Map(answer.value.map(({ key, group }) => [key, group])))
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

  return { groups, ready, saving, error, assign, reload }
}
