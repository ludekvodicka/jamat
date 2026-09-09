import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ConfigurationSection } from './configurationSection'

describe('app-client-ui/renderer/overlays/configuration/configurationSection', () => {
  afterEach(() => cleanup())

  it('draws its title above what it was given', () => {
    const view = render(
      <ConfigurationSection title="Listener"><p>body</p></ConfigurationSection>,
    )
    const section = view.container.querySelector('.jamat-configuration__section')

    expect(section?.querySelector('.jamat-configuration__section-title')?.textContent)
      .toBe('Listener')
    expect(section?.textContent).toContain('body')
  })

  /*
   * The tab's own class sits on the SAME element, because a tab styles its controls through
   * descendant selectors off it. Dropping the shared class to make room for it would take the
   * separator with it, and the screen would look exactly as it did before there were sections.
   */
  it('carries a tab class beside the shared one rather than instead of it', () => {
    const view = render(
      <ConfigurationSection title="AI versioning" className="jamat-configuration-versioning">
        <p>body</p>
      </ConfigurationSection>,
    )
    const section = view.container.querySelector('section')

    expect(section?.className)
      .toBe('jamat-configuration__section jamat-configuration-versioning')
  })
})
