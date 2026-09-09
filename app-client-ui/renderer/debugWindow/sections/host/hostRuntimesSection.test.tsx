import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { HostDebugFixtures } from './fixtures/hostDebugFixtures'
import { HostRuntimesSection } from './hostRuntimesSection'

describe('app-client-ui/renderer/debugWindow/sections/host/hostRuntimesSection', () => {
  afterEach(() => {
    HostDebugFixtures.removeBridge()
  })

  // The whole point of the table: what this client believes against what the Host is holding.
  it('draws every runtime the Host holds, the dead one and the orphan included', async () => {
    HostDebugFixtures.installBridge()
    const view = render(<HostRuntimesSection />)

    await waitFor(() => expect(view.getByText('live-1')).toBeInTheDocument())
    expect(view.getByText('A recorded session')).toBeInTheDocument()
    expect(view.getByText('dead-1')).toBeInTheDocument()
    expect(view.getByText('exited (3) process-exit')).toBeInTheDocument()
    expect(view.getByText('stray-1')).toBeInTheDocument()
    expect(view.getByText('orphan')).toBeInTheDocument()
    expect(view.getByText('2 live · 1 dead · 1 orphaned')).toBeInTheDocument()
  })

  // Why a row reads the way it does. The classifier computes its evidence and used to drop it, and
  // a verdict nobody can see the reason for is one nobody notices going wrong.
  it('draws the work verdict with the signals it rests on', async () => {
    HostDebugFixtures.installBridge(HostDebugFixtures.status({
      runtimes: [
        HostDebugFixtures.row({
          runtimeSessionId: 'live-1',
          work: { hint: 'waiting', signals: ['screen:menuFooter', 'wide-screen:selectedRow'] },
        }),
        HostDebugFixtures.row({ runtimeSessionId: 'shell-1' }),
      ],
      counts: { live: 2, dead: 0, orphans: 0 },
    }))
    const view = render(<HostRuntimesSection />)

    await waitFor(() => expect(view.getByText('live-1')).toBeInTheDocument())
    expect(view.getByText('waiting · screen:menuFooter wide-screen:selectedRow'))
      .toBeInTheDocument()
    // A shell is never classified, and the row says so rather than guessing a state for it. Read out
    // of THAT row's Work cell: the fixture draws em-dashes in other columns whatever the verdict is,
    // so counting them across the table passed with the classifier answering `unclassified`.
    const shellRow = view.getByText('shell-1').closest('tr') as HTMLTableRowElement | null
    if (shellRow === null)
      throw new Error('The table drew no row for shell-1')
    expect([...shellRow.cells].at(-1)?.textContent).toBe('—')
  })

  // A node under the Host still has to say whether that Host is up; it must not be a table alone.
  it('carries the same headline as the node above it', async () => {
    HostDebugFixtures.installBridge()
    const view = render(<HostRuntimesSection />)

    await waitFor(() => expect(view.getByText('Host v2026.08.10.1 · 2 live')).toBeInTheDocument())
    expect(view.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    // The ping is drawn by the node above, so this one does not ask for one.
    expect(view.queryByRole('button', { name: 'Ping' })).toBeNull()
  })

  it('says a Host with no runtime is holding none', async () => {
    HostDebugFixtures.installBridge(HostDebugFixtures.status({
      runtimes: [],
      counts: { live: 0, dead: 0, orphans: 0 },
    }))
    const view = render(<HostRuntimesSection />)

    await waitFor(() =>
      expect(view.getByText('The Host is holding no runtime.')).toBeInTheDocument())
  })
})
