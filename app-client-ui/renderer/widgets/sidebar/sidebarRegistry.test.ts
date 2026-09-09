import { describe, expect, it } from 'vitest'

import type { SidebarSide } from '../../../shared/sidebarsState'
import { SidebarRegistry, type SidebarViewDescriptor } from './sidebarRegistry'

describe('app-client-ui/renderer/widgets/sidebar/sidebarRegistry', () => {
  function descriptor(key: string, side: SidebarSide): SidebarViewDescriptor {
    return { key, side, title: key, component: () => null }
  }

  it('resolves a registered view', () => {
    const registry = new SidebarRegistry()
    registry.register(descriptor('probeLeft', 'left'))
    expect(registry.assertView('probeLeft').side).toBe('left')
  })

  // The second registration would otherwise shadow the first, and the stored key would resolve to
  // whichever module happened to load last.
  it('refuses a key that is already registered', () => {
    const registry = new SidebarRegistry()
    registry.register(descriptor('probeLeft', 'left'))
    expect(() => registry.register(descriptor('probeLeft', 'right')))
      .toThrow(/already registered/)
  })

  it('refuses to resolve a key nobody registered', () => {
    expect(() => new SidebarRegistry().assertView('probeLeft')).toThrow(/Unknown sidebar view/)
  })

  it('lists a side without the other side', () => {
    const registry = new SidebarRegistry()
    registry.register(descriptor('probeLeft', 'left'))
    registry.register(descriptor('probeRight', 'right'))
    registry.register(descriptor('secondLeft', 'left'))
    expect(registry.keysOf('left')).toEqual(['probeLeft', 'secondLeft'])
    expect(registry.keysOf('right')).toEqual(['probeRight'])
  })
})
