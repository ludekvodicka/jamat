import type { SessionInfo } from './sessionManagerApi.types'

export type SessionPromptInsertRefusal = 'not-live' | 'no-agent' | 'agent-waiting'

export class SessionPromptInsert {
  static refusal(session: Pick<SessionInfo, 'life' | 'agent' | 'activity'>): SessionPromptInsertRefusal | null {
    switch (session.life) {
      case 'starting':
      case 'ended':
      case 'lost': return 'not-live'
      case 'live': break
      default: throw new Error(`Unknown session life: ${session.life satisfies never}`)
    }
    if (!session.agent) return 'no-agent'
    switch (session.agent.agentId) {
      case 'claude':
      case 'codex': break
      default: throw new Error(`Unknown session agent: ${session.agent.agentId satisfies never}`)
    }
    switch (session.activity) {
      case 'waiting': return 'agent-waiting'
      case 'idle':
      case 'working':
      case 'unknown': return null
      case null: return 'no-agent'
      default: throw new Error(`Unknown session activity: ${session.activity satisfies never}`)
    }
  }
}
