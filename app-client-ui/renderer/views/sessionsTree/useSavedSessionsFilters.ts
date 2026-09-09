import { useCallback, useEffect, useRef, useState } from 'react'
import type { IpcResult } from '../../../shared/appClientUiIpc'
import { ErrorText } from '../../../shared/errorText'
import type { SavedSessionsFilter } from '../../../shared/sessionsFilterState'

export interface SavedSessionsFiltersPorts {
  loadFilters(): Promise<IpcResult<readonly SavedSessionsFilter[]>>
  saveFilters(filters: readonly SavedSessionsFilter[]): Promise<IpcResult<boolean>>
}

export function useSavedSessionsFilters(ports: SavedSessionsFiltersPorts) {
  const [saved, setSaved] = useState<readonly SavedSessionsFilter[]>([])
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, reload] = useState(0)
  const busy = useRef(false)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let disposed = false
    setReady(false)
    void ports.loadFilters().then((answer) => {
      if (disposed) return
      if (!answer.ok) {
        setError(`Saved filters could not be read: ${answer.error}`)
        return
      }
      setSaved(answer.value)
      setReady(true)
      setError(null)
    }).catch((thrown: unknown) => {
      if (!disposed) setError(`Saved filters could not be read: ${ErrorText.of(thrown)}`)
    })
    return () => { disposed = true }
  }, [ports, revision])

  const save = useCallback(async (next: readonly SavedSessionsFilter[]): Promise<boolean> => {
    if (!ready || busy.current) return false
    busy.current = true
    setSaving(true)
    setError(null)
    try {
      const answer = await ports.saveFilters(next)
      if (!mounted.current) return false
      if (!answer.ok || !answer.value) {
        setError(answer.ok ? 'Saved filters could not be stored.' : `Saved filters could not be stored: ${answer.error}`)
        return false
      }
      setSaved(next)
      return true
    } catch (thrown) {
      if (mounted.current) setError(`Saved filters could not be stored: ${ErrorText.of(thrown)}`)
      return false
    } finally {
      busy.current = false
      if (mounted.current) setSaving(false)
    }
  }, [ports, ready])

  return { saved, ready, saving, error, save, reload: () => reload((value) => value + 1) }
}
