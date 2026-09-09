import { SmokeHarness, SmokeRun } from './smokeHarness.js'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ClaudeCredentialsReading } from '../../lib-orchestrator/rateMonitor/claude/claudeCredentialsReader.js'
import { RateMonitor, type RateLimitSource } from '../../lib-orchestrator/rateMonitor/rateMonitor.js'
import { RateMonitorSources } from '../../lib-orchestrator/rateMonitor/rateMonitorSources.js'
import type {
  RateProviderState,
  RateWindow,
} from '../../lib-orchestrator/rateMonitor/rateMonitorApi.types.js'

/**
 * Whether Claude is read at all in this run, decided before anything is built. The token travels as a
 * value through one call and is never a field: it is here only so the sentinel below can prove that
 * what the Debug window would draw does not contain it.
 */
type ClaudeDecision =
  | { read: true; accessToken: string }
  | { read: false; reason: string }

/**
 * The rate monitor against the two real providers of this machine, which is the half no unit test can
 * have: a Codex process that is actually spawned, and an endpoint that actually answers.
 *
 * It drives the FACADE over the real sources rather than the sources alone, because two of the three
 * things being checked here are the facade's. What ends the Codex child is `RateMonitor.stop()` -
 * `AppHub.dispose` calls exactly that and nothing else - and what a surface would draw is the composed
 * `RateProviderState`, not the reading a source returned. The sources are handed in rather than left
 * to the facade for the one reason a smoke must own: WHETHER Claude is read is this file's decision,
 * and a provider not handed over is a provider not asked.
 *
 * Two endings are a skip and not a failure. A machine without Codex has nothing to read, and a Claude
 * login that is missing or expired would answer 401 - and this endpoint answers a client that asks too
 * often with a 429 that then stands, so a request already known to be wasted is never made.
 */
class SmokeRateMonitor extends SmokeHarness {
  /**
   * The Codex child is not `unref`ed: while it is up it holds this process up with it, which is the
   * whole point of the last check. After `stop()` the loop has to drain on its own, and this deadline
   * is what turns a hang into a failure instead of a smoke that never returns.
   */
  private static readonly exitDeadlineMillisecondsConst = 5_000
  /**
   * A minute rather than the source's own half of one: the smoke must never hand over a token the
   * source will then refuse, because that refusal would read as a failed provider rather than a skip.
   */
  private static readonly expiryMarginMillisecondsConst = 60_000

  private readonly cacheFile: string
  private readonly errors: string[] = []
  private skipped = 0
  private nudges = 0

  private constructor(root: string) {
    super()
    this.cacheFile = join(root, 'rate-monitor-cache.json')
  }

  static async run(): Promise<void> {
    const temporary = mkdtempSync(join(tmpdir(), 'jamat-v3-rate-monitor-smoke-'))
    const root = realpathSync.native(temporary)
    try { await new SmokeRateMonitor(root).execute() }
    finally { rmSync(temporary, { recursive: true, force: true }) }
  }

  private async execute(): Promise<void> {
    const decision = SmokeRateMonitor.claudeDecisionOf(
      await RateMonitorSources.credentials().read(),
      Date.now(),
    )
    if (!decision.read) this.skip(`Claude was not read: ${decision.reason}`)
    // Counted rather than acted on. In the client the push fires a read of Codex alone; here it
    // would turn one run into an unpredictable number of reads, and what it proves is that the child
    // is alive and talking, which the count says just as well.
    const codex = RateMonitorSources.codex({ nudge: () => { this.nudges += 1 } })
    const sources: readonly RateLimitSource[] = decision.read
      ? [codex, RateMonitorSources.claude()]
      : [codex]
    const monitor = new RateMonitor({
      configIdentity: 'rate-monitor-smoke',
      channel: 'development',
      onChanged: () => {},
      onError: (message) => { this.errors.push(message) },
      sources: () => sources,
      // A temporary file: this run must not write over what a client of this machine has cached, and
      // must not read a success of that client's as if it were its own.
      cacheFile: this.cacheFile,
    })

    await monitor.start()
    const started = monitor.snapshot()
    this.check('a start with no cache and nothing visible reads neither provider',
      started.providers.claude.kind === 'never-read'
      && started.providers.codex.kind === 'never-read'
      && this.errors.length === 0)
    const snapshot = await monitor.refresh()

    const codexState = snapshot.providers.codex
    if (codexState.kind === 'unconfigured')
      this.skip(`Codex was not read: ${codexState.reason}`)
    else this.checkProvider('Codex', codexState)
    if (decision.read) {
      this.checkProvider('Claude', snapshot.providers.claude)
      // The one seam a credential could cross. `RateProviderDebug` has no field for a token, so this
      // is the assertion that the type is telling the truth about the real file.
      this.check('nothing the Debug window would draw carries the OAuth access token',
        !JSON.stringify(monitor.debugStatus()).includes(decision.accessToken))
    }
    if (snapshot.providers.claude.kind === 'ok' || snapshot.providers.codex.kind === 'ok')
      this.check('what answered was written to the cache', existsSync(this.cacheFile))
    else this.skip('nothing was cached, because neither provider answered')
    this.check(`the run reported no errors (${this.errors.join(' | ')})`, this.errors.length === 0)

    monitor.stop()
    SmokeRateMonitor.armExitDeadline()
    console.log(`\nsmoke-rate-monitor: ${this.passed} checks passed, ${this.skipped} skipped, `
      + `${this.nudges} Codex push notifications seen`)
    console.log('  ..  stop() has been called; this process now has to exit on its own')
  }

  /**
   * Read from the credentials file and never from the endpoint: an expired token is worth no request,
   * and a machine logged in with an API key holds no OAuth token to spend at all.
   */
  private static claudeDecisionOf(reading: ClaudeCredentialsReading, now: number): ClaudeDecision {
    if (reading.kind === 'missing') return { read: false, reason: reading.reason }
    else if (reading.kind === 'ok') {
      const expiresAt = reading.expiresAt
      if (expiresAt !== null
        && expiresAt - SmokeRateMonitor.expiryMarginMillisecondsConst <= now)
        return {
          read: false,
          reason: `the OAuth token expired at ${new Date(expiresAt).toISOString()}, `
            + 'so a request would answer 401 and was not made',
        }
      return { read: true, accessToken: reading.accessToken }
    }
    else throw new Error('Unknown Claude credentials reading')
  }

  private checkProvider(name: string, state: RateProviderState): void {
    if (state.kind === 'ok') {
      this.check(`${name} answered ${state.windows.length} window(s), `
        + 'each over a real duration and inside 0 to 100 percent',
        state.windows.length > 0 && state.windows.every(SmokeRateMonitor.plausible))
      for (const window of state.windows) console.log(`      ${SmokeRateMonitor.lineOf(window)}`)
    }
    else if (state.kind === 'stale')
      throw new Error(`FAILED: ${name} could not be read: ${state.reason}`)
    else if (state.kind === 'unconfigured')
      throw new Error(`FAILED: ${name} answered unconfigured after being handed over: ${state.reason}`)
    else if (state.kind === 'never-read')
      throw new Error(`FAILED: ${name} was handed to the monitor and never read`)
    else
      throw new Error(`Unknown rate provider state: ${JSON.stringify(state)}`)
  }

  private static plausible(window: RateWindow): boolean {
    return window.durationMinutes > 0 && window.usedPercent >= 0 && window.usedPercent <= 100
  }

  private static lineOf(window: RateWindow): string {
    const label = window.model === undefined
      ? `${window.durationMinutes} min`
      : `${window.durationMinutes} min (${window.model})`
    return `${label}: ${window.usedPercent}% used, resets at ${window.resetsAt ?? 'unstated'}`
  }

  /**
   * The one check that cannot be an assertion: whether this process is free to end. It is `unref`ed so
   * that it is never itself the thing keeping the process alive - a deadline that answered its own
   * question would pass every time.
   */
  private static armExitDeadline(): void {
    const deadline = setTimeout(() => {
      console.error('smoke-rate-monitor: FAILED - the process was still running '
        + `${SmokeRateMonitor.exitDeadlineMillisecondsConst} ms after stop(); `
        + `held by ${process.getActiveResourcesInfo().join(', ')}`)
      process.exit(1)
    }, SmokeRateMonitor.exitDeadlineMillisecondsConst)
    deadline.unref()
  }


  /** A provider this machine does not have is not a failed read; there is nothing to read. */
  private skip(description: string): void {
    this.skipped += 1
    console.log(`  --  ${description}`)
  }
}

void SmokeRateMonitor.run().catch((error: unknown) => SmokeRun.failed('smoke-rate-monitor', error))
