import { describe, expect, it } from 'vitest'

import type { DebugSectionId } from '../../shared/debugSections.types'
import type { DebugSectionDescriptor } from './debugSection.types'
import { DebugWindowModel } from './debugWindowModel'

describe('app-client-ui/renderer/debugWindow/debugWindowModel', () => {
  function section(id: string, order: number): DebugSectionDescriptor {
    return {
      id: id as DebugSectionId,
      title: id,
      order,
      Component: () => {
        throw new Error(`The model test drew section ${id}`)
      },
    }
  }

  it('starts on the first section of the catalog', () => {
    expect(DebugWindowModel.initial([section('host', 0), section('cache', 1)]))
      .toEqual({ activeSection: 'host' })
    expect(DebugWindowModel.initial()).toEqual({ activeSection: 'host' })
  })

  // A window with no section is a defect in the catalog, not a window with nothing in it.
  it('refuses an empty catalog', () => {
    expect(() => DebugWindowModel.initial([])).toThrow(/holds no section/)
  })

  it('selects another section', () => {
    const start = DebugWindowModel.initial([section('host', 0), section('cache', 1)])
    expect(DebugWindowModel.transition(start, { input: 'select', section: 'cache' as DebugSectionId }))
      .toEqual({ activeSection: 'cache' })
  })

  // Same object, not an equal one: the frame reports the active section whenever it changes, and a
  // new object for a click that changed nothing would report it again.
  it('answers a click on the section already open with the state it was given', () => {
    const start = DebugWindowModel.initial([section('host', 0)])
    expect(DebugWindowModel.transition(start, { input: 'select', section: 'host' })).toBe(start)
  })

  it('throws on an input it does not know', () => {
    const start = DebugWindowModel.initial([section('host', 0)])
    expect(() => DebugWindowModel.transition(
      start,
      { input: 'resize' } as unknown as { input: 'select'; section: DebugSectionId },
    )).toThrow(/Unknown debug input/)
  })
})
