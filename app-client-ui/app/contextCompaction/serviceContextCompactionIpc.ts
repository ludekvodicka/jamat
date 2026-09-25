import type { RemoteControlTerminalDeliverFailureData } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlTerminal } from '../../../lib-orchestrator/remoteControl/remoteControlTerminal'
import { RemoteControlDeliverConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { ServiceIpcBase } from '../shared/serviceIpcBase'
import type { ContextCompactionCooldown } from '../../shared/contextCompactionCooldown'
import type { ContextCompactionDelivery } from '../../shared/contextCompactionDelivery'
import type { SessionTranscriptAccess } from '../sessionTranscript/sessionTranscriptAccess'

export class ServiceContextCompactionIpc extends ServiceIpcBase<
  typeof ServiceContextCompactionIpc.channelsConst
> {
  static readonly channelsConst = {
    'contextCompaction:claim-auto': true,
    'contextCompaction:note-manual': true,
    'contextCompaction:cooldown': true,
    'contextCompaction:deliver': true,
  } as const

  private static readonly cooldownMillisecondsConst = 10 * 60_000
  private static readonly commandConst = '/compact'
  private readonly cooldowns = new Map<string, number>()
  private readonly terminal: Pick<RemoteControlTerminal, 'deliver'>
  private readonly transcripts: Pick<SessionTranscriptAccess, 'read'>
  private readonly now: () => number

  constructor(
    terminal: Pick<RemoteControlTerminal, 'deliver'>,
    transcripts: Pick<SessionTranscriptAccess, 'read'>,
    now: () => number = Date.now,
  ) {
    super()
    this.terminal = terminal
    this.transcripts = transcripts
    this.now = now
  }

  initialize(): void {
    this.register('contextCompaction:claim-auto', (_event, sessionId) =>
      this.claimAutomatic(sessionId))
    this.register('contextCompaction:note-manual', (_event, sessionId) =>
      this.noteManual(sessionId))
    this.register('contextCompaction:cooldown', (_event, sessionId) =>
      this.cooldown(sessionId))
    this.register('contextCompaction:deliver', (_event, sessionId) =>
      this.deliver(sessionId))
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

  /**
   * Typed, not pasted: a slash command is what a person types, and a bracketed paste reaches the
   * TUI as pasted content, which Codex may hold as text rather than parse as a command.
   */
  private async deliver(sessionId: string): Promise<ContextCompactionDelivery> {
    const result = await this.terminal.deliver(sessionId, ServiceContextCompactionIpc.commandConst, {
      input: 'typed',
      readyTimeoutMs: RemoteControlDeliverConst.readyTimeoutMillisecondsConst,
      submitTimeoutMs: RemoteControlDeliverConst.submitTimeoutMillisecondsConst,
    }, { transcript: () => this.transcripts.read(sessionId) })
    if (result.ok) return { kind: 'delivered', proof: result.value.proof }
    // Every deliver refusal carries this shape; RemoteControlError types `data` only as a record.
    const data = result.error.data as Partial<RemoteControlTerminalDeliverFailureData> | undefined
    if (data?.stage === undefined || data.reason === undefined)
      throw new Error(`terminal.deliver refused without stage and reason: ${result.error.detail}`)
    return {
      kind: 'refused',
      stage: data.stage,
      reason: data.reason,
      detail: result.error.detail,
    }
  }
}
