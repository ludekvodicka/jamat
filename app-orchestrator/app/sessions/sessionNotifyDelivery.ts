import type { RemoteControlTerminalDeliverFailureData } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlDeliverConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { RemoteControlTerminal } from '../../../lib-orchestrator/remoteControl/remoteControlTerminal'
import type { SessionManager, SessionNotifyPort } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { SessionTranscriptAccess } from '../sessionTranscript/sessionTranscriptAccess'

/**
 * The wake-up line, typed through the same terminal the control API delivers
 * through, so it shares its one-delivery-at-a-time guard. Only into an empty composer: a draft, a
 * dialog or a session that does not run is tried again later. A line that reached the composer
 * without a proven submit is `typed`: delivered on record, never typed again, and holding the
 * session's idle gate as pending input until its turn shows in the transcript.
 */
export class SessionNotifyDelivery implements SessionNotifyPort {
  /** Short: a composer that is not empty now is tried again on the notifier's pace, not waited for. */
  private static readonly readyTimeoutMillisecondsConst = 5_000
  private readonly sessions: Pick<SessionManager, 'snapshot' | 'deliveryPending'>
  private readonly terminal: Pick<RemoteControlTerminal, 'deliver'>
  private readonly transcripts: Pick<SessionTranscriptAccess, 'read'>

  constructor(
    sessions: Pick<SessionManager, 'snapshot' | 'deliveryPending'>,
    terminal: Pick<RemoteControlTerminal, 'deliver'>,
    transcripts: Pick<SessionTranscriptAccess, 'read'>,
  ) {
    this.sessions = sessions
    this.terminal = terminal
    this.transcripts = transcripts
  }

  async deliver(sessionId: string, text: string, since: number): Promise<'delivered' | 'typed' | 'retry' | 'gone'> {
    const session = this.sessions.snapshot().sessions.find((candidate) => candidate.sessionId === sessionId)
    // A shell has no composer to type into, so it never will have one.
    if (session === undefined || session.kind !== 'agent') return 'gone'
    if (session.life !== 'live' && session.life !== 'starting') return 'retry'
    // A line whose turn already shows, for example typed just before a crash, is not typed twice.
    if (RemoteControlTerminal.userTurnSince(await this.transcripts.read(sessionId), text, since)) return 'delivered'
    const delivered = await this.terminal.deliver(sessionId, text, {
      input: 'paste',
      readyTimeoutMs: SessionNotifyDelivery.readyTimeoutMillisecondsConst,
      submitTimeoutMs: RemoteControlDeliverConst.submitTimeoutMillisecondsConst,
      queue: true,
    }, { transcript: () => this.transcripts.read(sessionId) })
    if (delivered.ok) return 'delivered'
    const data = delivered.error.data as Partial<RemoteControlTerminalDeliverFailureData> | undefined
    return data?.typed === true ? 'typed' : 'retry'
  }

  async taken(sessionId: string, text: string, since: number): Promise<boolean> {
    return RemoteControlTerminal.userTurnSince(await this.transcripts.read(sessionId), text, since)
  }

  holding(sessionId: string, held: boolean): void {
    this.sessions.deliveryPending(sessionId, held)
  }
}
