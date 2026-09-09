import { describe, expect, it } from 'vitest'

import type {
  RateAgentId,
  RateProviderState,
} from '../../../../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
import { DebugTimeFormat } from '../debugTimeFormat'
import { RateDebugFixtures } from './fixtures/rateDebugFixtures'
import { type RateDebugInput, RateDebugModel } from './rateDebugModel'

describe('app-client-ui/renderer/debugWindow/sections/rate/rateDebugModel', () => {
  it('opens holding nothing and asking for nothing', () => {
    expect(RateDebugModel.initial()).toEqual({ status: null, refreshing: false, problem: null })
  })

  it('reads on being told to, and takes the status that comes back', () => {
    const asked = RateDebugModel.transition(RateDebugModel.initial(), { input: 'load' })
    expect(asked.effects).toEqual([{ effect: 'load' }])

    const status = RateDebugFixtures.status()
    const arrived = RateDebugModel.transition(asked.state, { input: 'status-arrived', status })
    expect(arrived.state.status).toBe(status)
    expect(arrived.effects).toEqual([])
  })

  // The floor lives in the main process, so a second refresh would answer with what is already there
  // and the button would look as though it had done something.
  it('does not ask for a second refresh while one is still out', () => {
    const asked = RateDebugModel.transition(RateDebugModel.initial(), { input: 'refresh-asked' })
    expect(asked.effects).toEqual([{ effect: 'refresh' }])
    expect(asked.state.refreshing).toBe(true)
    expect(RateDebugModel.transition(asked.state, { input: 'refresh-asked' }).effects).toEqual([])
  })

  // A refresh answers with a snapshot, and the attempt times this screen is about are not in one.
  it('reads the status again once a refresh comes back', () => {
    const asked = RateDebugModel.transition(RateDebugModel.initial(), { input: 'refresh-asked' })
    const answered = RateDebugModel.transition(asked.state, { input: 'refresh-answered' })
    expect(answered.state.refreshing).toBe(false)
    expect(answered.effects).toEqual([{ effect: 'load' }])
  })

  it('keeps what failed until the next refresh is asked for', () => {
    const failed = RateDebugModel.transition(
      RateDebugModel.initial(),
      { input: 'failed', detail: 'The main process did not answer: the channel is gone' },
    )
    expect(failed.state.problem).toBe('The main process did not answer: the channel is gone')
    expect(failed.state.refreshing).toBe(false)

    expect(RateDebugModel.transition(failed.state, { input: 'refresh-asked' }).state.problem)
      .toBeNull()
  })

  it('throws on an input it does not know', () => {
    expect(() => RateDebugModel.transition(
      RateDebugModel.initial(),
      { input: 'stop-monitor' } as unknown as RateDebugInput,
    )).toThrow(/Unknown rate debug input/)
  })

  it('says the state and, whenever there is one, the reason', () => {
    expect(RateDebugModel.stateLineOf({ kind: 'ok', fetchedAt: 1, windows: [] })).toBe('ok')
    expect(RateDebugModel.stateLineOf({
      kind: 'stale',
      fetchedAt: 1,
      windows: [],
      reason: 'OAuth token expired',
    })).toBe('stale - OAuth token expired')
    expect(RateDebugModel.stateLineOf({
      kind: 'unconfigured',
      reason: 'codex is not installed',
    })).toBe('unconfigured - codex is not installed')
    expect(RateDebugModel.stateLineOf({ kind: 'never-read' })).toBe('never read')

    expect(() => RateDebugModel.stateLineOf({ kind: 'gone' } as unknown as RateProviderState))
      .toThrow(/Unknown rate provider state/)
  })

  // Every window the API answered with, model-scoped ones included: the widget's reduction is the
  // widget's, and this screen is where the ones it leaves out are looked for.
  it('hands over every window a state carries, and none where a state carries none', () => {
    const claude = RateDebugFixtures.claude()
    expect(RateDebugModel.windowsOf(claude.state).map((window) => window.model ?? 'any'))
      .toEqual(['any', 'any', 'opus', 'sonnet'])

    expect(RateDebugModel.windowsOf({ kind: 'unconfigured', reason: 'no codex' })).toEqual([])
    expect(RateDebugModel.windowsOf({ kind: 'never-read' })).toEqual([])

    expect(() => RateDebugModel.windowsOf({ kind: 'gone' } as unknown as RateProviderState))
      .toThrow(/Unknown rate provider state/)
  })

  it('draws a window as its length, its model, what is gone and when it comes back', () => {
    const [length, model, used, resets] = RateDebugModel.windowRowOf({
      durationMinutes: 10_080,
      usedPercent: 61,
      resetsAt: null,
      model: 'opus',
    })
    expect(length).toBe('10080 min (7d)')
    expect(model).toBe('opus')
    expect(used).toBe('61%')
    expect(resets).toBe('—')

    expect(RateDebugModel.windowRowOf({ durationMinutes: 300, usedPercent: 42, resetsAt: null })[0])
      .toBe('300 min (5h)')
    expect(RateDebugModel.windowRowOf({ durationMinutes: 300, usedPercent: 42, resetsAt: null })[1])
      .toBe('any')
  })

  // Both directions, because the reading that matters most is the one taken after the token is gone.
  it('says when the token runs out and how far away that is, either side of now', () => {
    const now = RateDebugFixtures.nowConst
    expect(RateDebugModel.expiryLineOf(now + 42 * 60_000, now)).toContain('expires in 42m 0s')
    expect(RateDebugModel.expiryLineOf(now - 3 * 60_000, now)).toContain('expired 3m 0s ago')
    expect(RateDebugModel.expiryLineOf(now + 90 * 60_000, now)).toContain('expires in 1h 30m')
    // Codex has no OAuth token at all, and a dash says that without inventing a reading.
    expect(RateDebugModel.expiryLineOf(null, now)).toBe('—')
  })

  // The gap between the two is the whole reason to open this screen; one "last updated" would hide it.
  it('keeps the last attempt and the last success apart', () => {
    const facts = RateDebugModel.providerFactsOf(
      RateDebugFixtures.claude(),
      RateDebugFixtures.nowConst,
    )
    const read = new Map(facts)
    expect(read.get('Last attempt')).toContain('20s ago')
    expect(read.get('Last success')).toContain('15m 0s ago')
    expect(read.get('State')).toBe('stale - OAuth token expired; the running Claude Code refreshes it')

    const never = new Map(RateDebugModel.providerFactsOf(
      RateDebugFixtures.codex({ lastAttemptAt: null, lastSuccessAt: null }),
      RateDebugFixtures.nowConst,
    ))
    expect(never.get('Last attempt')).toBe('never')
    expect(never.get('Last success')).toBe('never')
    expect(never.get('Last reason')).toBe('none')
  })

  it('reads the poll facts the monitor stamped on the status', () => {
    expect(RateDebugModel.pollFactsOf(RateDebugFixtures.status())).toEqual([
      ['A window is visible', 'yes'],
      ['Cadence', '600000 ms'],
      ['Claude floor', '180000 ms'],
      ['Composed at', DebugTimeFormat.at(RateDebugFixtures.nowConst)],
    ])
  })

  it('turns the extras into facts, and answers an empty list with an empty one', () => {
    expect(RateDebugModel.extraFactsOf(RateDebugFixtures.claude().extras))
      .toEqual([['Extra usage', '$12.40 of $50.00 used']])
    expect(RateDebugModel.extraFactsOf([])).toEqual([])
  })

  // The buckets the mapper skips are the reason the block exists, so the body is printed whole.
  it('prints the whole payload, including the buckets nothing maps', () => {
    const printed = RateDebugModel.rawOf(RateDebugFixtures.claude().raw)

    expect(printed).toContain('"five_hour"')
    expect(printed).toContain('"extra_usage"')
    expect(printed).toContain('"nimbus_quill"')
    expect(printed).toContain('"member_dashboard_available": false')
  })

  it('says so rather than printing null when nothing has been read', () => {
    expect(RateDebugModel.rawOf(null)).toBe('nothing has been read yet')
    expect(RateDebugModel.rawOf(undefined)).toBe('nothing has been read yet')
  })

  it('names the two providers and throws on anyone else', () => {
    expect(RateDebugModel.titleOf('claude')).toBe('Claude')
    expect(RateDebugModel.titleOf('codex')).toBe('Codex')
    expect(() => RateDebugModel.titleOf('gemini' as unknown as RateAgentId))
      .toThrow(/Unknown rate agent/)
  })
})
