import { describe, expect, it } from 'vitest'

import { HostDebugFixtures } from './fixtures/hostDebugFixtures'
import { type HostDebugInput, HostDebugModel } from './hostDebugModel'

describe('app-client-ui/renderer/debugWindow/sections/host/hostDebugModel', () => {
  /*
   * `pinging` is what disables the button, and it was cleared only by `ping-answered` - which a
   * rejected invoke skips entirely. One rejection left the button dead for the life of the window,
   * with nothing said. The terminal panel fixed the same shape and wrote it up.
   */
  it('releases the ping latch when the ping failed instead of answering', () => {
    const asked = HostDebugModel.transition(HostDebugModel.initial(), { input: 'ping-started' })
    expect(asked.state.pinging).toBe(true)

    const failed = HostDebugModel.transition(asked.state, {
      input: 'failed',
      detail: 'the pipe closed',
    })

    expect(failed.state.pinging).toBe(false)
    expect(failed.state.problem).toBe('the pipe closed')
    // And the button works again: a second ask is taken rather than swallowed by the latch.
    expect(HostDebugModel.transition(failed.state, { input: 'ping-started' }).effects)
      .toEqual([{ effect: 'ping' }])
  })

  // Every node of the host tree runs this machine, and only the one that draws a ping asks for one.
  it('opens holding nothing and asking for nothing', () => {
    expect(HostDebugModel.initial())
      .toEqual({ status: null, pinging: false, lastPing: null, problem: null })
  })

  it('takes the status the reader hands it', () => {
    const status = HostDebugFixtures.status()
    const step = HostDebugModel.transition(
      HostDebugModel.initial(),
      { input: 'status-arrived', status },
    )
    expect(step.state.status).toBe(status)
    expect(step.effects).toEqual([])
  })

  // The loop in the main process holds the same rule, and the two must not add up to two requests.
  it('does not ask for a second ping while one is still out', () => {
    const asked = HostDebugModel.transition(
      HostDebugModel.initial(),
      { input: 'ping-started' },
    )
    expect(asked.effects).toEqual([{ effect: 'ping' }])
    expect(HostDebugModel.transition(asked.state, { input: 'ping-started' }).effects).toEqual([])

    // The loop's own result, arriving while the manual ping is still out: it draws, and it
    // does NOT open the button for a second one.
    const meanwhile = HostDebugModel.transition(asked.state, {
      input: 'ping-answered',
      result: { at: 2, ok: false, detail: 'the loop asked' },
    }).state
    expect(meanwhile.pinging).toBe(true)
    expect(HostDebugModel.transition(meanwhile, { input: 'ping-started' }).effects).toEqual([])

    const settled = HostDebugModel.transition(asked.state, {
      input: 'ping-answered',
      mine: true,
      result: { at: 3, ok: false, detail: 'nothing there' },
    }).state
    expect(HostDebugModel.transition(settled, { input: 'ping-started' }).effects)
      .toEqual([{ effect: 'ping' }])
  })

  it('keeps the last ping, whichever way it went', () => {
    const failed = HostDebugModel.transition(HostDebugModel.initial(), {
      input: 'ping-answered',
      mine: true,
      result: { at: 7, ok: false, detail: 'host-unreachable: nothing there' },
    }).state
    expect(failed).toMatchObject({ pinging: false, lastPing: { at: 7, ok: false } })
  })

  /*
   * The drawn ping is the LATEST one, not the last to arrive. A loop result can be older than a
   * manual one it lands behind - two sources, one input - and reading it as newer walks the
   * panel backwards to a moment that has already passed.
   */
  it('keeps the newer ping when an older one arrives after it', () => {
    const newer = HostDebugModel.transition(HostDebugModel.initial(), {
      input: 'ping-answered',
      mine: true,
      result: { at: 90, ok: false, detail: 'the manual one' },
    }).state

    const older = HostDebugModel.transition(newer, {
      input: 'ping-answered',
      result: { at: 40, ok: false, detail: 'the loop, from before' },
    }).state

    expect(older.lastPing).toMatchObject({ at: 90, detail: 'the manual one' })
  })

  it('asks for a Host and clears what the last attempt said', () => {
    const failed = HostDebugModel.transition(
      HostDebugModel.initial(),
      { input: 'failed', detail: 'spawn-failed: no entry point' },
    ).state
    expect(failed.problem).toBe('spawn-failed: no entry point')

    const starting = HostDebugModel.transition(failed, { input: 'start-host' })
    expect(starting.state.problem).toBeNull()
    expect(starting.effects).toEqual([{ effect: 'start-host' }])
  })

  it('throws on an input it does not know', () => {
    expect(() => HostDebugModel.transition(
      HostDebugModel.initial(),
      { input: 'restart' } as unknown as HostDebugInput,
    )).toThrow(/Unknown host debug input/)
  })

  /*
   * The V1 rule, and the one that matters: a missing version on either side is `unknown`, never
   * `current`. Telling somebody their Host is up to date when nothing could be read is the failure
   * this whole section exists to prevent.
   */
  it('reads the version verdict, and never reads a missing one as current', () => {
    expect(HostDebugModel.versionVerdict(HostDebugFixtures.status())).toBe('current')

    expect(HostDebugModel.versionVerdict(HostDebugFixtures.status({
      expectedHostVersion: '2026.08.11.9',
    }))).toBe('stale')

    expect(HostDebugModel.versionVerdict(HostDebugFixtures.status({
      expectedHostVersion: null,
    }))).toBe('unknown')

    expect(HostDebugModel.versionVerdict(HostDebugFixtures.status({
      descriptor: null,
    }))).toBe('unknown')
  })

  it('reads the protocol verdict off the major alone', () => {
    expect(HostDebugModel.protocolVerdict(HostDebugFixtures.status())).toBe('match')

    expect(HostDebugModel.protocolVerdict(HostDebugFixtures.status({
      clientProtocol: { major: 2, minor: 0 },
    }))).toBe('mismatch')

    // A minor that moved is what a compatible addition looks like.
    expect(HostDebugModel.protocolVerdict(HostDebugFixtures.status({
      clientProtocol: { major: 1, minor: 4 },
    }))).toBe('match')

    expect(HostDebugModel.protocolVerdict(HostDebugFixtures.status({ descriptor: null })))
      .toBe('unknown')
  })

  // Delegated to the one derivation of presence there is, rather than switched on a third time.
  it('reads the headline through the shared presence derivation', () => {
    expect(HostDebugModel.headline(HostDebugFixtures.status()))
      .toEqual({ text: 'Host v2026.08.10.1 · 2 live', startable: false })

    expect(HostDebugModel.headline(HostDebugFixtures.status({ presence: 'starting' })).startable)
      .toBe(false)

    expect(HostDebugModel.headline(HostDebugFixtures.status({ presence: 'unreachable' })))
      .toEqual({ text: 'Host unreachable', startable: true })
  })
})
