import { z } from 'zod'

import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import { RemoteControlZod } from '../../../lib-orchestrator/remoteControl/remoteControlSchemas'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { SessionModelReader } from '../../../lib-orchestrator/sessionModelReader/sessionModelReader'
import type { SessionModelReading } from '../../../lib-orchestrator/sessionModelReader/sessionModelReaderApi.types'
import type { AppOperationMap } from '../../shared/appOperationMap'
import { AgentSessionContext } from '../shared/agentSessionContext'

/**
 * The model, the effort and how full the context is for one session: the manager says where the
 * session works and who is working there, and the library reads the transcript that agent writes.
 *
 * The gate in front of the reader is the point of this class. A session id that names nothing, a
 * shell session and an agent session with no native session id all answer `none` here, and the
 * reader is never asked. V1 fell back to the newest transcript in the directory when it had no id,
 * and a freshly opened tab then drew the neighbouring session's context. There is no fallback to
 * reach for: an id is either known or this answers nothing.
 */
export class SessionModelOperations {
  constructor(
    private readonly reader: SessionModelReader,
    private readonly sessions: SessionManager,
  ) {}

  register(registry: Pick<RemoteControlRegistry, 'registrar'>): void {
    const op = registry.registrar<AppOperationMap>()
    op('sessions.model', {
      kind: 'read',
      description: "The model, the effort and how full the context is, read from the session's own transcript.",
      input: z.strictObject({ sessionId: RemoteControlZod.text() }),
      run: async (body) => ({ ok: true, value: await this.get(body.sessionId) }),
    })
  }

  private async get(sessionId: string): Promise<SessionModelReading> {
    const context = await AgentSessionContext.of(this.sessions, sessionId)
    if (!context.ok) return { kind: 'none', reason: context.reason }
    return this.reader.read(context.value)
  }
}
