import { fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { HostDebugFixtures } from './sections/host/fixtures/hostDebugFixtures'
import { DebugWindow } from './debugWindow'
import { DebugSections } from './debugSections'

describe('app-client-ui/renderer/debugWindow/debugWindow', () => {
  afterEach(() => {
    HostDebugFixtures.removeBridge()
  })

  it('draws the catalog as a tree, parents and their children alike', () => {
    HostDebugFixtures.installBridge()
    const view = render(<DebugWindow />)

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
    const view = render(<DebugWindow />)

    await waitFor(() => expect(bridge.sections).toEqual(['host']))

    fireEvent.click(view.getByRole('treeitem', { name: 'Runtimes' }))
    await waitFor(() => expect(bridge.sections).toEqual(['host', 'host-runtimes']))
    expect(view.getByRole('region', { name: 'Runtimes' })).toBeInTheDocument()
  })

  // Mount on activate: a node that is not selected draws nothing and reads nothing.
  it('holds no node but the selected one in the document', async () => {
    HostDebugFixtures.installBridge()
    const view = render(<DebugWindow />)

    await waitFor(() => expect(view.getByRole('button', { name: 'Ping' })).toBeInTheDocument())
    expect(view.queryByRole('table')).toBeNull()

    fireEvent.click(view.getByRole('treeitem', { name: 'Runtimes' }))
    await waitFor(() => expect(view.getByRole('table')).toBeInTheDocument())
    expect(view.queryByRole('button', { name: 'Ping' })).toBeNull()
  })
})
