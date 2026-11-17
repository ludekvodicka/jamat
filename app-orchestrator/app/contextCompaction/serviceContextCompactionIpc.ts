import type { RemoteControlTerminalDeliverFailureData } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlTerminal } from '../../../lib-orchestrator/remoteControl/remoteControlTerminal'
import { RemoteControlDeliverConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { ServiceIpcBase } from '../../../lib-orchestrator/clientApi/serviceIpcBase'
import type { ContextCompactionCooldown } from '../../../lib-orchestrator/clientApi/contextCompactionCooldown'
import type { ContextCompactionDelivery } from '../../../lib-orchestrator/clientApi/contextCompactionDelivery'
import type { SessionTranscriptAccess } from '../sessionTranscript/sessionTranscriptAccess'
import type { ContextCompactionCooldowns } from './contextCompactionCooldowns'

export class ServiceContextCompactionIpc extends ServiceIpcBase<
  typeof ServiceContextCompactionIpc.channelsConst
> {
  static readonly channelsConst = {
    'contextCompaction:claim-auto': true,
    'contextCompaction:note-manual': true,
    'contextCompaction:cooldown': true,
    'contextCompaction:deliver': true,
  } as const

  private static readonly commandConst = '/compact'
  private readonly cooldowns: ContextCompactionCooldowns
  private readonly terminal: Pick<RemoteControlTerminal, 'deliver'>
  private readonly transcripts: Pick<SessionTranscriptAccess, 'read'>

  constructor(
    terminal: Pick<RemoteControlTerminal, 'deliver'>,
    transcripts: Pick<SessionTranscriptAccess, 'read'>,
    cooldowns: ContextCompactionCooldowns,
  ) {
    super()
    this.terminal = terminal
    this.transcripts = transcripts
    this.cooldowns = cooldowns
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

  claimAutomatic(sessionId: string): boolean { return this.cooldowns.claim(sessionId) }

  noteManual(sessionId: string): void { this.cooldowns.note(sessionId) }

  cooldown(sessionId: string): ContextCompactionCooldown | null { return this.cooldowns.read(sessionId) }

  /**
   * Typed, not pasted: a slash command is what a person types, and a bracketed paste reaches the
   * TUI as pasted content, which Codex may hold as text rather than parse as a command.
   */
  async deliver(sessionId: string): Promise<ContextCompactionDelivery> {
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
