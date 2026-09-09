import { describe, expect, it } from 'vitest'

import type { SessionRecord } from './sessionRecord.types'
import { SessionOutcomes } from './sessionOutcomes'

describe('lib-orchestrator/sessionManager/records/sessionOutcomes', () => {
  type Facts = Pick<SessionRecord, 'life' | 'stopRequested' | 'exitReason' | 'exitCode'>

  const windowsKillCodeConst = -1073741510

  function facts(life: SessionRecord['life'], rest: Omit<Facts, 'life'> = {}): Facts {
    return { life, ...rest }
  }

  it('says nothing about a session that has not ended', () => {
    expect(SessionOutcomes.of(facts('starting'))).toBe(null)
    expect(SessionOutcomes.of(facts('live'))).toBe(null)
  })

  /**
   * The witnesses are asked apart from the outcome they feed, by the caller with the narrower
   * question: was this ending WANTED. A clean exit nobody asked for is `finished` to `of` and not
   * an asked-for ending here, which is the whole reason the two are not one call.
   */
  it('answers the two witnesses on their own', () => {
    expect(SessionOutcomes.endingWasAsked({ stopRequested: true })).toBe(true)
    expect(SessionOutcomes.endingWasAsked({ exitReason: 'stopped' })).toBe(true)
    expect(SessionOutcomes.endingWasAsked({})).toBe(false)
    expect(SessionOutcomes.endingWasAsked({ exitReason: 'process-exit' })).toBe(false)
  })

  it('reads a stopped session as finished whatever code the platform gave the kill', () => {
    expect(SessionOutcomes.of(facts('ended', {
      stopRequested: true,
      exitCode: windowsKillCodeConst,
    }))).toBe('finished')
    // POSIX answers a signalled process with 0, which the exit code alone cannot tell from a clean run
    expect(SessionOutcomes.of(facts('ended', { stopRequested: true, exitCode: 0 })))
      .toBe('finished')
  })

  it('takes the Host at its word when this client never wrote the mark itself', () => {
    expect(SessionOutcomes.of(facts('ended', {
      exitReason: 'stopped',
      exitCode: windowsKillCodeConst,
    }))).toBe('finished')
  })

  it('reads an ending nobody asked for by its exit code', () => {
    expect(SessionOutcomes.of(facts('ended', { exitCode: 0 }))).toBe('finished')
    expect(SessionOutcomes.of(facts('ended', { exitCode: 1 }))).toBe('failed')
    expect(SessionOutcomes.of(facts('ended', { exitCode: windowsKillCodeConst }))).toBe('failed')
  })

  it('reads a record that ended with no code and no witness as failed', () => {
    expect(SessionOutcomes.of(facts('ended'))).toBe('failed')
    expect(SessionOutcomes.of(facts('ended', { exitReason: 'spawn-failed' }))).toBe('failed')
  })

  it('reads a session the Host lost as interrupted, whichever way it learned that', () => {
    expect(SessionOutcomes.of(facts('lost'))).toBe('interrupted')
    expect(SessionOutcomes.of(facts('ended', { exitReason: 'host-lost' }))).toBe('interrupted')
  })

  /**
   * The Host dying between the stop and the exit it never got to report. The record ends up `lost`,
   * but the person had finished with the session, and drawing it as interrupted would send them to
   * run again something they had just ended.
   */
  it('lets a stop outrank a lost record, not only a lost Host', () => {
    expect(SessionOutcomes.of(facts('lost', { stopRequested: true }))).toBe('finished')
    expect(SessionOutcomes.of(facts('lost', { exitReason: 'stopped' }))).toBe('finished')
    // A session nobody stopped is still interrupted, which is the word for what happened to it.
    expect(SessionOutcomes.of(facts('lost'))).toBe('interrupted')
  })

  it('lets a stop outrank a lost Host: the person had already finished with it', () => {
    expect(SessionOutcomes.of(facts('ended', {
      stopRequested: true,
      exitReason: 'host-lost',
    }))).toBe('finished')
  })

  it('throws on a life it does not know', () => {
    expect(() => SessionOutcomes.of({ life: 'paused' as SessionRecord['life'] }))
      .toThrow(/Unknown session life/)
  })
})
