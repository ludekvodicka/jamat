import { describe, expect, it } from 'vitest'
import { SessionGroups } from '../../lib-orchestrator/sessionManager/sessionGroups'
import { SessionsGroupsState, type SessionGroupDefinition } from './sessionsGroupsState'

describe('app-client-ui/shared/sessionsGroupsState', () => {
  it('copies assignments and retains explicit None', () => {
    const groups = [{ key: 'session:one', group: 'none' }]
    const copy = SessionsGroupsState.coerce(groups, () => { throw new Error('Unexpected report') })
    expect(copy).toEqual(groups)
    expect(copy[0]).not.toBe(groups[0])
    expect(SessionsGroupsState.coerce(undefined, () => {})).toEqual([])
  })

  /*
   * What a computer that has never been told otherwise draws. Both structural ids are in it and in
   * the ORDER, because where Sessions and Pinned sit is what decides which sections a person reads
   * above their own work and which below.
   */
  it('seeds the sections in the order they are stacked, Completed above Blocked', () => {
    const seeded = SessionsGroupsState.defaultsConst.map((definition) => definition.id)

    expect(seeded).toEqual([
      'pinned', 'priority', 'none', 'automation', 'waiting', 'completed', 'blocked',
    ])
    expect(SessionsGroupsState.problemOf(SessionsGroupsState.defaultsConst)).toBeNull()
    for (const id of SessionGroups.structuralConst) expect(seeded).toContain(id)
  })

  it('names the default section None in a menu and Sessions in a heading', () => {
    const none = SessionsGroupsState.defaultsConst.find((definition) => definition.id === 'none')!

    expect(none.title).toBe('Sessions')
    expect(SessionsGroupsState.labelOf(none)).toBe('None')
    expect(SessionsGroupsState.labelOf({ id: 'completed', title: 'Completed' })).toBe('Completed')
  })

  it.each([
    [null, 'session groups must be an array'],
    [[{ id: 'none', title: 'Sessions' }], 'session groups must keep "pinned"'],
    [[{ id: 'pinned', title: 'Pinned' }], 'session groups must keep "none"'],
    [
      [{ id: 'none', title: 'Sessions' }, { id: 'pinned', title: 'Pinned' }, { id: 'none', title: 'Again' }],
      'session group "none" is listed twice',
    ],
  ])('refuses a list the tree could not draw: %j', (value, problem) => {
    expect(SessionsGroupsState.problemOf(value)).toBe(problem)
    expect(SessionsGroupsState.isList(value)).toBe(false)
  })

  it.each([
    { id: 'Waiting', title: 'Waiting' },
    { id: 'waiting room', title: 'Waiting' },
    { id: '-waiting', title: 'Waiting' },
    { id: 'waiting', title: '   ' },
    { id: 'waiting', title: 'x'.repeat(SessionGroups.titleMaxLengthConst + 1) },
  ])('refuses the definition %j', (definition) => {
    expect(SessionsGroupsState.isDefinition(definition)).toBe(false)
    expect(SessionsGroupsState.problemOf([
      { id: 'none', title: 'Sessions' }, { id: 'pinned', title: 'Pinned' }, definition,
    ])).toMatch(/every session group needs an id/)
  })

  /*
   * A list this build cannot draw reads as the defaults rather than latching the file: a tree has to
   * draw something whatever a hand edit did, and the settings tab is where it gets repaired.
   */
  it('reads a damaged list as the defaults, once, with the reason', () => {
    const reports: string[] = []

    expect(SessionsGroupsState.coerceList([{ id: 'only', title: 'Only' }], (message) => reports.push(message)))
      .toEqual(SessionsGroupsState.defaultsConst)
    expect(reports).toEqual(['Stored session groups are invalid (session groups must keep "none"); using the default groups'])
    expect(SessionsGroupsState.coerceList(undefined, () => { throw new Error('Unexpected report') }))
      .toEqual(SessionsGroupsState.defaultsConst)
  })

  /*
   * Removing a group leaves keys naming it. They are dropped where the list is saved AND where the
   * tree reads it, because the two files are written separately; a session left filed under a
   * section nothing draws would be filtered out of every section, including the one it falls to.
   */
  it('drops assignments to a section that no longer exists and keeps the rest', () => {
    const sections: readonly SessionGroupDefinition[] = [
      { id: 'none', title: 'Sessions' }, { id: 'pinned', title: 'Pinned' },
    ]
    const assignments = [
      { key: 'session:one', group: 'pinned' },
      { key: 'session:two', group: 'blocked' },
    ]

    expect(SessionsGroupsState.pruned(assignments, sections)).toEqual([assignments[0]])
    expect(SessionsGroupsState.isGroup('blocked', sections)).toBe(false)
    expect(SessionsGroupsState.isGroup('pinned', sections)).toBe(true)
  })

  it.each([null, {}, [null], [{ key: '', group: 'pinned' }], [{ key: 'one', group: 'Not An Id' }],
    [{ key: 'one', group: 'pinned' }, { key: 'one', group: 'none' }], [{ key: 'x'.repeat(4097), group: 'waiting' }]])(
    'rejects invalid assignments %j', (value) => {
      const reports: string[] = []
      expect(SessionsGroupsState.isValid(value)).toBe(false)
      expect(SessionsGroupsState.coerce(value, (message) => reports.push(message))).toEqual([])
      expect(reports).toHaveLength(1)
    },
  )

  /*
   * An assignment naming a section this build has never heard of is SHAPE-valid on purpose: the
   * assignments are written by windows that may be older than the list beside them, and a store that
   * refused the whole file over one such key would throw away every other assignment in it.
   */
  it('stores an assignment to a group it does not know, and prunes it when reading', () => {
    expect(SessionsGroupsState.isValid([{ key: 'session:one', group: 'made-up-later' }])).toBe(true)
  })
})
