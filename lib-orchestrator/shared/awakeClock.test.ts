import { describe, expect, it } from 'vitest'
import { AwakeClock } from './awakeClock'

describe('AwakeClock', () => {
  it('keeps normal pre-sleep callbacks armed and excludes only the first native-suspend gap', () => {
    let at = 0
    const clock = new AwakeClock(() => at)
    clock.power(1, 'suspend')
    at = 1_000; clock.tick()
    expect(clock.now()).toBe(1_000)
    at = 91_000
    expect(clock.now()).toBe(1_000)
    clock.tick()
    at += 30_000
    expect(clock.now()).toBe(31_000)
  })

  it('samples each returned timestamp once even when the underlying source advances on every read', () => {
    let at = 0
    const clock = new AwakeClock(() => ++at)
    clock.power(1, 'suspend')
    at += 90_000
    const before = clock.now()
    clock.power(2, 'resume')
    expect(clock.now()).toBeGreaterThanOrEqual(before)
    clock.power(3, 'suspend')
    const awake = clock.now()
    clock.power(4, 'resume')
    expect(clock.now()).toBeGreaterThanOrEqual(awake)
  })

  it('consumes a same-turn late native epoch without shifting issued timestamps or arming a future gap', () => {
    let at = 0
    const clock = new AwakeClock(() => at)
    at = 91_000
    const issued = clock.now()
    expect(clock.power(1, 'suspend')).toEqual({ changed: true, late: true })
    expect(clock.now()).toBe(issued)
    at += 30_000
    expect(clock.now() - issued).toBe(30_000)
    expect(clock.power(1, 'suspend')).toEqual({ changed: false, late: false })
    expect(clock.now() - issued).toBe(30_000)
  })

  it('never forgives an arbitrary long gap without a native suspend', () => {
    let at = 0
    const clock = new AwakeClock(() => at)
    at = 90_000
    expect(clock.now()).toBe(90_000)
    clock.tick()
    expect(clock.now()).toBe(90_000)
  })

  it.each(['heartbeat-first', 'resume-first'] as const)('keeps timestamps nondecreasing with %s after wake', order => {
    let at = 0
    const clock = new AwakeClock(() => at)
    clock.power(1, 'suspend')
    at = 1_000; clock.tick()
    at = 91_000
    if (order === 'resume-first') clock.power(2, 'resume')
    else if (order !== 'heartbeat-first') throw new Error('Unknown ordering')
    const heartbeat = clock.now()
    at += 10
    clock.power(2, 'resume')
    const reply = clock.now()
    clock.tick()
    expect(reply).toBeGreaterThanOrEqual(heartbeat)
    expect(clock.now()).toBeGreaterThanOrEqual(reply)
    clock.power(1, 'suspend')
    at += 30_000
    expect(clock.now() - reply).toBe(30_000)
  })
})
