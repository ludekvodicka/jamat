import type { spawn } from 'node:child_process'

import type { RateLimitSource, RateSourceReading } from '../rateMonitor'
import { CodexAppServerClient } from './codexAppServerClient'
import { CodexRateLimitMapping } from './codexRateLimitMapping'
import { ErrorText } from '../../shared/errorText'
import type { RetainProfile } from '../../agentAccounts/agentAccountsApi.types'

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
  keepAlive?: boolean
  beforeRead?: () => Promise<unknown>
  withProfile?: (read: (retain?: RetainProfile) => Promise<RateSourceReading>) => Promise<RateSourceReading>
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

  private readonly deps: RateLimitSourceCodexDeps
  private client: CodexAppServerClient | null = null
  private stopped = false
  private exiting: Promise<void> | null

  constructor(deps: RateLimitSourceCodexDeps) {
    this.deps = deps
    this.exiting = null
  }

  private createClient(): CodexAppServerClient {
    const deps = this.deps
    return new CodexAppServerClient({
      onNotification: (method) => {
        if (method === RateLimitSourceCodex.updatedNotificationConst) deps.onNudge()
      },
      spawnImpl: deps.spawnImpl,
      platform: deps.platform,
      environment: deps.environment,
    })
  }

  async read(): Promise<RateSourceReading> {
    if (this.stopped) return { kind: 'failed', reason: 'The Codex quota source was stopped', oauthExpiresAt: null }
    try {
      return this.deps.withProfile ? await this.deps.withProfile(retain => this.readProfile(retain)) : await this.readProfile()
    } catch (error) { return { kind: 'failed', reason: ErrorText.of(error), oauthExpiresAt: null } }
  }

  private async readProfile(retain?: RetainProfile): Promise<RateSourceReading> {
    if (this.stopped) return { kind: 'failed', reason: 'The Codex quota source was stopped', oauthExpiresAt: null }
    if (this.exiting) return { kind: 'failed', reason: 'The Codex quota child did not stop', oauthExpiresAt: null }
    try { if (this.deps.beforeRead) await this.deps.beforeRead() }
    catch (error) { return { kind: 'failed', reason: ErrorText.of(error), oauthExpiresAt: null } }
    if (this.stopped) return { kind: 'failed', reason: 'The Codex quota source was stopped', oauthExpiresAt: null }
    const client = this.client ??= this.createClient()
    const answer = await client.readRateLimits()
    if (this.deps.keepAlive === false) {
      const closed = await client.close()
      if (this.client === client) this.client = null
      if (!closed) {
        const exiting = client.waitForExit()
        this.exiting = exiting
        retain?.(exiting)
        void exiting.then(() => { if (this.exiting === exiting) this.exiting = null })
        return { kind: 'failed', reason: 'The Codex quota child did not stop', oauthExpiresAt: null }
      }
    }
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
    this.stopped = true
    this.client?.stop()
    this.client = null
  }
}
