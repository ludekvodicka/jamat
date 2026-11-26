import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { SessionTaskListing, SessionTaskRow } from '../../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { ProcessesPaneStore } from './processesPaneStore'

type Reply = IpcResult<RemoteControlStepResult<Record<string, SessionTaskListing>>>
type LinesReply = IpcResult<RemoteControlStepResult<readonly { runId: string; line: string | null }[]>>

function linesReply(lines: readonly { runId: string; line: string | null }[]): LinesReply {
  return { ok: true, value: { ok: true, value: lines } }
}

function shellRow(id: string, state: 'running' | 'done' = 'running'): SessionTaskRow {
  return {
    kind: 'shell',
    shellId: id,
    command: 'sleep 60',
    description: 'wait',
    state,
    startedAt: 10_000,
    endedAt: state === 'running' ? null : 15_000,
    runs: 'command',
  }
}

function tasksReply(sessionId: string, rows: readonly SessionTaskRow[]): Reply {
  return {
    ok: true,
    value: {
      ok: true,
      value: {
        [sessionId]: { kind: 'tasks', rows, olderFinished: 0, catchingUp: false },
      },
    },
  }
}

describe('app-client-ui/renderer/processes/processesPaneStore', () => {
  let stop: (() => void) | null = null

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    stop?.()
    stop = null
    vi.useRealTimers()
  })

  it('polls every 3 s while visible, stops while hidden, and reads immediately when shown again', async () => {
    const calls: (readonly string[])[] = []
    const replies: Reply[] = [
      tasksReply('s1', [shellRow('b1', 'running')]),
      tasksReply('s1', [shellRow('b1', 'done')]),
      tasksReply('s1', [shellRow('b1', 'done'), shellRow('b2', 'running')]),
    ]
    const store = new ProcessesPaneStore('s1', {
      listTasks: (sessionIds) => {
        calls.push(sessionIds)
        const reply = replies.shift()
        if (reply === undefined) throw new Error('No reply left')
        return Promise.resolve(reply)
      },
      scriptLastLines: vi.fn(async () => linesReply([])),
    }, true)

    stop = store.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([['s1']])
    expect(store.current().rows).toHaveLength(1)
    expect(store.current().error).toBeNull()

    await vi.advanceTimersByTimeAsync(ProcessesPaneStore.refreshMillisecondsConst - 1)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2)
    expect(store.current().rows[0]).toMatchObject({ kind: 'shell', shellId: 'b1', state: 'done' })

    store.setVisible(false)
    await vi.advanceTimersByTimeAsync(ProcessesPaneStore.refreshMillisecondsConst * 4)
    expect(calls).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)

    store.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(3)
    expect(store.current().rows).toHaveLength(2)
  })

  it('makes no call when started hidden until shown', async () => {
    const listTasks = vi.fn(async () => tasksReply('s1', [shellRow('b1')]))
    const scriptLastLines = vi.fn(async () => linesReply([{ runId: 'svc-1', line: 'ok' }]))
    const store = new ProcessesPaneStore('s1', { listTasks, scriptLastLines }, false, true)

    stop = store.start()
    await vi.advanceTimersByTimeAsync(ProcessesPaneStore.refreshMillisecondsConst * 3)
    expect(listTasks).not.toHaveBeenCalled()
    expect(scriptLastLines).not.toHaveBeenCalled()

    store.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(listTasks).toHaveBeenCalledTimes(1)
    expect(scriptLastLines).toHaveBeenCalledTimes(1)
  })

  it('keeps single-flight reads without overlapping calls', async () => {
    let resolveFirst: ((value: Reply) => void) | null = null
    const listTasks = vi.fn(() => new Promise<Reply>((resolve) => { resolveFirst = resolve }))
    const store = new ProcessesPaneStore('s1', { listTasks, scriptLastLines: vi.fn(async () => linesReply([])) }, true)

    stop = store.start()
    expect(listTasks).toHaveBeenCalledTimes(1)
    store.setVisible(false)
    store.setVisible(true)
    await vi.advanceTimersByTimeAsync(ProcessesPaneStore.refreshMillisecondsConst * 2)
    expect(listTasks).toHaveBeenCalledTimes(1)

    resolveFirst!(tasksReply('s1', [shellRow('b1')]))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.current().rows).toHaveLength(1)
  })

  it('keeps the last rows on a refused listing, reports the error, and clears it on recovery', async () => {
    const replies: Reply[] = [
      tasksReply('s1', [shellRow('b1', 'running')]),
      { ok: true, value: { ok: false, error: { code: 'unavailable', detail: 'Host offline' } } },
      { ok: false, error: 'IPC closed' },
      tasksReply('s1', [shellRow('b1', 'running')]),
    ]
    const store = new ProcessesPaneStore('s1', {
      listTasks: () => Promise.resolve(replies.shift()!),
      scriptLastLines: vi.fn(async () => linesReply([])),
    }, true)

    stop = store.start()
    await vi.advanceTimersByTimeAsync(0)
    const firstRows = store.current().rows
    expect(firstRows).toHaveLength(1)
    expect(store.current().error).toBeNull()

    await vi.advanceTimersByTimeAsync(ProcessesPaneStore.refreshMillisecondsConst)
    expect(store.current().rows).toBe(firstRows)
    expect(store.current().error).toBe('Reading processes: Host offline')

    await vi.advanceTimersByTimeAsync(ProcessesPaneStore.refreshMillisecondsConst)
    expect(store.current().rows).toBe(firstRows)
    expect(store.current().error).toBe('Reading processes: IPC closed')

    await vi.advanceTimersByTimeAsync(ProcessesPaneStore.refreshMillisecondsConst)
    expect(store.current().rows).toBe(firstRows)
    expect(store.current().error).toBeNull()
  })

  it('treats a none listing as an empty list without an error', async () => {
    const store = new ProcessesPaneStore('s1', {
      listTasks: async () => ({
        ok: true,
        value: {
          ok: true,
          value: {
            s1: { kind: 'none', code: 'not-agent', reason: 'Shell session' },
          },
        },
      }),
      scriptLastLines: vi.fn(async () => linesReply([])),
    }, true)

    stop = store.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.current()).toEqual({ rows: [], serviceLines: new Map(), error: null })
  })

  it('polls scriptLastLines every 2 s only while visible and a service runs, and clears lines when services stop', async () => {
    const lineReplies: LinesReply[] = [
      linesReply([{ runId: 'svc-1', line: 'Reply 1' }]),
      linesReply([{ runId: 'svc-1', line: 'Reply 2' }]),
      linesReply([{ runId: 'svc-1', line: 'Reply 3' }]),
    ]
    const scriptLastLines = vi.fn(() => Promise.resolve(lineReplies.shift()!))
    const store = new ProcessesPaneStore('s1', {
      listTasks: vi.fn(async () => tasksReply('s1', [])),
      scriptLastLines,
    }, true, false)

    stop = store.start()
    await vi.advanceTimersByTimeAsync(ProcessesPaneStore.serviceLinesRefreshMillisecondsConst * 3)
    expect(scriptLastLines).not.toHaveBeenCalled()

    store.setServiceRunning(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(scriptLastLines).toHaveBeenCalledTimes(1)
    expect(scriptLastLines).toHaveBeenLastCalledWith('s1')
    expect(store.current().serviceLines.get('svc-1')).toBe('Reply 1')

    await vi.advanceTimersByTimeAsync(ProcessesPaneStore.serviceLinesRefreshMillisecondsConst - 1)
    expect(scriptLastLines).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(scriptLastLines).toHaveBeenCalledTimes(2)
    expect(store.current().serviceLines.get('svc-1')).toBe('Reply 2')

    store.setVisible(false)
    await vi.advanceTimersByTimeAsync(ProcessesPaneStore.serviceLinesRefreshMillisecondsConst * 3)
    expect(scriptLastLines).toHaveBeenCalledTimes(2)

    store.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(scriptLastLines).toHaveBeenCalledTimes(3)
    expect(store.current().serviceLines.get('svc-1')).toBe('Reply 3')

    store.setServiceRunning(false)
    expect(store.current().serviceLines.size).toBe(0)
    await vi.advanceTimersByTimeAsync(ProcessesPaneStore.serviceLinesRefreshMillisecondsConst * 3)
    expect(scriptLastLines).toHaveBeenCalledTimes(3)
  })
})
