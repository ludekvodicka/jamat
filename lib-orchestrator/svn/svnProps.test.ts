import { describe, expect, it } from 'vitest'

import { SvnProps } from './svnProps'

const blob = (text: string) => new TextEncoder().encode(text)

describe('SvnProps', () => {
  it('reads implicit names and explicit values, an empty value and a value with a parenthesis exactly', () => {
    const props = SvnProps.parseSkel(blob('(svn:ignore 22 node_modules\ndist\n(x)\n svn:eol-style 6 native empty 0 )'))
    expect(props.get('svn:ignore')).toBe('node_modules\ndist\n(x)\n')
    expect(props.get('svn:eol-style')).toBe('native')
    expect(props.get('empty')).toBe('')
    expect(props.get('svn:keywords')).toBeUndefined()
  })

  it('reads an empty list, no blob and multi-byte values by byte count', () => {
    expect(SvnProps.parseSkel(blob('()')).get('a')).toBeUndefined()
    expect(SvnProps.parseSkel(null).get('a')).toBeUndefined()
    expect(SvnProps.parseSkel(blob('(note 2 é)')).get('note')).toBe('é')
  })

  it('reads every property list of inherited properties', () => {
    const lists = SvnProps.parseInheritedSkel(blob('(file:///repo (svn:global-ignores 5 *.wav) file:///repo/trunk (a 1 b))'))
    expect(lists.map((props) => props.get('svn:global-ignores') ?? props.get('a'))).toEqual(['*.wav', 'b'])
    expect(SvnProps.parseInheritedSkel(blob('()'))).toEqual([])
  })

  it('refuses a skel that is cut short', () => {
    expect(() => SvnProps.parseSkel(blob('(svn:ignore 30 short)'))).toThrow()
    expect(() => SvnProps.parseSkel(blob('(svn:ignore 3 abc'))).toThrow()
  })
})
