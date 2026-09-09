import { describe, expect, it } from 'vitest'

import { SessionsViewState } from './sessionsViewState'

describe('app-client-ui/shared/sessionsViewState', () => {
  function reported(value: unknown): { view: string; messages: string[] } {
    const messages: string[] = []
    return { view: SessionsViewState.coerce(value, (message) => messages.push(message)), messages }
  }

  it('starts from two trees, which is the arrangement that shows both kinds', () => {
    expect(SessionsViewState.defaultConst).toBe('separated')
  })

  it('keeps a value it knows, and says nothing about it', () => {
    for (const view of ['separated', 'together', 'states'])
      expect(reported(view)).toEqual({ view, messages: [] })
  })

  // Nothing stored is the first start, not a fault: reporting it would put a line on the console of
  // every user who has never pressed the button.
  it('takes a missing value as the default without a word', () => {
    for (const value of [undefined, null])
      expect(reported(value)).toEqual({ view: 'separated', messages: [] })
  })

  it('reads a value it does not know as the default, and reports it', () => {
    for (const value of ['SEPARATED', 'sideways', 42, {}, []]) {
      const answer = reported(value)
      expect(answer.view).toBe('separated')
      expect(answer.messages).toHaveLength(1)
      expect(answer.messages[0]).toContain('is not a view')
    }
  })

  it('validates the value rather than its text, so no writer is refused for its spelling', () => {
    expect(SessionsViewState.isValid('together')).toBe(true)
    expect(SessionsViewState.isValid('separated')).toBe(true)
    expect(SessionsViewState.isValid('states')).toBe(true)
    for (const value of ['Together', ' together', 'both', null, undefined, 1, {}])
      expect(SessionsViewState.isValid(value)).toBe(false)
  })
})
