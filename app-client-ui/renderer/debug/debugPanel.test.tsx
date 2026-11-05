import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { HostDebugFixtures } from './sections/host/fixtures/hostDebugFixtures'
import { DebugPanel, type DebugPanelVisibility } from './debugPanel'
import { DebugSections } from './debugSections'

class FakePanelApi {
  isVisible = true
  private listener: ((event: { isVisible: boolean }) => void) | null = null

  readonly onDidVisibilityChange = ((listener: (event: { isVisible: boolean }) => void) => {
    this.listener = listener
    return { dispose: () => { this.listener = null } }
  }) as unknown as DebugPanelVisibility['onDidVisibilityChange']

  show(visible: boolean): void {
    this.isVisible = visible
    this.listener?.({ isVisible: visible })
  }

  asApi(): DebugPanelVisibility {
    return this as unknown as DebugPanelVisibility
  }
}

describe('app-client-ui/renderer/debug/debugPanel', () => {
  afterEach(() => {
    // Unmounted first: closing the tab reports through the bridge.
    cleanup()
    HostDebugFixtures.removeBridge()
  })

  it('draws the catalog as a tree, parents and their children alike', () => {
    HostDebugFixtures.installBridge()
    const view = render(<DebugPanel api={new FakePanelApi().asApi()} />)

    const items = view.getAllByRole('treeitem')
    expect(items.map((item) => item.textContent))
      .toEqual(DebugSections.flatten().map((node) => node.title))
    expect(items[0]).toHaveAttribute('aria-selected', 'true')
    expect(items[0]).toHaveAttribute('aria-level', '1')
    expect(items[1]).toHaveAttribute('aria-level', '2')
    expect(view.getByRole('region', { name: 'Host' })).toBeInTheDocument()
  })

  // The gate that stops the main process pinging for a node nobody is looking at is half this
  // report, so it has to go out on mount and on every change of node.
  it('reports the node on screen, on mount and on every switch', async () => {
    const bridge = HostDebugFixtures.installBridge()
    const view = render(<DebugPanel api={new FakePanelApi().asApi()} />)

    await waitFor(() => expect(bridge.sections).toEqual(['host']))

    fireEvent.click(view.getByRole('treeitem', { name: 'Runtimes' }))
    await waitFor(() => expect(bridge.sections).toEqual(['host', 'host-runtimes']))
    expect(view.getByRole('region', { name: 'Runtimes' })).toBeInTheDocument()
  })

  // A tab behind another one is not looked at, so it must close the ping gate and reopen it.
  it('reports no node while the tab is hidden and none after it closes', async () => {
    const bridge = HostDebugFixtures.installBridge()
    const api = new FakePanelApi()
    const view = render(<DebugPanel api={api.asApi()} />)
    await waitFor(() => expect(bridge.sections).toEqual(['host']))

    act(() => api.show(false))
    await waitFor(() => expect(bridge.sections).toEqual(['host', null]))
    act(() => api.show(true))
    await waitFor(() => expect(bridge.sections).toEqual(['host', null, 'host']))

    view.unmount()
    expect(bridge.sections.at(-1)).toBeNull()
  })

  // Mount on activate: a node that is not selected draws nothing and reads nothing.
  it('holds no node but the selected one in the document', async () => {
    HostDebugFixtures.installBridge()
    const view = render(<DebugPanel api={new FakePanelApi().asApi()} />)

    await waitFor(() => expect(view.getByRole('button', { name: 'Ping' })).toBeInTheDocument())
    expect(view.queryByRole('table')).toBeNull()

    fireEvent.click(view.getByRole('treeitem', { name: 'Runtimes' }))
    await waitFor(() => expect(view.getByRole('table')).toBeInTheDocument())
    expect(view.queryByRole('button', { name: 'Ping' })).toBeNull()
  })
})
