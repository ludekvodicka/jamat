import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { HostDebugFixtures } from './fixtures/hostDebugFixtures'
import { HostLaunchSection } from './hostLaunchSection'

describe('app-client-ui/renderer/debugWindow/sections/host/hostLaunchSection', () => {
  afterEach(() => {
    HostDebugFixtures.removeBridge()
  })

  it('draws the descriptor a running Host published and the command that would start one', async () => {
    HostDebugFixtures.installBridge()
    const view = render(<HostLaunchSection />)

    await waitFor(() => expect(view.getByText('4242')).toBeInTheDocument())
    expect(view.getByText('51234')).toBeInTheDocument()
    expect(view.getByText('2026.08.10.1 (tree: 2026.08.10.1)')).toBeInTheDocument()
    expect(view.getByText('C:/tools/electron.exe')).toBeInTheDocument()
    expect(view.getByText('--import tsx Q:/tree/app-host/start.ts')).toBeInTheDocument()
  })

  // The launch environment carries the whole of process.env and is dropped before it is composed.
  it('draws no environment, because none travels', async () => {
    HostDebugFixtures.installBridge()
    const view = render(<HostLaunchSection />)

    await waitFor(() => expect(view.getByText('Launch')).toBeInTheDocument())
    expect(view.getByText('Working directory')).toBeInTheDocument()
    expect(view.queryByText('Environment')).toBeNull()
  })

  it('says why a tree that cannot start a Host cannot', async () => {
    HostDebugFixtures.installBridge(HostDebugFixtures.status({
      launch: {
        ok: false,
        command: null,
        args: [],
        cwd: null,
        refusal: 'no Host entry point at Q:/packaged/app-host/start.ts',
      },
    }))
    const view = render(<HostLaunchSection />)

    await waitFor(() => expect(view.getByText(/no Host entry point/)).toBeInTheDocument())
  })
})
