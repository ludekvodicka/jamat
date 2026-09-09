import { describe, expect, it } from 'vitest'

import { ErrnoCode } from './errnoCode'

/**
 * A `catch` binds an `unknown`, and what arrives there is whatever was thrown. The cast this
 * replaces - `(error as NodeJS.ErrnoException).code` - says the field is there, and reading it off a
 * `null` throws inside the handler that exists to stop a throw.
 */
describe('lib-orchestrator/shared/errnoCode', () => {
  it('reads the code off a real errno error', () => {
    const error: NodeJS.ErrnoException = new Error('spawn tool ENOENT')
    error.code = 'ENOENT'

    expect(ErrnoCode.of(error)).to.equal('ENOENT')
  })

  it('answers null for everything that has no code to read', () => {
    for (const thrown of [null, undefined, 'ENOENT', 42, new Error('no code'), {}, []])
      expect(ErrnoCode.of(thrown), JSON.stringify(thrown ?? null)).to.equal(null)
  })

  it('answers null for a code that is not a string', () => {
    expect(ErrnoCode.of({ code: 2 })).to.equal(null)
    expect(ErrnoCode.of({ code: null })).to.equal(null)
  })

  it('does not throw for a thrown null', () => {
    expect(() => ErrnoCode.of(null)).to.not.throw()
  })
})
