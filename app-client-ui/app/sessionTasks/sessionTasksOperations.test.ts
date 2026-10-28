import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RemoteControlPeerConst } from '../../../lib-orchestrator/remoteControl/remoteControlPeerProtocol'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { SessionInfo, SessionScriptOutput } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SessionTasks, SessionTasksContext } from '../../../lib-orchestrator/sessionTasks/sessionTasks'
import type {
  SessionShellOutput,
  SessionSubagentTranscript,
  SessionTaskListing,
  SessionTaskParentState,
} from '../../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import type { TabControlTaskItem } from '../../shared/tabControl'
import { RegistryBench } from '../remoteControl/fixtures/registryBench'
import type { TabControlBroker } from '../tabs/tabControlBroker'
import { SessionTasksOperations } from './sessionTasksOperations'

describe('app-client-ui/app/sessionTasks/sessionTasksOperations', () => {
  const listingConst: SessionTaskListing = { kind: 'tasks', rows: [], olderFinished: 0, catchingUp: false }
  const sessionsConst = {
    'agent-1': { agentId: 'claude' as const, nativeSessionId: 'native-1' as string | null, life: 'live', activity: 'working' },
    'agent-idle': { agentId: 'claude' as const, nativeSessionId: 'native-2' as string | null, life: 'ended', activity: 'idle' },
    'shell-1': { agentId: null, nativeSessionId: null, life: 'live', activity: null },
    'agent-unlaunched': { agentId: 'claude' as const, nativeSessionId: null, life: 'starting', activity: null },
  }
  const transcriptConst: SessionSubagentTranscript = { kind: 'unchanged', revision: '1:2' }
  const shellOutputConst: SessionShellOutput = { kind: 'unchanged', revision: '1:2:running' }
  const scriptOutputConst: SessionScriptOutput = {
    state: 'succeeded', source: 'log', lines: ['done'], terminal: null, endedAt: 123,
  }
  let scriptReads: { sessionId: string; runId: string }[]
  let reads: { context: SessionTasksContext; parent: SessionTaskParentState }[]
  let transcriptReads: {
    context: SessionTasksContext
    subagentId: string
    parent: SessionTaskParentState
    known: string | null
  }[]
  let shellReads: {
    context: SessionTasksContext
    shellId: string
    parent: SessionTaskParentState
    known: string | null
  }[]
  let bench: RegistryBench
  let opens: { tabTitle: string; item: TabControlTaskItem }[]
  let workflows: { sessionId: string; tabTitle: string }[]

  function tabsUnderTest(): Pick<TabControlBroker, 'openTask' | 'openWorkflow'> {
    return {
      openTask: (tabTitle, item) => {
        opens.push({ tabTitle, item })
        return Promise.resolve({ ok: true, value: { kind: 'task-opened', panelId: 'terminal:agent-1', windowId: 'second' } })
      },
      openWorkflow: (sessionId, tabTitle) => {
        workflows.push({ sessionId, tabTitle })
        return Promise.resolve({ ok: true, value: { kind: 'workflow-opened', panelId: `terminal:${sessionId}`, windowId: 'second' } })
      },
    }
  }

  function tasksUnderTest(): SessionTasks {
    return {
      list: (context: SessionTasksContext, parent: SessionTaskParentState) => {
        reads.push({ context, parent })
        return Promise.resolve(listingConst)
      },
      transcript: (
        context: SessionTasksContext,
        subagentId: string,
        parent: SessionTaskParentState,
        known: string | null,
      ) => {
        transcriptReads.push({ context, subagentId, parent, known })
        return Promise.resolve(transcriptConst)
      },
      shellOutput: (
        context: SessionTasksContext,
        shellId: string,
        parent: SessionTaskParentState,
        known: string | null,
      ) => {
        shellReads.push({ context, shellId, parent, known })
        return Promise.resolve(shellOutputConst)
      },
    } as unknown as SessionTasks
  }

  function sessionsUnderTest(): SessionManager {
    return {
      scriptOutputOf: async (sessionId: string, runId: string) => {
        scriptReads.push({ sessionId, runId })
        return sessionId === 'shell-1' && runId === 'run-1'
          ? { ok: true, value: scriptOutputConst }
          : { ok: false, code: 'not-found', detail: `Session ${sessionId} has no script run ${runId}` }
      },
      transcriptContext: (sessionId: string) => {
        const found = sessionsConst[sessionId as keyof typeof sessionsConst]
        if (!found)
          return Promise.resolve({
            ok: false as const,
            code: 'unknown-session' as const,
            detail: `Session ${sessionId} does not exist`,
          })
        return Promise.resolve({
          ok: true as const,
          value: {
            agentId: found.agentId,
            cwd: 'C:/work',
            nativeSessionId: found.nativeSessionId,
            launchModel: 'claude-opus-5[1m]',
          },
        })
      },
      snapshot: () => ({
        sessions: Object.entries(sessionsConst).map(([sessionId, one]) =>
          ({ sessionId, life: one.life, activity: one.activity, tabTitle: `Tab ${sessionId}`,
            scripts: sessionId === 'shell-1' ? { runs: [{ runId: 'run-1', row: false, title: 'Source setup' }] } : undefined }) as unknown as SessionInfo),
      }),
    } as unknown as SessionManager
  }

  beforeEach(() => {
    bench = new RegistryBench()
    reads = []
    transcriptReads = []
    shellReads = []
    scriptReads = []
    opens = []
    workflows = []
    new SessionTasksOperations(tasksUnderTest(), sessionsUnderTest(), tabsUnderTest()).register(bench.registry)
  })

  it('derives shareable task titles from source readers and refuses foreign runs and missing native identity', async () => {
    const tasks = tasksUnderTest()
    const operations = new SessionTasksOperations(tasks, sessionsUnderTest(), tabsUnderTest())
    vi.spyOn(tasks, 'transcript').mockResolvedValue({ kind: 'transcript', revision: 'source',
      header: { agentType: 'Explore', description: 'Source task', model: null, state: 'done', contextTokens: null }, entries: [], earlierStepsOmitted: false })
    vi.spyOn(tasks, 'shellOutput').mockResolvedValue({ kind: 'output', revision: 'source', command: 'source-command', state: 'done',
      startedAt: 1, endedAt: 2, text: 'source bytes', earlierOutputOmitted: false })
    expect(await operations.itemOf('agent-1', { kind: 'subagent', subagentId: 'agent' })).toMatchObject({ sessionId: 'agent-1', title: 'Explore: Source task' })
    expect(await operations.itemOf('agent-1', { kind: 'shell', shellId: 'shell' })).toMatchObject({ sessionId: 'agent-1', title: '$ source-command' })
    expect(await operations.itemOf('shell-1', { kind: 'script', runId: 'run-1' })).toMatchObject({ sessionId: 'shell-1', title: 'Source setup', task: { kind: 'script', runId: 'run-1' } })
    await expect(operations.itemOf('agent-1', { kind: 'script', runId: 'run-1' })).rejects.toThrow('no script run')
    await expect(operations.itemOf('agent-unlaunched', { kind: 'subagent', subagentId: 'agent' })).rejects.toThrow()
    expect(tasks.transcript).toHaveBeenCalledTimes(1)
  })

  it('registers its read operations and the open write, none of which a peer can be granted', () => {
    expect(bench.registry.names().sort())
      .toEqual(['sessionTasks.list', 'sessionTasks.open', 'sessionTasks.openWorkflow', 'sessionTasks.shellOutput', 'sessionTasks.transcript',
        'sessions.scriptOutput'])
    for (const name of ['sessionTasks.list', 'sessionTasks.transcript', 'sessionTasks.shellOutput', 'sessionTasks.open', 'sessionTasks.openWorkflow',
      'sessions.scriptOutput']) {
      expect(bench.registry.isWrite(name)).toBe(name === 'sessionTasks.open' || name === 'sessionTasks.openWorkflow')
      expect(RemoteControlPeerConst.controlOperations as readonly string[]).not.toContain(name)
    }
  })

  it('reads script output for a local shell parent and preserves a missing-run refusal', async () => {
    expect(await bench.call('sessions.scriptOutput', { sessionId: 'shell-1', runId: 'run-1' }))
      .toEqual({ ok: true, value: scriptOutputConst })
    expect(await bench.call('sessions.scriptOutput', { sessionId: 'shell-1', runId: 'missing' }))
      .toEqual({ ok: false, error: {
        code: 'not-found', detail: 'Session shell-1 has no script run missing', data: { sourceCode: 'not-found' },
      } })
    expect(scriptReads).toEqual([
      { sessionId: 'shell-1', runId: 'run-1' }, { sessionId: 'shell-1', runId: 'missing' },
    ])
  })

  it('validates both script output ids and refuses caller-provided file paths', async () => {
    for (const body of [
      { sessionId: '', runId: 'run-1' },
      { sessionId: 'shell-1', runId: '' },
      { sessionId: 'shell-1' },
      { sessionId: 'shell-1', runId: 'run-1', file: 'C:/other.log' },
    ])
      expect((await bench.call('sessions.scriptOutput', body)).ok).toBe(false)
    expect(scriptReads).toEqual([])
  })

  it("opens a sub-agent in its parent's split under the session's tab title, keyed by session and id", async () => {
    expect(await bench.call('sessionTasks.open', {
      sessionId: 'agent-1',
      task: { kind: 'subagent', subagentId: 'a1' },
      title: 'Explore: Look at docs',
    })).toEqual({ ok: true, value: { panelId: 'terminal:agent-1' } })

    expect(opens).toEqual([{
      tabTitle: 'Tab agent-1',
      item: { key: 'task:agent-1:subagent:a1', title: 'Explore: Look at docs', sessionId: 'agent-1',
        task: { kind: 'subagent', subagentId: 'a1' } },
    }])
  })

  it("opens a background shell in its parent's split, keyed by session and shell id", async () => {
    expect(await bench.call('sessionTasks.open', {
      sessionId: 'agent-1',
      task: { kind: 'shell', shellId: 'b1' },
      title: '$ ping -n 30 127.0.0.1',
    })).toEqual({ ok: true, value: { panelId: 'terminal:agent-1' } })

    expect(opens).toEqual([{
      tabTitle: 'Tab agent-1',
      item: { key: 'task:agent-1:shell:b1', title: '$ ping -n 30 127.0.0.1', sessionId: 'agent-1',
        task: { kind: 'shell', shellId: 'b1' } },
    }])
  })

  it("opens a session's workflow in its own tab under the session's tab title, and refuses an unknown session", async () => {
    expect(await bench.call('sessionTasks.openWorkflow', { sessionId: 'agent-1' }))
      .toEqual({ ok: true, value: { panelId: 'terminal:agent-1' } })
    expect(workflows).toEqual([{ sessionId: 'agent-1', tabTitle: 'Tab agent-1' }])
    expect(await bench.call('sessionTasks.openWorkflow', { sessionId: 'nobody' })).toMatchObject({ ok: false, error: { code: 'not-found' } })
    expect(workflows).toHaveLength(1)
  })

  it('refuses to open a task of an unknown session, or one named by a path', async () => {
    expect(await bench.call('sessionTasks.open', {
      sessionId: 'nobody', task: { kind: 'subagent', subagentId: 'a1' }, title: 'Explore: x',
    })).toMatchObject({ ok: false, error: { code: 'not-found' } })
    expect((await bench.call('sessionTasks.open', {
      sessionId: 'agent-1', task: { kind: 'subagent', subagentId: 'a1', file: 'C:/x.jsonl' }, title: 'Explore: x',
    })).ok).toBe(false)
    expect(opens).toEqual([])
  })

  it('opens a saved script run in its parent split without requiring an agent identity or a live record', async () => {
    expect(await bench.call('sessionTasks.open', {
      sessionId: 'shell-1', task: { kind: 'script', runId: 'run-1' }, title: 'Setup project',
    })).toEqual({ ok: true, value: { panelId: 'terminal:agent-1' } })
    expect(opens).toEqual([{
      tabTitle: 'Tab shell-1',
      item: { key: 'task:shell-1:script:run-1', title: 'Setup project', sessionId: 'shell-1',
        task: { kind: 'script', runId: 'run-1' } },
    }])
    expect(scriptReads).toEqual([])
  })

  it('refuses a script under the wrong parent, an unknown run and malformed script refs before opening', async () => {
    for (const body of [
      { sessionId: 'agent-1', task: { kind: 'script', runId: 'run-1' }, title: 'Setup' },
      { sessionId: 'shell-1', task: { kind: 'script', runId: 'missing' }, title: 'Setup' },
      { sessionId: 'shell-1', task: { kind: 'script', runId: '' }, title: 'Setup' },
      { sessionId: 'shell-1', task: { kind: 'script' }, title: 'Setup' },
      { sessionId: 'shell-1', task: { kind: 'script', runId: 'run-1', file: 'C:/other.log' }, title: 'Setup' },
    ])
      expect((await bench.call('sessionTasks.open', body)).ok).toBe(false)
    expect(opens).toEqual([])
  })

  it('answers each id, passing the snapshot life and activity of the parent', async () => {
    const before = Date.now()

    expect(await bench.call('sessionTasks.list', { sessionIds: ['agent-1', 'agent-idle'] })).toEqual({
      ok: true,
      value: { 'agent-1': listingConst, 'agent-idle': listingConst },
    })

    expect(reads.map((read) => [read.context, read.parent.live, read.parent.busy])).toEqual([
      [{ agentId: 'claude', cwd: 'C:/work', nativeSessionId: 'native-1' }, true, true],
      [{ agentId: 'claude', cwd: 'C:/work', nativeSessionId: 'native-2' }, false, false],
    ])
    expect(reads[0]!.parent.now).toBeGreaterThanOrEqual(before)
  })

  it('reads nothing for an unknown id, a shell session or an agent with no native session id', async () => {
    expect(await bench.call('sessionTasks.list', { sessionIds: ['nobody', 'shell-1', 'agent-unlaunched'] })).toEqual({
      ok: true,
      value: {
        nobody: { kind: 'none', code: 'transcript-not-found', reason: 'Session nobody does not exist' },
        'shell-1': { kind: 'none', code: 'not-agent', reason: 'not an agent session' },
        'agent-unlaunched': {
          kind: 'none',
          code: 'native-session-id-pending',
          reason: 'the agent session has no native session id yet',
        },
      },
    })
    expect(reads).toEqual([])
  })

  it('refuses more than 64 ids in one call', async () => {
    const answer = await bench.call('sessionTasks.list', {
      sessionIds: Array.from({ length: 65 }, (_, index) => `agent-${index}`),
    })

    expect(answer.ok).toBe(false)
    expect(reads).toEqual([])
  })

  it('reads one sub-agent transcript with the parent state and the known revision', async () => {
    expect(await bench.call('sessionTasks.transcript', { sessionId: 'agent-1', subagentId: 'a1', known: '1:2' }))
      .toEqual({ ok: true, value: transcriptConst })
    expect(await bench.call('sessionTasks.transcript', { sessionId: 'agent-idle', subagentId: 'a2' }))
      .toEqual({ ok: true, value: transcriptConst })

    expect(transcriptReads.map((read) => [read.context, read.subagentId, read.parent.live, read.parent.busy, read.known]))
      .toEqual([
        [{ agentId: 'claude', cwd: 'C:/work', nativeSessionId: 'native-1' }, 'a1', true, true, '1:2'],
        [{ agentId: 'claude', cwd: 'C:/work', nativeSessionId: 'native-2' }, 'a2', false, false, null],
      ])
  })

  it('reads no transcript for a shell session, and refuses a body with a path', async () => {
    expect(await bench.call('sessionTasks.transcript', { sessionId: 'shell-1', subagentId: 'a1' })).toEqual({
      ok: true,
      value: { kind: 'none', code: 'not-agent', reason: 'not an agent session' },
    })
    const answer = await bench.call('sessionTasks.transcript', {
      sessionId: 'agent-1',
      subagentId: 'a1',
      file: 'C:/x.jsonl',
    })

    expect(answer.ok).toBe(false)
    expect(transcriptReads).toEqual([])
  })

  it('reads one shell output with the parent state and the known revision', async () => {
    expect(await bench.call('sessionTasks.shellOutput', { sessionId: 'agent-1', shellId: 'b1', known: '1:2:running' }))
      .toEqual({ ok: true, value: shellOutputConst })
    expect(await bench.call('sessionTasks.shellOutput', { sessionId: 'agent-idle', shellId: 'b2' }))
      .toEqual({ ok: true, value: shellOutputConst })

    expect(shellReads.map((read) => [read.context, read.shellId, read.parent.live, read.parent.busy, read.known]))
      .toEqual([
        [{ agentId: 'claude', cwd: 'C:/work', nativeSessionId: 'native-1' }, 'b1', true, true, '1:2:running'],
        [{ agentId: 'claude', cwd: 'C:/work', nativeSessionId: 'native-2' }, 'b2', false, false, null],
      ])
  })

  it('reads no shell output for a shell session, and refuses a body with a path', async () => {
    expect(await bench.call('sessionTasks.shellOutput', { sessionId: 'shell-1', shellId: 'b1' })).toEqual({
      ok: true,
      value: { kind: 'none', code: 'not-agent', reason: 'not an agent session' },
    })
    expect((await bench.call('sessionTasks.shellOutput', { sessionId: 'agent-1', shellId: 'b1', file: 'C:/b1.output' })).ok)
      .toBe(false)
    expect(shellReads).toEqual([])
  })
})
