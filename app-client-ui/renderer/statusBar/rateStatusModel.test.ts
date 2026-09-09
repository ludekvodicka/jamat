import { describe, expect, it } from 'vitest'

import type {
  RateMonitorSnapshot,
  RateProviderState,
  RateWindow,
} from '../../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
import { RateStatusModel } from './rateStatusModel'

describe('app-client-ui/renderer/statusBar/rateStatusModel', () => {
  class Rates {
    static readonly nowConst = Date.parse('2026-08-17T12:00:00.000Z')

    /** What a full Claude answer looks like: two plain windows and two scoped to a model. */
    static windows(): readonly RateWindow[] {
      return [
        {
          durationMinutes: 300,
          usedPercent: 41.6,
          resetsAt: '2026-08-17T14:15:00.000Z',
        },
        { durationMinutes: 10_080, usedPercent: 12, resetsAt: null },
        { durationMinutes: 10_080, usedPercent: 87, resetsAt: null, model: 'opus' },
        { durationMinutes: 10_080, usedPercent: 3, resetsAt: null, model: 'sonnet' },
      ]
    }

    static ok(windows: readonly RateWindow[] = Rates.windows()): RateProviderState {
      return { kind: 'ok', fetchedAt: Rates.nowConst - 5 * 60_000, windows }
    }

    static snapshot(
      claude: RateProviderState,
      codex: RateProviderState = { kind: 'never-read' },
    ): RateMonitorSnapshot {
      return { revision: 7, providers: { claude, codex } }
    }

    static letters(state: RateProviderState): string[] {
      return RateStatusModel.segmentsOf(state).map((segment) => segment.letter)
    }
  }

  /**
   * The whole reduction the bar performs, and the change of narrowing to one provider: every window
   * the answer carried gets a segment, the model-scoped weeklies included. Under two providers they
   * lived in the tooltip, which is the one place a user who is out of opus cannot see them.
   */
  it('draws every window the answer carried, the model-scoped ones after the plain ones', () => {
    const reading = RateStatusModel.readingOf(
      Rates.snapshot(Rates.ok()),
      'claude',
      Rates.nowConst,
    )

    expect(reading.text).toBe([
      'S: 42% [████░░░░░░]',
      'W: 12% [█░░░░░░░░░]',
      'O: 87% [█████████░]',
      'So:  3% [░░░░░░░░░░]',
    ].join(', '))
    expect(reading.dim).toBe(false)
    expect(reading.name).toBe('Claude')
    expect(reading.tooltip).toBe([
      'Claude usage · read 5m 0s ago',
      'Session 42% · resets in 2h 15m',
      'Weekly 12%',
      'Weekly (opus) 87%',
      'Weekly (sonnet) 3%',
    ].join('\n'))
  })

  /**
   * The two plain windows are matched on their duration and on carrying no model, never on their
   * position: reading them off 0 and 1 would letter the opus weekly `S` the day a provider reorders
   * its answer. A scoped weekly whose initial is already taken takes a second character instead.
   */
  it('letters the plain windows first whatever order they arrive in', () => {
    expect(Rates.letters(Rates.ok())).toEqual(['S', 'W', 'O', 'So'])
    expect(Rates.letters(Rates.ok([...Rates.windows()].reverse())))
      .toEqual(['S', 'W', 'So', 'O'])
  })

  // The meter is a strip of text rather than a drawn bar, so its width is the thing to hold.
  it('draws a meter of exactly ten cells whatever the number is', () => {
    const meters = [0, 7, 42, 100].map((usedPercent) =>
      RateStatusModel.segmentTextOf({ letter: 'S', usedPercent }))

    expect(meters).toEqual([
      'S:  0% [░░░░░░░░░░]',
      'S:  7% [█░░░░░░░░░]',
      'S: 42% [████░░░░░░]',
      'S: 100% [██████████]',
    ])
    for (const meter of meters)
      expect(meter.slice(meter.indexOf('[') + 1, meter.indexOf(']'))).toHaveLength(10)
  })

  // A window that is not there is not drawn: a weekly-only answer is a normal answer.
  it('draws only what the answer carried', () => {
    const reading = RateStatusModel.readingOf(
      Rates.snapshot(Rates.ok([{ durationMinutes: 10_080, usedPercent: 12, resetsAt: null }])),
      'claude',
      Rates.nowConst,
    )

    expect(reading.text).toBe('W: 12% [█░░░░░░░░░]')
    expect(reading.dim).toBe(false)
  })

  /**
   * Answered, and there is nothing in it. V1's shape: the letters stand and the numbers are a
   * question mark, so a reading that says nothing still says WHICH nothing, and the widget does not
   * change size when the numbers finally arrive. Both letters for both providers: Codex reports its
   * own five-hour window too, so giving it one letter made the widget reflow on the first answer.
   */
  it('keeps a letter per window a provider answers with and drops only the number', () => {
    const empty = RateStatusModel.readingOf(Rates.snapshot(Rates.ok([])), 'claude', Rates.nowConst)
    const unread = RateStatusModel.readingOf(
      Rates.snapshot(Rates.ok(), { kind: 'never-read' }),
      'codex',
      Rates.nowConst,
    )

    expect(empty.text).toBe('S:? W:?')
    expect(empty.dim).toBe(true)
    expect(unread.text).toBe('S:? W:?')
    expect(unread.dim).toBe(true)
    expect(unread.tooltip).toBe('Codex usage has not been read yet')
  })

  // A duration this bar has no letter for is still a number somebody is measured by. Dropped, it
  // fell through to the placeholder, so a provider on 87 percent of a daily cap read as "not read".
  it('draws a window of an unfamiliar length by its own length rather than dropping it', () => {
    const reading = RateStatusModel.readingOf(
      Rates.snapshot(Rates.ok([{ durationMinutes: 1_440, usedPercent: 87, resetsAt: null }])),
      'claude',
      Rates.nowConst,
    )

    expect(reading.text).toContain('24h: 87%')
    expect(reading.dim).toBe(false)
  })

  it('stands a placeholder where there is no provider at all and says why in the tooltip', () => {
    const reading = RateStatusModel.readingOf(
      Rates.snapshot(Rates.ok(), { kind: 'unconfigured', reason: 'codex is not installed' }),
      'codex',
      Rates.nowConst,
    )

    expect(reading.name).toBe('Codex')
    expect(reading.text).toBe('-')
    expect(reading.dim).toBe(true)
    expect(reading.tooltip).toBe('Codex usage is unavailable: codex is not installed')
  })

  /**
   * A failed read never destroys the last good windows: the same numbers stand, dimmed, and both the
   * reason and how old they are ride in the tooltip.
   */
  it('keeps the last good windows when a read failed and dates them', () => {
    const reading = RateStatusModel.readingOf(Rates.snapshot({
      kind: 'stale',
      fetchedAt: Rates.nowConst - 95 * 60_000,
      windows: [{ durationMinutes: 300, usedPercent: 42, resetsAt: null }],
      reason: 'OAuth token expired',
    }), 'claude', Rates.nowConst)

    expect(reading.dim).toBe(true)
    expect(reading.text).toBe('S: 42% [████░░░░░░]')
    expect(reading.tooltip).toBe([
      'Claude usage · OAuth token expired',
      'last read 1h 35m ago',
      'Session 42%',
    ].join('\n'))
  })

  it('says so plainly when a provider has never answered at all', () => {
    const reading = RateStatusModel.readingOf(Rates.snapshot({
      kind: 'stale',
      fetchedAt: null,
      windows: [],
      reason: 'HTTP 429',
    }), 'claude', Rates.nowConst)

    expect(reading.text).toBe('S:? W:?')
    expect(reading.tooltip).toBe('Claude usage · HTTP 429\nnever read successfully')
  })

  // One provider is asked for and one is answered: the other one's state is not this widget's.
  it('reads the provider it was asked for and nothing else out of the snapshot', () => {
    const snapshot = Rates.snapshot(Rates.ok(), Rates.ok([
      { durationMinutes: 10_080, usedPercent: 90, resetsAt: null },
    ]))

    expect(RateStatusModel.readingOf(snapshot, 'codex', Rates.nowConst).text)
      .toBe('W: 90% [█████████░]')
    expect(RateStatusModel.readingOf(snapshot, 'claude', Rates.nowConst).text)
      .not.toContain('90%')
  })

  // Claude publishes a page for its own limits and Codex publishes none: a link to nowhere is worse.
  it('sends only Claude to a usage page', () => {
    const snapshot = Rates.snapshot(Rates.ok(), Rates.ok())

    expect(RateStatusModel.readingOf(snapshot, 'claude', Rates.nowConst).usageUrl)
      .toBe('https://claude.ai/settings/usage')
    expect(RateStatusModel.readingOf(snapshot, 'codex', Rates.nowConst).usageUrl).toBe(null)
  })

  // Four states today, and the fifth one has to be taught rather than silently drawn as a fourth.
  it('refuses a provider state it was never taught', () => {
    const state = { kind: 'napping' } as unknown as RateProviderState

    expect(() => RateStatusModel.readingOf(Rates.snapshot(state), 'claude', Rates.nowConst))
      .toThrow('Unknown rate provider state in tooltipOf: {"kind":"napping"}')
    // The other two carry the same shape and used to carry the same words, so this assertion could
    // not tell which of the three had fired - and two of them could be deleted with it still green.
    expect(() => RateStatusModel.segmentsOf(state))
      .toThrow('Unknown rate provider state in windowsOf: {"kind":"napping"}')
  })

  it('holds the meter inside 0 and 100 whatever a provider reported', () => {
    const reading = RateStatusModel.readingOf(Rates.snapshot(Rates.ok([
      { durationMinutes: 300, usedPercent: 140, resetsAt: null },
      { durationMinutes: 10_080, usedPercent: -4, resetsAt: null },
    ])), 'claude', Rates.nowConst)

    expect(reading.text).toBe('S: 100% [██████████], W:  0% [░░░░░░░░░░]')
  })
})
