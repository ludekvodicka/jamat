import { AppControl } from '../ipc/appControl'
import type { TaskPanePorts } from './taskPaneStore'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionSubagentTranscript } from '../../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import { ControlBridgeFixture } from '../ipc/fixtures/controlBridgeFixture'
import type { PanelSplitTaskItem } from '../widgets/tabs/panelSplit'
import { TaskPane } from './taskPane'
import { ScriptOutputView } from './scriptOutputView'

describe('app-client-ui/renderer/taskView/taskPane', () => {
  const ports: TaskPanePorts = { transcript: (request) => AppControl.call('sessionTasks.transcript', request),
    shellOutput: (request) => AppControl.call('sessionTasks.shellOutput', request), scriptOutput: (request) => AppControl.call('sessions.scriptOutput', request),
    openTerminal: async (runId) => { const answer = await AppControl.call('tabs.open', { session: { kind: 'sessionId', sessionId: runId } }); return !answer.ok ? answer.error : !answer.value.ok ? answer.value.error.detail : null },
  }
  afterEach(() => cleanup())

  const itemConst: PanelSplitTaskItem = { kind: 'task', key: 'task:s-1:subagent:a1', title: 'Explore: Look at docs',
    sessionId: 's-1', task: { kind: 'subagent', subagentId: 'a1' } }

  function install(answer: SessionSubagentTranscript): ControlBridgeFixture {
    const control = new ControlBridgeFixture().on('sessionTasks.transcript', { ok: true, value: answer })
    ;(window as unknown as { appClient: unknown }).appClient = { control: control.bridge() }
    return control
  }

  it('reads the transcript and draws its header and entries as plain text', async () => {
    const control = install({
      kind: 'transcript',
      revision: '1:2',
      header: { agentType: 'Explore', description: 'Look at docs', model: 'claude-opus-5', state: 'done', contextTokens: 31_200 },
      entries: [
        { kind: 'prompt', text: 'Find <b>the</b> docs', truncated: false },
        { kind: 'tool', tool: 'Read', summary: 'docs/x.md', output: null, outputTruncated: false, failed: false, at: null },
        { kind: 'message', role: 'assistant', text: '**Found** two files', truncated: true, at: 1 },
      ],
      earlierStepsOmitted: false,
    })
    render(<TaskPane ports={ports} item={itemConst} visible />)

    expect(await screen.findByText('Explore: Look at docs')).toBeTruthy()
    expect(screen.getByText('Done · claude-opus-5 · 31,200 context tokens')).toBeTruthy()
    expect(screen.getByText('Find <b>the</b> docs')).toBeTruthy()
    expect(screen.getByText('**Found** two files')).toBeTruthy()
    expect(screen.getByText('The rest of this text is cut.')).toBeTruthy()
    expect(screen.getByText('docs/x.md')).toBeTruthy()
    expect(control.bodiesOf('sessionTasks.transcript')).toEqual([{ sessionId: 's-1', subagentId: 'a1' }])
  })

  // A day long past, so both times carry their date.
  const shellStartedAtConst = new Date(2026, 0, 5, 18, 12, 3).getTime()

  it('reads a shell item by its id and draws the command, the state and the output as plain text', async () => {
    const control = new ControlBridgeFixture().on('sessionTasks.shellOutput', { ok: true, value: {
      kind: 'output', revision: '1:2:done', command: 'ping -n 30 127.0.0.1', state: 'done',
      startedAt: shellStartedAtConst, endedAt: shellStartedAtConst + 167_000,
      text: 'Reply from <b>127.0.0.1</b>\nDone\n', earlierOutputOmitted: true,
    } })
    ;(window as unknown as { appClient: unknown }).appClient = { control: control.bridge() }
    render(<TaskPane ports={ports} item={{ kind: 'task', key: 'task:s-1:shell:b1', title: '$ ping -n 30 127.0.0.1', sessionId: 's-1',
      task: { kind: 'shell', shellId: 'b1' } }} visible />)

    expect(await screen.findByText('$ ping -n 30 127.0.0.1')).toBeTruthy()
    expect(screen.getByText('Done')).toBeTruthy()
    expect(screen.getByText('Earlier output is not shown.')).toBeTruthy()
    expect(screen.getByTestId('shell-output-text').textContent).toBe('Reply from <b>127.0.0.1</b>\nDone\n')
    expect(screen.getByText(`Started ${new Date(shellStartedAtConst).toLocaleString()}`)).toBeTruthy()
    expect(screen.getByText(`Ended ${new Date(shellStartedAtConst + 167_000).toLocaleString()} · took 2m 47s`)).toBeTruthy()
    expect(control.bodiesOf('sessionTasks.shellOutput')).toEqual([{ sessionId: 's-1', shellId: 'b1' }])
  })

  it('says why there is nothing to show', async () => {
    install({ kind: 'none', code: 'unknown-task', reason: 'The session lists no such sub-agent' })
    render(<TaskPane ports={ports} item={itemConst} visible />)

    expect(await screen.findByText('The session lists no such sub-agent')).toBeTruthy()
  })

  it('reads a script saved log as plain text in its existing task pane', async () => {
    const control = new ControlBridgeFixture().on('sessions.scriptOutput', { ok: true, value: {
      state: 'succeeded', source: 'log', lines: ['<b>installed</b>', 'done'], terminal: null, endedAt: 123,
    } })
    ;(window as unknown as { appClient: unknown }).appClient = { control: control.bridge() }
    render(<TaskPane ports={ports} item={{ kind: 'task', key: 'task:s-1:script:r1', title: 'Setup project', sessionId: 's-1',
      task: { kind: 'script', runId: 'r1' } }} visible />)
    expect(await screen.findByText('Setup project')).toBeTruthy()
    expect(screen.getByText('Succeeded · Saved log')).toBeTruthy()
    expect(screen.getByTestId('script-output-text').textContent).toBe('<b>installed</b>\ndone')
    expect(screen.queryByRole('button', { name: 'Open terminal' })).toBeNull()
    expect(control.bodiesOf('sessions.scriptOutput')).toEqual([{ sessionId: 's-1', runId: 'r1' }])
  })

  it('offers Open terminal only while script output has a terminal, and keeps the view through collapse', async () => {
    const control = new ControlBridgeFixture().on('tabs.open', { ok: true, value: {} })
    ;(window as unknown as { appClient: unknown }).appClient = { control: control.bridge() }
    const { rerender } = render(<ScriptOutputView openTerminal={ports.openTerminal} title="Setup project" runId="r1" output={{
      state: 'running', source: 'live', lines: ['installing'],
      terminal: { hostInstanceId: 'host', runtimeSessionId: 'runtime', generation: 1 },
    }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    await waitFor(() => expect(control.bodiesOf('tabs.open')).toEqual([{ session: { kind: 'sessionId', sessionId: 'r1' } }]))
    expect(screen.getByTestId('script-output-text').textContent).toBe('installing')

    rerender(<ScriptOutputView openTerminal={ports.openTerminal} title="Setup project" runId="r1" output={{
      state: 'succeeded', source: 'log', lines: ['installed'], terminal: null,
    }} />)
    expect(screen.getByText('Setup project')).toBeTruthy()
    expect(screen.getByText('Succeeded · Saved log')).toBeTruthy()
    expect(screen.getByTestId('script-output-text').textContent).toBe('installed')
    expect(screen.queryByRole('button', { name: 'Open terminal' })).toBeNull()
  })

  it('shows an unavailable script log reason without offering a terminal', () => {
    render(<ScriptOutputView openTerminal={ports.openTerminal} title="Setup project" runId="r1" output={{
      state: 'lost', source: 'log', lines: [], terminal: null, logReason: 'The Host restarted before saving output',
      failureReason: 'The SVN command ended without an exit code',
    }} />)
    expect(screen.getByText('The Host restarted before saving output')).toBeTruthy()
    expect(screen.getByText('Lost · Log unavailable')).toBeTruthy()
    expect(screen.getByText('The SVN command ended without an exit code').closest('header')).toBeTruthy()
    expect(screen.queryByText('Lost · Saved log')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open terminal' })).toBeNull()
  })

  it('says why a stopped run ended without marking it as a failure', () => {
    render(<ScriptOutputView openTerminal={ports.openTerminal} title="Worktree validation" runId="r1" output={{
      state: 'stopped', source: 'log', lines: [], terminal: null, failureReason: 'its run was stopped',
    }} />)
    expect(screen.getByText('Stopped · Saved log')).toBeTruthy()
    expect(screen.getByText('its run was stopped').className).not.toContain('task-view__failed')
  })

  it('reads nothing while its tab is hidden and once when it is shown', async () => {
    const control = install({ kind: 'none', code: 'unknown-task', reason: 'The session lists no such sub-agent' })
    const { rerender } = render(<TaskPane ports={ports} item={itemConst} visible={false} />)
    expect(screen.getByText('Reading the sub-agent…')).toBeTruthy()
    await Promise.resolve()
    expect(control.bodiesOf('sessionTasks.transcript')).toEqual([])

    rerender(<TaskPane ports={ports} item={itemConst} visible />)
    await waitFor(() => expect(control.bodiesOf('sessionTasks.transcript')).toHaveLength(1))
  })

  it('replaces equal task IDs on a new source generation and ignores a late retired read', async () => {
    let release!: (value: Awaited<ReturnType<TaskPanePorts['scriptOutput']>>) => void
    const oldRead = vi.fn(() => new Promise<Awaited<ReturnType<TaskPanePorts['scriptOutput']>>>((resolve) => { release = resolve }))
    const newRead = vi.fn(async () => ({ ok: true as const, value: { ok: true as const, value: {
      source: 'log' as const, state: 'succeeded' as const, terminal: null, lines: ['Source two'],
    } } }))
    const item: PanelSplitTaskItem = { kind: 'task', key: 'same-key', title: 'Script', sessionId: 'same-session', task: { kind: 'script', runId: 'same-run' } }
    const view = render(<TaskPane ports={{ ...ports, scriptOutput: oldRead }} item={item} visible />)
    await waitFor(() => expect(oldRead).toHaveBeenCalledOnce())
    view.rerender(<TaskPane ports={{ ...ports, scriptOutput: newRead }} item={item} visible />)
    expect(await screen.findByText('Source two')).toBeTruthy()
    await act(async () => release({ ok: true, value: { ok: true, value: { source: 'log', state: 'succeeded', terminal: null, lines: ['Retired source'] } } }))
    expect(screen.queryByText('Retired source')).toBeNull()
    expect(screen.getByText('Source two')).toBeTruthy()
    expect(newRead).toHaveBeenCalledExactlyOnceWith({ sessionId: 'same-session', runId: 'same-run' })
  })
})
