import type { AntigravityLimitReader } from '../../../lib-orchestrator/limitRecovery/antigravityLimitReader'
import type { ClaudeLimitReader } from '../../../lib-orchestrator/limitRecovery/claudeLimitReader'
import type { LimitReading } from '../../../lib-orchestrator/limitRecovery/limitRecoveryApi.types'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import { AgentSessionContext } from '../shared/agentSessionContext'

/** A session's limit reading: the manager says where its transcript is, the reader reads its last turn. */
export class SessionLimitReads {
  private readonly sessions: SessionManager
  private readonly reader: Pick<ClaudeLimitReader, 'read'>
  private readonly antigravityReader?: Pick<AntigravityLimitReader, 'read'>

  constructor(
    sessions: SessionManager,
    reader: Pick<ClaudeLimitReader, 'read'>,
    antigravityReader?: Pick<AntigravityLimitReader, 'read'>,
  ) {
    this.sessions = sessions
    this.reader = reader
    this.antigravityReader = antigravityReader
  }

  async read(sessionId: string): Promise<LimitReading> {
    const context = await AgentSessionContext.of(this.sessions, sessionId)
    if (!context.ok) return { kind: 'none' }
    if (context.value.agentId === 'claude')
      return this.reader.read({ cwd: context.value.cwd, nativeSessionId: context.value.nativeSessionId })
    if (context.value.agentId === 'antigravity' && this.antigravityReader !== undefined)
      return this.antigravityReader.read({ cwd: context.value.cwd, nativeSessionId: context.value.nativeSessionId })
    return { kind: 'none' }
  }
}
