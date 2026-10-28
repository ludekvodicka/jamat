import { WorktreeWords } from '../../../lib-orchestrator/worktrees/worktreeViews'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  SessionInfo,
  SessionsSnapshot,
  SessionWorkflowInfo,
  SessionWorkflowStep,
  SessionWorkflowStepState,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { ControlBridgeFixture } from '../ipc/fixtures/controlBridgeFixture'
import { WorkflowPane, type WorkflowPorts, WorkflowStepGlyphs } from './workflowPane'
import { WorkflowPortsOf } from './workflowPorts'

const sourcePress: typeof WorkflowPortsOf.press = (id, action, agreement, commit) => WorkflowPortsOf.press(id, { ...action, command: WorktreeWords.command(action) }, agreement, commit)

describe('app-client-ui/renderer/workflow/workflowPane', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  const step = (key: string, title: string, state: SessionWorkflowStepState, extra?: Partial<SessionWorkflowStep>): SessionWorkflowStep =>
    ({ key, title, detail: '', state, startedAt: null, endedAt: null, target: { kind: 'none' }, ...extra })

  function workflowOf(overrides?: Partial<SessionWorkflowInfo>): SessionWorkflowInfo {
    const result: SessionWorkflowInfo = {
      kind: 'finish', workflowId: 'a1', title: 'Finish of 014 - fix login', badge: 'updating', summary: 'Running svn update', open: true,
      rounds: [{ title: 'Finish', steps: [
        step('1:stopping', 'Stop the session', 'done', { startedAt: 0, endedAt: 1_500 }),
        step('1:check:lint', 'Check lint', 'failed', { startedAt: 1_500, endedAt: 4_000, detail: 'failed', target: { kind: 'run', runId: 'c1' } }),
        step('1:updating', 'svn update', 'running', { startedAt: 10_000, detail: 'svn update 014', target: { kind: 'run', runId: 'u1' } }),
        step('1:waits', 'Wait', 'waits', { startedAt: 1, endedAt: 2, detail: 'conflicts after the update' }),
        step('1:review:.', 'Review', 'pending'),
        step('1:skip', 'Setup', 'skipped'),
      ] }],
      actions: [{ id: 'finish-again', label: 'Finish again', primary: true }, { id: 'keep', label: 'Keep worktree', primary: false }],
      ...overrides,
    }
    result.actions = result.actions.map((action) => ({ ...action, command: WorktreeWords.command(action) }))
    return result
  }

  const conflictPorts = () => ({
    resolve: vi.fn(async () => null), openFile: vi.fn(async () => null), openConflictEditor: vi.fn(async () => null), openBrief: vi.fn(async () => null),
  })
  const portsOf = (): WorkflowPorts => ({ openStep: vi.fn(), press: vi.fn(async () => ({ kind: 'done' as const })), conflicts: conflictPorts() })

  const session = (workflow?: SessionWorkflowInfo): SessionInfo =>
    ({ sessionId: 's1', ...workflow === undefined ? {} : { workflow } }) as unknown as SessionInfo

  function storeOf(sessions: Partial<SessionInfo>[]) {
    const listeners = new Set<() => void>()
    let snapshot = { revision: 1, sessions } as unknown as SessionsSnapshot
    return {
      current: () => ({ snapshot, error: null }) as never,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      publish(next: Partial<SessionInfo>[]) {
        snapshot = { revision: 2, sessions: next } as unknown as SessionsSnapshot
        for (const listener of listeners) listener()
      },
    }
  }

  it('draws the presses of the step that waits under it, Solve with agent opening its own operation, and the rest in the footer', async () => {
    const ports = portsOf()
    const waiting = workflowOf({
      rounds: [{ title: 'Finish', steps: [
        step('1:updating', 'svn update', 'waits', { detail: 'other commits changed this project: a.ts', target: { kind: 'run', runId: 'u1' } }),
        step('1:review:.', 'Review', 'pending'),
      ] }],
      actions: [
        { id: 'finish-again', label: 'Continue to review', primary: true, place: 'step' },
        { id: 'solve-with-agent', label: 'Solve with agent', primary: false, place: 'step' },
        { id: 'keep', label: 'Keep worktree', primary: false },
      ],
    })
    render(<WorkflowPane session={session(waiting)} sessions={storeOf([])} visible ports={ports} />)

    const under = screen.getByRole('group', { name: 'svn update actions' })
    expect(within(under).getAllByRole('button').map((button) => button.textContent)).toEqual(['Continue to review', 'Solve with agent'])
    expect(within(document.querySelector('.workflow__footer') as HTMLElement).getAllByRole('button').map((button) => button.textContent))
      .toEqual(['Keep worktree'])
    fireEvent.click(within(under).getByRole('button', { name: 'Solve with agent' }))
    await waitFor(() => expect(ports.press).toHaveBeenCalledWith({ id: 'solve-with-agent', label: 'Solve with agent', primary: false, place: 'step', command: { operation: 'sessions.solveWithAgent', body: {} } }, {}))

    cleanup()
    // Without a step that waits or runs, a step press goes to the footer.
    const ended = workflowOf({ rounds: [{ title: 'Finish', steps: [step('1:review:.', 'Review', 'done')] }],
      actions: [{ id: 'finish-again', label: 'Finish again', primary: true, place: 'step' }] })
    render(<WorkflowPane session={session(ended)} sessions={storeOf([])} visible ports={portsOf()} />)
    expect(within(document.querySelector('.workflow__footer') as HTMLElement).getByRole('button', { name: 'Finish again' })).toBeTruthy()
  })

  it('draws every step state with its glyph, its duration and its detail, and the run line of a running run', () => {
    vi.useFakeTimers()
    vi.setSystemTime(12_000)
    const store = storeOf([{ sessionId: 'u1', step: { text: 'U src/catalog.ts', detail: null, progress: null, startedAt: null } }])
    render(<WorkflowPane session={session(workflowOf())} sessions={store} visible ports={portsOf()} />)

    expect(screen.getByText('Finish of 014 - fix login')).toBeTruthy()
    expect(screen.getByText('Running svn update')).toBeTruthy()
    expect(Array.from(document.querySelectorAll('.workflow__step')).map((row) => row.getAttribute('data-state')))
      .toEqual(['done', 'failed', 'running', 'waits', 'pending', 'skipped'])
    expect(Array.from(document.querySelectorAll('.workflow__glyph')).map((glyph) => glyph.textContent)).toEqual(['✓', '✕', '◐', '!', '○', '-'])
    expect(screen.getByText('1.5 s')).toBeTruthy()
    expect(screen.getByText('2 s')).toBeTruthy()
    expect(screen.getByText('U src/catalog.ts')).toBeTruthy()
    expect(screen.getByText('conflicts after the update')).toBeTruthy()
    expect(() => WorkflowStepGlyphs.of('paused' as SessionWorkflowStepState)).toThrow(/Unknown workflow step state/)
  })

  it('says so when the session has no workflow', () => {
    render(<WorkflowPane session={session()} sessions={storeOf([])} visible ports={portsOf()} />)
    expect(screen.getByText('Nothing runs for this session now.')).toBeTruthy()
  })

  it('opens a step through its target, and a client step is no button', () => {
    const openStep = vi.fn()
    render(<WorkflowPane session={session(workflowOf())} sessions={storeOf([])} visible ports={{ ...portsOf(), openStep }} />)
    fireEvent.click(screen.getByText('svn update'))
    expect(openStep).toHaveBeenCalledWith({ kind: 'run', runId: 'u1' }, 'svn update')
    expect(screen.getByText('Stop the session').closest('button')).toBeNull()
  })

  it('maps each target kind onto its operation, and none or conflicts onto nothing', async () => {
    const control = new ControlBridgeFixture()
      .on('sessionTasks.open', { ok: true, value: { panelId: 'terminal:s1' } })
      .on('tabs.open', { ok: true, value: { kind: 'opened', panelId: 'terminal:r1', windowId: 'main' } })
    ;(window as unknown as { appClient: unknown }).appClient = { control: control.bridge() }
    const report = vi.fn()
    WorkflowPortsOf.openStep('s1', { kind: 'run', runId: 'u1' }, 'svn update', report)
    WorkflowPortsOf.openStep('s1', { kind: 'agent', runId: 'cl' }, 'Claude resolves the conflicts', report)
    WorkflowPortsOf.openStep('s1', { kind: 'commit', runId: 'r1' }, 'Review', report)
    WorkflowPortsOf.openStep('s1', { kind: 'none' }, 'Stop the session', report)
    WorkflowPortsOf.openStep('s1', { kind: 'conflicts' }, 'Conflicts', report)

    await waitFor(() => expect(report).toHaveBeenCalledTimes(3))
    expect(control.calls).toEqual([
      { operation: 'sessionTasks.open', body: { sessionId: 's1', task: { kind: 'script', runId: 'u1' }, title: 'svn update' } },
      { operation: 'tabs.open', body: { session: { kind: 'sessionId', sessionId: 'cl' } } },
      { operation: 'tabs.open', body: { session: { kind: 'sessionId', sessionId: 'r1' } } },
    ])
    expect(report.mock.calls.every(([sentence]) => sentence === null)).toBe(true)
  })

  it('sends Finish again, Keep worktree and Discard as the Finish press with their choice, and Retry setup as the retry', async () => {
    const pressed: unknown[] = []
    const control = new ControlBridgeFixture().on('sessions.finishWorktree', (body) => {
      pressed.push(body)
      return { ok: true, value: { sessionId: 's1', actionId: 'a1' } }
    })
    ;(window as unknown as { appClient: unknown }).appClient = { control: control.bridge() }
    for (const id of ['finish-again', 'keep', 'discard'] as const)
      expect(await sourcePress('s1', { id, label: id, primary: false }, {})).toEqual({ kind: 'done' })
    expect(pressed).toEqual([
      { session: { kind: 'sessionId', sessionId: 's1' }, choice: 'commit' },
      { session: { kind: 'sessionId', sessionId: 's1' }, choice: 'keep' },
      { session: { kind: 'sessionId', sessionId: 's1' }, choice: 'discard' },
    ])
    control.on('sessions.retrySetup', { ok: true, value: { sessionId: 's1' } })
    expect(await sourcePress('s1', { id: 'retry-setup', label: 'Retry setup', primary: true }, { acknowledgeSetup: 'hash-2' }))
      .toEqual({ kind: 'done' })
    expect(control.bodiesOf('sessions.retrySetup')).toEqual([{ session: { kind: 'sessionId', sessionId: 's1' }, acknowledgeSetup: 'hash-2' }])
  })

  it('reports a refused press by its sentence, without the code meant for programs', async () => {
    const control = new ControlBridgeFixture().on('sessions.finishWorktree',
      { ok: false, error: { code: 'conflict', detail: 'The worktree now lies at Q:/wt.deleting; press Try again', data: { sourceCode: 'svn-failed' } } })
    ;(window as unknown as { appClient: unknown }).appClient = { control: control.bridge() }
    expect(await sourcePress('s1', { id: 'finish-again', label: 'Try again', primary: true }, {}))
      .toEqual({ kind: 'refused', sentence: 'Try again failed: The worktree now lies at Q:/wt.deleting; press Try again' })
  })

  it('sends Stop agent as a stop of the agent run it names, and offers it with Keep and Discard while the resolver works', async () => {
    const control = new ControlBridgeFixture().on('sessions.finalize', { ok: true, value: { sessionId: 'cl' } })
    ;(window as unknown as { appClient: unknown }).appClient = { control: control.bridge() }
    const stopAgent = { id: 'stop-agent' as const, label: 'Stop agent', primary: false, runId: 'cl' }
    expect(await sourcePress('s1', stopAgent, {})).toEqual({ kind: 'done' })
    expect(control.bodiesOf('sessions.finalize')).toEqual([{ session: { kind: 'sessionId', sessionId: 'cl' }, expect: 'stop' }])

    const ports = portsOf()
    render(<WorkflowPane session={session(workflowOf({ summary: 'Claude resolves the conflicts', actions: [stopAgent,
      { id: 'keep', label: 'Keep worktree', primary: false }, { id: 'discard', label: 'Discard', primary: false }] }))}
    sessions={storeOf([])} visible ports={ports} />)
    expect(Array.from(document.querySelectorAll('.workflow__action')).map((button) => button.textContent))
      .toEqual(['Stop agent', 'Keep worktree', 'Discard'])
    fireEvent.click(screen.getByRole('button', { name: 'Keep worktree' }))
    await waitFor(() => expect(ports.press).toHaveBeenCalledWith({ id: 'keep', label: 'Keep worktree', primary: false, command: { operation: 'sessions.finishWorktree', body: { choice: 'keep' } } }, {}))
  })

  it('sends Resolve with agent as Commit with agent, and Open merger as a tab open of the merger run', async () => {
    const control = new ControlBridgeFixture()
      .on('sessions.finishWorktree', { ok: true, value: { sessionId: 's1', actionId: 'a1' } })
      .on('tabs.open', { ok: true, value: { windowId: 'w', panelId: 'p' } })
    ;(window as unknown as { appClient: unknown }).appClient = { control: control.bridge() }
    expect(await sourcePress('s1', { id: 'resolve-with-agent', label: 'Resolve with agent', primary: false }, {})).toEqual({ kind: 'done' })
    expect(control.bodiesOf('sessions.finishWorktree')).toEqual([{ session: { kind: 'sessionId', sessionId: 's1' }, choice: 'commit', agent: true }])
    expect(await sourcePress('s1', { id: 'open-merger', label: 'Open merger', primary: false, runId: 'm1' }, {})).toEqual({ kind: 'done' })
    expect(control.bodiesOf('tabs.open')).toEqual([{ session: { kind: 'sessionId', sessionId: 'm1' } }])
  })

  it('opens the worktree in VS Code from the footer through the menu channel that reads the root off the session', async () => {
    const openProjectVsCode = vi.fn(async () => ({ ok: true as const, value: true }))
    ;(window as unknown as { appClient: unknown }).appClient = { terminalMenu: { openProjectVsCode } }
    const open = { id: 'open-in-vscode' as const, label: 'Open in VS Code', primary: false }
    expect(await sourcePress('s1', open, {})).toEqual({ kind: 'done' })
    expect(openProjectVsCode).toHaveBeenCalledWith('s1')
    openProjectVsCode.mockResolvedValueOnce({ ok: true, value: false })
    expect(await sourcePress('s1', open, {})).toEqual({ kind: 'refused', sentence: 'Open in VS Code failed: no session s1' })
  })

  it('settles a path as a window press, with the confirmation only when the person gave it, and answers a refusal as its sentence', async () => {
    const control = new ControlBridgeFixture()
      .on('sessions.resolveConflict', { ok: true, value: { sessionId: 's1', path: '.aidocs/engines', state: 'settled', left: 2 } })
    ;(window as unknown as { appClient: unknown }).appClient = { control: control.bridge() }
    const ports = WorkflowPortsOf.conflictsOf('s1', () => null)
    expect(await ports.resolve('.aidocs/engines', 'keep-both', false)).toBeNull()
    expect(await ports.resolve('src/catalog.ts', 'keep-mine', true)).toBeNull()
    expect(control.bodiesOf('sessions.resolveConflict')).toEqual([
      { session: { kind: 'sessionId', sessionId: 's1' }, path: '.aidocs/engines', option: 'keep-both' },
      { session: { kind: 'sessionId', sessionId: 's1' }, path: 'src/catalog.ts', option: 'keep-mine', confirm: true },
    ])
    control.on('sessions.resolveConflict', { ok: false, error: { code: 'conflict', detail: 'only you can choose it', data: { sourceCode: 'person-only' } } })
    expect(await ports.resolve('src/catalog.ts', 'keep-mine', false)).toMatch(/^Settle failed: .*only you can choose it/)
  })

  it('opens a conflicted file beside the workflow and answers the refusals of both openers for the row', async () => {
    const document = { documentKey: 'k1', name: 'catalog.ts', source: { kind: 'workspace', sessionId: 's1', path: 'W:/catalog.ts' } }
    const openConflictFile = vi.fn(async () => ({ ok: true as const, value: { ok: true as const, value: document } }))
    const openConflictEditor = vi.fn(async () => ({ ok: true as const, value: { ok: false as const, detail: 'TortoiseSVN is missing' } }))
    ;(window as unknown as { appClient: unknown }).appClient = { terminalMenu: { openConflictFile, openConflictEditor } }
    const openInSplit = vi.fn(() => null)
    const ports = WorkflowPortsOf.conflictsOf('s1', openInSplit)
    expect(await ports.openFile('src/catalog.ts')).toBeNull()
    expect(openConflictFile).toHaveBeenCalledWith('s1', 'src/catalog.ts')
    expect(openInSplit).toHaveBeenCalledWith(document)
    expect(await ports.openConflictEditor('.aidocs/engines')).toBe('TortoiseSVN is missing')
    openConflictFile.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'outside-root', detail: '../x is not inside the worktree' } } as never)
    expect(await ports.openFile('../x')).toBe('Open failed: ../x is not inside the worktree')
  })

  it('asks for the agreement a footer press was refused for, and presses again with its hash', async () => {
    const answers = [
      { ok: false as const, error: { code: 'conflict' as const, detail: 'agree first', data: { sourceCode: 'setup-not-acknowledged',
        setup: { commands: ['after lint: pnpm lint'], hash: 'hash-1' } } } },
      { ok: true as const, value: { sessionId: 's1', actionId: 'a1' } },
    ]
    const press = vi.fn(async (action: Parameters<WorkflowPorts['press']>[0], agreement: Parameters<WorkflowPorts['press']>[1]) => {
      const control = new ControlBridgeFixture().on('sessions.finishWorktree', answers.shift()!)
      ;(window as unknown as { appClient: unknown }).appClient = { control: control.bridge() }
      return sourcePress('s1', action, agreement)
    })
    render(<WorkflowPane session={session(workflowOf())} sessions={storeOf([])} visible ports={{ openStep: vi.fn(), press, conflicts: conflictPorts() }} />)

    fireEvent.click(screen.getByRole('button', { name: 'Finish again' }))
    await waitFor(() => expect(screen.getByText('after lint: pnpm lint')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Agree and finish' }))
    await waitFor(() => expect(press).toHaveBeenCalledTimes(2))
    expect(press.mock.calls.map(([action, agreement]) => [action.id, agreement]))
      .toEqual([['finish-again', {}], ['finish-again', { acknowledgeSetup: 'hash-1' }]])
    await waitFor(() => expect(screen.queryByText('after lint: pnpm lint')).toBeNull())
  })

  it('shows a refused press under the footer', async () => {
    const ports: WorkflowPorts = { openStep: vi.fn(), press: vi.fn(async () => ({ kind: 'refused' as const, sentence: 'Keep worktree failed: no' })),
      conflicts: conflictPorts() }
    render(<WorkflowPane session={session(workflowOf())} sessions={storeOf([])} visible ports={ports} />)
    fireEvent.click(screen.getByRole('button', { name: 'Keep worktree' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Keep worktree failed: no'))
    expect(ports.press).toHaveBeenCalledWith({ id: 'keep', label: 'Keep worktree', primary: false, command: { operation: 'sessions.finishWorktree', body: { choice: 'keep' } } }, {})
  })

  it('draws the conflict list inside the Conflicts step, follows a new snapshot, and a click on the step brings the list into view', () => {
    const entry = (path: string, state: 'person' | 'agent', description: string) =>
      ({ path, kind: 'text' as const, state, description, by: null, saved: null, options: [] })
    const conflictWorkflow = workflowOf({ badge: '3 conflicts need you', rounds: [{ title: 'Finish', steps: [
      step('1:updating', 'svn update', 'done', { detail: 'svn update left 3 conflicts', target: { kind: 'run', runId: 'u1' } }),
      step('1:conflicts', 'Conflicts', 'waits', { detail: '3 conflicts need you', target: { kind: 'conflicts' } }),
      step('1:review:.', 'Review', 'pending'),
    ] }] })
    const waiting = (summary: string, entries: ReturnType<typeof entry>[]): SessionInfo => ({
      ...session(conflictWorkflow),
      svnAction: { kind: 'finish', stage: 'updating', needs: summary, needsKind: 'conflict', review: null, summary, conflicts: { entries, more: 0 } },
    }) as SessionInfo
    const openStep = vi.fn()
    const view = render(<WorkflowPane session={waiting('3 conflicts need you', [
      entry('.aidocs/engines', 'person', 'Your session added this folder with 2 files; r421 added it with 3 files.'),
      entry('src/catalog.ts', 'person', 'Your session and r421 changed the same lines of this file.'),
      entry('src/wallets.ts', 'person', 'Your session and r421 changed the same lines of this file.'),
    ])} sessions={storeOf([])} visible ports={{ ...portsOf(), openStep }} />)

    const conflictsStep = screen.getByText('Conflicts').closest('li')!
    const list = within(conflictsStep).getByRole('region', { name: '3 conflicts need you' })
    expect(within(list).getByRole('region', { name: 'Needs you' }).querySelectorAll('li')).toHaveLength(3)
    expect(within(list).getByText('Your session added this folder with 2 files; r421 added it with 3 files.')).toBeTruthy()
    fireEvent.click(screen.getByText('Conflicts'))
    expect(document.activeElement).toBe(list)
    expect(openStep).not.toHaveBeenCalled()

    view.rerender(<WorkflowPane session={waiting('3 conflicts: merger on 1, 2 need you', [
      entry('.aidocs/engines', 'person', 'Your session added this folder with 2 files; r421 added it with 3 files.'),
      entry('src/catalog.ts', 'agent', 'Your session and r421 changed the same lines of this file.'),
      entry('src/wallets.ts', 'person', 'Your session and r421 changed the same lines of this file.'),
    ])} sessions={storeOf([])} visible ports={{ ...portsOf(), openStep }} />)
    const followed = screen.getByRole('region', { name: '3 conflicts: merger on 1, 2 need you' })
    expect(within(followed).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['Merger works on', 'Needs you'])
  })

  it('draws no list where the action carries none, and the conflict step is then no button', () => {
    render(<WorkflowPane session={session(workflowOf({ rounds: [{ title: 'Finish', steps: [
      step('1:conflicts', 'Conflicts', 'waits', { target: { kind: 'conflicts' } }),
    ] }] }))} sessions={storeOf([])} visible ports={portsOf()} />)
    expect(screen.getByText('Conflicts').closest('button')).toBeNull()
    expect(document.querySelector('.workflow__conflicts')).toBeNull()
  })

  it('ticks the running step only while the pane is visible', () => {
    vi.useFakeTimers()
    vi.setSystemTime(12_000)
    const view = render(<WorkflowPane session={session(workflowOf())} sessions={storeOf([])} visible={false} ports={portsOf()} />)
    const running = () => document.querySelector('.workflow__step[data-state="running"] .workflow__time')?.textContent
    expect(running()).toBe('2 s')
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(running()).toBe('2 s')

    view.rerender(<WorkflowPane session={session(workflowOf())} sessions={storeOf([])} visible ports={portsOf()} />)
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(running()).toBe('6 s')
  })
})
