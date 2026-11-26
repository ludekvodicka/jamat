import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { SessionScriptRunInfo } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SessionTaskListing, SessionTaskRow } from '../../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import type { AppClientUiBridge, IpcResult } from '../../shared/appClientUiIpc'
import { AppClientUiReport } from '../../shared/appClientUiReport'
import { ProcessesPane, ProcessesPorts, type ProcessesPanePorts } from './processesPane'

type TasksReply = IpcResult<RemoteControlStepResult<Record<string, SessionTaskListing>>>

function runOf(over: Partial<SessionScriptRunInfo> = {}): SessionScriptRunInfo {
  return {
    runId: 'r-1',
    phase: 'inner',
    scriptId: 'requested',
    name: over.title ?? 'build',
    title: 'build',
    state: 'running',
    commands: [],
    row: true,
    log: 'none',
    startedAt: 10_000,
    summary: 'build · running',
    ...over,
  }
}

function tasksOf(sessionId: string, rows: readonly SessionTaskRow[]): TasksReply {
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

function portsOf(over: Partial<ProcessesPanePorts> = {}): ProcessesPanePorts {
  return {
    listTasks: vi.fn(async () => tasksOf('s1', [])),
    scriptLastLines: vi.fn(async () => ({ ok: true as const, value: { ok: true as const, value: [] } })),
    stopRun: vi.fn(async () => null),
    removeRun: vi.fn(async () => null),
    ...over,
  }
}

describe('app-client-ui/renderer/processes/processesPane', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  it('opens the local Processes split tab through sessionTasks.openProcesses and reports failures', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { ok: true, value: { panelId: 'p1' } } })
      .mockResolvedValueOnce({ ok: true, value: { ok: false, error: { code: 'not-found', detail: 'No such session' } } })
      .mockResolvedValueOnce({ ok: false, error: 'Bridge unavailable' })
    const report = vi.spyOn(AppClientUiReport, 'error').mockImplementation(() => {})
    ;(window as unknown as { appClient: Partial<AppClientUiBridge> }).appClient = {
      control: { call } as unknown as AppClientUiBridge['control'],
    }

    ProcessesPorts.open('s1')
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith('sessionTasks.openProcesses', { sessionId: 's1' }))
    expect(report).not.toHaveBeenCalled()

    ProcessesPorts.open('missing')
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith('Processes could not be opened: No such session'))

    ProcessesPorts.open('broken')
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith('Processes could not be opened: Bridge unavailable'))
  })

  it('lists running services before ended runs, preserves library summaries, and omits Remove for collapsed runs', () => {
    const runs: SessionScriptRunInfo[] = [
      runOf({
        runId: 'r-failed',
        scriptId: 'requested',
        title: 'test',
        state: 'failed',
        exitCode: 3,
        row: true,
        startedAt: 30_000,
        endedAt: 32_000,
        summary: 'test · failed · exit 3 · 2 s',
      }),
      runOf({
        runId: 'r-service-live',
        scriptId: 'service',
        title: 'ping',
        state: 'running',
        row: true,
        startedAt: 20_000,
        summary: 'ping · running',
      }),
      runOf({
        runId: 'r-service-exited',
        scriptId: 'service',
        title: 'dev',
        state: 'failed',
        exitCode: 0,
        row: false,
        startedAt: 10_000,
        endedAt: 15_000,
        summary: 'dev · exited · exit 0 · 5 s',
      }),
      runOf({
        runId: 'r-before',
        phase: 'before',
        scriptId: 'setup',
        title: 'setup',
        state: 'succeeded',
        row: false,
        startedAt: 5_000,
        endedAt: 6_000,
        summary: 'setup · succeeded · 1 s',
      }),
    ]

    const { container } = render(
      <ProcessesPane
        sessionId="s1"
        runs={runs}
        visible
        ports={portsOf()}
        onOpen={vi.fn()}
      />,
    )

    const rows = [...container.querySelectorAll('.processes-pane__row')]
    expect(rows.map((row) => row.getAttribute('data-process-id'))).toEqual([
      'r-service-live',
      'r-failed',
      'r-service-exited',
    ])
    expect(rows[1].textContent).toContain('failed · exit 3 · 2 s')
    expect(rows[2].textContent).toContain('exited · exit 0 · 5 s')
    expect(rows[0].querySelector('button')?.textContent).toBe('Stop')
    expect(rows[1].querySelector('button')?.textContent).toBe('Remove')
    expect(rows[2].querySelector('button')).toBeNull()
  })

  it('opens a clicked item in the task pane and runs Stop and Remove without opening', async () => {
    const onOpen = vi.fn()
    const stopRun = vi.fn(async () => null)
    const removeRun = vi.fn(async () => 'Remove failed: busy')
    const runs: SessionScriptRunInfo[] = [
      runOf({
        runId: 'r-service',
        scriptId: 'service',
        title: 'ping',
        state: 'running',
        row: true,
        startedAt: 20_000,
        summary: 'ping · running',
      }),
      runOf({
        runId: 'r-failed',
        scriptId: 'requested',
        title: 'lint',
        state: 'failed',
        exitCode: 2,
        row: true,
        startedAt: 10_000,
        endedAt: 12_000,
        summary: 'lint · failed · exit 2 · 2 s',
      }),
    ]

    const { container } = render(
      <ProcessesPane
        sessionId="s1"
        runs={runs}
        visible
        ports={portsOf({ stopRun, removeRun })}
        onOpen={onOpen}
      />,
    )

    const serviceRow = container.querySelector('[data-process-id="r-service"]') as HTMLElement
    fireEvent.click(serviceRow)
    expect(onOpen).toHaveBeenCalledWith({ kind: 'script', runId: 'r-service' }, 'ping')

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await vi.waitFor(() => expect(stopRun).toHaveBeenCalledWith('r-service'))
    expect(onOpen).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await vi.waitFor(() => expect(removeRun).toHaveBeenCalledWith('r-failed'))
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Remove failed: busy'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('orders a running shell after a newer running service and before a done sub-agent, showing tags, steps and durations without exit codes', async () => {
    const onOpen = vi.fn()
    const runs: SessionScriptRunInfo[] = [
      runOf({
        runId: 'r-service',
        scriptId: 'service',
        title: 'ping',
        state: 'running',
        row: true,
        startedAt: 30_000,
        summary: 'ping · running',
      }),
    ]
    const taskRows: SessionTaskRow[] = [
      {
        kind: 'shell',
        shellId: 'b1',
        command: 'codex exec review',
        description: 'Run codex reviewer',
        state: 'running',
        startedAt: 20_000,
        endedAt: null,
        runs: 'agent',
      },
      {
        kind: 'subagent',
        subagentId: 'a1',
        agentType: 'Explore',
        description: 'Scan routes',
        depth: 1,
        parentSubagentId: null,
        state: 'done',
        startedAt: 10_000,
        endedAt: 14_500,
        model: 'claude-sonnet',
        step: 'Read app.ts',
      },
    ]

    const { container } = render(
      <ProcessesPane
        sessionId="s1"
        runs={runs}
        visible
        ports={portsOf({ listTasks: vi.fn(async () => tasksOf('s1', taskRows)) })}
        onOpen={onOpen}
      />,
    )

    await vi.waitFor(() => expect(container.querySelectorAll('.processes-pane__row')).toHaveLength(3))
    const rows = [...container.querySelectorAll('.processes-pane__row')]
    expect(rows.map((row) => row.getAttribute('data-process-id'))).toEqual(['r-service', 'b1', 'a1'])

    expect(rows[1].textContent).toContain('$ codex exec review')
    expect(rows[1].textContent).toContain('agent')
    expect(rows[1].textContent).not.toContain('exit')

    expect(rows[2].textContent).toContain('Explore')
    expect(rows[2].textContent).toContain('Scan routes')
    expect(rows[2].textContent).toContain('Read app.ts')
    expect(rows[2].textContent).toContain('done · 4.5 s')
    expect(rows[2].textContent).not.toContain('exit')

    fireEvent.click(rows[1])
    expect(onOpen).toHaveBeenCalledWith({ kind: 'shell', shellId: 'b1' }, '$ codex exec review')

    fireEvent.click(rows[2])
    expect(onOpen).toHaveBeenCalledWith({ kind: 'subagent', subagentId: 'a1' }, 'Explore: Scan routes')
  })

  it('keeps the last listed tasks and shows the error line when a later poll is refused', async () => {
    const taskRows: SessionTaskRow[] = [
      {
        kind: 'shell',
        shellId: 'b1',
        command: 'sleep 60',
        description: null,
        state: 'running',
        startedAt: 20_000,
        endedAt: null,
        runs: 'command',
      },
    ]
    const listTasks = vi.fn<ProcessesPanePorts['listTasks']>()
      .mockResolvedValueOnce(tasksOf('s1', taskRows))
      .mockResolvedValueOnce({ ok: true, value: { ok: false, error: { code: 'unavailable', detail: 'Transcript locked' } } })

    const ports = portsOf({ listTasks })
    const { container, rerender } = render(
      <ProcessesPane
        sessionId="s1"
        runs={[]}
        visible
        ports={ports}
        onOpen={vi.fn()}
      />,
    )

    await vi.waitFor(() => expect(container.querySelector('[data-process-id="b1"]')).not.toBeNull())
    rerender(<ProcessesPane sessionId="s1" runs={[]} visible={false} ports={ports} onOpen={vi.fn()} />)
    rerender(<ProcessesPane sessionId="s1" runs={[]} visible ports={ports} onOpen={vi.fn()} />)

    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Reading processes: Transcript locked'))
    expect(container.querySelector('[data-process-id="b1"]')).not.toBeNull()
  })

  it('shows the last output line of a running service and makes no scriptLastLines call without one', async () => {
    const scriptLastLines = vi.fn(async () => ({
      ok: true as const,
      value: { ok: true as const, value: [{ runId: 'r-service', line: 'Reply from 127.0.0.1: bytes=32 time<1ms' }] },
    }))
    const requestedOnly = [runOf({ runId: 'r-req', scriptId: 'requested', state: 'running' })]
    const ports = portsOf({ scriptLastLines })
    const { container, rerender } = render(
      <ProcessesPane sessionId="s1" runs={requestedOnly} visible ports={ports} onOpen={vi.fn()} />,
    )
    expect(scriptLastLines).not.toHaveBeenCalled()

    const withService = [
      ...requestedOnly,
      runOf({ runId: 'r-service', scriptId: 'service', title: 'ping', state: 'running' }),
    ]
    rerender(<ProcessesPane sessionId="s1" runs={withService} visible ports={ports} onOpen={vi.fn()} />)
    await vi.waitFor(() =>
      expect(container.querySelector('[data-process-id="r-service"] .processes-pane__detail')?.textContent)
        .toBe('Reply from 127.0.0.1: bytes=32 time<1ms'))
    expect(container.querySelector('[data-process-id="r-req"] .processes-pane__detail')).toBeNull()
  })
})
