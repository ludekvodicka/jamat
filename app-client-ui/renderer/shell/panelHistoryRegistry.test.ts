import { describe, expect, it, vi } from 'vitest'

import { PanelHistoryRegistry } from './panelHistoryRegistry'

describe('app-client-ui/renderer/shell/panelHistoryRegistry', () => {
  it('sends a step to the panel in front only, and to nothing once it unregisters', () => {
    const registry = new PanelHistoryRegistry()
    const first = vi.fn()
    const second = vi.fn()
    const release = registry.register('panel-1', first)
    registry.register('panel-2', second)

    registry.step('panel-1', 'back')
    registry.step('panel-1', 'forward')
    registry.step(null, 'back')
    registry.step('panel-3', 'back')
    expect(first.mock.calls).toEqual([['back'], ['forward']])
    expect(second).not.toHaveBeenCalled()
    expect(() => registry.register('panel-2', vi.fn())).toThrow(/already registered/)

    release()
    registry.step('panel-1', 'back')
    expect(first).toHaveBeenCalledTimes(2)
  })
})
