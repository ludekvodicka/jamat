import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { SessionScriptOutput } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type {
  SessionShellOutput,
  SessionShellState,
  SessionSubagentState,
  SessionSubagentTranscript,
} from '../../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { TaskPaneStore, type TaskPaneTarget } from './taskPaneStore'

type Reply = IpcResult<RemoteControlStepResult<SessionSubagentTranscript>>
type ShellReply = IpcResult<RemoteControlStepResult<SessionShellOutput>>
type ScriptReply = IpcResult<RemoteControlStepResult<SessionScriptOutput>>

describe('app-client-ui/renderer/taskView/taskPaneStore', () => {
  const targetConst: TaskPaneTarget = { sessionId: 's-1', task: { kind: 'subagent', subagentId: 'a1' } }
  const shellTargetConst: TaskPaneTarget = { sessionId: 's-1', task: { kind: 'shell', shellId: 'b1' } }
  const scriptTargetConst: TaskPaneTarget = { sessionId: 's-1', task: { kind: 'script', runId: 'r1' } }

  function script(state: SessionScriptOutput['state'], source: SessionScriptOutput['source'], lines: string[]): ScriptReply {
    return { ok: true, value: { ok: true, value: { state, source, lines, terminal: null } } }
  }

  function transcript(state: SessionSubagentState, revision: string): Reply {
    return { ok: true, value: { ok: true, value: {
      kind: 'transcript',
      revision,
      header: { agentType: 'general-purpose', description: 'Edit a file', model: 'claude-opus-5', state, contextTokens: 1_000 },
      entries: [{ kind: 'prompt', text: 'Do it', truncated: false }],
      earlierStepsOmitted: false,
    } } }
  }

  function output(state: SessionShellState, revision: string, text: string): ShellReply {
    return { ok: true, value: { ok: true, value: {
      kind: 'output', revision, command: 'ping -n 30 127.0.0.1', state, startedAt: 1, endedAt: null, text,
      earlierOutputOmitted: false,
    } } }
  }

  function unchanged(revision: string): Reply {
    return { ok: true, value: { ok: true, value: { kind: 'unchanged', revision } } }
  }

  class Harness {
    readonly requests: Record<string, string>[] = []
    readonly replies: Reply[] = []
    readonly shellReplies: ShellReply[] = []
    readonly scriptReplies: ScriptReply[] = []
    readonly store: TaskPaneStore
    notified = 0

    constructor(visible = true, target = targetConst) {
      this.store = new TaskPaneStore(target, {
        transcript: (request) => {
          this.requests.push(request)
          const reply = this.replies.shift()
          if (reply === undefined) throw new Error('No reply left')
          return Promise.resolve(reply)
        },
        shellOutput: (request) => {
          this.requests.push(request)
          const reply = this.shellReplies.shift()
          if (reply === undefined) throw new Error('No reply left')
          return Promise.resolve(reply)
        },
        scriptOutput: (request) => {
          this.requests.push(request)
          const reply = this.scriptReplies.shift()
          if (reply === undefined) throw new Error('No reply left')
          return Promise.resolve(reply)
        },
      }, visible)
      this.store.subscribe(() => this.notified++)
    }
  }

  let stop: (() => void) | null = null

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    stop?.()
    stop = null
    vi.useRealTimers()
  })

  it('reads every 2 s while the agent runs, sending the revision it holds', async () => {
    const harness = new Harness()
    harness.replies.push(transcript('running', '1:10'), unchanged('1:10'), transcript('running', '2:20'))
    stop = harness.store.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.requests).toEqual([{ sessionId: 's-1', subagentId: 'a1' }])
    const first = harness.store.current()
    expect(first.kind).toBe('transcript')

    await vi.advanceTimersByTimeAsync(TaskPaneStore.refreshMillisecondsConst - 1)
    expect(harness.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.requests[1]).toEqual({ sessionId: 's-1', subagentId: 'a1', known: '1:10' })
    expect(harness.store.current()).toBe(first)
    expect(harness.notified).toBe(1)

    await vi.advanceTimersByTimeAsync(TaskPaneStore.refreshMillisecondsConst)
    expect(harness.requests[2]).toEqual({ sessionId: 's-1', subagentId: 'a1', known: '1:10' })
    expect(harness.store.current()).toMatchObject({ kind: 'transcript', revision: '2:20' })
  })

  it('stops after the read that finds the agent settled', async () => {
    const harness = new Harness()
    harness.replies.push(transcript('running', '1:10'), transcript('done', '2:20'))
    stop = harness.store.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(TaskPaneStore.refreshMillisecondsConst)
    expect(harness.store.current()).toMatchObject({ kind: 'transcript', header: { state: 'done' } })

    await vi.advanceTimersByTimeAsync(TaskPaneStore.refreshMillisecondsConst * 5)
    expect(harness.requests).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads once when the tab is shown again and follows a resumed agent', async () => {
    const harness = new Harness()
    harness.replies.push(transcript('done', '1:10'), transcript('running', '2:20'), transcript('running', '3:30'))
    stop = harness.store.start()
    await vi.advanceTimersByTimeAsync(0)
    harness.store.setVisible(false)
    harness.store.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.requests[1]).toEqual({ sessionId: 's-1', subagentId: 'a1', known: '1:10' })

    await vi.advanceTimersByTimeAsync(TaskPaneStore.refreshMillisecondsConst)
    expect(harness.requests).toHaveLength(3)
  })

  it('reads nothing while the tab is hidden or after another item became active', async () => {
    const hidden = new Harness(false)
    stop = hidden.store.start()
    await vi.advanceTimersByTimeAsync(TaskPaneStore.refreshMillisecondsConst * 3)
    expect(hidden.requests).toHaveLength(0)
    stop()

    const harness = new Harness()
    harness.replies.push(transcript('running', '1:10'), unchanged('1:10'))
    stop = harness.store.start()
    await vi.advanceTimersByTimeAsync(0)
    harness.store.setVisible(false)
    await vi.advanceTimersByTimeAsync(TaskPaneStore.refreshMillisecondsConst * 3)
    expect(harness.requests).toHaveLength(1)

    harness.store.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.requests).toHaveLength(2)
    stop()
    stop = null
    await vi.advanceTimersByTimeAsync(TaskPaneStore.refreshMillisecondsConst * 3)
    expect(harness.requests).toHaveLength(2)
  })

  it('draws a failure or a missing task and stops reading', async () => {
    const harness = new Harness()
    harness.replies.push(
      { ok: false, error: 'Channel closed' },
    )
    stop = harness.store.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.store.current()).toEqual({ kind: 'failed', reason: 'Channel closed' })

    const none = new Harness()
    none.replies.push({ ok: true, value: { ok: true, value: { kind: 'none', code: 'unknown-task', reason: 'No such sub-agent' } } })
    const stopNone = none.store.start()
    await vi.advanceTimersByTimeAsync(TaskPaneStore.refreshMillisecondsConst * 3)
    expect(none.store.current()).toEqual({ kind: 'none', reason: 'No such sub-agent' })
    expect(none.requests).toHaveLength(1)
    expect(harness.requests).toHaveLength(1)
    stopNone()
  })

  it('follows a running shell by its id every 2 s and stops after the read that finds it ended', async () => {
    const harness = new Harness(true, shellTargetConst)
    harness.shellReplies.push(
      output('running', '1:10:running', 'Reply 1\n'),
      { ok: true, value: { ok: true, value: { kind: 'unchanged', revision: '1:10:running' } } },
      output('done', '2:20:done', 'Reply 1\nReply 2\n'),
    )
    stop = harness.store.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.requests).toEqual([{ sessionId: 's-1', shellId: 'b1' }])
    expect(harness.store.current()).toMatchObject({ kind: 'output', text: 'Reply 1\n' })

    await vi.advanceTimersByTimeAsync(TaskPaneStore.refreshMillisecondsConst * 2)
    expect(harness.requests.slice(1)).toEqual([
      { sessionId: 's-1', shellId: 'b1', known: '1:10:running' },
      { sessionId: 's-1', shellId: 'b1', known: '1:10:running' },
    ])
    expect(harness.store.current()).toMatchObject({ kind: 'output', state: 'done', text: 'Reply 1\nReply 2\n' })

    await vi.advanceTimersByTimeAsync(TaskPaneStore.refreshMillisecondsConst * 5)
    expect(harness.requests).toHaveLength(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a script view through finished live reads until collapse supplies its saved log', async () => {
    const harness = new Harness(true, scriptTargetConst)
    harness.scriptReplies.push(
      script('running', 'live', ['installing']),
      script('succeeded', 'live', ['installed']),
      script('succeeded', 'live', ['installed']),
      script('succeeded', 'log', ['Setup', 'installed']),
    )
    stop = harness.store.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.store.current()).toMatchObject({ kind: 'script', output: { source: 'live', lines: ['installing'] } })
    await vi.advanceTimersByTimeAsync(TaskPaneStore.refreshMillisecondsConst * 2)
    expect(harness.store.current()).toMatchObject({ kind: 'script', output: { state: 'succeeded', source: 'live' } })
    await vi.advanceTimersByTimeAsync(TaskPaneStore.refreshMillisecondsConst)
    expect(harness.store.current()).toEqual({ kind: 'script', output: {
      state: 'succeeded', source: 'log', lines: ['Setup', 'installed'], terminal: null,
    } })
    await vi.advanceTimersByTimeAsync(TaskPaneStore.refreshMillisecondsConst * 5)
    expect(harness.requests).toEqual(Array.from({ length: 4 }, () => ({ sessionId: 's-1', runId: 'r1' })))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps script output through a transient read error and recovers on the next poll', async () => {
    const harness = new Harness(true, scriptTargetConst)
    harness.scriptReplies.push(
      script('running', 'live', ['installing']),
      { ok: false, error: 'Connection lost' },
      { ok: true, value: { ok: false, error: { code: 'unavailable', detail: 'Host reconnecting' } } },
      script('succeeded', 'log', ['installed']),
    )
    stop = harness.store.start()
    await vi.advanceTimersByTimeAsync(TaskPaneStore.refreshMillisecondsConst)
    expect(harness.store.current()).toMatchObject({ kind: 'script', error: 'Connection lost', output: { lines: ['installing'] } })
    await vi.advanceTimersByTimeAsync(TaskPaneStore.refreshMillisecondsConst)
    expect(harness.store.current()).toMatchObject({ kind: 'script', error: 'Host reconnecting', output: { lines: ['installing'] } })
    await vi.advanceTimersByTimeAsync(TaskPaneStore.refreshMillisecondsConst)
    expect(harness.store.current()).toEqual({ kind: 'script', output: {
      state: 'succeeded', source: 'log', lines: ['installed'], terminal: null,
    } })
  })

  it('retries an initial script read error but stops on an unknown run', async () => {
    const harness = new Harness(true, scriptTargetConst)
    harness.scriptReplies.push(
      { ok: false, error: 'Connection lost' },
      { ok: true, value: { ok: false, error: { code: 'not-found', detail: 'No such run' } } },
    )
    stop = harness.store.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.store.current()).toEqual({ kind: 'failed', reason: 'Connection lost' })
    await vi.advanceTimersByTimeAsync(TaskPaneStore.refreshMillisecondsConst * 5)
    expect(harness.store.current()).toEqual({ kind: 'failed', reason: 'No such run' })
    expect(harness.requests).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not poll a hidden script and reads its saved log when the tab returns', async () => {
    const harness = new Harness(true, scriptTargetConst)
    harness.scriptReplies.push(script('running', 'live', ['installing']), script('succeeded', 'log', ['installed']))
    stop = harness.store.start()
    await vi.advanceTimersByTimeAsync(0)
    harness.store.setVisible(false)
    await vi.advanceTimersByTimeAsync(TaskPaneStore.refreshMillisecondsConst * 5)
    expect(harness.requests).toHaveLength(1)
    harness.store.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.store.current()).toMatchObject({ kind: 'script', output: { source: 'log' } })
    expect(harness.requests).toHaveLength(2)
  })

  it('keeps the library reason for an unavailable saved log and stops polling', async () => {
    const harness = new Harness(true, scriptTargetConst)
    harness.scriptReplies.push({ ok: true, value: { ok: true, value: {
      state: 'lost', source: 'log', lines: [], terminal: null, logReason: 'The Host restarted before output was saved',
    } } })
    stop = harness.store.start()
    await vi.advanceTimersByTimeAsync(TaskPaneStore.refreshMillisecondsConst * 5)
    expect(harness.store.current()).toMatchObject({ kind: 'script', output: { logReason: 'The Host restarted before output was saved' } })
    expect(harness.requests).toHaveLength(1)
  })
})
