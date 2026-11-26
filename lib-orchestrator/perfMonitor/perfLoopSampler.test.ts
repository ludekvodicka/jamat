import { describe, expect, it } from 'vitest'
import { PerfLoopSampler } from './perfLoopSampler'
import type { PerfEvent } from './perfRecord.types'

describe('lib-orchestrator/perfMonitor/perfLoopSampler', () => {
  it('reports utilization from the busy clock each second and in the minute sample', () => {
    let wall = 0, mono = 0, busy = 0
    const events: PerfEvent[] = [], observed: (number | null)[] = []
    const sampler = new PerfLoopSampler(event => events.push(event), () => wall, () => mono, value => observed.push(value), () => busy)
    sampler.start()
    for (let step = 1; step <= 1_200; step++) {
      wall += 50
      mono += 50
      busy += step <= 200 ? 30 : 5
      sampler.poll()
    }
    sampler.stop()
    expect(observed[0]).toBeCloseTo(0.6)
    expect(observed.at(-1)).toBeCloseTo(0.1)
    const sample = events.find(event => event.kind === 'sample')
    expect(sample).toMatchObject({ kind: 'sample' })
    if (sample?.kind !== 'sample') throw new Error('No minute sample')
    expect(sample.elu).toBeCloseTo((200 * 30 + 1_000 * 5) / 60_000)
  })
})
