import type { RemoteControlTerminalDeliverFailureData } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlDeliverConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import type { RemoteControlTerminal } from '../../../lib-orchestrator/remoteControl/remoteControlTerminal'
import type { SessionManager, SessionNotifyPort } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { SessionTranscriptAccess } from '../sessionTranscript/sessionTranscriptAccess'

/**
 * The wake-up line, typed through the same terminal the control API delivers
 * through, so it shares its one-delivery-at-a-time guard. Only into an empty composer: a draft, a
 * dialog or a session that does not run is tried again later. A line that reached the composer is
 * delivered even when its submit was not proven, because typing it again would double it.
 */
export class SessionNotifyDelivery implements SessionNotifyPort {
  /** Short: a composer that is not empty now is tried again on the notifier's pace, not waited for. */
  private static readonly readyTimeoutMillisecondsConst = 5_000
  private readonly sessions: Pick<SessionManager, 'snapshot'>
  private readonly terminal: Pick<RemoteControlTerminal, 'deliver'>
  private readonly transcripts: Pick<SessionTranscriptAccess, 'read'>

  constructor(
    sessions: Pick<SessionManager, 'snapshot'>,
    terminal: Pick<RemoteControlTerminal, 'deliver'>,
    transcripts: Pick<SessionTranscriptAccess, 'read'>,
  ) {
    this.sessions = sessions
    this.terminal = terminal
    this.transcripts = transcripts
  }

  async deliver(sessionId: string, text: string): Promise<'delivered' | 'retry' | 'gone'> {
    const session = this.sessions.snapshot().sessions.find((candidate) => candidate.sessionId === sessionId)
    // A shell has no composer to type into, so it never will have one.
    if (session === undefined || session.kind !== 'agent') return 'gone'
    if (session.life !== 'live' && session.life !== 'starting') return 'retry'
    const delivered = await this.terminal.deliver(sessionId, text, {
      input: 'paste',
      readyTimeoutMs: SessionNotifyDelivery.readyTimeoutMillisecondsConst,
      submitTimeoutMs: RemoteControlDeliverConst.submitTimeoutMillisecondsConst,
      queue: true,
    }, { transcript: () => this.transcripts.read(sessionId) })
    if (delivered.ok) return 'delivered'
    const data = delivered.error.data as Partial<RemoteControlTerminalDeliverFailureData> | undefined
    return data?.typed === true ? 'delivered' : 'retry'
  }
}
