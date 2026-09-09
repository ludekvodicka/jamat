import { describe, expect, it } from 'vitest'

import type { DebugSectionId } from '../../shared/debugSections.types'
import type { DebugSectionDescriptor } from './debugSection.types'
import { DebugSections } from './debugSections'
import { RateClaudeSection, RateCodexSection } from './sections/rate/rateDebugSection'

describe('app-client-ui/renderer/debugWindow/debugSections', () => {
  /** The catalog is data; what a descriptor draws is nothing this file needs to render. */
  function section(id: string, order: number): DebugSectionDescriptor {
    return {
      id: id as DebugSectionId,
      title: id,
      order,
      Component: () => {
        throw new Error(`The catalog test drew section ${id}`)
      },
    }
  }

  it('holds the two subsystems and the provider nodes under rate limits', () => {
    const sections = DebugSections.ordered()
    expect(sections.map((descriptor) => [descriptor.id, descriptor.order]))
      .toEqual([['host', 0], ['rate', 1]])
    expect(DebugSections.nodeOf('rate', sections).children?.map((descriptor) => [
      descriptor.id,
      descriptor.title,
      descriptor.order,
    ])).toEqual([
      ['rate-codex', 'Codex', 0],
      ['rate-claude', 'Claude', 1],
    ])
    expect(DebugSections.nodeOf('rate-codex', sections).Component).toBe(RateCodexSection)
    expect(DebugSections.nodeOf('rate-claude', sections).Component).toBe(RateClaudeSection)
  })

  it('returns the sections in the order they declare, not the order they were written', () => {
    const ordered = DebugSections.ordered([
      section('cache', 2),
      section('host', 0),
      section('projects', 1),
    ])

    expect(ordered.map((descriptor) => descriptor.id)).toEqual(['host', 'projects', 'cache'])
  })

  // Two sections sharing an id leave `activeSection` pointing at either of them.
  it('refuses a duplicate id', () => {
    expect(() => DebugSections.ordered([section('host', 0), section('host', 1)]))
      .toThrow(/same id/)
  })

  // Two sections sharing an order make the list depend on the sort's stability, not the catalog.
  it('refuses a duplicate order', () => {
    expect(() => DebugSections.ordered([section('host', 0), section('projects', 0)]))
      .toThrow(/same order/)
  })

  it('leaves the catalog it was given alone', () => {
    const given = [section('projects', 1), section('host', 0)]

    DebugSections.ordered(given)

    expect(given.map((descriptor) => descriptor.id)).toEqual(['projects', 'host'])
  })
})
