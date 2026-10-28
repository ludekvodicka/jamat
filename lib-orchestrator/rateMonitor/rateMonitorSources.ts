import { StatusLineRateReader } from './claude/statusLineRateReader'
import type { AccountView, RetainProfile } from '../agentAccounts/agentAccountsApi.types'
import { ClaudeCredentialsReader } from './claude/claudeCredentialsReader'
import { RateLimitSourceClaude } from './claude/rateLimitSourceClaude'
import { RateLimitSourceCodex } from './codex/rateLimitSourceCodex'
import type { RateLimitSource, RateSourceHooks, RateSourceReading } from './rateMonitor'
import { RolloutRateReader } from './codex/rolloutRateReader'

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
  static statusLine(directory: string, accountFor: ConstructorParameters<typeof StatusLineRateReader>[1]): StatusLineRateReader {
    return new StatusLineRateReader(directory, accountFor)
  }

  static rollouts(home: string, accounts: () => Promise<readonly AccountView[]>): RolloutRateReader {
    return new RolloutRateReader(home, accounts)
  }

  static forAccount(account: AccountView, home: string, hooks: RateSourceHooks, mainHome = home,
    prepare?: () => Promise<unknown>, withProfile?: (read: (retain?: RetainProfile) => Promise<RateSourceReading>) => Promise<RateSourceReading>): RateLimitSource {
    let source: RateLimitSource
    if (account.agentId === 'claude')
      source = new RateLimitSourceClaude({ credentials: new ClaudeCredentialsReader(home) })
    else if (account.agentId === 'codex')
      source = new RateLimitSourceCodex({ environment: account.isMain ? process.env
        : { ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: mainHome }, keepAlive: account.isMain,
        beforeRead: account.isMain ? undefined : prepare,
        withProfile: account.isMain ? undefined : withProfile,
        onNudge: () => hooks.nudge(account.agentId, account.accountId) })
    else throw new Error(`Unknown rate agent: ${JSON.stringify(account.agentId)}`)
    return { agentId: account.agentId, accountId: account.accountId, label: account.label,
      minimumIntervalMilliseconds: source.minimumIntervalMilliseconds,
      read: () => source.read(), stop: () => source.stop() }
  }

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
