import { AppControl } from '../../ipc/appControl'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ControlBridgeFixture } from '../../ipc/fixtures/controlBridgeFixture'
import { SessionTaskRows } from './sessionTaskRows'
import type { ProcessRowNode, ScriptRunNode, SessionProcessesNode, TaskRowNode } from './sessionsTreeModel'

describe('app-client-ui/renderer/views/sessionsTree/sessionTaskRows', () => {
  afterEach(() => cleanup())
  const onOpen = (row: TaskRowNode, title: string) => { void AppControl.call('sessionTasks.open', { sessionId: row.sessionId, task: row.task, title }) }

  function row(subagentId: string, fields: Partial<TaskRowNode> = {}): TaskRowNode {
    return {
      id: `task:s-1:subagent:${subagentId}`,
      sessionId: 's-1',
      task: { kind: 'subagent', subagentId },
      label: 'Explore',
      description: `Look at ${subagentId}`,
      detail: null,
      state: 'done',
      depth: 1,
      ...fields,
    }
  }

  function taskRows(rows: readonly TaskRowNode[]): readonly ProcessRowNode[] {
    return rows.map((entry) => ({ kind: 'task', row: entry }))
  }

  const processes: SessionProcessesNode = {
    placement: 'nested',
    numberPrefix: null,
    rows: taskRows([
      row('run-1', { state: 'running', detail: 'Bash ls docs/architecture' }),
      row('run-2', { state: 'running', depth: 2, label: 'general-purpose' }),
      row('new'), row('mid', { state: 'failed' }), row('old', { state: 'stopped' }),
    ]),
    more: null,
  }

  function Harness(): React.JSX.Element {
    return <SessionTaskRows onOpen={onOpen} processes={processes} />
  }

  function drawnIds(container: HTMLElement): string[] {
    return [...container.querySelectorAll<HTMLElement>('.jamat-sessions__task')].map((element) => element.dataset.task ?? '')
  }

  it('draws running rows with type, description and step, a depth-2 row marked for its indent', () => {
    const { container } = render(<Harness />)

    expect(drawnIds(container)).toEqual(['task:s-1:subagent:run-1', 'task:s-1:subagent:run-2', 'task:s-1:subagent:new', 'task:s-1:subagent:mid', 'task:s-1:subagent:old'])
    const first = container.querySelector<HTMLElement>('[data-task="task:s-1:subagent:run-1"]')!
    expect(first.textContent).toContain('Explore')
    expect(first.textContent).toContain('Look at run-1')
    expect(first.textContent).toContain('Bash ls docs/architecture')
    expect(first.querySelector('[data-paint]')?.getAttribute('data-paint')).toBe('accent')
    expect(container.querySelector('[data-task="task:s-1:subagent:run-2"]')?.getAttribute('data-depth')).toBe('2')
  })

  it('prefixes each row with the session number only when the rows stand beside the session', () => {
    const nested = render(<SessionTaskRows onOpen={onOpen} processes={processes} />)
    expect(nested.container.querySelector('.jamat-sessions__task-number')).toBeNull()
    nested.unmount()

    const { container } = render(
      <SessionTaskRows onOpen={onOpen} processes={{ ...processes, placement: 'beside', numberPrefix: '018' }} />,
    )
    expect([...container.querySelectorAll('.jamat-sessions__task-number')].map((node) => node.textContent))
      .toEqual(['018', '018', '018', '018', '018'])
  })

  it('draws retained finished rows directly without a finished group or older count', () => {
    const { container } = render(<Harness />)
    expect(screen.queryByRole('button', { name: /finished/ })).toBeNull()
    expect(screen.queryByText(/older/)).toBeNull()
    expect(drawnIds(container)).toHaveLength(5)
    expect([...container.querySelectorAll('.jamat-sessions__task [data-paint]')]
      .slice(2).map((element) => element.getAttribute('data-paint'))).toEqual(['ok', 'danger', 'muted'])
  })

  it('draws a shell as `$ <command>` with its description as the tooltip, and opens it titled with the command', async () => {
    const control = new ControlBridgeFixture().on('sessionTasks.open', { ok: true, value: { panelId: 'terminal:s-1' } })
    ;(window as unknown as { appClient: unknown }).appClient = { control: control.bridge() }
    const shell: TaskRowNode = {
      id: 'task:s-1:shell:b1',
      sessionId: 's-1',
      task: { kind: 'shell', shellId: 'b1' },
      label: '$ ping -n 300 127.0.0.1',
      description: 'Ping the loopback',
      detail: null,
      state: 'killed',
      depth: 1,
    }
    const { container } = render(
      <SessionTaskRows onOpen={onOpen} processes={{ ...processes, rows: taskRows([shell]) }} />,
    )

    const drawn = container.querySelector<HTMLElement>('[data-task="task:s-1:shell:b1"]')!
    expect(drawn.textContent).toContain('$ ping -n 300 127.0.0.1')
    expect(drawn.querySelector('[title="Ping the loopback"]')).not.toBeNull()
    expect(drawn.querySelector('[data-paint]')?.getAttribute('title')).toBe('Killed')
    expect(drawn.getAttribute('role')).toBe('button')
    expect(drawn.querySelector('.jamat-sessions__task-tag')).toBeNull()

    fireEvent.click(drawn)
    await waitFor(() => expect(control.bodiesOf('sessionTasks.open')).toEqual([
      { sessionId: 's-1', task: { kind: 'shell', shellId: 'b1' }, title: '$ ping -n 300 127.0.0.1' },
    ]))
  })

  it('draws the agent tag with an accessible title only for shell rows running an agent', () => {
    const rows: TaskRowNode[] = [
      { id: 'task:s-1:shell:b-agent', sessionId: 's-1', task: { kind: 'shell', shellId: 'b-agent' }, label: '$ codex exec "hi"', description: '', detail: null, state: 'running', depth: 1, runs: 'agent' },
      { id: 'task:s-1:shell:b-cmd', sessionId: 's-1', task: { kind: 'shell', shellId: 'b-cmd' }, label: '$ pnpm test', description: '', detail: null, state: 'running', depth: 1, runs: 'command' },
      { id: 'task:s-1:shell:b-legacy', sessionId: 's-1', task: { kind: 'shell', shellId: 'b-legacy' }, label: '$ sleep 30', description: '', detail: null, state: 'running', depth: 1 },
    ]
    const { container } = render(<SessionTaskRows onOpen={onOpen} processes={{ ...processes, rows: taskRows(rows) }} />)
    const agentRow = container.querySelector<HTMLElement>('[data-task="task:s-1:shell:b-agent"]')!
    const tag = agentRow.querySelector<HTMLElement>('.jamat-sessions__task-tag')
    expect(tag?.textContent).toBe('agent')
    expect(tag?.getAttribute('title')).toBe('Background shell running an agent')
    expect(container.querySelector('[data-task="task:s-1:shell:b-cmd"] .jamat-sessions__task-tag')).toBeNull()
    expect(container.querySelector('[data-task="task:s-1:shell:b-legacy"] .jamat-sessions__task-tag')).toBeNull()
  })

  it('draws no finished row when nothing finished', () => {
    render(<SessionTaskRows onOpen={onOpen} processes={{ ...processes, rows: [] }} />)

    expect(screen.queryByRole('button', { name: /finished/ })).toBeNull()
  })

  it("opens a clicked row in its parent's split, titled with the type and the description", async () => {
    const control = new ControlBridgeFixture().on('sessionTasks.open', { ok: true, value: { panelId: 'terminal:s-1' } })
    ;(window as unknown as { appClient: unknown }).appClient = { control: control.bridge() }
    const { container } = render(<Harness />)

    fireEvent.click(container.querySelector<HTMLElement>('[data-task="task:s-1:subagent:run-1"]')!)
    fireEvent.keyDown(container.querySelector<HTMLElement>('[data-task="task:s-1:subagent:run-2"]')!, { key: 'Enter' })

    await waitFor(() => expect(control.bodiesOf('sessionTasks.open')).toEqual([
      { sessionId: 's-1', task: { kind: 'subagent', subagentId: 'run-1' }, title: 'Explore: Look at run-1' },
      { sessionId: 's-1', task: { kind: 'subagent', subagentId: 'run-2' }, title: 'general-purpose: Look at run-2' },
    ]))
  })

  it('draws run, history and task rows in order, and renders the local more row as interactive and remote as plain text', () => {
    const onOpenProcesses = vi.fn()
    const historyRun: ScriptRunNode = {
      runId: 'svc-ended', phase: 'inner', scriptId: 'service', name: 'web', title: 'web',
      commands: [], state: 'stopped', startedAt: 100, endedAt: 200, row: false,
      summary: 'web · stopped', log: 'saved', open: null,
    }
    const localProcesses: SessionProcessesNode = {
      placement: 'nested',
      numberPrefix: null,
      rows: [
        { kind: 'run', sessionId: 'svc-live' },
        { kind: 'history', run: historyRun },
      ],
      more: { count: 3, opens: true },
    }
    const { container, rerender } = render(
      <SessionTaskRows
        processes={localProcesses}
        renderRun={(sessionId) => <div key={sessionId} data-order={sessionId}>{sessionId}</div>}
        renderHistory={(run) => <div key={run.runId} data-order={run.runId}>{run.summary}</div>}
        onOpen={onOpen}
        onOpenProcesses={onOpenProcesses}
      />,
    )

    expect([...container.querySelectorAll('[data-order]')].map((el) => el.getAttribute('data-order')))
      .toEqual(['svc-live', 'svc-ended'])
    const more = container.querySelector<HTMLElement>('[data-processes-more="3"]')!
    expect(more.textContent).toContain('and 3 more…')
    expect(more.textContent).toContain('open processes')
    expect(more.getAttribute('role')).toBe('button')
    fireEvent.keyDown(more, { key: 'Enter' })
    fireEvent.click(more)
    expect(onOpenProcesses).toHaveBeenCalledTimes(2)

    rerender(
      <SessionTaskRows
        processes={{ ...localProcesses, more: { count: 3, opens: false } }}
        renderRun={(sessionId) => <div key={sessionId} data-order={sessionId}>{sessionId}</div>}
        renderHistory={(run) => <div key={run.runId} data-order={run.runId}>{run.summary}</div>}
        onOpen={onOpen}
        onOpenProcesses={onOpenProcesses}
      />,
    )
    const remoteMore = container.querySelector<HTMLElement>('[data-processes-more="3"]')!
    expect(remoteMore.textContent).toBe('and 3 more…')
    expect(remoteMore.getAttribute('role')).toBeNull()
    expect(remoteMore.querySelector('.jamat-sessions__task-more-link')).toBeNull()
  })
})
