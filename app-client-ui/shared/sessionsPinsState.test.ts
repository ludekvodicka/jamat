import { describe, expect, it } from 'vitest'
import { SessionsPinsState } from './sessionsPinsState'

describe('app-client-ui/shared/sessionsPinsState', () => {
  it('loads older documents without pins and copies valid pins', () => {
    expect(SessionsPinsState.coerce(undefined, () => { throw new Error('Unexpected report') })).toEqual([])
    const pins = ['session:one', 'category:nodejs']
    expect(SessionsPinsState.coerce(pins, () => {})).toEqual(pins)
    expect(SessionsPinsState.coerce(pins, () => {})).not.toBe(pins)
  })

  it.each([null, {}, [''], ['same', 'same'], [1], ['x'.repeat(4097)]])('reports invalid stored pins %j', (value) => {
    const reports: string[] = []
    expect(SessionsPinsState.isValid(value)).toBe(false)
    expect(SessionsPinsState.coerce(value, (message) => reports.push(message))).toEqual([])
    expect(reports).toHaveLength(1)
  })
})
