import { fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { HostDebugFixtures } from './fixtures/hostDebugFixtures'
import { HostDebugSection } from './hostDebugSection'

describe('app-client-ui/renderer/debugWindow/sections/host/hostDebugSection', () => {
  afterEach(() => {
    HostDebugFixtures.removeBridge()
  })

  it('says what the Host is and how fresh both verdicts are', async () => {
    HostDebugFixtures.installBridge()
    const view = render(<HostDebugSection />)

    await waitFor(() => expect(view.getByText('Host v2026.08.10.1 · 2 live')).toBeInTheDocument())
    expect(view.getByText('version: current')).toBeInTheDocument()
    expect(view.getByText('protocol: match')).toBeInTheDocument()
    // The counts belong here; the table they are counting hangs under its own node.
    expect(view.getByText('Live runtimes')).toBeInTheDocument()
    expect(view.queryByRole('table')).toBeNull()
  })

  // This is the node that draws a ping, so it is the node that asks for one.
  it('asks for one ping when it opens and another when the button is pressed', async () => {
    const bridge = HostDebugFixtures.installBridge()
    const view = render(<HostDebugSection />)

    await waitFor(() => expect(bridge.pings).toBe(1))
    fireEvent.click(view.getByRole('button', { name: 'Ping' }))
    await waitFor(() => expect(bridge.pings).toBe(2))
  })

  // The loop's answers and the button's answers are the same input, so they draw the same way.
  it('draws a ping the main process took on its own', async () => {
    const bridge = HostDebugFixtures.installBridge()
    const view = render(<HostDebugSection />)
    await waitFor(() => expect(bridge.pings).toBe(1))

    bridge.pushPing({
      at: HostDebugFixtures.nowConst,
      ok: true,
      latencyMilliseconds: 12,
      hello: {
        protocol: { major: 1, minor: 0 },
        buildVersion: '2026.08.10.1',
        sourceRevision: 'source-tree',
        platform: 'win32',
        arch: 'x64',
        hostGeneration: 'generation-1',
        pid: 4_242,
        runtimesLive: 2,
        runtimesDead: 1,
        eventRevision: 12,
      },
    })

    await waitFor(() => expect(view.getByText('12 ms')).toBeInTheDocument())
  })

  // R8's third action, and the only one that changes anything. There is no Stop, here or anywhere.
  it('offers Start Host only for a Host nobody can reach', async () => {
    const running = HostDebugFixtures.installBridge()
    const view = render(<HostDebugSection />)
    await waitFor(() => expect(view.getByRole('button', { name: 'Refresh' })).toBeInTheDocument())
    expect(view.queryByRole('button', { name: 'Start Host' })).toBeNull()
    expect(view.queryByRole('button', { name: /stop/i })).toBeNull()
    expect(running.startHosts).toBe(0)

    view.unmount()
    HostDebugFixtures.removeBridge()
    const unreachable = HostDebugFixtures.installBridge(HostDebugFixtures.status({
      presence: 'unreachable',
      descriptor: null,
    }))
    const second = render(<HostDebugSection />)

    await waitFor(() =>
      expect(second.getByRole('button', { name: 'Start Host' })).toBeInTheDocument())
    fireEvent.click(second.getByRole('button', { name: 'Start Host' }))
    await waitFor(() => expect(unreachable.startHosts).toBe(1))
  })
})
