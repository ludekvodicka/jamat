import { ClaudeCredentialsReader } from './claude/claudeCredentialsReader'
import { RateLimitSourceClaude } from './claude/rateLimitSourceClaude'
import { RateLimitSourceCodex } from './codex/rateLimitSourceCodex'
import type { RateLimitSource, RateSourceHooks } from './rateMonitor'

/**
 * The two providers this subsystem reads, and the one door to them.
 *
 * `claude/` and `codex/` are the subsystem's inside; the monitor is its public surface and takes the
 * sources by injection, so a consumer that has to decide WHICH sources to build - the smoke, which
 * runs without a Claude token - had nowhere to ask and reached into the two directories instead. It
 * asks here now, and moving a source inside them breaks nothing outside.
 *
 * The credentials reader travels with them because it answers the one question that decides the
 * pair: whether this machine has a Claude token at all.
 */
export class RateMonitorSources {
  static of(hooks: RateSourceHooks): readonly RateLimitSource[] {
    return [RateMonitorSources.claude(), RateMonitorSources.codex(hooks)]
  }

  static claude(): RateLimitSource {
    return new RateLimitSourceClaude()
  }

  /** The one asymmetry between the two: the Codex server pushes when its numbers move. */
  static codex(hooks: RateSourceHooks): RateLimitSource {
    return new RateLimitSourceCodex({ onNudge: () => hooks.nudge('codex') })
  }

  static credentials(): ClaudeCredentialsReader {
    return new ClaudeCredentialsReader()
  }
}
