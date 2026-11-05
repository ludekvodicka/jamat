import { beforeEach, describe, expect, it } from 'vitest'

import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type {
  SessionModelReader,
} from '../../../lib-orchestrator/sessionModelReader/sessionModelReader'
import type {
  SessionModelReading,
} from '../../../lib-orchestrator/sessionModelReader/sessionModelReaderApi.types'
import type {
  SessionModelContext,
} from '../../../lib-orchestrator/sessionModelReader/sessionModelSource'
import { RegistryBench } from '../remoteControl/fixtures/registryBench'
import { SessionModelOperations } from './sessionModelOperations'

describe('app-client-ui/app/sessionModel/sessionModelOperations', () => {
  const readingConst: SessionModelReading = {
    kind: 'ok',
    info: {
      model: 'claude-sonnet-4-5-20250929',
      modelLabel: 'Sonnet 4.5',
      effortLevel: 'high',
      contextTokens: 90_000,
      contextWindow: 1_000_000,
    },
  }
  /**
   * One record per session id, so a test says which kind of session it is asking about.
   *
   * The unlaunched agent IS an agent - that is the whole case. It used to carry `agent: null`, the
   * same bytes as the shell beside it, so the second half of the gate's name named nothing: the fake
   * was handed the reduced answer and never performed the reduction.
   */
  const sessionsConst = {
    'agent-1': { kind: 'agent' as const, cwd: 'C:/work', agent: { agentId: 'claude' as const, nativeSessionId: 'native-1', model: 'claude-opus-5[1m]' as string | null } },
    'shell-1': { kind: 'shell' as const, cwd: 'C:/work', agent: null },
    'agent-unlaunched': { kind: 'agent' as const, cwd: 'C:/work', agent: { agentId: 'claude' as const, nativeSessionId: '', model: null as string | null } },
  }
  let reads: SessionModelContext[]
  let bench: RegistryBench

  function readerUnderTest(): SessionModelReader {
    return {
      read: (context: SessionModelContext) => {
        reads.push(context)
        return Promise.resolve(readingConst)
      },
    } as unknown as SessionModelReader
  }

  function sessionsUnderTest(): SessionManager {
    return {
      transcriptContext: (sessionId: string) => {
        const found = sessionsConst[sessionId as keyof typeof sessionsConst]
        if (!found)
          return Promise.resolve({
            ok: false as const,
            code: 'unknown-session' as const,
            detail: `Session ${sessionId} does not exist`,
          })
        const agent = found.kind === 'agent' ? found.agent : null
        return Promise.resolve({
          ok: true as const,
          value: {
            agentId: agent?.agentId ?? null,
            cwd: found.cwd,
            nativeSessionId: agent?.nativeSessionId || null,
            launchModel: agent?.model ?? null,
          },
        })
      },
    } as unknown as SessionManager
  }

  beforeEach(() => {
    bench = new RegistryBench()
    reads = []
    new SessionModelOperations(readerUnderTest(), sessionsUnderTest()).register(bench.registry)
  })

  /** Each channel the window used to call, by the operation it is now. */
  async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (channel === 'sessionModel:get') return bench.call('sessions.model', { sessionId: args[0] })
    throw new Error(`No operation for ${channel}`)
  }

  it('registers its operations', () => {
    expect(bench.registry.names().sort()).toEqual(['sessions.model'])
  })

  it('answers an unknown session with the detail the manager gave, and reads nothing', async () => {
    expect(await invoke('sessionModel:get', 'nobody')).toEqual({
      ok: true,
      value: { kind: 'none', reason: 'Session nobody does not exist' },
    })
    expect(reads).toEqual([])
  })

  /*
   * The gate, and the reason it is measured by what the reader was NOT asked: V1 answered a session
   * it had no id for with the newest transcript in the directory, so a tab opened next to a busy
   * session drew that session's context and warned about a conversation the user was not having.
   */
  it('reads nothing for a shell session or an agent that has no native session id', async () => {
    expect(await invoke('sessionModel:get', 'shell-1')).toEqual({
      ok: true,
      value: { kind: 'none', reason: 'not an agent session' },
    })
    expect(await invoke('sessionModel:get', 'agent-unlaunched')).toEqual({
      ok: true,
      value: { kind: 'none', reason: 'the agent session has no native session id yet' },
    })
    expect(reads).toEqual([])
  })

  /*
   * The launch model travels with the rest, and it is the only one of the four the transcript cannot
   * answer: Claude records `claude-opus-5` for a session running on the million-token tier, so the
   * window drawn without this is a fifth of the real one.
   */
  it('hands the reader the agent, the directory, the native id and the launch model', async () => {
    expect(await invoke('sessionModel:get', 'agent-1')).toEqual({ ok: true, value: readingConst })

    expect(reads).toEqual([{
      agentId: 'claude',
      cwd: 'C:/work',
      nativeSessionId: 'native-1',
      launchModel: 'claude-opus-5[1m]',
    }])
    // Composed field by field rather than forwarded: the session id the caller named has no field
    // to travel in, so a record that grows one cannot carry it over this seam.
    expect(Object.keys(reads[0]!).sort())
      .toEqual(['agentId', 'cwd', 'launchModel', 'nativeSessionId'])
  })
})
