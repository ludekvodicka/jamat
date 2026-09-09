import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { SidebarProbeView } from './sidebarProbeView'

describe('app-client-ui/renderer/views/sidebarProbeView', () => {
  it('reads back the side, the key and the width it was given', () => {
    render(<SidebarProbeView side="right" viewKey="probeRight" width={340} />)
    expect(screen.getByText('probeRight')).toBeTruthy()
    expect(screen.getByText('right')).toBeTruthy()
    expect(screen.getByText('340')).toBeTruthy()
  })

  // The same promise the panel probe makes: a view is not rebuilt while it is on screen, so state
  // nothing outside it knows about survives a resize.
  it('keeps its own state across a width change', () => {
    const view = render(<SidebarProbeView side="left" viewKey="probeLeft" width={260} />)
    fireEvent.click(screen.getByText('Local state: 0'))
    view.rerender(<SidebarProbeView side="left" viewKey="probeLeft" width={300} />)
    expect(screen.getByText('Local state: 1')).toBeTruthy()
    expect(screen.getByText('300')).toBeTruthy()
  })
})
