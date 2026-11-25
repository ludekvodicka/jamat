import { describe, expect, it } from 'vitest'
import { SessionsGroupsState } from '../clientApi/sessionsGroupsState'
import { SessionGroups } from './sessionGroups'

describe('lib-orchestrator/sessionManager/sessionGroups', () => {
  /*
   * A read problem replaces the whole stored list with the defaults, and the relay refuses a computer
   * whose list fails `isList`. A list that still holds the four former bot sections must read whole,
   * so the startup cleanup sees them and a custom section beside them survives.
   */
  it('reads a stored list that still holds the four former bot sections, custom sections included', () => {
    const olderList = [
      { id: 'pinned', title: 'Pinned' },
      { id: 'review', title: 'Review' },
      { id: 'none', title: 'Sessions' },
      { id: 'automation', title: 'Automation' },
      { id: 'waiting', title: 'Waiting' },
      { id: 'completed', title: 'Completed' },
      { id: 'blocked', title: 'Blocked' },
    ]

    expect(SessionGroups.definitionsProblemOf(olderList)).toBeNull()
    expect(SessionGroups.isList(olderList)).toBe(true)
    expect(SessionsGroupsState.coerceList(olderList, (message) => { throw new Error(message) })).toEqual(olderList)
  })
})
