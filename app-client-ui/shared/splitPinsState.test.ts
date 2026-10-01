import { describe, expect, it } from 'vitest'
import { SplitPinsState } from './splitPinsState'

describe('app-client-ui/shared/splitPinsState', () => {
  it('loads older documents without split pins and copies valid ones', () => {
    expect(SplitPinsState.coerce(undefined, () => { throw new Error('Unexpected report') })).toEqual({})
    const pins = { 'session-1': [{ key: 'doc-a', kind: 'file', pinned: true }] }
    const coerced = SplitPinsState.coerce(pins, () => { throw new Error('Unexpected report') })
    expect(coerced).toEqual(pins)
    expect(coerced['session-1']).not.toBe(pins['session-1'])
  })

  it.each([null, [], 'pins'])('reports a stored value that is not a map %j', (value) => {
    const reports: string[] = []
    expect(SplitPinsState.coerce(value, (message) => reports.push(message))).toEqual({})
    expect(reports).toHaveLength(1)
  })

  it('drops the invalid sessions and keeps the rest', () => {
    const reports: string[] = []
    const pins = SplitPinsState.coerce({
      good: [{ key: 'a' }],
      empty: [],
      noKey: [{ title: 'x' }],
      twice: [{ key: 'a' }, { key: 'a' }],
    }, (message) => reports.push(message))
    expect(pins).toEqual({ good: [{ key: 'a' }] })
    expect(reports).toHaveLength(1)
  })

  it.each([
    null,
    {},
    [null],
    [[]],
    [{ key: '' }],
    [{ key: 1 }],
    [{ key: 'same' }, { key: 'same' }],
    Array.from({ length: SplitPinsState.itemsMaxConst + 1 }, (_, index) => ({ key: `k${index}` })),
    [{ key: 'big', title: 'x'.repeat(70_000) }],
  ])('refuses invalid items %#', (value) => {
    expect(SplitPinsState.isValidItems(value)).toBe(false)
  })

  it('removes a session with no pins and moves a written one to the end', () => {
    const pins = { a: [{ key: '1' }], b: [{ key: '2' }] }
    expect(Object.keys(SplitPinsState.stored(pins, 'a', [{ key: '3' }]))).toEqual(['b', 'a'])
    expect(SplitPinsState.stored(pins, 'a', [])).toEqual({ b: [{ key: '2' }] })
    expect(pins).toEqual({ a: [{ key: '1' }], b: [{ key: '2' }] })
  })

  it('forgets the oldest session past the limit', () => {
    let pins = {}
    for (let index = 0; index <= SplitPinsState.sessionsMaxConst; index += 1)
      pins = SplitPinsState.stored(pins, `session-${index}`, [{ key: 'doc' }])
    expect(Object.keys(pins)).toHaveLength(SplitPinsState.sessionsMaxConst)
    expect(pins).not.toHaveProperty('session-0')
    expect(pins).toHaveProperty(`session-${SplitPinsState.sessionsMaxConst}`)
  })
})
