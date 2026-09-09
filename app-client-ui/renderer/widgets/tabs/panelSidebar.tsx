import type { IDockviewPanelProps } from 'dockview'
import { useCallback, useEffect, useRef, useState } from 'react'

import { type SidebarSide, SidebarsState } from '../../../shared/sidebarsState'
import { usePanelParameters } from './panelParameters'
import './panelSidebar.css'

export interface PanelSidebarState {
  visible: boolean
  width: number
  activeView: string | null
}

export interface PanelSidebarHandle {
  state: PanelSidebarState
  toggle(): void
  show(): void
  open(viewKey: string): void
  resize(width: number): void
}

/**
 * What a tab's own sidebar remembers, and where. The state lives in the panel's parameters, which
 * dockview serializes into the layout. TabsController also carries those parameters across a user
 * close and reopen for this window's lifetime. After a split each panel carries its own; a closed
 * panel's copy never reaches the window's state file.
 */
export class PanelSidebarParams {
  private static readonly paramsKeyConst = 'sidebar'
  /** Inside SidebarsState's bounds on purpose: the widths are clamped by the same rule below. */
  private static readonly defaultWidthConst = 440

  /** A tab opens without one. The sidebar is something the user asks for, per tab. */
  static default(defaultView: string | null = null): PanelSidebarState {
    return {
      visible: false,
      width: SidebarsState.clamp(PanelSidebarParams.defaultWidthConst),
      activeView: defaultView,
    }
  }

  static of(params: unknown, defaultView: string | null = null): PanelSidebarState {
    if (!params || typeof params !== 'object')
      return PanelSidebarParams.default(defaultView)
    const stored = (params as Record<string, unknown>)[PanelSidebarParams.paramsKeyConst]
    if (!stored || typeof stored !== 'object')
      return PanelSidebarParams.default(defaultView)
    const state = stored as Partial<PanelSidebarState>
    return {
      visible: typeof state.visible === 'boolean' ? state.visible : false,
      width: typeof state.width === 'number'
        ? SidebarsState.clamp(state.width)
        : SidebarsState.clamp(PanelSidebarParams.defaultWidthConst),
      activeView: typeof state.activeView === 'string' && state.activeView
        ? state.activeView
        : defaultView,
    }
  }

  static merged(params: unknown, state: PanelSidebarState): Record<string, unknown> {
    const current = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    return { ...current, [PanelSidebarParams.paramsKeyConst]: state }
  }
}

export function usePanelSidebar(
  props: IDockviewPanelProps,
  defaultView: string | null = null,
): PanelSidebarHandle {
  const [state, setState] = useState<PanelSidebarState>(
    () => PanelSidebarParams.of(props.params, defaultView),
  )
  const { current: currentParameters, update: updateParameters } = usePanelParameters(props)
  const params = props.params
  /** What this hook last wrote, so a parameter change from anywhere else is recognisable. */
  const written = useRef<string | null>(null)

  // The parameters are the store, and dockview's fromJSON REUSES a live panel with the same id
  // (update in place, no remount). Without this the restored state would be re-rendered into the
  // panel while the hook kept the stale one, and the next write would put the stale one back.
  const incoming = JSON.stringify(PanelSidebarParams.of(params, defaultView))
  useEffect(() => {
    if (incoming === written.current)
      return
    written.current = incoming
    setState(JSON.parse(incoming) as PanelSidebarState)
  }, [incoming])

  const store = useCallback((currentParams: unknown, next: PanelSidebarState) => {
    written.current = JSON.stringify(next)
    setState(next)
    // `api.updateParameters` and not `panel.update`: only this path reaches the group model, which
    // is what makes dockview fire onDidLayoutChange - and that event is the whole reason the
    // debounced layout save ever hears about a width the user just dragged.
    updateParameters(PanelSidebarParams.merged(currentParams, next))
  }, [updateParameters])

  return {
    state,
    toggle: useCallback(
      () => {
        const currentParams = currentParameters()
        const current = PanelSidebarParams.of(currentParams, defaultView)
        store(currentParams, { ...current, visible: !current.visible })
      },
      [currentParameters, defaultView, store],
    ),
    show: useCallback(
      () => {
        const currentParams = currentParameters()
        const current = PanelSidebarParams.of(currentParams, defaultView)
        if (!current.visible) store(currentParams, { ...current, visible: true })
      },
      [currentParameters, defaultView, store],
    ),
    open: useCallback(
      (viewKey: string) => {
        const currentParams = currentParameters()
        const current = PanelSidebarParams.of(currentParams, defaultView)
        store(currentParams, { ...current, visible: true, activeView: viewKey })
      },
      [currentParameters, defaultView, store],
    ),
    resize: useCallback(
      (width: number) => {
        const currentParams = currentParameters()
        const current = PanelSidebarParams.of(currentParams, defaultView)
        store(currentParams, { ...current, width: SidebarsState.clamp(width) })
      },
      [currentParameters, defaultView, store],
    ),
  }
}

/**
 * The row a panel becomes when it carries a sidebar, so no panel writes this layout twice. The side
 * decides the order of the two children rather than a CSS `order`, so the DOM reads the way the
 * panel looks and a screen reader walks it in the same order.
 */
export function PanelSidebarLayout(props: {
  side: SidebarSide
  sidebar: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const content = <div className="jamat-panel-sidebar__content">{props.children}</div>
  if (props.side === 'left')
    return <div className="jamat-panel-sidebar">{props.sidebar}{content}</div>
  else if (props.side === 'right')
    return <div className="jamat-panel-sidebar">{content}{props.sidebar}</div>
  else
    throw new Error(`Unknown sidebar side: ${JSON.stringify(props.side)}`)
}
