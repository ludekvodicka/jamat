import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { SessionTranscriptReader } from '../../../lib-orchestrator/sessionTranscriptReader/sessionTranscriptReader'
import type { SessionTranscriptReading } from '../../../lib-orchestrator/sessionTranscriptReader/sessionTranscriptReaderApi.types'
import { AgentSessionContext } from '../shared/agentSessionContext'

export class SessionTranscriptAccess {
  constructor(
    private readonly sessions: SessionManager,
    private readonly reader: SessionTranscriptReader,
  ) {}

  async read(sessionId: string): Promise<SessionTranscriptReading> {
    const context = await AgentSessionContext.of(this.sessions, sessionId)
    if (!context.ok) return { kind: 'none', code: context.code, reason: context.reason }
    return this.reader.read(context.value)
  }
}
