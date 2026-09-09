import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { SessionModelReader } from '../../../lib-orchestrator/sessionModelReader/sessionModelReader'
import type { SessionModelReading } from '../../../lib-orchestrator/sessionModelReader/sessionModelReaderApi.types'
import { AgentSessionContext } from '../shared/agentSessionContext'
import { ServiceIpcBase } from '../shared/serviceIpcBase'

/**
 * What the status bar is told about the session behind the active terminal: one read, composed the
 * same way `fileChanges:list` is - the manager says where the session works and who is working
 * there, and the library reads the transcript that agent is writing.
 *
 * The gate in front of the reader is the point of this class. A session id that names nothing, a
 * shell session and an agent session with no native session id all answer `none` here, and the
 * reader is never asked. V1 fell back to the newest transcript in the directory when it had no id,
 * and a freshly opened tab then drew the neighbouring session's context - a warning about a
 * conversation the user was not having. There is no fallback to reach for: an id is either known or
 * this answers nothing.
 */
export class ServiceSessionModelIpc
  extends ServiceIpcBase<typeof ServiceSessionModelIpc.channelsConst> {
  static readonly channelsConst = {
    'sessionModel:get': true,
  } as const

  constructor(
    private readonly reader: SessionModelReader,
    private readonly sessions: SessionManager,
  ) {
    super()
  }

  initialize(): void {
    this.register('sessionModel:get', (_event, sessionId) => this.get(sessionId))
    this.assertComplete(ServiceSessionModelIpc.channelsConst)
  }

  private async get(sessionId: string): Promise<SessionModelReading> {
    const context = await AgentSessionContext.of(this.sessions, sessionId)
    if (!context.ok) return { kind: 'none', reason: context.reason }
    return this.reader.read(context.value)
  }
}
