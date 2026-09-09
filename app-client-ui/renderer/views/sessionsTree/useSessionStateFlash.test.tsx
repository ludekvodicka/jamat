import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { SessionGlyph } from './sessionNodeState'
import { useSessionStateFlash } from './useSessionStateFlash'

describe('app-client-ui/renderer/views/sessionsTree/useSessionStateFlash', () => {
  afterEach(cleanup)

  function Subject(props: { glyph: SessionGlyph }): React.JSX.Element {
    return <span>{useSessionStateFlash(props.glyph)}</span>
  }

  /** A tree that blinks on everything the moment it opens is a tree nobody reads a blink off. */
  it('flashes nothing on a row it has never drawn', () => {
    const view = render(<Subject glyph="working" />)

    expect(view.container.textContent).toBe('0')
  })

  it('counts every state change, so a second one restarts the tint the first is still running', () => {
    const view = render(<Subject glyph="working" />)

    view.rerender(<Subject glyph="waiting" />)
    expect(view.container.textContent).toBe('1')

    view.rerender(<Subject glyph="working" />)
    expect(view.container.textContent).toBe('2')
  })

  /**
   * The tree redraws on every snapshot tick, and the glyph is unchanged in almost all of them. A
   * count that moved there would blink at somebody twice a second for ever.
   */
  it('stands still while the state does', () => {
    const view = render(<Subject glyph="idle" />)

    view.rerender(<Subject glyph="idle" />)
    view.rerender(<Subject glyph="idle" />)

    expect(view.container.textContent).toBe('0')
  })
})
