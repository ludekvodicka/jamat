import { describe, expect, it, vi } from 'vitest'

import { PanelFocusRegistry } from './panelFocusRegistry'

describe('app-client-ui/renderer/shell/panelFocusRegistry', () => {
  it('gives the caret to the panel that was named, and to no other', () => {
    const registry = new PanelFocusRegistry()
    const first = vi.fn()
    const second = vi.fn()
    registry.register('terminal:1', first)
    registry.register('terminal:2', second)

    expect(registry.focus('terminal:2')).toBe(true)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
  })

  /** A tab with no surface to type into is the ordinary case, not a failure: the caller does nothing. */
  it('answers false for a panel that registered nothing, and for no panel at all', () => {
    const registry = new PanelFocusRegistry()

    expect(registry.focus('fileViewer:1')).toBe(false)
    expect(registry.focus(null)).toBe(false)
  })

  it('retires the registration it was given, never the one that replaced it', () => {
    const registry = new PanelFocusRegistry()
    const first = vi.fn()
    const second = vi.fn()
    const release = registry.register('terminal:1', first)
    registry.register('terminal:1', second)

    release()

    expect(registry.focus('terminal:1')).toBe(true)
    expect(second).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()
  })
})
