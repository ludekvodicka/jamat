import type {
  SessionInfo,
  SessionsSnapshot,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SessionModelInfo } from '../../../lib-orchestrator/sessionModelReader/sessionModelReaderApi.types'
import { AgentSettings } from '../../shared/agentSettings'
import type { ContextCompactionCooldown } from '../../shared/contextCompactionCooldown'
import { ErrorText } from '../../shared/errorText'
import type { SnapshotStoreState } from '../ipc/snapshotStore'
import { SessionContextUsage } from '../sessionModel/sessionContextUsage'
import type { AgentSettingsStoreState } from './agentSettingsStore'
import type { SessionCompactResult } from './sessionCompact'

export interface ContextCompactionSessions {
  current(): SnapshotStoreState<SessionsSnapshot>
  subscribe(onChanged: () => void): () => void
}

export interface ContextCompactionModelReader {
  readNow(sessionId: string): Promise<SessionModelInfo | null>
}

export interface ContextCompactionSettingsReader {
  current(): AgentSettingsStoreState
  subscribe(onChanged: () => void): () => void
}

export interface ContextCompactionRunner {
  hasTarget(sessionId: string): boolean
  automatic(sessionId: string, canSubmit: () => boolean): Promise<SessionCompactResult>
  cooldown(sessionId: string): Promise<ContextCompactionCooldown | null>
}

export interface ContextCompactionDrafts {
  status(sessionId: string): { characters: number; quietAt: number }
  subscribe(onChanged: () => void): () => void
}

interface ContextCompactionCheck {
  reason: string
  nextCheckAt: number | null
}

export interface ContextCompactionStatus extends ContextCompactionCheck {
  cooldown: ContextCompactionCooldown | null
}

export class ContextCompactionController {
  private static readonly recheckMillisecondsConst = 5 * 60_000

  private readonly checks = new Map<string, ContextCompactionCheck & { evaluated: boolean }>()
  private readonly evaluating = new Map<string, number>()
  private stopping: (() => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private nextRecheckAt = 0
  private generation = 0

  constructor(
    private readonly sessions: ContextCompactionSessions,
    private readonly model: ContextCompactionModelReader,
    private readonly settings: ContextCompactionSettingsReader,
    private readonly compact: ContextCompactionRunner,
    private readonly drafts: ContextCompactionDrafts,
    private readonly reportError: (message: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  start(): () => void {
    if (this.stopping !== null)
      throw new Error('The context compaction controller is already started')
    const generation = ++this.generation
    this.nextRecheckAt = this.now() + ContextCompactionController.recheckMillisecondsConst
    const sessionsOff = this.sessions.subscribe(() => this.changed(generation))
    const settingsOff = this.settings.subscribe(() => {
      this.checks.clear()
      this.changed(generation)
    })
    const draftsOff = this.drafts.subscribe(() => this.changed(generation))
    const stop = (): void => {
      if (this.stopping !== stop) return
      sessionsOff()
      settingsOff()
      draftsOff()
      this.clearTimer()
      this.stopping = null
      this.generation += 1
      this.checks.clear()
      this.evaluating.clear()
    }
    this.stopping = stop
    this.changed(generation)
    return stop
  }

  async inspect(sessionId: string): Promise<ContextCompactionStatus> {
    const cooldown = await this.compact.cooldown(sessionId)
    if (this.stopping === null)
      return { reason: 'The automatic compaction controller is stopped.', nextCheckAt: null, cooldown }
    const blocked = this.blocked(sessionId)
    if (blocked !== null) return { ...blocked, cooldown }
    const check = this.checks.get(sessionId)
    const nextCheckAt = Math.min(this.nextRecheckAt, check?.nextCheckAt ?? this.nextRecheckAt)
    if (cooldown !== null)
      return {
        reason: check?.nextCheckAt === cooldown.expiresAt ? check.reason
          : 'Waiting for the pause after the last compact request to end.',
        nextCheckAt: Math.max(cooldown.expiresAt, nextCheckAt),
        cooldown,
      }
    return {
      reason: check?.reason ?? 'Waiting for the next context check.',
      nextCheckAt: this.evaluating.has(sessionId) ? null : nextCheckAt,
      cooldown: null,
    }
  }

  private changed(generation: number): void {
    if (this.generation !== generation) return
    const sessions = this.sessions.current().snapshot?.sessions ?? []
    const present = new Set(sessions.map((session) => session.sessionId))
    for (const sessionId of this.checks.keys())
      if (!present.has(sessionId)) this.checks.delete(sessionId)
    for (const session of sessions) this.consider(session.sessionId, generation)
    this.arm(generation)
  }

  private consider(sessionId: string, generation: number): void {
    const blocked = this.blocked(sessionId)
    if (blocked !== null) {
      this.checks.set(sessionId, { ...blocked, evaluated: false })
      return
    }
    if (this.evaluating.has(sessionId)) return
    const check = this.checks.get(sessionId)
    if (check?.evaluated && check.nextCheckAt !== null && check.nextCheckAt > this.now()) return
    this.evaluating.set(sessionId, generation)
    this.checks.set(sessionId, { reason: 'Checking fresh context usage.', nextCheckAt: null, evaluated: true })
    void this.evaluate(sessionId, generation)
      .catch((error: unknown) => {
        if (this.generation !== generation) return
        const reason = `The automatic compact check failed: ${ErrorText.of(error)}`
        this.retryLater(sessionId, reason)
        this.reportError(`Auto-compact for session ${sessionId} failed: ${ErrorText.of(error)}`)
      })
      .finally(() => {
        if (this.evaluating.get(sessionId) !== generation) return
        this.evaluating.delete(sessionId)
        this.arm(generation)
      })
  }

  private async evaluate(sessionId: string, generation: number): Promise<void> {
    const cooldown = await this.compact.cooldown(sessionId)
    if (!this.canContinue(sessionId, generation)) return
    if (cooldown !== null) {
      this.checks.set(sessionId, {
        evaluated: true,
        reason: 'Waiting for the pause after the last compact request to end.',
        nextCheckAt: cooldown.expiresAt,
      })
      return
    }
    const model = await this.model.readNow(sessionId)
    if (!this.canContinue(sessionId, generation)) return
    if (model === null) {
      this.retryLater(sessionId, 'Context usage could not be read. Automatic compact cannot decide yet.')
      return
    }
    const percent = SessionContextUsage.percentOf(model)
    if (percent === null) {
      this.retryLater(sessionId, 'The context window is unknown. Automatic compact cannot decide yet.')
      return
    }
    const session = this.session(sessionId)
    const settings = this.settings.current().value
    if (session?.agent === undefined || settings === null) return
    const threshold = AgentSettings.contextCompactionFor(settings, session.agent.agentId).autoPercent
    if (percent < threshold) {
      this.retryLater(sessionId, `The last context check was ${percent}%, below the ${threshold}% threshold.`)
      return
    }
    const result = await this.compact.automatic(sessionId, () => this.canContinue(sessionId, generation))
    if (this.generation !== generation) return
    let reason: string
    switch (result.kind) {
      case 'sent': reason = 'Compact was requested. Its result is not confirmed by Jamat.'; break
      case 'cooldown': reason = 'Another compact request holds the automatic cooldown.'; break
      case 'unavailable': reason = 'The compact command could not reach a writable terminal.'; break
      case 'failed': reason = result.detail; break
      case 'cancelled': return
      default: throw new Error(`Unknown compact result: ${JSON.stringify(result)}`)
    }
    const nextCooldown = await this.compact.cooldown(sessionId)
    if (this.generation !== generation) return
    if (nextCooldown !== null)
      this.checks.set(sessionId, {
        evaluated: true,
        reason,
        nextCheckAt: nextCooldown.expiresAt,
      })
    else
      this.retryLater(sessionId, reason)
  }

  private canContinue(sessionId: string, generation: number): boolean {
    if (this.generation !== generation) return false
    const blocked = this.blocked(sessionId)
    if (blocked === null) return true
    this.checks.set(sessionId, { ...blocked, evaluated: false })
    return false
  }

  private blocked(sessionId: string): ContextCompactionCheck | null {
    const session = this.session(sessionId)
    if (session === null) return { reason: 'The session is no longer available.', nextCheckAt: null }
    switch (session.kind) {
      case 'shell': return { reason: 'Shell sessions cannot compact context.', nextCheckAt: null }
      case 'agent': break
      default: throw new Error(`Unknown session kind: ${JSON.stringify(session.kind)}`)
    }
    switch (session.life) {
      case 'starting':
      case 'ended':
      case 'lost': return { reason: 'Waiting for a live agent session.', nextCheckAt: null }
      case 'live': break
      default: throw new Error(`Unknown session life: ${JSON.stringify(session.life)}`)
    }
    const value = this.settings.current().value
    if (value === null || session.agent === undefined)
      return { reason: 'Agent settings are not available.', nextCheckAt: null }
    if (!AgentSettings.contextCompactionFor(value, session.agent.agentId).enabled)
      return { reason: 'Automatic compaction is disabled for this agent.', nextCheckAt: null }
    switch (session.activity) {
      case 'working':
        return { reason: 'The agent is working. Waiting for it to become idle.', nextCheckAt: null }
      case 'waiting':
        return { reason: 'The agent is waiting for your answer or approval.', nextCheckAt: null }
      case 'unknown':
      case null:
        return { reason: 'The agent activity is unknown. Waiting for a confirmed idle state.', nextCheckAt: null }
      case 'idle': break
      default: throw new Error(`Unknown session activity: ${JSON.stringify(session.activity)}`)
    }
    if (!this.compact.hasTarget(sessionId))
      return { reason: 'No writable terminal is attached in this window.', nextCheckAt: this.nextRecheckAt }
    const draft = this.drafts.status(sessionId)
    if (draft.characters > 0)
      return { reason: 'The prompt has unsent text. Submit or clear it before automatic compaction.', nextCheckAt: null }
    if (draft.quietAt > this.now())
      return { reason: 'Waiting for 15 seconds without typing in this terminal.', nextCheckAt: draft.quietAt }
    return null
  }

  private session(sessionId: string): SessionInfo | null {
    return this.sessions.current().snapshot?.sessions
      .find((session) => session.sessionId === sessionId) ?? null
  }

  private retryLater(sessionId: string, reason: string): void {
    this.checks.set(sessionId, {
      evaluated: true,
      reason,
      nextCheckAt: this.now() + ContextCompactionController.recheckMillisecondsConst,
    })
  }

  private arm(generation: number): void {
    if (this.generation !== generation) return
    this.clearTimer()
    let next = this.nextRecheckAt
    for (const check of this.checks.values())
      if (check.nextCheckAt !== null && check.nextCheckAt > this.now())
        next = Math.min(next, check.nextCheckAt)
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.now() >= this.nextRecheckAt) {
        this.nextRecheckAt = this.now() + ContextCompactionController.recheckMillisecondsConst
        this.checks.clear()
      }
      this.changed(generation)
    }, Math.max(0, next - this.now()))
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}
