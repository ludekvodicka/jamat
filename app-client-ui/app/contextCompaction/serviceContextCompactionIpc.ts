import { ServiceIpcBase } from '../shared/serviceIpcBase'
import type { ContextCompactionCooldown } from '../../shared/contextCompactionCooldown'

export class ServiceContextCompactionIpc extends ServiceIpcBase<
  typeof ServiceContextCompactionIpc.channelsConst
> {
  static readonly channelsConst = {
    'contextCompaction:claim-auto': true,
    'contextCompaction:note-manual': true,
    'contextCompaction:cooldown': true,
  } as const

  private static readonly cooldownMillisecondsConst = 10 * 60_000
  private readonly cooldowns = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {
    super()
  }

  initialize(): void {
    this.register('contextCompaction:claim-auto', (_event, sessionId) =>
      this.claimAutomatic(sessionId))
    this.register('contextCompaction:note-manual', (_event, sessionId) =>
      this.noteManual(sessionId))
    this.register('contextCompaction:cooldown', (_event, sessionId) =>
      this.cooldown(sessionId))
    this.assertComplete(ServiceContextCompactionIpc.channelsConst)
  }

  private claimAutomatic(sessionId: string): boolean {
    const now = this.now()
    this.prune(now)
    if ((this.cooldowns.get(sessionId) ?? 0) > now) return false
    this.cooldowns.set(
      sessionId,
      now + ServiceContextCompactionIpc.cooldownMillisecondsConst,
    )
    return true
  }

  private noteManual(sessionId: string): void {
    const now = this.now()
    this.prune(now)
    this.cooldowns.set(
      sessionId,
      now + ServiceContextCompactionIpc.cooldownMillisecondsConst,
    )
  }

  private prune(now: number): void {
    for (const [sessionId, expiresAt] of this.cooldowns)
      if (expiresAt <= now) this.cooldowns.delete(sessionId)
  }

  private cooldown(sessionId: string): ContextCompactionCooldown | null {
    this.prune(this.now())
    const expiresAt = this.cooldowns.get(sessionId)
    return expiresAt === undefined ? null : {
      requestedAt: expiresAt - ServiceContextCompactionIpc.cooldownMillisecondsConst,
      expiresAt,
    }
  }
}
