import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react'

import type { TabDecorations, TabDecorationsStore } from './tabDecorations'

const tabDecorationsContext = createContext<TabDecorationsStore | null>(null)

/**
 * Wraps the whole tab surface, so a tab and the content inside it reach the same store without the
 * shell threading it through dockview. Content publishes; the tab reads. Neither knows the other.
 */
export function TabDecorationsProvider(props: {
  store: TabDecorationsStore
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <tabDecorationsContext.Provider value={props.store}>
      {props.children}
    </tabDecorationsContext.Provider>
  )
}

/** What a tab draws. Subscribed per panel id, so a tick on one tab re-renders that one tab. */
export function useTabDecorations(panelId: string): TabDecorations {
  const store = useTabDecorationsStore()
  return useSyncExternalStore(
    useCallback((listener) => store.subscribe(panelId, listener), [store, panelId]),
    useCallback(() => store.get(panelId), [store, panelId]),
  )
}

/**
 * What content fills its own tab with. The decorations go with the panel: an unmounted panel is a
 * closed tab, and a closed tab leaves no reading behind for the next panel to inherit.
 */
export function useTabDecorationsPublisher(
  panelId: string,
): (decorations: TabDecorations) => void {
  const store = useTabDecorationsStore()
  useEffect(() => () => store.clear(panelId), [store, panelId])
  return useCallback(
    (decorations: TabDecorations) => store.set(panelId, decorations),
    [store, panelId],
  )
}

/** Missing provider is a wiring mistake, and a silent one costs a tab that never updates. */
function useTabDecorationsStore(): TabDecorationsStore {
  const store = useContext(tabDecorationsContext)
  if (!store)
    throw new Error('Tab decorations are read outside TabDecorationsProvider')
  return store
}
