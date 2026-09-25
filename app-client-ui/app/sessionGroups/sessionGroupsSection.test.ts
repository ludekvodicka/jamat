import { describe, expect, it } from 'vitest'

import { SessionsGroupsState } from '../../shared/sessionsGroupsState'
import { SessionGroupsSection } from './sessionGroupsSection'

describe('app-client-ui/app/sessionGroups/sessionGroupsSection', () => {
  it('owns the sessionGroups key and nothing about the file it sits in', () => {
    expect(SessionGroupsSection.spec.key).toBe('sessionGroups')
  })

  it('reads an absent key as the seeded sections, saying nothing', () => {
    expect(SessionGroupsSection.spec.coerce(undefined, () => { throw new Error('Unexpected report') }))
      .toEqual(SessionsGroupsState.defaultsConst)
  })

  /*
   * Total by contract: a hand edit that broke the list reads as the defaults rather than latching
   * the whole file, and the section declares no `damaged`, so the settings tab can write over it.
   * A tree has to draw something whatever state the config is in.
   */
  it('reads a broken list as the defaults, reports why, and still allows a save over it', () => {
    const reports: string[] = []

    expect(SessionGroupsSection.spec.coerce([{ id: 'only', title: 'Only' }], (message) => reports.push(message)))
      .toEqual(SessionsGroupsState.defaultsConst)
    expect(reports).toHaveLength(1)
    expect(SessionGroupsSection.spec.damaged).toBeUndefined()
  })

  it('refuses a write the tree could not draw and takes the one it could', () => {
    expect(SessionGroupsSection.spec.validate(SessionsGroupsState.defaultsConst)).toBeNull()
    expect(SessionGroupsSection.spec.validate([{ id: 'none', title: 'Sessions' }]))
      .toBe('session groups must keep "pinned"')
  })
})
