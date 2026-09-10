import { describe, expect, it } from 'vitest'

import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { SessionTranscriptContext, SessionTranscriptReader } from '../../../lib-orchestrator/sessionTranscriptReader/sessionTranscriptReader'
import type { SessionTranscriptReading } from '../../../lib-orchestrator/sessionTranscriptReader/sessionTranscriptReaderApi.types'
import { SessionTranscriptAccess } from './sessionTranscriptAccess'

describe('app-client-ui/app/sessionTranscript/sessionTranscriptAccess', () => {
  it('uses the session transcript context and the injected reader exactly once', async () => {
    const contexts: SessionTranscriptContext[] = []
    const sessions = {
      transcriptContext: () => Promise.resolve({
        ok: true as const,
        value: {
          agentId: 'claude' as const,
          cwd: 'Q:/old-worktree',
          nativeSessionId: 'native-1',
          launchModel: null,
        },
      }),
    } as unknown as SessionManager
    const reader = {
      read: (context: SessionTranscriptContext) => {
        contexts.push(context)
        return Promise.resolve(SessionTranscriptAccessTest.readingConst)
      },
    } as unknown as SessionTranscriptReader

    await expect(new SessionTranscriptAccess(sessions, reader).read('session-1'))
      .resolves.toEqual(SessionTranscriptAccessTest.readingConst)
    expect(contexts).toEqual([{
      agentId: 'claude',
      cwd: 'Q:/old-worktree',
      nativeSessionId: 'native-1',
      launchModel: null,
    }])
  })

  it('returns stable none results without calling the reader', async () => {
    let reads = 0
    const sessions = {
      transcriptContext: () => Promise.resolve({
        ok: true as const,
        value: { agentId: null, cwd: 'Q:/work', nativeSessionId: null },
      }),
    } as unknown as SessionManager
    const reader = { read: () => { reads += 1 } } as unknown as SessionTranscriptReader

    await expect(new SessionTranscriptAccess(sessions, reader).read('shell-1')).resolves.toEqual({
      kind: 'none',
      code: 'not-agent',
      reason: 'not an agent session',
    })
    expect(reads).toBe(0)
  })

  it('keeps every context and reader none code stable', async () => {
    const cases = [
      {
        context: { ok: false as const, code: 'unknown-session' as const, detail: 'unknown id' },
        reading: null,
        expected: { kind: 'none', code: 'transcript-not-found', reason: 'unknown id' },
      },
      {
        context: {
          ok: true as const,
          value: { agentId: null, cwd: 'Q:/work', nativeSessionId: null },
        },
        reading: null,
        expected: { kind: 'none', code: 'not-agent', reason: 'not an agent session' },
      },
      {
        context: {
          ok: true as const,
          value: { agentId: 'codex' as const, cwd: 'Q:/work', nativeSessionId: null },
        },
        reading: null,
        expected: {
          kind: 'none',
          code: 'native-session-id-pending',
          reason: 'the agent session has no native session id yet',
        },
      },
      {
        context: {
          ok: true as const,
          value: { agentId: 'codex' as const, cwd: 'Q:/work', nativeSessionId: 'native-1' },
        },
        reading: {
          kind: 'none' as const,
          code: 'transcript-not-found' as const,
          reason: 'exact transcript does not exist',
        },
        expected: {
          kind: 'none',
          code: 'transcript-not-found',
          reason: 'exact transcript does not exist',
        },
      },
      {
        context: {
          ok: true as const,
          value: { agentId: 'claude' as const, cwd: 'Q:/work', nativeSessionId: 'native-2' },
        },
        reading: {
          kind: 'none' as const,
          code: 'transcript-unreadable' as const,
          reason: 'read refused',
        },
        expected: { kind: 'none', code: 'transcript-unreadable', reason: 'read refused' },
      },
    ]

    for (const item of cases) {
      const sessions = {
        transcriptContext: () => Promise.resolve(item.context),
      } as unknown as SessionManager
      const reader = {
        read: () => Promise.resolve(item.reading),
      } as unknown as SessionTranscriptReader
      await expect(new SessionTranscriptAccess(sessions, reader).read('session-1'))
        .resolves.toEqual(item.expected)
    }
  })
})

class SessionTranscriptAccessTest {
  static readonly readingConst = {
    kind: 'messages',
    messages: [{ role: 'assistant', text: 'done', at: 2, textTruncated: false }],
    bounds: { maxMessages: 10, maxCharactersPerMessage: 2_000, scannedBytes: 100 },
    earlierContentOmitted: false,
  } as const satisfies SessionTranscriptReading
}
