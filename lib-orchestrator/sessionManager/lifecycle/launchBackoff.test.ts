import { describe, expect, it } from 'vitest'

import type { SessionRecordLaunchWait } from '../records/sessionRecord.types'
import { LaunchBackoff } from './launchBackoff'

describe('lib-orchestrator/sessionManager/lifecycle/launchBackoff', () => {
  function wait(attempts: number, lastAttemptAt = 1_000): SessionRecordLaunchWait {
    return { attempts, lastAttemptAt, reason: '64 live runtimes is the limit' }
  }

  it('counts a refusal on from whatever the record already carried', () => {
    expect(LaunchBackoff.after(undefined, 'no lease', 500))
      .toEqual({ attempts: 1, lastAttemptAt: 500, reason: 'no lease' })
    expect(LaunchBackoff.after(wait(3), 'still full', 900))
      .toEqual({ attempts: 4, lastAttemptAt: 900, reason: 'still full' })
  })

  /** A record nobody has refused yet has nothing to wait for, and absence is not a delay. */
  it('lets an unrefused launch through', () => {
    expect(LaunchBackoff.due(undefined, 0)).toBe(true)
  })

  /**
   * The first refusals really are the transient ones - a restarted Host answers 401 until the
   * watcher has its new descriptor - so they are retried on the reconciler's own cadence.
   */
  it('retries the first two refusals immediately', () => {
    expect(LaunchBackoff.due(wait(1), 1_000)).toBe(true)
  })

  it('spaces the ones after that, and settles on a minute', () => {
    expect(LaunchBackoff.due(wait(2), 1_000)).toBe(false)
    expect(LaunchBackoff.due(wait(2), 3_000)).toBe(true)
    expect(LaunchBackoff.due(wait(4), 1_000 + 14_999)).toBe(false)
    expect(LaunchBackoff.due(wait(4), 1_000 + 15_000)).toBe(true)
    // Past the table, so every further refusal waits the same minute rather than growing for ever.
    expect(LaunchBackoff.due(wait(40), 1_000 + 59_999)).toBe(false)
    expect(LaunchBackoff.due(wait(40), 1_000 + 60_000)).toBe(true)
  })

  /**
   * A machine that resumed, or an NTP step backwards, would otherwise park the record until wall
   * time caught up with a stamp written in the future.
   */
  it('does not park a record behind a clock that went backwards', () => {
    expect(LaunchBackoff.due(wait(40, 9_000), 1_000)).toBe(true)
  })

  /**
   * Below the threshold the row says `starting`, which is what a launch still going through looks
   * like. Above it that would be a lie: nothing is starting while the Host keeps refusing.
   */
  it('says nothing about a launch refused once or twice', () => {
    expect(LaunchBackoff.visible(undefined)).toBe(false)
    expect(LaunchBackoff.visible(wait(2))).toBe(false)
    expect(LaunchBackoff.visible(wait(3))).toBe(true)
  })
})
