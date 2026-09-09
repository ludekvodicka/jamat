import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { WelcomePanel } from './welcomePanel'

describe('app-client-ui/renderer/panels/welcomePanel', () => {
  it('names the app and says how a workspace is split', () => {
    render(<WelcomePanel />)

    expect(screen.getByRole('heading').textContent).toBe('Jamat')
    expect(screen.getByLabelText('Welcome').textContent).toMatch(/Drag a tab/)
  })

  // The version is a status bar reading. In a panel parameter it would enter the derived panel id
  // and open a second welcome panel on the first version bump.
  it('shows no version, so no panel id of this panel depends on one', () => {
    const { container } = render(<WelcomePanel />)

    expect(container.querySelector('.jamat-welcome__version')).toBeNull()
    expect(screen.getByLabelText('Welcome').textContent).not.toMatch(/\bv\d/)
  })
})
