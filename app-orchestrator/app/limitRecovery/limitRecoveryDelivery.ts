import type { RemoteControlTerminalDeliverFailureData } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlDeliverConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { RemoteControlTerminal } from '../../../lib-orchestrator/remoteControl/remoteControlTerminal'
import type { LimitRecoveryOutcome } from '../../../lib-orchestrator/limitRecovery/limitRecovery'
import type { SessionTranscriptAccess } from '../sessionTranscript/sessionTranscriptAccess'

/**
 * The instruction to continue, typed through the terminal the control API delivers through, so it
 * shares its one-delivery-at-a-time guard. The whole attempt may take as long as the terminal's
 * longest ready wait: a resumed conversation can take a while before its composer is drawn, and right
 * after a switch the new runtime may not be listed yet, which the terminal answers as not live.
 */
export class LimitRecoveryDelivery {
  private static readonly retryMillisecondsConst = 2_000
  private readonly terminal: Pick<RemoteControlTerminal, 'deliver'>
  private readonly transcripts: Pick<SessionTranscriptAccess, 'read'>
  private readonly pause: (milliseconds: number) => Promise<void>

  constructor(terminal: Pick<RemoteControlTerminal, 'deliver'>, transcripts: Pick<SessionTranscriptAccess, 'read'>,
    pause: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds))) {
    this.terminal = terminal
    this.transcripts = transcripts
    this.pause = pause
  }

  async deliver(sessionId: string, text: string): Promise<LimitRecoveryOutcome> {
    const since = Date.now()
    const deadline = since + RemoteControlDeliverConst.readyTimeoutMaximumMillisecondsConst
    for (;;) {
      const delivered = await this.terminal.deliver(sessionId, text, {
        input: 'paste',
        readyTimeoutMs: Math.max(RemoteControlDeliverConst.readyTimeoutMinimumMillisecondsConst, deadline - Date.now()),
        submitTimeoutMs: RemoteControlDeliverConst.submitTimeoutMillisecondsConst,
      }, { transcript: () => this.transcripts.read(sessionId) })
      if (delivered.ok) return { ok: true }
      // A line whose turn shows anyway was taken; the terminal only missed the proof in time.
      if (RemoteControlTerminal.userTurnSince(await this.transcripts.read(sessionId), text, since)) return { ok: true }
      const data = delivered.error.data as Partial<RemoteControlTerminalDeliverFailureData> | undefined
      if (data?.reason !== 'not-live' || data.typed === true || Date.now() + LimitRecoveryDelivery.retryMillisecondsConst >= deadline)
        return { ok: false, detail: delivered.error.detail }
      await this.pause(LimitRecoveryDelivery.retryMillisecondsConst)
    }
  }
}
