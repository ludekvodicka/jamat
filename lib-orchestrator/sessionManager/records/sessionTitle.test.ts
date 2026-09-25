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

  /*
   * The custom number, which is the one a CALLER brings: `i34` for issue 34. Everything below is
   * one claim - the letters make it unreadable as a count - so the pair that matters most is the
   * last two lines, where `i34` spends nothing and the fork of it spends the 15 it was given.
   */
  it('reads a custom number as the prefix, alone and as the left half of a fork', () => {
    expect(SessionTitle.partsOf('i34 - issue work')).toEqual({ number: 'i34', name: 'issue work' })
    expect(SessionTitle.partsOf('pr1200 - review')).toEqual({ number: 'pr1200', name: 'review' })
    expect(SessionTitle.partsOf('i34')).toEqual({ number: 'i34', name: '' })
    expect(SessionTitle.partsOf('i34-015 - fork'))
      .toEqual({ number: 'i34-015', name: 'fork' })
  })

  it('leaves a name alone unless it is shaped exactly like one', () => {
    for (const title of [
      'hotfix for the parser',
      'i18n cleanup',
      'abcd12 - four letters',
      'i1234567 - seven digits',
      'i34-i35 - the right half is never custom',
    ])
      expect(SessionTitle.partsOf(title)).toEqual({ number: null, name: title })
  })

  it('counts nothing for a custom number, and the allocated half of its fork', () => {
    expect(SessionTitle.allocatedNumberOf('i34 - issue work')).toBeNull()
    expect(SessionTitle.allocatedNumberOf('i34-015 - fork')).toBe(15)
  })

  it('composes a fork of a custom number by keeping it on the left', () => {
    expect(SessionTitle.composeFork('i34', '015', 'fork')).toBe('i34-015 - fork')
    expect(SessionTitle.composeFork('i34-015', '016', 'fork')).toBe('i34-016 - fork')
  })

  it('names what a caller may bring and what a caller may select by', () => {
    for (const value of ['i34', 'pr1200', 'x64', 'i1'])
      expect(SessionTitle.isCustomNumber(value)).toBe(true)
    // An allocated number is the answering computer's to hand out, so it is selectable and never
    // bringable; the four after it are shapes no slot can hold at all.
    for (const value of ['014', '014-015', 'abcd12', 'i1234567', 'hotfix', 'i34-i35'])
      expect(SessionTitle.isCustomNumber(value)).toBe(false)
    for (const value of ['014', '0012', '014-015', '014-0015', 'i34', 'pr1200', 'i34-015'])
      expect(SessionTitle.isSelectorNumber(value)).toBe(true)
    for (const value of ['12', 'abc', 'abcd12', 'i1234567', '014-x15', 'i34-i35', ''])
      expect(SessionTitle.isSelectorNumber(value)).toBe(false)
  })

  it('collapses newlines to spaces and trims when normalizing a name', () => {
    expect(SessionTitle.normalizeName(' first\r\nsecond\n\nthird ')).toBe('first second third')
  })
})
