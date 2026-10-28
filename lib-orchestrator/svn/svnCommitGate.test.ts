import { describe, expect, it } from 'vitest'

import { SvnCommitGate } from './svnCommitGate'

describe('SvnCommitGate', () => {
  it.each(['x.ts.mine', 'x.working', 'x.tsx.r485', 'x.merge-left.r12', 'x.merge-right.r13', 'dir_conflicts.2.prej'])('refuses SVN sidecar %s', (path) => {
    expect(SvnCommitGate.problems({ conflicted: [], untracked: [path], markers: [] }))
      .toEqual([`Refused: ${path} is an svn conflict file`])
  })

  it('names each path once, by its first problem, and every path in one pass', () => {
    expect(SvnCommitGate.problems({ conflicted: ['b.ts'], untracked: ['a.ts.r3'], markers: ['a.ts.r3', 'b.ts', 'c.ts'] })).toEqual([
      'Refused: b.ts is conflicted', 'Refused: a.ts.r3 is an svn conflict file', 'Refused: c.ts contains svn conflict markers'])
  })

  it('tells its own refusal from another refusal of the same code', () => {
    expect(SvnCommitGate.isGateRefusal(SvnCommitGate.problems({ conflicted: ['b.ts'], untracked: ['a.ts.r3'], markers: ['c.ts'] }).join('\n'))).toBe(true)
    expect(SvnCommitGate.isGateRefusal('Cannot prove landed path žluťoučký')).toBe(false)
  })

  it('accepts names that only resemble a sidecar', () => {
    expect(SvnCommitGate.problems({ conflicted: [], untracked: ['notes.r2d2', 'mine.ts'], markers: [] })).toEqual([])
  })

  it.each([
    ['<<<<<<< .mine\nours\n=======\ntheirs\n>>>>>>> .r5', true],
    ['<<<<<<< .mine\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> .r5', true],
    ['Heading\n=======\nA paragraph', false],
    ['=======\n<<<<<<< .mine\n>>>>>>> .r5', false],
    ['prefix <<<<<<< .mine\n=======\n>>>>>>> .r5', false],
  ])('requires an ordered triplet at line starts', (text, expected) => {
    expect(SvnCommitGate.hasMarkerTriplet(text)).toBe(expected)
  })
})
