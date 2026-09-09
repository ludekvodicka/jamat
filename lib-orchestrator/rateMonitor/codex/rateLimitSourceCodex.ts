import type { spawn } from 'node:child_process'

import type { RateLimitSource, RateSourceReading } from '../rateMonitor'
import { CodexAppServerClient } from './codexAppServerClient'
import { CodexRateLimitMapping } from './codexRateLimitMapping'

export interface RateLimitSourceCodexDeps {
  /**
   * Wired at construction and not part of the source contract: Codex is the only provider that says
   * anything on its own, and the other side of this subsystem must not grow a hook for it.
   */
  onNudge: () => void
  /** The tests script a whole app-server through this; nothing in production passes it. */
  spawnImpl?: typeof spawn
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
}

/**
 * The Codex half of the rate monitor: one app-server child, asked for its limits and listened to
 * while it is up.
 *
 * A machine without Codex is the ordinary case this separates out. It is not a failed read - there
 * is nothing to read - so it answers `unconfigured` and the surface draws a placeholder instead of
 * windows nobody has.
 */
export class RateLimitSourceCodex implements RateLimitSource {
  /**
   * The one notification worth acting on. It carries no numbers of its own: it says the answer has
   * moved, and the answer is then asked for through the same read as any other.
   */
  private static readonly updatedNotificationConst = 'account/rateLimits/updated'
  private static readonly notInstalledReasonConst = 'Codex is not installed'

  readonly agentId = 'codex' as const

  private readonly client: CodexAppServerClient

  constructor(deps: RateLimitSourceCodexDeps) {
    this.client = new CodexAppServerClient({
      onNotification: (method) => {
        if (method === RateLimitSourceCodex.updatedNotificationConst) deps.onNudge()
      },
      spawnImpl: deps.spawnImpl,
      platform: deps.platform,
      environment: deps.environment,
    })
  }

  async read(): Promise<RateSourceReading> {
    const answer = await this.client.readRateLimits()
    if (answer.ok)
      return {
        kind: 'ok',
        windows: CodexRateLimitMapping.windowsOf(answer.result),
        // Codex reports no fact without a window, and it authenticates through its own config rather
        // than through a token this process can see - so neither field has anything to carry.
        extras: [],
        raw: answer.result,
        oauthExpiresAt: null,
      }
    else if (answer.code === 'not-installed')
      return {
        kind: 'unconfigured',
        reason: RateLimitSourceCodex.notInstalledReasonConst,
        oauthExpiresAt: null,
      }
    else if (answer.code === 'failed')
      return { kind: 'failed', reason: answer.reason, oauthExpiresAt: null }
    else
      throw new Error(`Unknown Codex answer: ${JSON.stringify(answer)}`)
  }

  stop(): void {
    this.client.stop()
  }
}
