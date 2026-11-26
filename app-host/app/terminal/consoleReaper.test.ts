import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConsoleReaper } from './consoleReaper'

const minute = ConsoleReaper.minimumAgeMsConst

describe('app-host/app/terminal/consoleReaper', () => {
  afterEach(() => { vi.useRealTimers() })

  it('ends only old consoles that no live terminal started right after', () => {
    const now = 10 * minute
    const consoles = [
      { pid: 1, startedAt: now - 2 * minute },
      { pid: 2, startedAt: now - 3 * minute },
      { pid: 3, startedAt: now - 1_000 },
      { pid: 4, startedAt: now - 4 * minute },
    ]
    const roots = [
      { alive: true, processStartedAt: now - 3 * minute + 40 },
      { alive: false, processStartedAt: now - 2 * minute + 40 },
      { alive: true, processStartedAt: now - 4 * minute + ConsoleReaper.pairingMsConst + 1 },
    ]
    expect(ConsoleReaper.orphans(consoles, roots, now).map(row => row.pid)).toEqual([1, 4])
  })

  it('ends nothing while a live terminal has no start identity yet', () => {
    expect(ConsoleReaper.orphans([{ pid: 1, startedAt: 0 }], [{ alive: true, processStartedAt: null }], 10 * minute)).toEqual([])
  })

  it('waits for a held-back console to come of age and for a missing start identity', () => {
    const now = 10 * minute
    const young = { pid: 1, startedAt: now - 20_000 }
    expect(ConsoleReaper.retryIn([young], [], now)).toBe(minute - 20_000 + 1_000)
    expect(ConsoleReaper.retryIn([young], [{ alive: true, processStartedAt: young.startedAt + 100 }], now)).toBeNull()
    expect(ConsoleReaper.retryIn([{ pid: 2, startedAt: now - 2 * minute }], [], now)).toBeNull()
    expect(ConsoleReaper.retryIn([young], [{ alive: true, processStartedAt: null }], now)).toBe(ConsoleReaper.settleMsConst)
  })

  it.runIf(process.platform === 'win32')('sweeps again when the console of a terminal that ended right after its start comes of age', async () => {
    vi.useFakeTimers()
    let now = 10 * minute
    const console = { pid: 9, startedAt: now - 2_000 }
    const stop = vi.fn(async () => {})
    const reaper = new ConsoleReaper(() => [], { list: async () => [console], stop, now: () => now, report: vi.fn() })
    reaper.exited()
    now += ConsoleReaper.settleMsConst
    await vi.advanceTimersByTimeAsync(ConsoleReaper.settleMsConst)
    expect(stop).not.toHaveBeenCalled()
    now += minute
    await vi.advanceTimersByTimeAsync(minute)
    expect(stop).toHaveBeenCalledWith([console])
    reaper.dispose()
  })

  it.runIf(process.platform === 'win32')('sweeps once after a burst of exits settles and reports a failed query instead of throwing', async () => {
    vi.useFakeTimers()
    const list = vi.fn(async () => [{ pid: 7, startedAt: 0 }])
    const stop = vi.fn(async () => {})
    const reaper = new ConsoleReaper(() => [], { list, stop, now: () => 10 * minute, report: vi.fn() })
    reaper.exited()
    reaper.exited()
    await vi.advanceTimersByTimeAsync(ConsoleReaper.settleMsConst)
    expect(list).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledWith([{ pid: 7, startedAt: 0 }])
    const report = vi.fn()
    const failing = new ConsoleReaper(() => [], { list: async () => { throw new Error('query refused') }, stop, report })
    await failing.sweep()
    expect(report).toHaveBeenCalledWith('Ending the consoles of ended terminals failed: query refused')
    reaper.dispose()
  })
})
