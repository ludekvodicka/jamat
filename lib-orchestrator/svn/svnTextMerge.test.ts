import { describe, expect, it } from 'vitest'
import { SvnTextMerge } from './svnTextMerge'

const crlf = (lines: string[]) => Buffer.from(lines.join('\r\n'))
const lf = (lines: string[]) => Buffer.from(lines.join('\n'))
const text = (bytes: Buffer | null) => bytes === null ? null : bytes.toString('utf8')

describe('SvnTextMerge', () => {
  const older = ['one', 'two', 'three', 'four', 'five', 'six', '']

  it('merges a session edit saved with LF into a CRLF file that changed elsewhere, in the incoming line ends (Finish 072)', () => {
    const mine = lf(['one', 'TWO', 'three', 'four', 'five', 'six', ''])
    const theirs = crlf(['one', 'two', 'three', 'four', 'five', 'SIX', ''])
    expect(text(SvnTextMerge.merge(crlf(older), mine, theirs))).toBe('one\r\nTWO\r\nthree\r\nfour\r\nfive\r\nSIX\r\n')
  })

  it('takes the same change of both sides once', () => {
    const both = crlf(['one', 'two', 'THREE', 'four', 'five', 'six', ''])
    expect(text(SvnTextMerge.merge(crlf(older), lf(['one', 'two', 'THREE', 'four', 'five', 'six', '']), both))).toBe(both.toString('utf8'))
  })

  it('refuses changes of both sides that overlap or touch', () => {
    expect(SvnTextMerge.merge(lf(older), lf(['one', 'two', 'MINE', 'four', 'five', 'six', '']), lf(['one', 'two', 'THEIRS', 'four', 'five', 'six', '']))).toBeNull()
    expect(SvnTextMerge.merge(lf(older), lf(['one', 'TWO', 'three', 'four', 'five', 'six', '']), lf(['one', 'two', 'THREE', 'four', 'five', 'six', '']))).toBeNull()
  })

  it('refuses two blocks added at the same place, as the two if blocks of scripts/smoke/ui.ts (Finish 072)', () => {
    const at = (block: string[]) => lf(['one', 'two', 'three', ...block, 'four', 'five', 'six', ''])
    expect(SvnTextMerge.merge(lf(older), at(['if (a) {', '  run(a)', '}']), at(['if (b) {', '  run(b)', '}']))).toBeNull()
  })

  it('keeps additions and removals of both sides apart from each other', () => {
    const mine = lf(['zero', 'one', 'two', 'three', 'four', 'five', 'six', ''])
    const theirs = lf(['one', 'two', 'three', 'four', 'six', ''])
    expect(text(SvnTextMerge.merge(lf(older), mine, theirs))).toBe('zero\none\ntwo\nthree\nfour\nsix\n')
  })

  it('refuses an incoming side with mixed line ends, which it could not write back unchanged', () => {
    const theirs = Buffer.from('one\r\ntwo\nthree\r\nfour\r\nfive\r\nSIX\r\n')
    expect(SvnTextMerge.merge(crlf(older), lf(['ONE', 'two', 'three', 'four', 'five', 'six', '']), theirs)).toBeNull()
  })

  it('keeps a missing final line end as either side has it', () => {
    const base = lf(['a', 'b', 'c'])
    expect(text(SvnTextMerge.merge(base, lf(['A', 'b', 'c']), lf(['a', 'b', 'C'])))).toBe('A\nb\nC')
  })
})
