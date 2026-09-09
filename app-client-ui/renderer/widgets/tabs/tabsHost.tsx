import {
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IWatermarkPanelProps,
} from 'dockview'
import { useEffect, useMemo } from 'react'
import 'dockview/dist/styles/dockview.css'

import type { CommandRegistry } from '../../commands/commandRegistry'
import type { PanelFocusRegistry } from '../../shell/panelFocusRegistry'
import { CustomTab } from './customTab'
import type { TabSessionFacts } from './tabContextMenu'
import type { PanelRegistry } from './panelRegistry'
import type { TabsController } from './tabsController'
import './tabs.css'

/**
 * The dockview surface. It owns nothing but the mount: what a panel key means lives in the
 * registry, and what opening or restoring does lives in the controller.
 */
export function TabsHost(props: {
  registry: PanelRegistry
  controller: TabsController
  commands: CommandRegistry
  /** What a tab's session is, read when its menu opens. `null` where the tab has no session. */
  sessionFacts(sessionId: string): TabSessionFacts | null
  /** Where a clicked tab hands the caret back to the panel below it. */
  panelFocus: PanelFocusRegistry
  onReady(): void
}): React.JSX.Element {
  // Built once: dockview treats a new component map as new components and would remount every
  // panel, which for a terminal means dropping and re-establishing its attachment.
  const components = useMemo(() => props.registry.components(), [props.registry])
  const controller = props.controller

  // The surface can go away without the window going with it - a dev-server reload, a remount - and
  // dockview empties itself on the way out. Letting go of the subscription here means the teardown
  // is not even heard; the controller refuses an empty layout as well, because the order of a
  // React unmount is not something this should depend on.
  useEffect(() => () => controller.dispose(), [controller])

  // The tab renderer is memoised for the same reason as the map above, not for the render cost.
  const tabComponent = useMemo(() => function Tab(
    tabProps: IDockviewPanelHeaderProps,
  ): React.JSX.Element {
    return (
      <CustomTab
        {...tabProps}
        controller={props.controller}
        commands={props.commands}
        sessionFacts={props.sessionFacts}
        panelFocus={props.panelFocus}
      />
    )
  }, [props.controller, props.commands, props.sessionFacts, props.panelFocus])

  const watermark = useMemo(() => function EmptyWatermark(
    _props: IWatermarkPanelProps,
  ): React.JSX.Element {
    return (
      <div className="jamat-watermark">
        <span className="jamat-watermark__text">No panels open</span>
        <button
          className="jamat-watermark__button"
          type="button"
          onClick={() => props.controller.openWelcome()}
        >
          Open Home
        </button>
      </div>
    )
  }, [props.controller])

  return (
    <DockviewReact
      className="dockview-theme-dark"
      components={components}
      defaultTabComponent={tabComponent}
      watermarkComponent={watermark}
      defaultRenderer="always"
      onReady={(event: DockviewReadyEvent) => {
        props.controller.attach(event.api)
        props.onReady()
      }}
    />
  )
}
