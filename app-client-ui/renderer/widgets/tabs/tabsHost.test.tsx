import { act, render, waitFor } from '@testing-library/react'
import type { DockviewApi, IDockviewPanelProps } from 'dockview'
import { describe, expect, it, vi } from 'vitest'

import { CommandRegistry } from '../../commands/commandRegistry'
import { PanelFocusRegistry } from '../../shell/panelFocusRegistry'
import { PanelRegistry } from './panelRegistry'
import { TabDecorationsStore } from './tabDecorations'
import { TabDecorationsProvider } from './tabDecorationsContext'
import { TabsController } from './tabsController'
import { TabsHost } from './tabsHost'

describe('app-client-ui/renderer/widgets/tabs/tabsHost', () => {
  function wiring() {
    const registry = new PanelRegistry()
    registry.register({
      key: 'welcome',
      title: 'Home',
      component: (() => null) as unknown as React.FunctionComponent<IDockviewPanelProps>,
    })
    const saved: string[] = []
    const controller = new TabsController({
      registry,
      saveLayout: (layout) => { saved.push(layout); return Promise.resolve(true) },
      clearLayout: () => Promise.resolve(true),
      claimPanel: () => Promise.resolve({ kind: 'granted' }),
      reconcilePanels: (panels) => Promise.resolve({
        acceptedPanelIds: panels.map((panel) => panel.panelId),
        rejectedPanelIds: [],
      }),
      releasePanel: () => Promise.resolve(),
      setActivePanel: () => Promise.resolve(),
      tabDragStarted: () => Promise.resolve(),
      transferPrepare: () => Promise.resolve(null),
      transferCommit: () => Promise.resolve(),
      transferAbort: () => Promise.resolve(),
      movePanel: () => Promise.resolve(),
      reportError: () => undefined,
    })
    return {
      registry,
      controller,
      commands: new CommandRegistry(),
      panelFocus: new PanelFocusRegistry(),
      saved,
    }
  }

  /**
   * The second half of rule 4. dockview empties itself when the surface goes away, and it does so
   * while the layout subscription is still live - which is how a dev-server reload replaced a
   * workspace of four panels with three empty groups. Letting go here means the teardown is not
   * even heard.
   */
  it('lets go of the controller when the surface unmounts', async () => {
    const { registry, controller, commands, panelFocus } = wiring()
    const onReady = vi.fn()
    const dispose = vi.spyOn(controller, 'dispose')

    const view = render(
      <TabsHost
        registry={registry}
        controller={controller}
        commands={commands}
        sessionFacts={() => null}
        panelFocus={panelFocus}
        onReady={onReady}
      />,
    )
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))

    view.unmount()

    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('hands the controller the api it was given, once', async () => {
    const { registry, controller, commands, panelFocus } = wiring()
    const attach = vi.spyOn(controller, 'attach')

    render(
      <TabsHost
        registry={registry}
        controller={controller}
        commands={commands}
        sessionFacts={() => null}
        panelFocus={panelFocus}
        onReady={() => undefined}
      />,
    )

    await waitFor(() => expect(attach).toHaveBeenCalledTimes(1))
  })

  it('moves the only active marker when dockview activates another tab', async () => {
    const { registry, controller, commands, panelFocus } = wiring()
    const attach = vi.spyOn(controller, 'attach')
    const { container } = render(
      <TabDecorationsProvider store={new TabDecorationsStore()}>
        <TabsHost
          registry={registry}
          controller={controller}
          commands={commands}
          sessionFacts={() => null}
        panelFocus={panelFocus}
          onReady={() => undefined}
        />
      </TabDecorationsProvider>,
    )
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(1))
    const api: DockviewApi = attach.mock.calls[0][0]
    const activeTitles = (): string[] => [
      ...container.querySelectorAll('.jamat-tab.is-active .jamat-tab__title'),
    ].map((title) => title.textContent ?? '')

    act(() => {
      api.addPanel({ id: 'panel-a', component: 'welcome', title: 'A' })
      api.addPanel({ id: 'panel-b', component: 'welcome', title: 'B' })
    })
    await waitFor(() => expect(activeTitles()).toEqual(['B']))

    act(() => api.getPanel('panel-a')?.api.setActive())
    await waitFor(() => expect(activeTitles()).toEqual(['A']))
  })
})
