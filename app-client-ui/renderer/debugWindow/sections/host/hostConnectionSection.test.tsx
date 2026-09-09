import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { HostDebugFixtures } from './fixtures/hostDebugFixtures'
import { HostConnectionSection } from './hostConnectionSection'

describe('app-client-ui/renderer/debugWindow/sections/host/hostConnectionSection', () => {
  afterEach(() => {
    HostDebugFixtures.removeBridge()
  })

  it('draws the four things this client talks to a Host through', async () => {
    HostDebugFixtures.installBridge()
    const view = render(<HostConnectionSection />)

    await waitFor(() => expect(view.getByText('Descriptor watch')).toBeInTheDocument())
    expect(view.getByText('Events socket')).toBeInTheDocument()
    expect(view.getByText('Controller lease')).toBeInTheDocument()
    expect(view.getByText('Reconcile')).toBeInTheDocument()
    expect(view.getByText('Poll')).toBeInTheDocument()

    expect(view.getByText('host-1:51234')).toBeInTheDocument()
    expect(view.getByText('lease-1')).toBeInTheDocument()
    expect(view.getByText('2000 ms')).toBeInTheDocument()
    expect(view.getByText('poll')).toBeInTheDocument()
  })

  // The identity says which Host process on which port; the token is not on the wire to draw.
  it('never draws a token, because none travels', async () => {
    HostDebugFixtures.installBridge()
    const view = render(<HostConnectionSection />)

    await waitFor(() => expect(view.getByText('host-1:51234')).toBeInTheDocument())
    expect(view.container.textContent).not.toContain('token')
  })
})
