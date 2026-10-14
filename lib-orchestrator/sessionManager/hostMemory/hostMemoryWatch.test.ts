import { describe, expect, it } from 'vitest'

import type { HostHealthResult } from '../../../app-host/app/wire/hostWire.js'
import type { HostCallResult } from '../../hostClient/hostClient.types'
import { HostMemoryReadings } from './hostMemoryReadings'
import { HostMemoryWatch } from './hostMemoryWatch'

describe('lib-orchestrator/sessionManager/hostMemory/hostMemoryWatch', () => {
  const minute = 60_000
  const health: HostHealthResult = {
    startedAt: 0,
    sampleEveryMs: 10 * minute,
    samples: [{ at: 5 * minute, rssBytes: 100 * 1024 ** 2, heapUsedBytes: 1024 ** 2, externalBytes: 0 }],
  }

  function watch(answer: () => HostCallResult<HostHealthResult> | null) {
    const state = { now: 0, reads: 0 }
    const memory = new HostMemoryWatch({
      read: async () => {
        state.reads += 1
        return answer()
      },
      now: () => state.now,
    })
    return { memory, state }
  }

  it('reads at once, then at most once per ten minutes', async () => {
    const { memory, state } = watch(() => ({ ok: true, value: health }))

    expect(await memory.observe('host-1')).toBe(true)
    expect(memory.reading()).toEqual(HostMemoryReadings.of(health))
    state.now = 9 * minute
    expect(await memory.observe('host-1')).toBe(false)
    expect(state.reads).toBe(1)

    state.now = 10 * minute
    expect(await memory.observe('host-1')).toBe(true)
    expect(state.reads).toBe(2)
  })

  it('reads at once when the Host instance changes, and forgets the old reading', async () => {
    const { memory, state } = watch(() => ({ ok: true, value: health }))
    await memory.observe('host-1')
    state.now = minute

    expect(await memory.observe('host-2')).toBe(true)
    expect(state.reads).toBe(2)

    expect(await memory.observe(null)).toBe(true)
    expect(memory.reading()).toBeNull()
    expect(await memory.observe(null)).toBe(false)
    expect(state.reads).toBe(2)
  })

  it('says the Host cannot report when it predates host.health', async () => {
    const { memory } = watch(() => null)

    await memory.observe('host-1')

    expect(memory.reading()).toBe(HostMemoryReadings.notReportedConst)
  })

  it('keeps the last reading through a failed read, and waits the cadence before asking again', async () => {
    let failing = false
    const { memory, state } = watch(() => failing
      ? { ok: false, code: 'host-unreachable', detail: 'gone' }
      : { ok: true, value: health })
    await memory.observe('host-1')
    const before = memory.reading()
    failing = true
    state.now = 10 * minute

    expect(await memory.observe('host-1')).toBe(false)
    expect(memory.reading()).toBe(before)
    state.now = 11 * minute
    await memory.observe('host-1')
    expect(state.reads).toBe(2)
  })

  it('drops an answer from a Host that was replaced while it was read', async () => {
    let release: (answer: HostCallResult<HostHealthResult>) => void = () => undefined
    const memory = new HostMemoryWatch({
      read: () => new Promise((resolve) => { release = resolve }),
      now: () => 0,
    })
    const first = memory.observe('host-1')
    await memory.observe('host-2')
    release({ ok: true, value: health })

    expect(await first).toBe(false)
    expect(memory.reading()).toBeNull()
  })
})
