import { describe, expect, it } from 'vitest'

import { SessionsViewState } from './sessionsViewState'

describe('app-client-ui/shared/sessionsViewState', () => {
  function reported(value: unknown): { view: string; messages: string[] } {
    const messages: string[] = []
    return { view: SessionsViewState.coerce(value, (message) => messages.push(message)), messages }
  }

  it('starts from one tree, which is what the panel holds', () => {
    expect(SessionsViewState.defaultConst).toBe('together')
  })

  it('keeps a value it knows, and says nothing about it', () => {
    for (const view of ['together', 'states'])
      expect(reported(view)).toEqual({ view, messages: [] })
  })

  /*
   * `separated` drew the plain tabs in a tree of their own and was the default until 2026-09-23. A
   * file that still says it was written by the build before this one, not by something that cannot
   * write this file, so it is read as the default without a word about it.
   */
  it('takes the retired third arrangement as the default without a word', () => {
    expect(reported('separated')).toEqual({ view: 'together', messages: [] })
  })

  // Nothing stored is the first start, not a fault: reporting it would put a line on the console of
  // every user who has never pressed the button.
  it('takes a missing value as the default without a word', () => {
    for (const value of [undefined, null])
      expect(reported(value)).toEqual({ view: 'together', messages: [] })
  })

  it('reads a value it does not know as the default, and reports it', () => {
    for (const value of ['SEPARATED', 'sideways', 42, {}, []]) {
      const answer = reported(value)
      expect(answer.view).toBe('together')
      expect(answer.messages).toHaveLength(1)
      expect(answer.messages[0]).toContain('is not a view')
    }
  })

  it('validates the value rather than its text, so no writer is refused for its spelling', () => {
    expect(SessionsViewState.isValid('together')).toBe(true)
    expect(SessionsViewState.isValid('states')).toBe(true)
    for (const value of ['Together', ' together', 'separated', 'both', null, undefined, 1, {}])
      expect(SessionsViewState.isValid(value)).toBe(false)
  })
})
