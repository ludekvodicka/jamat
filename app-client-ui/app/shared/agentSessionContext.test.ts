import { describe, expect, it } from 'vitest'

import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import { AgentSessionContext } from './agentSessionContext'

describe('app-client-ui/app/shared/agentSessionContext', () => {
  it('uses transcript provenance rather than the current working context', async () => {
    const sessions = {
      transcriptContext: () => Promise.resolve({
        ok: true as const,
        value: {
          agentId: 'codex' as const,
          cwd: 'Q:/Repo/.worktrees/original',
          nativeSessionId: 'native-1',
        },
      }),
      workingContext: () => Promise.resolve({
        ok: true as const,
        value: { cwd: 'Q:/Repo', agent: null, sessionId: 'session-1', worktree: null },
      }),
    } as unknown as SessionManager

    await expect(AgentSessionContext.of(sessions, 'session-1')).resolves.toEqual({
      ok: true,
      value: {
        agentId: 'codex',
        cwd: 'Q:/Repo/.worktrees/original',
        nativeSessionId: 'native-1',
      },
    })
  })

  it('returns stable codes without guessing another transcript', async () => {
    const cases = [
      {
        value: { agentId: null, cwd: 'Q:/Repo', nativeSessionId: null },
        code: 'not-agent',
      },
      {
        value: { agentId: 'claude' as const, cwd: 'Q:/Repo', nativeSessionId: null },
        code: 'native-session-id-pending',
      },
    ] as const

    for (const item of cases) {
      const sessions = {
        transcriptContext: () => Promise.resolve({ ok: true as const, value: item.value }),
      } as unknown as SessionManager
      await expect(AgentSessionContext.of(sessions, 'session-1'))
        .resolves.toMatchObject({ ok: false, code: item.code })
    }

    const missing = {
      transcriptContext: () => Promise.resolve({
        ok: false as const,
        code: 'unknown-session' as const,
        detail: 'Session missing does not exist',
      }),
    } as unknown as SessionManager
    await expect(AgentSessionContext.of(missing, 'missing')).resolves.toEqual({
      ok: false,
      code: 'transcript-not-found',
      reason: 'Session missing does not exist',
    })
  })
})
