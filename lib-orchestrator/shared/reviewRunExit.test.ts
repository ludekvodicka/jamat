import { describe, expect, it } from 'vitest'

import { ReviewRunExit } from './reviewRunExit'

describe('lib-orchestrator/shared/reviewRunExit', () => {
  it('writes a settled commit status as the exit code of the review run', () => {
    expect(ReviewRunExit.codeOf('committed', true, null)).toBe(0)
    expect(ReviewRunExit.codeOf('cancelled', true, null)).toBe(10)
    expect(ReviewRunExit.codeOf('failed', true, 'File is locked')).toBe(11)
    expect(ReviewRunExit.codeOf('failed', true, 'svn: E155011: File is out of date')).toBe(12)
    expect(ReviewRunExit.codeOf('external-closed', true, null)).toBe(13)
  })

  it('calls every status that did not settle, and any it does not know, interrupted', () => {
    for (const [state, closed] of [['failed', false], ['cancelled', false], ['editing', false], ['running', false], ['gone', true]] as const)
      expect(ReviewRunExit.codeOf(state, closed, null), state).toBe(14)
  })

  it('reads an exit code back, and any other code or none as an interrupted review', () => {
    expect([0, 10, 11, 12, 13, 14].map((code) => ReviewRunExit.of(code)))
      .toEqual(['committed', 'cancelled', 'failed', 'out-of-date', 'external', 'interrupted'])
    expect(ReviewRunExit.of(undefined)).toBe('interrupted')
    expect(ReviewRunExit.of(1)).toBe('interrupted')
    expect(ReviewRunExit.of(-1073741510)).toBe('interrupted')
  })
})
