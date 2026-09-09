import { describe, expect, it } from 'vitest'

import { SessionTitle } from './sessionTitle'

describe('lib-orchestrator/sessionManager/records/sessionTitle', () => {
  it('splits a prefixed title into its number and name', () => {
    expect(SessionTitle.partsOf('014 - jméno')).toEqual({ number: '014', name: 'jméno' })
  })

  it('answers a bare number with an empty name', () => {
    expect(SessionTitle.partsOf('014')).toEqual({ number: '014', name: '' })
  })

  it('keeps a fork pair as one prefix', () => {
    expect(SessionTitle.partsOf('014-015 - jméno'))
      .toEqual({ number: '014-015', name: 'jméno' })
  })

  it('answers a title without a prefix with a null number', () => {
    expect(SessionTitle.partsOf('bez prefixu')).toEqual({ number: null, name: 'bez prefixu' })
  })

  it('composes back what it split', () => {
    const parts = SessionTitle.partsOf('014 - jméno')
    expect(SessionTitle.compose(parts.number, parts.name)).toBe('014 - jméno')
  })

  it('canonizes a title that never had the separator', () => {
    const parts = SessionTitle.partsOf('014 jméno')
    expect(parts).toEqual({ number: '014', name: 'jméno' })
    expect(SessionTitle.compose(parts.number, parts.name)).toBe('014 - jméno')
  })

  it('composes a bare number from an empty name, and a bare name from a null number', () => {
    expect(SessionTitle.compose('014', '')).toBe('014')
    expect(SessionTitle.compose(null, 'jen jméno')).toBe('jen jméno')
    expect(SessionTitle.compose(null, '')).toBe('')
  })

  it('composes a fork from the original and newly allocated numbers', () => {
    expect(SessionTitle.composeFork('014', '015', 'jméno')).toBe('014-015 - jméno')
    expect(SessionTitle.composeFork(null, '015', 'jméno')).toBe('015 - jméno')
    expect(SessionTitle.composeFork('014-015', '016', 'jméno')).toBe('014-016 - jméno')
    expect(SessionTitle.composeFork('014', null, 'jméno')).toBe('jméno')
  })

  it('reads the counter number from the right side of a fork prefix', () => {
    expect(SessionTitle.allocatedNumberOf('014 - parent')).toBe(14)
    expect(SessionTitle.allocatedNumberOf('014-015 - fork')).toBe(15)
    expect(SessionTitle.allocatedNumberOf('without a number')).toBeNull()
  })

  it('collapses newlines to spaces and trims when normalizing a name', () => {
    expect(SessionTitle.normalizeName(' first\r\nsecond\n\nthird ')).toBe('first second third')
  })
})
