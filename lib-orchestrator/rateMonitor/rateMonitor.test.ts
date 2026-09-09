import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  type RateLimitSource,
  RateMonitor,
  type RateSourceHooks,
  type RateSourceReading,
} from './rateMonitor'
import type { RateAgentId, RateWindow } from './rateMonitorApi.types'

describe('lib-orchestrator/rateMonitor/rateMonitor', () => {
  const pollMillisecondsConst = 600_000
  const claudeFloorMillisecondsConst = 180_000
  const startClockConst = 1_000_000
  const created: string[] = []

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function cacheFile(): string {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-rate-monitor-'))
    created.push(directory)
    return join(directory, 'rate-monitor-cache.json')
  }

  function rateWindow(durationMinutes: number, usedPercent: number): RateWindow {
    return { durationMinutes, usedPercent, resetsAt: null }
  }

  function okReading(windows: readonly RateWindow[]): RateSourceReading {
    return { kind: 'ok', windows, extras: [], raw: { windows }, oauthExpiresAt: null }
  }

  interface Fake {
    readonly source: RateLimitSource
    reads: number
    stops: number
    reading: RateSourceReading
    /** While true a read hangs, which is what a second caller has to be handed the promise of. */
    gated: boolean
    release: () => void
  }

  function fakeSource(agentId: RateAgentId, windows: readonly RateWindow[]): Fake {
    let open: (() => void) | null = null
    const fake: Fake = {
      reads: 0,
      stops: 0,
      reading: okReading(windows),
      gated: false,
      release: () => {
        open?.()
        open = null
      },
      source: {
        agentId,
        async read(): Promise<RateSourceReading> {
          fake.reads += 1
          if (fake.gated) await new Promise<void>((resolve) => { open = resolve })
          return fake.reading
        },
        stop(): void {
          fake.stops += 1
        },
      },
    }
    return fake
  }

  interface Harness {
    rate: RateMonitor
    claude: Fake
    codex: Fake
    hooks: RateSourceHooks
    /** The revision handed out with each `onChanged`, so both the count and the value are readable. */
    changes: number[]
    errors: string[]
    /** Moves the injected clock and the timers together: the two must never drift apart. */
    elapse: (milliseconds: number) => Promise<void>
  }

  function harness(options: { cacheFile?: string; startedAt?: number } = {}): Harness {
    let clock = options.startedAt ?? startClockConst
    let captured: RateSourceHooks | undefined
    const claude = fakeSource('claude', [rateWindow(300, 40)])
    const codex = fakeSource('codex', [rateWindow(300, 10)])
    const changes: number[] = []
    const errors: string[] = []
    const rate = new RateMonitor({
      configIdentity: 'identity-a',
      channel: 'development',
      onChanged: () => changes.push(rate.snapshot().revision),
      onError: (message) => errors.push(message),
      sources: (hooks) => {
        captured = hooks
        return [claude.source, codex.source]
      },
      cacheFile: options.cacheFile ?? cacheFile(),
      now: () => clock,
    })
    if (captured === undefined) throw new Error('the monitor never asked for its sources')
    return {
      rate,
      claude,
      codex,
      hooks: captured,
      changes,
      errors,
      elapse: async (milliseconds) => {
        clock += milliseconds
        await vi.advanceTimersByTimeAsync(milliseconds)
      },
    }
  }

  it('reads nothing while nothing is visible, and every provider the moment something is', async () => {
    const context = harness()
    await context.rate.start()
    await context.elapse(pollMillisecondsConst * 2)
    expect([context.claude.reads, context.codex.reads]).toEqual([0, 0])

    context.rate.setWindowVisible(true)
    await context.elapse(0)

    expect([context.claude.reads, context.codex.reads]).toEqual([1, 1])
    expect(context.rate.snapshot().providers.claude).toEqual({
      kind: 'ok',
      fetchedAt: startClockConst + pollMillisecondsConst * 2,
      windows: [rateWindow(300, 40)],
    })
  })

  // A client builds its windows before it starts this, so the visibility arrives while there is
  // nothing to arm yet. Taken up only on the next change, the poll would wait for a window to be
  // hidden and shown again before it ever ran.
  it('takes up a visibility it was told about before it was started', async () => {
    const context = harness()
    context.rate.setWindowVisible(true)
    await context.elapse(0)
    expect([context.claude.reads, context.codex.reads]).toEqual([0, 0])

    await context.rate.start()
    await context.elapse(0)
    expect([context.claude.reads, context.codex.reads]).toEqual([1, 1])

    await context.elapse(pollMillisecondsConst)
    expect([context.claude.reads, context.codex.reads]).toEqual([2, 2])
  })

  it('polls on the interval while visible and stops the moment nothing is', async () => {
    const context = harness()
    await context.rate.start()
    context.rate.setWindowVisible(true)
    await context.elapse(0)

    await context.elapse(pollMillisecondsConst)
    expect([context.claude.reads, context.codex.reads]).toEqual([2, 2])

    context.rate.setWindowVisible(false)
    await context.elapse(pollMillisecondsConst * 3)
    expect([context.claude.reads, context.codex.reads]).toEqual([2, 2])
  })

  // Showing a window is not a reason to ask the same question again: only what one interval has left
  // behind is read, and everything else is still what the last round said.
  it('reads only the provider whose last success is older than the interval when a window returns', async () => {
    const context = harness()
    await context.rate.start()
    context.rate.setWindowVisible(true)
    await context.elapse(0)
    expect([context.claude.reads, context.codex.reads]).toEqual([1, 1])

    // Codex pushes late in the interval and is answered on the spot, so only Claude's answer ages out.
    await context.elapse(pollMillisecondsConst - 100_000)
    context.hooks.nudge('codex')
    await context.elapse(0)
    context.rate.setWindowVisible(false)
    await context.elapse(100_001)

    context.rate.setWindowVisible(true)
    await context.elapse(0)

    expect([context.claude.reads, context.codex.reads]).toEqual([2, 2])
  })

  // Nothing while hidden means nothing, and a push that arrives then is still the provider saying its
  // own answer moved: it is held and spent on the way back, however fresh that answer looks by age.
  it('holds a push arriving while hidden and reads that provider when a window returns', async () => {
    const context = harness()
    await context.rate.start()
    context.rate.setWindowVisible(true)
    await context.elapse(0)
    context.rate.setWindowVisible(false)

    context.hooks.nudge('codex')
    await context.elapse(0)
    expect([context.claude.reads, context.codex.reads]).toEqual([1, 1])

    context.rate.setWindowVisible(true)
    await context.elapse(0)

    // Codex because it pushed, Claude not at all: its last answer is still inside the interval.
    expect([context.claude.reads, context.codex.reads]).toEqual([1, 2])
  })

  it('holds Claude to one attempt per floor, manual refresh included, and never holds Codex', async () => {
    const context = harness()
    await context.rate.start()
    context.rate.setWindowVisible(true)
    await context.elapse(0)

    await context.rate.refresh()
    expect([context.claude.reads, context.codex.reads]).toEqual([1, 2])

    await context.elapse(claudeFloorMillisecondsConst)
    await context.rate.refresh()
    expect([context.claude.reads, context.codex.reads]).toEqual([2, 3])
  })

  // A failed attempt still counts: a run of failures must not turn into a run of requests.
  it('measures the Claude floor from the attempt and not from the success', async () => {
    const context = harness()
    context.claude.reading = { kind: 'failed', reason: 'refused', oauthExpiresAt: null }
    await context.rate.start()
    context.rate.setWindowVisible(true)
    await context.elapse(0)
    expect(context.claude.reads).toBe(1)

    await context.elapse(claudeFloorMillisecondsConst - 1)
    await context.rate.refresh()
    expect(context.claude.reads).toBe(1)
  })

  it('nudges one provider only, and drops a second push inside the floor', async () => {
    const context = harness()
    await context.rate.start()
    context.rate.setWindowVisible(true)
    await context.elapse(0)
    expect([context.claude.reads, context.codex.reads]).toEqual([1, 1])

    context.codex.gated = true
    context.hooks.nudge('codex')
    context.hooks.nudge('codex')
    await context.elapse(0)
    // One read for two pushes, and Claude's cadence is untouched by somebody else's notification.
    expect([context.claude.reads, context.codex.reads]).toEqual([1, 2])

    context.codex.release()
    await context.elapse(0)
    expect(context.rate.snapshot().providers.codex).toMatchObject({ kind: 'ok' })
  })

  /*
   * A push that arrives while a read is ALREADY OUT is about something that read cannot know: it
   * left for the server before the change happened, so it answers with the state from before it.
   * Merged into that read, the notification was counted as served and the floor then blocked a fresh
   * one for another five seconds - so the bar held the old percentage for up to a whole poll
   * interval, in exactly the situation the push exists for.
   */
  it('reads again for a push that arrived after the running read had left', async () => {
    const context = harness()
    await context.rate.start()
    context.rate.setWindowVisible(true)
    await context.elapse(0)
    expect(context.codex.reads).toBe(1)

    // The POLL's own read, on its way to the server. It left before the push below happened, so it
    // answers with the state from before it.
    context.codex.gated = true
    await context.elapse(pollMillisecondsConst)
    expect(context.codex.reads).toBe(2)

    context.hooks.nudge('codex')
    await context.elapse(0)
    // Merged, which is right for two pushes and wrong for this one.
    expect(context.codex.reads).toBe(2)

    context.codex.gated = false
    context.codex.release()
    await context.elapse(0)

    // The repeat, once the read that could not know about the push has landed.
    expect(context.codex.reads).toBe(3)
    // And exactly once: nothing chains a fourth read behind it.
    await context.elapse(0)
    expect(context.codex.reads).toBe(3)
  })

  /*
   * The push that caused the repeat is served BY the repeat, so the floor it set is spent. Left
   * standing, the next push - about something the repeat's own read could not know either - would be
   * dropped for five more seconds.
   */
  it('takes a push arriving right after the repeat it caused', async () => {
    const context = harness()
    await context.rate.start()
    context.rate.setWindowVisible(true)
    await context.elapse(0)

    context.codex.gated = true
    await context.elapse(pollMillisecondsConst)
    context.hooks.nudge('codex')
    await context.elapse(0)
    context.codex.gated = false
    context.codex.release()
    await context.elapse(0)
    const afterRepeat = context.codex.reads

    // Inside the nudge floor, and still taken: the floor belonged to a push already served.
    context.hooks.nudge('codex')
    await context.elapse(0)

    expect(context.codex.reads).toBe(afterRepeat + 1)
  })

  it('does not repeat a read for a push that started one of its own', async () => {
    const context = harness()
    await context.rate.start()
    context.rate.setWindowVisible(true)
    await context.elapse(0)

    context.codex.gated = true
    context.hooks.nudge('codex')
    await context.elapse(0)
    context.codex.gated = false
    context.codex.release()
    await context.elapse(0)

    // One read for the push, and no repeat: nothing arrived while it was out.
    expect(context.codex.reads).toBe(2)
  })

  // The merge itself, which the test above cannot show: its second push is stopped by the floor
  // rather than by the single-flight, so the whole of `readProvider`'s in-flight map could be
  // deleted with every case here still green. This is the one thing that keeps a click on the
  // widget during the poll's own read from costing the endpoint a second request.
  it('hands a caller arriving mid-read the read already out, rather than starting another', async () => {
    const context = harness()
    await context.rate.start()
    context.rate.setWindowVisible(true)
    await context.elapse(0)

    context.codex.gated = true
    context.hooks.nudge('codex')
    await context.elapse(0)
    expect(context.codex.reads).toBe(2)

    // Past the push floor, so nothing but the merge can stop this one reaching the source.
    await context.elapse(6_000)
    const refreshed = context.rate.refresh()
    await context.elapse(0)
    expect(context.codex.reads).toBe(2)

    context.codex.release()
    await refreshed
    expect(context.codex.reads).toBe(2)
  })

  // Every read merges into one while it is out; nothing merges two that are seconds apart. If a read
  // is ever what makes the server push again, the two feed each other with no ceiling at all.
  it('bounds the reads one provider\'s pushes can set off, without touching the cadence', async () => {
    const context = harness()
    await context.rate.start()
    context.rate.setWindowVisible(true)
    await context.elapse(0)
    expect(context.codex.reads).toBe(1)

    context.hooks.nudge('codex')
    await context.elapse(0)
    expect(context.codex.reads).toBe(2)

    // The read has settled, so nothing merges this one: only the floor can hold it.
    await context.elapse(1_000)
    context.hooks.nudge('codex')
    await context.elapse(0)
    expect(context.codex.reads).toBe(2)

    await context.elapse(5_000)
    context.hooks.nudge('codex')
    await context.elapse(0)
    expect(context.codex.reads).toBe(3)
  })

  it('keeps the last good windows through a failure, and answers an empty stale before the first success', async () => {
    const context = harness()
    context.claude.reading = { kind: 'failed', reason: 'no answer', oauthExpiresAt: null }
    await context.rate.start()
    context.rate.setWindowVisible(true)
    await context.elapse(0)

    expect(context.rate.snapshot().providers.claude)
      .toEqual({ kind: 'stale', fetchedAt: null, windows: [], reason: 'no answer' })

    context.codex.reading = { kind: 'failed', reason: 'the child died', oauthExpiresAt: null }
    await context.elapse(pollMillisecondsConst)

    expect(context.rate.snapshot().providers.codex).toEqual({
      kind: 'stale',
      fetchedAt: startClockConst,
      windows: [rateWindow(300, 10)],
      reason: 'the child died',
    })
  })

  // On a machine without one of the two agents this is every poll it will ever make, and each one
  // would otherwise wake every window with the same answer.
  it('moves neither the revision nor the callback for a provider answering the same nothing', async () => {
    const context = harness()
    const unconfigured: RateSourceReading =
      { kind: 'unconfigured', reason: 'codex is not installed', oauthExpiresAt: null }
    context.claude.reading = unconfigured
    context.codex.reading = unconfigured
    await context.rate.start()
    context.rate.setWindowVisible(true)
    await context.elapse(0)

    const settled = context.rate.snapshot().revision
    const emitted = context.changes.length
    await context.elapse(pollMillisecondsConst)
    await context.elapse(pollMillisecondsConst)

    expect([context.claude.reads, context.codex.reads]).toEqual([3, 3])
    expect(context.rate.snapshot().revision).toBe(settled)
    expect(context.changes.length).toBe(emitted)
  })

  it('writes each success to the cache and hydrates from it, honest about when it was read', async () => {
    const file = cacheFile()
    const first = harness({ cacheFile: file })
    await first.rate.start()
    first.rate.setWindowVisible(true)
    await first.elapse(0)

    const second = harness({ cacheFile: file, startedAt: startClockConst + pollMillisecondsConst })
    await second.rate.start()

    expect(second.rate.snapshot().providers.claude)
      .toEqual({ kind: 'ok', fetchedAt: startClockConst, windows: [rateWindow(300, 40)] })
    expect(second.changes).toEqual([2])
  })

  // The restart loop of a development session must not spend a request against an endpoint that
  // counts them, when the answer on disk is younger than the cadence would have asked at anyway.
  it('skips the first read while the cache is younger than the interval, and reads on the next tick', async () => {
    const file = cacheFile()
    const first = harness({ cacheFile: file })
    await first.rate.start()
    first.rate.setWindowVisible(true)
    await first.elapse(0)

    const second = harness({ cacheFile: file, startedAt: startClockConst + 1_000 })
    await second.rate.start()
    second.rate.setWindowVisible(true)
    await second.elapse(0)
    expect([second.claude.reads, second.codex.reads]).toEqual([0, 0])

    await second.elapse(pollMillisecondsConst)
    expect([second.claude.reads, second.codex.reads]).toEqual([1, 1])
  })

  // The development restart loop against an endpoint that is currently refusing. A run of failures
  // stores no windows at all, so the attempt is the only thing that can carry the floor across a
  // start - and without it every restart spends the request the floor exists to hold back.
  it('holds the Claude floor across a restart on which nothing ever succeeded', async () => {
    const file = cacheFile()
    const refused: RateSourceReading = { kind: 'failed', reason: 'refused', oauthExpiresAt: null }
    const first = harness({ cacheFile: file })
    first.claude.reading = refused
    await first.rate.start()
    first.rate.setWindowVisible(true)
    await first.elapse(0)
    expect(first.claude.reads).toBe(1)

    const second = harness({ cacheFile: file, startedAt: startClockConst + 1_000 })
    second.claude.reading = refused
    await second.rate.start()
    second.rate.setWindowVisible(true)
    await second.elapse(0)
    await second.rate.refresh()

    expect(second.claude.reads).toBe(0)
    expect(second.rate.debugStatus().providers.claude.lastAttemptAt).toBe(startClockConst)

    await second.elapse(claudeFloorMillisecondsConst)
    await second.rate.refresh()
    expect(second.claude.reads).toBe(1)
  })

  it('writes the attempt of a failed read without disturbing the windows it still has', async () => {
    const file = cacheFile()
    const first = harness({ cacheFile: file })
    await first.rate.start()
    first.rate.setWindowVisible(true)
    await first.elapse(0)
    first.claude.reading = { kind: 'failed', reason: 'refused', oauthExpiresAt: null }
    await first.elapse(pollMillisecondsConst)

    const second = harness({
      cacheFile: file,
      startedAt: startClockConst + pollMillisecondsConst + 1,
    })
    await second.rate.start()

    expect(second.rate.snapshot().providers.claude)
      .toEqual({ kind: 'ok', fetchedAt: startClockConst, windows: [rateWindow(300, 40)] })
    expect(second.rate.debugStatus().providers.claude.lastAttemptAt)
      .toBe(startClockConst + pollMillisecondsConst)
  })

  it('treats an unreadable cache as no cache, without a word about it', async () => {
    const file = cacheFile()
    writeFileSync(file, 'not json', 'utf8')
    const context = harness({ cacheFile: file })

    await context.rate.start()

    expect(context.errors).toEqual([])
    expect(context.rate.snapshot().providers.claude).toEqual({ kind: 'never-read' })
    context.rate.setWindowVisible(true)
    await context.elapse(0)
    expect(context.rate.snapshot().providers.claude).toMatchObject({ kind: 'ok' })
  })

  // The two timestamps agree until something goes wrong, and their gap is what says how long a
  // provider has been failing - the one fact the reduced state deliberately cannot carry.
  it('shows the attempt and the success drifting apart, and has nowhere to put a credential', async () => {
    const context = harness()
    context.claude.reading = okReading([rateWindow(300, 40)])
    await context.rate.start()
    context.rate.setWindowVisible(true)
    await context.elapse(0)

    context.claude.reading =
      { kind: 'failed', reason: 'the OAuth token expired', oauthExpiresAt: 4_242 }
    await context.elapse(pollMillisecondsConst)

    const status = context.rate.debugStatus()
    expect(status.poll).toEqual({
      windowVisible: true,
      cadenceMilliseconds: pollMillisecondsConst,
      claudeFloorMilliseconds: claudeFloorMillisecondsConst,
    })
    expect(status.providers.claude.lastAttemptAt).toBe(startClockConst + pollMillisecondsConst)
    expect(status.providers.claude.lastSuccessAt).toBe(startClockConst)
    expect(status.providers.claude.lastReason).toBe('the OAuth token expired')
    expect(status.providers.claude.oauthExpiresAt).toBe(4_242)
    expect(Object.keys(status.providers.claude).sort()).toEqual([
      'extras',
      'lastAttemptAt',
      'lastReason',
      'lastSuccessAt',
      'oauthExpiresAt',
      'raw',
      'state',
    ])
  })

  // Both mappers answer an empty list for a body whose shape moved, so an `ok` is not proof that
  // anything was read. Taken as authoritative it wipes the numbers out of memory and out of the
  // cache file in one step, and the restart afterwards hydrates the same nothing.
  it('keeps the last windows when a successful read carries none', async () => {
    const context = harness()
    await context.rate.start()
    context.rate.setWindowVisible(true)
    await context.elapse(0)

    context.claude.reading = okReading([])
    await context.elapse(pollMillisecondsConst)

    expect(context.rate.snapshot().providers.claude).toEqual({
      kind: 'ok',
      fetchedAt: startClockConst,
      windows: [rateWindow(300, 40)],
    })
  })

  // A clock corrected backwards, or a cache file carried over from a machine that was ahead. Every
  // gate subtracts these from now, so a future one never elapses: Claude is floored for good and no
  // provider is ever due again, while the tooltip reports the numbers as read moments ago.
  it('drops a cached attempt and a cached success that are ahead of the clock', async () => {
    const file = cacheFile()
    writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      savedAt: startClockConst,
      providers: {
        claude: {
          fetchedAt: startClockConst + pollMillisecondsConst,
          windows: [rateWindow(300, 90)],
          extras: [],
        },
      },
      attempts: { claude: startClockConst + pollMillisecondsConst },
    }), 'utf8')

    const context = harness({ cacheFile: file })
    await context.rate.start()
    context.rate.setWindowVisible(true)
    await context.elapse(0)

    expect(context.claude.reads).toBe(1)
    expect(context.rate.snapshot().providers.claude).toEqual({
      kind: 'ok',
      fetchedAt: startClockConst,
      windows: [rateWindow(300, 40)],
    })
  })

  // `stop()` ends the provider sources for good, so a monitor that came back up would hold a Codex
  // client that answers a failure to everything. Better said out loud than drawn as a dead provider.
  it('refuses to start again once it has been stopped', async () => {
    const context = harness()
    await context.rate.start()
    context.rate.stop()

    await expect(context.rate.start()).rejects.toThrow('A stopped rate monitor cannot be started again')
    context.rate.setWindowVisible(true)
    await context.elapse(pollMillisecondsConst * 2)
    expect([context.claude.reads, context.codex.reads]).toEqual([0, 0])
  })

  it('stops the timer and the sources, and stopping twice costs the sources one stop', async () => {
    const context = harness()
    await context.rate.start()
    context.rate.setWindowVisible(true)
    await context.elapse(0)

    context.rate.stop()
    context.rate.stop()
    await context.elapse(pollMillisecondsConst * 2)

    expect([context.claude.stops, context.codex.stops]).toEqual([1, 1])
    expect([context.claude.reads, context.codex.reads]).toEqual([1, 1])
  })

  it('reports a source that broke the contract and throws, without losing the poll', async () => {
    const context = harness()
    await context.rate.start()
    context.claude.source.read = () => Promise.reject(new Error('the source threw'))
    context.rate.setWindowVisible(true)
    await context.elapse(0)

    expect(context.errors).toEqual(['Reading the claude rate limits threw: the source threw'])
    expect(context.rate.snapshot().providers.claude)
      .toEqual({ kind: 'stale', fetchedAt: null, windows: [], reason: 'the source threw' })
    expect(context.rate.snapshot().providers.codex).toMatchObject({ kind: 'ok' })
  })
})
