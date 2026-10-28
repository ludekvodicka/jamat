import { describe, expect, it, vi } from 'vitest'
import { TickGuard } from './tickGuard'

describe('TickGuard', () => {
  it('aborts only the refused kind until the next tick', async () => {
    const a = { update: vi.fn(async () => false) }
    const b = { update: vi.fn(async () => true) }
    const stores = new Map([['a', a], ['b', b]])
    const guard = new TickGuard(stores)
    expect(await guard.write('a', (doc) => doc)).toBe(false)
    expect(await guard.write('a', (doc) => doc)).toBe(false)
    expect(await guard.write('b', (doc) => doc)).toBe(true)
    expect(a.update).toHaveBeenCalledTimes(1)
    expect(guard.open('a')).toBe(false)
    expect(new TickGuard(stores).open('a')).toBe(true)
  })
})
