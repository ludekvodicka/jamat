import { describe, expect, it } from 'vitest'

import { MainWorkLedger } from './mainWorkLedger'

describe('app-client-ui/app/perf/mainWorkLedger', () => {
  it('keeps the worst of the window and starts the next one at the read', () => {
    const ledger = new MainWorkLedger()
    ledger.note('tabs:list', 12)
    ledger.note('fileChanges:working-tree', 900)
    ledger.note('sessions:snapshot', 40)

    expect(ledger.sample()).toEqual({ label: 'fileChanges:working-tree', milliseconds: 900 })
    expect(ledger.sample()).toBeNull()
  })

  // A keystroke that waited five milliseconds waited for nobody, and a name for it would bury the
  // one that matters under two hundred handlers doing their job.
  it('names nothing that was quick', () => {
    const ledger = new MainWorkLedger()
    ledger.note('tabs:list', 4)
    expect(ledger.sample()).toBeNull()
  })

  /**
   * The SYNCHRONOUS part is what blocks the loop. An async handler that awaits for a second has held
   * nothing up, so what is timed is the call until it returns - which for a promise-returning
   * handler is everything it did before its first await.
   */
  it('times the call rather than the promise it hands back', async () => {
    const ledger = new MainWorkLedger()
    const answer = ledger.run('sessions:create', () => {
      const until = performance.now() + 8
      while (performance.now() < until) { /* a handler that really is on the loop */ }
      return new Promise((resolve) => setTimeout(() => resolve('done'), 40))
    })

    const worst = ledger.sample()
    expect(worst?.label).toBe('sessions:create')
    expect(worst?.milliseconds).toBeGreaterThanOrEqual(5)
    expect(worst?.milliseconds).toBeLessThan(40)
    expect(await answer).toBe('done')
  })

  it('hands back what the work returned, and records a throw as time spent too', () => {
    const ledger = new MainWorkLedger()
    expect(ledger.run('tabs:list', () => 'value')).toBe('value')

    expect(() => ledger.run('sessions:remove', () => {
      const until = performance.now() + 8
      while (performance.now() < until) { /* held the loop, then failed */ }
      throw new Error('refused')
    })).toThrow('refused')
    expect(ledger.sample()?.label).toBe('sessions:remove')
  })
})
