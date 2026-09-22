import { describe, expect, it } from 'vitest'
import { SessionGroups } from '../../lib-orchestrator/sessionManager/sessionGroups'
import { SessionsGroupsState } from './sessionsGroupsState'

describe('app-client-ui/shared/sessionsGroupsState', () => {
  it('copies assignments and retains explicit None', () => {
    const groups = [{ key: 'session:one', group: 'none' as const }]
    const copy = SessionsGroupsState.coerce(groups, () => { throw new Error('Unexpected report') })
    expect(copy).toEqual(groups)
    expect(copy[0]).not.toBe(groups[0])
    expect(SessionsGroupsState.coerce(undefined, () => {})).toEqual([])
  })

  /*
   * The two lists are one vocabulary in two orders: the library's decides what a create may ask for
   * and is asked `includes`, this one decides what a person sees and where. A group offered here and
   * refused there would be a section nothing can be filed into from outside the app.
   */
  it('offers every group the library accepts, with Automation above Waiting and Blocked', () => {
    const offered = SessionsGroupsState.choicesConst.map((choice) => choice.key)

    expect([...offered].sort()).toEqual([...SessionGroups.namesConst].sort())
    expect(offered.indexOf('automation')).toBe(offered.indexOf('none') + 1)
    expect(offered.indexOf('automation')).toBeLessThan(offered.indexOf('waiting'))
    expect(offered.indexOf('automation')).toBeLessThan(offered.indexOf('blocked'))
    expect(SessionsGroupsState.isGroup('automation')).toBe(true)
  })

  it.each([null, {}, [null], [{ key: '', group: 'pinned' }], [{ key: 'one', group: 'unknown' }],
    [{ key: 'one', group: 'pinned' }, { key: 'one', group: 'none' }], [{ key: 'x'.repeat(4097), group: 'waiting' }]])(
    'rejects invalid assignments %j', (value) => {
      const reports: string[] = []
      expect(SessionsGroupsState.isValid(value)).toBe(false)
      expect(SessionsGroupsState.coerce(value, (message) => reports.push(message))).toEqual([])
      expect(reports).toHaveLength(1)
    },
  )
})
