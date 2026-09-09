import type { SessionTranscriptReading } from '../../../lib-orchestrator/sessionTranscriptReader/sessionTranscriptReaderApi.types'
import { ServiceIpcBase } from '../shared/serviceIpcBase'
import type { SessionTranscriptAccess } from './sessionTranscriptAccess'

/**
 * The last words of a session that has ended, for the panel that has nothing else left to draw.
 *
 * Composed exactly as `sessionModel:get` is, through the same gate and for the same reason: the
 * manager says where the session worked and who was working there, and an id that names nothing, a
 * shell session or an agent with no native session id all answer `none` without the reader ever
 * being asked. There is no falling back to the newest transcript in the directory - that is how a
 * panel ends up showing somebody else's conversation.
 */
export class ServiceSessionTranscriptIpc
  extends ServiceIpcBase<typeof ServiceSessionTranscriptIpc.channelsConst> {
  static readonly channelsConst = {
    'sessionTranscript:get': true,
  } as const

  constructor(
    private readonly access: SessionTranscriptAccess,
  ) {
    super()
  }

  initialize(): void {
    this.register('sessionTranscript:get', (_event, sessionId) => this.get(sessionId))
    this.assertComplete(ServiceSessionTranscriptIpc.channelsConst)
  }

  private async get(sessionId: string): Promise<SessionTranscriptReading> {
    return this.access.read(sessionId)
  }
}
