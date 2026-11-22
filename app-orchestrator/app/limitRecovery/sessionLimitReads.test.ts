import { describe, expect, it } from 'vitest'

import type { ClaudeLimitContext } from '../../../lib-orchestrator/limitRecovery/claudeLimitReader'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import { SessionLimitReads } from './sessionLimitReads'

describe('app-orchestrator/app/limitRecovery/sessionLimitReads', () => {
  const contexts: Record<string, { agentId: string | null; nativeSessionId: string | null }> = {
    claude: { agentId: 'claude', nativeSessionId: 'native-1' },
    codex: { agentId: 'codex', nativeSessionId: 'native-2' },
    pending: { agentId: 'claude', nativeSessionId: null },
  }
  const sessions = {
    transcriptContext: async (sessionId: string) => contexts[sessionId] === undefined
      ? { ok: false, code: 'unknown-session', detail: 'none' }
      : { ok: true, value: { ...contexts[sessionId], cwd: 'C:/work', launchModel: null } },
  } as unknown as SessionManager

  it('reads only a Claude session that names its conversation', async () => {
    const asked: ClaudeLimitContext[] = []
    const reads = new SessionLimitReads(sessions, { read: async (context) => {
      asked.push(context)
      return { kind: 'limit', recordId: 'r', at: 1, window: 'session', resetsAt: 2 }
    } })
    expect(await reads.read('claude')).toMatchObject({ kind: 'limit', recordId: 'r' })
    expect(await reads.read('codex')).toEqual({ kind: 'none' })
    expect(await reads.read('pending')).toEqual({ kind: 'none' })
    expect(await reads.read('nobody')).toEqual({ kind: 'none' })
    expect(asked).toEqual([{ cwd: 'C:/work', nativeSessionId: 'native-1' }])
  })
})
