import type { SidebarSide } from '../../../shared/sidebarsState'
import type { SidebarRegistry } from './sidebarRegistry'
import { SidebarDock } from './sidebarDock'
import type { SidebarsHandle } from './useSidebars'

/**
 * How a workspace draws ONE of its two sidebars. Beside the dock it renders rather than in the
 * shell that calls it: nothing else draws it, and the shell was the only place to look for it.
 */
export class AppShellSidebars {
  /**
   * Nothing is drawn for a side whose state names no view. A side that is merely CLOSED is still
   * rendered and hidden by layout: unmounting it would throw away the view's own state on every
   * toggle, and a global sidebar is the one surface this shell promises outlives everything.
   */
  static render(
    side: SidebarSide,
    registry: SidebarRegistry,
    handle: SidebarsHandle,
  ): React.JSX.Element | null {
    const sideState = handle.state[side]
    if (sideState.activeView === null)
      return null
    const descriptor = registry.assertView(sideState.activeView)
    const View = descriptor.component
    return (
      <SidebarDock
        side={side}
        title={descriptor.title}
        width={sideState.width}
        hidden={!sideState.visible}
        action={descriptor.headerAction}
        onResize={(width) => handle.resize(side, width)}
        onClose={() => handle.toggle(side)}
      >
        <View side={side} viewKey={descriptor.key} width={sideState.width} />
      </SidebarDock>
    )
  }
}
