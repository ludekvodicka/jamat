import type {
  SessionAgentId,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'

/**
 * Everything a transcript reader needs: where one session's file is, and what its launch asked the
 * agent to run on. The second is not decoration - a Claude transcript records the bare model id and
 * never the `[1m]` tier, so the reader that draws the context window learns it here or nowhere.
 */
export interface AgentSessionWorkingContext {
  agentId: SessionAgentId
  cwd: string
  nativeSessionId: string
  launchModel: string | null
}

/**
 * The gate both transcript readers sit behind, written once.
 *
 * Two services ask the same question - what is this session running on, and what did it last say -
 * and each held the same seven lines down to the sentence. What the gate refuses matters more than
 * its length: a session id that names nothing, a shell session, and an agent that has not launched
 * yet all answer `none` WITHOUT the reader being asked. V1 fell back to the newest transcript in the
 * directory instead, so a tab opened beside a busy session drew that session's conversation.
 */
export class AgentSessionContext {
  static async of(
    sessions: SessionManager,
    sessionId: string,
  ): Promise<
    | { ok: true; value: AgentSessionWorkingContext }
    | {
      ok: false
      code: 'not-agent' | 'native-session-id-pending' | 'transcript-not-found'
      reason: string
    }
  > {
    const context = await sessions.transcriptContext(sessionId)
    if (!context.ok)
      return { ok: false, code: 'transcript-not-found', reason: context.detail }
    if (context.value.agentId === null)
      return { ok: false, code: 'not-agent', reason: 'not an agent session' }
    if (context.value.nativeSessionId === null)
      return {
        ok: false,
        code: 'native-session-id-pending',
        reason: 'the agent session has no native session id yet',
      }
    return {
      ok: true,
      value: {
        agentId: context.value.agentId,
        cwd: context.value.cwd,
        nativeSessionId: context.value.nativeSessionId,
        launchModel: context.value.launchModel,
      },
    }
  }
}
