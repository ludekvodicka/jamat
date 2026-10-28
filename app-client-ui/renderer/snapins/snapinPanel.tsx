import { useEffect, useMemo, useState, useSyncExternalStore, useCallback } from 'react'
import type { IDockviewPanelProps } from 'dockview'
import { AppControl } from '../ipc/appControl'
import { ErrorText } from '../../shared/errorText'
import { SnapinViewStore } from './snapinViewStore'
import { SectionViews } from './sectionViews'
import './snapins.css'

export function SnapinPanel({ api, params }: IDockviewPanelProps): React.JSX.Element {
  const kind = typeof params.kind === 'string' ? params.kind : ''
  const store = useMemo(() => new SnapinViewStore(kind), [kind])
  const [available, setAvailable] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [visible, setVisible] = useState(api.isVisible)
  const state = useSyncExternalStore(useCallback((changed) => store.subscribe(changed), [store]), useCallback(() => store.current(), [store]))
  useEffect(() => {
    setAvailable(null)
    setError(null)
    let disposed = false
    let stop: (() => void) | undefined
    void store.catalog.then((answer) => {
      if (disposed) return
      if (!answer.ok) { setError(answer.error); return }
      const known = answer.value.kinds.some((entry) => entry.kind === kind)
      setAvailable(known)
      if (known) stop = store.start()
    }).catch((reason: unknown) => { if (!disposed) setError(ErrorText.of(reason)) })
    return () => { disposed = true; stop?.() }
  }, [store, kind])
  useEffect(() => {
    const subscription = api.onDidVisibilityChange((event) => setVisible(event.isVisible))
    return () => subscription.dispose()
  }, [api])
  // Showing the panel is what lists the source: the manager never lists it in the background, and
  // every view change after that arrives as a push.
  useEffect(() => {
    if (!visible || !available) return
    void AppControl.call('snapins.press', { kind, actionId: 'shared.refresh' })
      .catch((reason: unknown) => setError(ErrorText.of(reason)))
  }, [visible, available, kind])
  async function press(actionId: string, itemKeys?: string[]): Promise<void> {
    setError(null)
    try {
      const answer = await AppControl.call('snapins.press', { kind, actionId, itemKeys })
      if (!answer.ok) setError(answer.error)
      else if (!answer.value.ok) setError(answer.value.error.detail)
    } catch (reason) { setError(ErrorText.of(reason)) }
  }
  return <section className="snapins" aria-label={state.snapshot?.title ?? 'Snap-in'}>
    {(error ?? state.error) && <p role="alert">{error ?? state.error}</p>}
    {available === false && <p>This snap-in is no longer available</p>}
    {available !== false && !state.snapshot && !error && <p>Loading snap-in…</p>}
    {available && state.snapshot && <><h1>{state.snapshot.title}</h1><p>{state.snapshot.state}</p>
      <SectionViews sections={state.snapshot.sections} onPress={(actionId, itemKeys) => { void press(actionId, itemKeys) }} /></>}
  </section>
}
