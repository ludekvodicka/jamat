import * as React from 'react'
import { WorktreeWords } from '../../../lib-orchestrator/worktrees/worktreeViews'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo, SessionsSnapshot, SessionWorkflowBody, SessionWorkflowInfo } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { AppControl } from '../ipc/appControl'
import type { WorkflowPorts } from '../workflow/workflowPane'
import { SessionActionsPane, SessionActionsScroll } from './sessionActionsPane'
import { StepBody } from './stepBody'
import { WorkflowPortsOf } from '../workflow/workflowPorts'
import type { CommitPanePorts } from '../versioning/commitPanePorts'
import type { VersioningCommitDraftDto } from '../../shared/versioningCommit'
import type { FileChangesWorkingTreeSnapshot } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'

function reviewFixture(override: Partial<VersioningCommitDraftDto> = {}, files: Partial<FileChangesWorkingTreeSnapshot> = {}) {
  let draft: VersioningCommitDraftDto = { draftId: 'draft', sessionId: 's1', vcs: 'svn', source: 'svn', scopeRoot: 'Q:/work',
    scopeTooltip: 'Q:/work', message: 'Fix selection', proposedByAgent: true, editedByPerson: false, phase: { kind: 'editing' }, revision: 1, ...override }
  const snapshot: FileChangesWorkingTreeSnapshot = { snapshotId: 'snapshot', sessionId: 's1', createdAt: 1,
    source: { requested: 'svn', selected: 'svn', available: ['svn'], fallbackReason: null },
    defaultBaseline: { kind: 'svn-base', revision: null, label: 'BASE', baselineId: 'base', createdAt: null },
    entries: ['a.txt', 'b.txt'].map((name) => ({ fileId: name, path: `Q:/work/${name}`, displayPath: name, nodeKind: 'file', status: 'modified',
      location: 'workspace', previousPath: null, previousDisplayPath: null, modifiedAt: 1, sources: ['vcs'], gitState: null })), externalRoots: [], warnings: [], ...files }
  const listeners = new Set<() => void>()
  const bridge: CommitPanePorts = {
    versioning: {
      openDraft: vi.fn<CommitPanePorts['versioning']['openDraft']>(async () => ({ ok: true, value: { ok: true, value: { draftId: 'draft', scopeRoot: 'Q:/work', title: 'Commit SVN' }, messageApplied: false } })),
      readCommit: vi.fn<CommitPanePorts['versioning']['readCommit']>(async () => ({ ok: true, value: structuredClone(draft) })),
      commitFiles: vi.fn<CommitPanePorts['versioning']['commitFiles']>(async () => ({ ok: true, value: { ok: true, value: snapshot } })),
      setCommitMessage: vi.fn<CommitPanePorts['versioning']['setCommitMessage']>(async (_id, message) => {
        draft = { ...draft, message, editedByPerson: true, revision: draft.revision + 1 }
        for (const listener of listeners) listener()
        return { ok: true, value: true }
      }),
      runCommit: vi.fn(), closeCommit: vi.fn<CommitPanePorts['versioning']['closeCommit']>(async () => ({ ok: true, value: undefined })),
      openTortoise: vi.fn(), revertCommitFile: vi.fn(), externalDiff: vi.fn(), saveSettings: vi.fn(),
      getSettings: vi.fn<CommitPanePorts['versioning']['getSettings']>(async () => ({ ok: true, value: { mode: 'checkpoints', diffTool: { kind: 'internal' } } })),
    },
    openFile: vi.fn(), releaseFile: vi.fn(), reportError: vi.fn(),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  ports.reviews = bridge
  const workflow = section('Finish', true)
  workflow.rounds[0].steps = [{ key: '1:changes', title: 'Changes', detail: '', state: 'waits', startedAt: null, endedAt: null,
    target: { kind: 'none' }, body: { kind: 'commit', vcs: 'svn', scopeRoot: 'Q:/work' } }]
  workflow.actions = [{ id: 'finish-again', label: 'Commit & merge', primary: true, place: 'step', requiresCommit: true },
    { id: 'discard', label: 'Discard', primary: false, place: 'step', confirm: 'Discard the changes?' },
    { id: 'keep', label: 'Keep', primary: false, place: 'step' }]
  return { workflow, bridge, changeDraft: (change: Partial<VersioningCommitDraftDto>) => {
    draft = { ...draft, ...change, revision: draft.revision + 1 }
    for (const listener of listeners) listener()
    return structuredClone(draft)
  } }
}

function repositoryFixture() {
  const repositories = ['front', 'apps'].map((repositoryName) => ({ root: `Q:/work/${repositoryName}`, repositoryName,
    repository: `https://svn/${repositoryName}`, expectedPrefix: `[${repositoryName}]`, paths: ['a.txt'],
    message: `[${repositoryName}] Fix`, source: 'person-local' as const, acknowledged: [] }))
  const fixture = reviewFixture({ epoch: 'source', repositories })
  const body = fixture.workflow.rounds[0].steps[0].body!
  if (body.kind !== 'commit') throw new Error('Expected review')
  body.repositories = repositories
  const edit = vi.fn<NonNullable<CommitPanePorts['versioning']['editCommit']>>()
  fixture.bridge.versioning = { ...fixture.bridge.versioning, editCommit: edit }
  return { ...fixture, repositories, edit }
}

const ports: WorkflowPorts = { clearHistory: vi.fn(async (): Promise<string | null> => null), reviews: {} as CommitPanePorts, tasks: {
  scriptOutput: (request) => AppControl.call('sessions.scriptOutput', request),
  transcript: (request) => AppControl.call('sessionTasks.transcript', request),
  shellOutput: (request) => AppControl.call('sessionTasks.shellOutput', request),
}, openStep: vi.fn(), press: vi.fn(async () => ({ kind: 'done' as const })),
  conflicts: { resolve: vi.fn(), openFile: vi.fn(), openConflictEditor: vi.fn(), openBrief: vi.fn() } }
const store = { current: () => ({ snapshot: { sessions: [] } as unknown as SessionsSnapshot, error: null }), subscribe: () => () => {} }
const section = (id: string, open: boolean): SessionWorkflowInfo => ({ kind: 'before', workflowId: id, title: id, open, badge: '', summary: '',
  actions: [], rounds: [{ title: id, steps: [{ key: 'run', title: 'Checkout', detail: '', state: open ? 'running' : 'done',
    startedAt: null, endedAt: null, target: { kind: 'run', runId: 'r1' }, body: { kind: 'log', runId: 'r1' } }] }] })
const session = (sections: SessionWorkflowInfo[]) => {
  const info = { sessionId: 's1', actions: { sections } } as SessionInfo
  WorktreeWords.decorate(info)
  return info
}

describe('Session actions', () => {
  it('binds the first automatic review after syncing and refuses a later version while it stays open', async () => {
    const { workflow } = reviewFixture()
    workflow.badge = 'Ready for validation'
    const syncing = { ...session([section('Finish', true)]), worktreeView: { version: 3 } } as SessionInfo
    const view = render(<SessionActionsPane session={syncing} sessions={store} visible ports={ports} />)
    expect(screen.queryByRole('region', { name: 'Review changes' })).toBeNull()
    const reviewing = { ...session([workflow]), worktreeView: { version: 4 } } as SessionInfo
    view.rerender(<SessionActionsPane session={reviewing} sessions={store} visible ports={ports} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled())
    expect(screen.queryByText(/This review is outdated/)).toBeNull()
    expect(screen.getByText('Ready for validation')).toBeVisible()
    view.rerender(<SessionActionsPane session={{ ...reviewing, worktreeView: { ...reviewing.worktreeView!, version: 5 } }} sessions={store} visible ports={ports} />)
    expect(screen.getByText(/This review is outdated/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Commit & merge' }))
    expect(ports.press).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reload current review' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled())
    expect(screen.queryByText(/This review is outdated/)).toBeNull()
  })

  it('refuses a still-open review after another window transitions its version', async () => {
    const { workflow } = reviewFixture()
    const initial = { ...session([workflow]), worktreeView: { version: 3 } } as SessionInfo
    const view = render(<SessionActionsPane session={initial} sessions={store} visible ports={ports} />)
    await screen.findByRole('button', { name: 'Commit & merge' })
    view.rerender(<SessionActionsPane session={{ ...initial, worktreeView: { ...initial.worktreeView!, version: 4 } }} sessions={store} visible ports={ports} />)
    expect(screen.getByText(/This review is outdated/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Commit & merge' }))
    expect(ports.press).not.toHaveBeenCalled()
  })

  it('retires an acknowledged repository edit so a later remote source message appears', async () => {
    const f = repositoryFixture()
    f.edit.mockImplementation(async (request) => ({ ok: true, value: { ok: true, value:
      f.changeDraft({ repositories: f.repositories.map((row) => row.root === request.repositoryMessage?.root ? { ...row, message: request.repositoryMessage.message } : row) }) } }))
    render(<SessionActionsPane session={session([f.workflow])} sessions={store} visible ports={ports} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled())
    // Each repository commits with its own message, so the one shared message box is not offered.
    expect(screen.queryByLabelText('Commit message')).toBeNull()
    fireEvent.change(screen.getByLabelText('Commit message front (front)'), { target: { value: '[front] Local A' } })
    await waitFor(() => expect(f.bridge.versioning.editCommit).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled())
    await act(async () => { f.changeDraft({ repositories: f.repositories.map((row) => ({ ...row, message: `[${row.repositoryName}] Remote B`, source: 'person-remote' })) }) })
    await waitFor(() => expect(screen.getByLabelText('Commit message front (front)')).toHaveValue('[front] Remote B'))
    expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled()
  })

  it('keeps a newer pending repository keystroke when the source acknowledges the previous edit', async () => {
    const f = repositoryFixture()
    const replies: (() => void)[] = []
    f.edit.mockImplementation((request) => new Promise((resolve) => replies.push(() => resolve({ ok: true, value: { ok: true, value:
      f.changeDraft({ repositories: f.repositories.map((row) => row.root === request.repositoryMessage?.root ? { ...row, message: request.repositoryMessage.message } : row) }) } }))))
    render(<SessionActionsPane session={session([f.workflow])} sessions={store} visible ports={ports} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled())
    const editor = screen.getByLabelText('Commit message front (front)')
    fireEvent.change(editor, { target: { value: '[front] A' } })
    await waitFor(() => expect(replies).toHaveLength(1))
    fireEvent.change(editor, { target: { value: '[front] AB' } })
    await act(async () => { replies[0]() })
    await waitFor(() => expect(replies).toHaveLength(2))
    expect(editor).toHaveValue('[front] AB')
    expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeDisabled()
    await act(async () => { replies[1]() })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled())
  })

  it('shows a rejected repository save and preserves its unsent text', async () => {
    const f = repositoryFixture()
    f.edit.mockImplementation(async () => { throw new Error('Repository save disconnected') })
    render(<SessionActionsPane session={session([f.workflow])} sessions={store} visible ports={ports} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Commit message front (front)'), { target: { value: '[front] Unsent' } })
    await waitFor(() => expect(screen.getAllByText(/Repository save disconnected/).length).toBeGreaterThan(0))
    expect(screen.getByLabelText('Commit message front (front)')).toHaveValue('[front] Unsent')
    expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeDisabled()
  })

  it('does not carry an unsent human message to a different repository at the same mount', async () => {
    const f = repositoryFixture()
    f.edit.mockImplementation(async () => { throw new Error('Save disconnected') })
    render(<SessionActionsPane session={session([f.workflow])} sessions={store} visible ports={ports} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Commit message front (front)'), { target: { value: '[front] Private unsent draft' } })
    await waitFor(() => expect(screen.getAllByText(/Save disconnected/).length).toBeGreaterThan(0))
    await act(async () => { f.changeDraft({ repositories: f.repositories.map((row) => row.repositoryName === 'front'
      ? { ...row, repository: 'https://svn/replacement', repositoryName: 'replacement', expectedPrefix: '[replacement]', message: '' } : row) }) })
    await waitFor(() => expect(screen.getByLabelText('Commit message replacement (front)')).toHaveValue('[replacement] '))
    expect(screen.queryByDisplayValue('[front] Private unsent draft')).toBeNull()
  })

  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals() })

  it('shows an empty log for a plain session and restores ended sections with their time after reopening', () => {
    const view = render(<SessionActionsPane session={session([])} sessions={store} visible ports={ports} />)
    expect(screen.getByText('No session actions recorded.')).toBeTruthy()
    view.unmount()
    const history = session([{ ...section('Finished action', false), startedAt: 1_700_000_000_000 }])
    const first = render(<SessionActionsPane session={history} sessions={store} visible ports={ports} />)
    fireEvent.click(screen.getByRole('button', { name: /Finished action/ }))
    expect(screen.getByText('Checkout')).toBeTruthy()
    first.unmount()
    render(<SessionActionsPane session={history} sessions={store} visible ports={ports} />)
    expect(screen.getByRole('button', { name: /Finished action/ }).getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe('2023-11-14T22:13:20.000Z')
  })

  it('offers Stop on a running requested run and presses the stop of that run', async () => {
    const stop = { id: 'stop-run' as const, label: 'Stop', primary: false, runId: 'v1' }
    render(<SessionActionsPane session={session([{ ...section('Worktree validation', true), kind: 'script', actions: [stop] }])} sessions={store} visible ports={ports} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(ports.press).toHaveBeenCalledExactlyOnceWith(
      { ...stop, command: { operation: 'sessions.finalize', sessionId: 'v1', body: { expect: 'stop' } } }, {}, undefined))
  })

  // UA1-J10-8: the failed run of an old Host instance had no Remove here, only in the CLI.
  it('offers Remove on an ended requested run and presses the removal of that run', async () => {
    const remove = { id: 'remove-run' as const, label: 'Remove', primary: false, runId: 'r1' }
    render(<SessionActionsPane session={session([{ ...section('j10-requested-fail', false), kind: 'script', actions: [remove] }])} sessions={store} visible ports={ports} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(ports.press).toHaveBeenCalledExactlyOnceWith(
      { ...remove, command: { operation: 'sessions.remove', sessionId: 'r1', body: {} } }, {}, undefined))
  })

  it('draws sections in order and starts completed sections collapsed', () => {
    render(<SessionActionsPane session={session([section('Setup', false), section('Finish', true)])} sessions={store} visible ports={ports} />)
    expect(Array.from(document.querySelectorAll('.session-actions__heading')).map((element) => [element.textContent, element.getAttribute('aria-expanded')]))
      .toEqual([['Setup', 'false'], ['Finish', 'true']])
    expect(screen.getAllByText('Checkout')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Setup' }))
    expect(screen.getAllByText('Checkout')).toHaveLength(2)
  })

  // UA1-J07-7: the outcome of a kept worktree carries its decision; a collapsed heading hid it.
  it('starts a closed section with presses expanded and confirms Discard of a kept worktree before pressing it', async () => {
    const confirm = 'Already published: j07ea r4. 1 changed path is not published and will be discarded with this worktree. Save a copy and discard it?'
    const kept = { ...section('Finish of 002', false), kind: 'finish' as const, actions: [
      { id: 'prepare-worktree' as const, label: 'Update and prepare again', primary: true }, { id: 'discard' as const, label: 'Discard', primary: false, confirm }] }
    render(<SessionActionsPane session={session([section('Setup', false), kept])} sessions={store} visible ports={ports} />)
    expect(Array.from(document.querySelectorAll('.session-actions__heading')).map((element) => element.getAttribute('aria-expanded')))
      .toEqual(['false', 'true'])
    expect(screen.getByRole('button', { name: 'Update and prepare again' })).toBeEnabled()
    vi.mocked(ports.press).mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(ports.press).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain(confirm)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Confirm Discard' })))
    expect(ports.press).toHaveBeenCalledWith({ ...kept.actions[1], command: { operation: 'sessions.finishWorktree', body: { choice: 'discard' } } }, {}, undefined)
  })

  it('draws the session step and its progress under the running client stage', () => {
    const removing: SessionWorkflowInfo = { kind: 'finish', workflowId: 'f', title: 'Finish', open: true, badge: '', summary: '', actions: [],
      rounds: [{ title: 'Finish', steps: [{ key: 'remove', title: 'Remove the worktree', detail: '', state: 'running',
        startedAt: null, endedAt: null, target: { kind: 'none' } }] }] }
    const info = { ...session([removing]),
      step: { text: 'Removing the worktree', detail: '12,000 of 48,000 files', progress: { done: 12000, total: 48000 }, startedAt: null } } as SessionInfo
    render(<SessionActionsPane session={info} sessions={store} visible ports={ports} />)
    expect(screen.getByText('Removing the worktree · 12,000 of 48,000 files')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25')
  })

  it('reads a run only while its body is expanded and stops polling at its saved log', async () => {
    vi.useFakeTimers()
    const call = vi.spyOn(AppControl, 'call').mockResolvedValue({ ok: true, value: { ok: true, value: {
      source: 'live', state: 'running', terminal: null, lines: ['Checking out'], truncated: false,
    } } } as never)
    render(<SessionActionsPane session={session([section('Setup', true)])} sessions={store} visible ports={ports} />)
    expect(call).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Show details: Checkout' })))
    expect(screen.getByText('Checking out')).toBeTruthy()
    expect(call).toHaveBeenCalledWith('sessions.scriptOutput', { sessionId: 's1', runId: 'r1' })
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(call).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Hide details: Checkout' }))
    await act(async () => vi.advanceTimersByTimeAsync(4000))
    expect(call).toHaveBeenCalledTimes(2)
    call.mockResolvedValue({ ok: true, value: { ok: true, value: { source: 'log', state: 'succeeded', terminal: null,
      lines: ['Finished'], truncated: false } } } as never)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Show details: Checkout' })))
    expect(screen.getByText('Finished')).toBeTruthy()
    await act(async () => vi.advanceTimersByTimeAsync(4000))
    expect(call).toHaveBeenCalledTimes(3)
    expect(ports.openStep).not.toHaveBeenCalled()
  })

  it('shows supplied message findings and source, and requires a fresh acknowledgement for each message', async () => {
    const { workflow } = reviewFixture({ message: 'Shrnutí: U 043 zatím necommituj', messageSource: 'agent-proposal',
      messageFindings: [{ id: 'no-prefix', text: 'No [Project] prefix', confirm: true }, { id: 'chat-opening', text: 'Chat opening', confirm: true }] })
    render(<SessionActionsPane session={session([workflow])} sessions={store} visible ports={ports} />)
    expect(await screen.findByText('No [Project] prefix')).toBeTruthy()
    expect(screen.getByText('Chat opening')).toBeTruthy()
    expect(screen.getByText('Source: agent-proposal')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeDisabled()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'I checked this message' }))
    expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), { target: { value: 'Different message' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeDisabled())
  })

  it('keeps Commit disabled for an empty message even when there are no selections to change', async () => {
    const { workflow } = reviewFixture({ message: '', messageFindings: [{ id: 'empty', text: 'Enter a commit message' }] })
    render(<SessionActionsPane session={session([workflow])} sessions={store} visible ports={ports} />)
    expect(await screen.findByText('Enter a commit message')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeDisabled()
    expect(screen.queryByRole('checkbox', { name: 'I checked this message' })).toBeNull()
  })

  it('names no missing file while the review is still loading its selection (UA1-J13-7)', async () => {
    const { workflow } = reviewFixture()
    workflow.validation = { cwd: 'Q:/work', checks: 'passed', canRun: false, requiredSelection: ['Q:/work/a.txt', 'Q:/work/b.txt'] }
    render(<SessionActionsPane session={session([workflow])} sessions={store} visible ports={ports} />)
    expect(screen.queryByText('Include the whole verified change set. Missing:')).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled())
    expect(screen.queryByText('Include the whole verified change set. Missing:')).toBeNull()
  })

  it('blocks an incomplete required selection and names the omitted file', async () => {
    const { workflow } = reviewFixture()
    workflow.validation = { cwd: 'Q:/work', checks: 'passed', canRun: false, requiredSelection: ['Q:/work/a.txt', 'Q:/work/b.txt'] }
    render(<SessionActionsPane session={session([workflow])} sessions={store} visible ports={ports} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled())
    fireEvent.click(screen.getByLabelText('Include b.txt'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeDisabled())
    const missing = screen.getByRole('list', { name: 'Missing from the selection' })
    expect(screen.getByText('Include the whole verified change set. Missing:')).toBeTruthy()
    expect(within(missing).getByText('b.txt').getAttribute('title')).toBe('Q:/work/b.txt')
    // A long list scrolls inside its own bound instead of squeezing the message editor above it.
    expect(missing.closest('.session-actions__missing')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Commit & merge' }))
    expect(ports.press).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Include b.txt'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled())
  })

  it('sends the reviewed selection to Finish, returns to its history, and requires a second press for Discard', async () => {
    const { workflow, bridge } = reviewFixture()
    render(<SessionActionsPane session={session([workflow])} sessions={store} visible ports={ports} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled())
    expect(screen.getAllByRole('button', { name: 'Commit & merge' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
    fireEvent.click(screen.getByLabelText('Include b.txt'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Commit & merge' })))
    expect(ports.press).toHaveBeenCalledWith(workflow.actions[0], {}, { selection: ['Q:/work/a.txt'], message: 'Fix selection', messageSource: 'unknown', acknowledgedFindings: [] })
    expect(screen.queryByRole('region', { name: 'Review changes' })).toBeNull()
    expect(bridge.versioning.runCommit).not.toHaveBeenCalled()
    vi.mocked(ports.press).mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(ports.press).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('Discard the changes?')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Confirm Discard' })))
    expect(ports.press).toHaveBeenCalledWith(workflow.actions[1], {}, undefined)
  })

  it('opens an embedded live script through the injected source terminal navigation', async () => {
    const local = vi.spyOn(AppControl, 'call')
    const openTerminal = vi.fn(async () => null)
    const source = { ...ports, tasks: { ...ports.tasks!, openTerminal, scriptOutput: vi.fn(async () => ({ ok: true as const, value: {
      ok: true as const, value: { source: 'live' as const, state: 'running' as const, lines: ['Remote checkout'],
        terminal: { hostInstanceId: 'source-host', runtimeSessionId: 'source-runtime', generation: 1 } },
    } })) } }
    render(<SessionActionsPane session={session([section('Setup', true)])} sessions={store} visible ports={source} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Show details: Checkout' })))
    expect(screen.getByText('Remote checkout')).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open terminal' })))
    expect(openTerminal).toHaveBeenCalledExactlyOnceWith('r1')
    expect(local).not.toHaveBeenCalled()
  })

  it('keeps local embedded script navigation in the local workflow composition', async () => {
    vi.stubGlobal('appClient', { fileChanges: {}, fileViewer: {} })
    const call = vi.spyOn(AppControl, 'call').mockResolvedValue({ ok: true, value: { ok: true, value: {} } } as never)
    const local = WorkflowPortsOf.of('s1', vi.fn(), () => null)
    expect(await local.tasks?.openTerminal?.('r1')).toBeNull()
    expect(call).toHaveBeenCalledExactlyOnceWith('tabs.open', { session: { kind: 'sessionId', sessionId: 'r1' } })
  })

  it('collapses every section and log, stops polling, and keeps logs closed when a section is reopened', async () => {
    vi.useFakeTimers()
    const call = vi.spyOn(AppControl, 'call').mockResolvedValue({ ok: true, value: { ok: true, value: {
      source: 'live', state: 'running', terminal: null, lines: ['Updating'], truncated: false,
    } } } as never)
    const first = section('First', true)
    const second = section('Second', true)
    for (const workflow of [first, second]) workflow.rounds[0].steps[0].state = 'waits'
    render(<SessionActionsPane session={session([first, second])} sessions={store} visible ports={ports} />)
    await act(async () => {})
    expect(screen.getAllByRole('button', { name: 'Close log: Checkout' })).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(screen.queryByText('Updating')).toBeNull()
    expect(screen.getByRole('button', { name: 'First' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'Second' })).toHaveAttribute('aria-expanded', 'false')
    const reads = call.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(4000))
    expect(call).toHaveBeenCalledTimes(reads)
    fireEvent.click(screen.getByRole('button', { name: 'First' }))
    expect(screen.getByRole('button', { name: 'Show details: Checkout' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Updating')).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Show details: Checkout' })))
    fireEvent.click(screen.getByRole('button', { name: 'Close log: Checkout' }))
    expect(screen.getByRole('button', { name: 'Show details: Checkout' })).toHaveFocus()
    expect(screen.queryByText('Updating')).toBeNull()
    const closedReads = call.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(4000))
    expect(call).toHaveBeenCalledTimes(closedReads)
  })

  it('clears through the session operation, keeps active sections, and reports a refusal without hiding history', async () => {
    const local = vi.spyOn(AppControl, 'sessions')
    const clear = vi.mocked(ports.clearHistory!).mockResolvedValue('The history could not be saved')
    const view = render(<SessionActionsPane session={session([section('Old setup', false), section('Running', true)])} sessions={store} visible ports={ports} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Clear' })))
    expect(clear).toHaveBeenCalledWith()
    expect(local).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('The history could not be saved')
    expect(screen.getByRole('button', { name: 'Old setup' })).toBeTruthy()
    clear.mockResolvedValue(null)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Clear' })))
    view.rerender(<SessionActionsPane session={session([section('Running', true)])} sessions={store} visible ports={ports} />)
    expect(screen.queryByRole('button', { name: 'Old setup' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Running' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(ports.press).not.toHaveBeenCalled()
    view.rerender(<SessionActionsPane session={session([{ ...section('Failed setup', false),
      actions: [{ id: 'retry-setup', label: 'Retry setup', primary: true }] }])} sessions={store} visible ports={ports} />)
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled()
  })

  it('keeps the real editor, message and selection across Back, Escape and reopening', async () => {
    const { workflow, bridge } = reviewFixture()
    const view = render(<SessionActionsPane session={session([section('Setup', false), workflow])} sessions={store} visible ports={ports} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled())
    const editor = screen.getByRole('textbox', { name: 'Commit message' })
    expect(screen.queryByRole('button', { name: 'Setup' })).toBeNull()
    fireEvent.click(screen.getByLabelText('Include b.txt'))
    fireEvent.change(editor, { target: { value: 'Only the reviewed file' } })
    fireEvent.click(screen.getByRole('button', { name: 'Back to Session actions' }))
    expect(screen.getByRole('button', { name: 'Setup' })).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(ports.press).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(screen.getByRole('textbox')).toBe(editor)
    expect(editor).toHaveValue('Only the reviewed file')
    expect(screen.getByLabelText('Include b.txt')).not.toBeChecked()
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(bridge.versioning.runCommit).not.toHaveBeenCalled()
    fireEvent.keyDown(editor, { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    fireEvent.keyDown(screen.getByRole('region', { name: 'Session actions' }), { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
    view.rerender(<SessionActionsPane session={session([workflow])} sessions={store} visible ports={ports} />)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(bridge.versioning.closeCommit).not.toHaveBeenCalled()
  })

  // UA1-J09-8: Try again, Verify again and a confirmed press took 6 to 7 s with nothing to see.
  it('says at once under the pressed button that its press runs, and drops the line when it is answered', async () => {
    const waiting = { ...section('Finish of 001', true), kind: 'finish' as const, actions: [
      { id: 'finish-again' as const, label: 'Verify again', primary: true, place: 'step' as const },
      { id: 'discard' as const, label: 'Discard', primary: false, confirm: 'Discard it?' }] }
    let settle!: (answer: Awaited<ReturnType<WorkflowPorts['press']>>) => void
    const press = vi.fn<WorkflowPorts['press']>(() => new Promise((resolve) => { settle = resolve }))
    render(<SessionActionsPane session={session([waiting])} sessions={store} visible ports={{ ...ports, press }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Verify again' }))
    const group = screen.getByRole('group', { name: 'Checkout actions' })
    expect(within(group).getByRole('status')).toHaveTextContent('Verify again: sent, Jamat works on it')
    expect(screen.getByRole('button', { name: 'Verify again' })).toBeDisabled()
    await act(async () => settle({ kind: 'done' }))
    expect(within(group).queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Discard' }))
    expect(screen.getAllByRole('status').map((line) => line.textContent)).toContain('Discard: sent, Jamat works on it')
    await act(async () => settle({ kind: 'done' }))
  })

  // UA1-J12-6: two clicks inside one task both passed the enabled button; the later one read a version the first had cleared.
  it('ignores the second press of a fast double click and sends the version the first press saw', async () => {
    const f = reviewFixture({ epoch: 'source' })
    f.bridge.versioning = { ...f.bridge.versioning, decideCommit: vi.fn(),
      editCommit: vi.fn(async () => ({ ok: true as const, value: { ok: true as const, value: f.changeDraft({}) } })) }
    const press = vi.fn<WorkflowPorts['press']>(async () => ({ kind: 'done' as const }))
    const revised = { current: () => ({ snapshot: { sessions: [], revision: 7 } as unknown as SessionsSnapshot, error: null }), subscribe: () => () => {} }
    render(<SessionActionsPane session={{ ...session([f.workflow]), worktreeView: { version: 4 } } as SessionInfo} sessions={revised} visible ports={{ ...ports, press }} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled())
    const button = screen.getByRole('button', { name: 'Commit & merge' })
    await act(async () => { button.click(); button.click() })
    await waitFor(() => expect(press).toHaveBeenCalled(), { timeout: 5_000 })
    await act(async () => {})
    expect(press).toHaveBeenCalledTimes(1)
    expect(press.mock.calls[0][2]).toMatchObject({ reviewVersion: 4 })
  })

  it('approves the review an enabled button was drawn with when the click comes before the effects of that render', async () => {
    const f = reviewFixture({ epoch: 'source' })
    f.bridge.versioning = { ...f.bridge.versioning, decideCommit: vi.fn(),
      editCommit: vi.fn(async () => ({ ok: true as const, value: { ok: true as const, value: f.changeDraft({}) } })) }
    const press = vi.fn<WorkflowPorts['press']>(async () => ({ kind: 'done' as const }))
    const revised = { current: () => ({ snapshot: { sessions: [], revision: 7 } as unknown as SessionsSnapshot, error: null }), subscribe: () => () => {} }
    // The observer runs in the microtask after the commit that enables the button, before React runs that commit's effects.
    const observer = new MutationObserver(() => {
      const button = screen.queryByRole('button', { name: 'Commit & merge' })
      if (button === null || button.hasAttribute('disabled')) return
      observer.disconnect()
      button.click()
    })
    observer.observe(document.body, { subtree: true, childList: true, attributes: true })
    render(<SessionActionsPane session={{ ...session([f.workflow]), worktreeView: { version: 4 } } as SessionInfo} sessions={revised} visible ports={{ ...ports, press }} />)
    await waitFor(() => expect(press).toHaveBeenCalledWith(f.workflow.actions[0], {}, expect.objectContaining({ selection: ['Q:/work/a.txt', 'Q:/work/b.txt'] })))
    expect(screen.queryByText(/shared review changed/i)).toBeNull()
  })

  // UA1-J12-3: the request never reached the source, yet the pane said the shared review changed.
  it('says a Publish whose review save the channel lost was not sent, and draws no changed review', async () => {
    const f = reviewFixture({ epoch: 'source' })
    f.bridge.versioning = { ...f.bridge.versioning, decideCommit: vi.fn(),
      editCommit: vi.fn(async () => ({ ok: false as const, error: 'Remote session view request timed out', channelLost: { computer: 'Peer PC', accepted: false } })) }
    const press = vi.fn<WorkflowPorts['press']>(async () => ({ kind: 'done' as const }))
    const revised = { current: () => ({ snapshot: { sessions: [], revision: 7 } as unknown as SessionsSnapshot, error: null }), subscribe: () => () => {} }
    render(<SessionActionsPane session={{ ...session([f.workflow]), worktreeView: { version: 4 } } as SessionInfo} sessions={revised} visible ports={{ ...ports, press }} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled())
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Commit & merge' })))
    expect(await screen.findAllByText('Not sent: the connection to Peer PC is lost; nothing was approved.')).not.toHaveLength(0)
    expect(screen.queryByText(/shared review changed/i)).toBeNull()
    expect(press).not.toHaveBeenCalled()
  })

  // UA1-J12-4: nobody typed here, the compare showed the hidden top-level message, and Reload kept the refusals.
  it('refuses a stale press without claiming unsent text, compares the changed repository message, and clears the refusals on reload', async () => {
    const f = repositoryFixture()
    f.bridge.versioning = { ...f.bridge.versioning, decideCommit: vi.fn() }
    f.edit.mockImplementation(async () => ({ ok: true, value: { ok: false, code: 'stale', detail: 'This review changed in another viewer. Compare or reload its edits.',
      current: f.changeDraft({ message: 'Hidden top-level draft', repositories: f.repositories.map((row) => row.repositoryName === 'front' ? { ...row, message: '[front] Peer edit' } : row) }) } }))
    const revised = { current: () => ({ snapshot: { sessions: [], revision: 7 } as unknown as SessionsSnapshot, error: null }), subscribe: () => () => {} }
    render(<SessionActionsPane session={{ ...session([f.workflow]), worktreeView: { version: 4 } } as SessionInfo} sessions={revised} visible ports={ports} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled())
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Commit & merge' })))
    expect(await screen.findAllByText('The shared review changed. Read the source selection and message again.')).not.toHaveLength(0)
    expect(screen.getByText('Shared review changed.')).toBeInTheDocument()
    expect(screen.queryByText(/unsent text/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Use my text' })).toBeNull()
    const compare = within(screen.getByText('Compare source message').closest('details')!)
    expect(compare.getByText('[front] Peer edit')).toBeInTheDocument()
    expect(compare.queryByText('[apps] Fix')).toBeNull()
    expect(compare.queryByText('Hidden top-level draft')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reload shared edits' }))
    expect(screen.queryByText('The shared review changed. Read the source selection and message again.')).toBeNull()
    expect(screen.queryByText('This review changed in another viewer. Compare or reload its edits.')).toBeNull()
    expect(ports.press).not.toHaveBeenCalled()
  })

  it('returns immediately while Finish is pending and preserves review after a refusal', async () => {
    const { workflow } = reviewFixture()
    let settle!: (answer: Awaited<ReturnType<WorkflowPorts['press']>>) => void
    const press = vi.fn<WorkflowPorts['press']>(() => new Promise((resolve) => { settle = resolve }))
    render(<SessionActionsPane session={session([workflow])} sessions={store} visible ports={{ ...ports, press }} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Commit & merge' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('button', { name: 'Review changes' })).toBeDisabled()
    await act(async () => settle({ kind: 'refused', sentence: 'The selected content changed. Review again.' }))
    expect(screen.getByRole('alert')).toHaveTextContent('The selected content changed')
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(screen.getByRole('textbox')).toHaveValue('Fix selection')
  })

  it('opens a new review after changed content and removes its executable controls when the section closes', async () => {
    const { workflow, bridge } = reviewFixture()
    const view = render(<SessionActionsPane session={session([workflow])} sessions={store} visible ports={ports} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled())
    const initialReads = vi.mocked(bridge.versioning.commitFiles).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Back to Session actions' }))
    const next = { ...workflow, rounds: [{ title: 'Retry', steps: [{ ...workflow.rounds[0].steps[0], key: '2:changes',
      body: { kind: 'commit' as const, vcs: 'svn' as const, scopeRoot: 'Q:/work', marked: ['a.txt'] } }] }] }
    view.rerender(<SessionActionsPane session={session([next])} sessions={store} visible ports={ports} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeEnabled())
    expect(vi.mocked(bridge.versioning.commitFiles).mock.calls.length).toBeGreaterThan(initialReads)
    expect(screen.getByText('Changed during update. Review again: a.txt')).toBeTruthy()
    view.rerender(<SessionActionsPane session={session([{ ...next, open: false, actions: [] }])} sessions={store} visible ports={ports} />)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Review changes' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Commit & merge' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Changes' })).toBeNull()
  })

  it('says the live sessions of the main copy are unknown while the Host cannot be reached, and lists none (UA1-J08-6)', () => {
    render(<StepBody body={{ kind: 'sessions', sessions: [], liveUnknown: true }} sessionId="s1" title="X" visible ports={ports} conflicts={ports.conflicts} />)
    expect(screen.getByText('The Host cannot be reached, so which sessions still run in the main copy is unknown. The update changes files under any that do.')).toBeTruthy()
    expect(screen.queryByText('No other live sessions work in the main copy.')).toBeNull()
    expect(screen.queryAllByRole('listitem')).toEqual([])
  })

  it('throws for an unknown body in the exhaustive renderer', () => {
    expect(() => StepBody({ body: { kind: 'unknown' } as unknown as SessionWorkflowBody, sessionId: 's1', title: 'X', visible: true,
      ports, conflicts: ports.conflicts })).toThrow('Unknown step body')
  })

  it('keeps Later waiting, folds the presses into its line until Show brings them back, sends exactly the displayed live IDs, and redraws a changed list inline', async () => {
    const call = vi.spyOn(AppControl, 'sessionsDone').mockResolvedValue({ ok: true, value: { ok: false, code: 'live-sessions',
      detail: 'The sessions working in Q:/Work/App changed; confirm the current list (2 live).' } })
    const workflow = section('Finish', true)
    workflow.rounds[0].steps = [{ key: 'main-update', title: 'Update main copy', detail: '', state: 'waits', startedAt: null, endedAt: null,
      target: { kind: 'none' }, body: { kind: 'sessions', sessions: [{ sessionId: 'one', title: '021 - Coordinator', number: '021' },
        { sessionId: 'two', title: 'J08 main shell C', number: 'J08' }] } }]
    workflow.actions = [{ id: 'update-main', label: 'Update', primary: true, place: 'step', confirmLive: ['one', 'two'] },
      { id: 'later', label: 'Later', primary: false, place: 'step', deferred: 'Main copy update left for later. It still waits on this step.' }]
    const updatePorts = { ...ports, press: (action: Parameters<WorkflowPorts['press']>[0]) => WorkflowPortsOf.press('s1', action, {}) }
    const view = render(<SessionActionsPane session={session([workflow])} sessions={store} visible ports={updatePorts} />)
    // UA1-J08-6: the title already starts with its number, so each session reads once.
    expect(within(screen.getByRole('list', { name: 'Live sessions in the main copy' })).getAllByRole('listitem').map((item) => item.textContent))
      .toEqual(['021 - Coordinator', 'J08 main shell C'])
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Later' })))
    expect(call).not.toHaveBeenCalled()
    expect(within(screen.getByRole('group', { name: 'Update main copy actions' })).getByRole('status').textContent).toBe('Main copy update left for later. It still waits on this step.')
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Later' })).toBeNull()
    expect(screen.getByRole('list', { name: 'Live sessions in the main copy' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show Update' }))
    expect(screen.getByRole('button', { name: 'Later' })).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Update' })))
    expect(call).toHaveBeenLastCalledWith('sessions.updateMain', { session: { kind: 'sessionId', sessionId: 's1' }, confirmLive: ['one', 'two'] })
    expect(screen.getByRole('alert').textContent).toBe('The sessions in the main copy changed. Check the list and press Update again.')
    workflow.rounds[0].steps[0].body = { kind: 'sessions', sessions: [] }
    workflow.actions[0] = { ...workflow.actions[0], confirmLive: [] }
    call.mockResolvedValue({ ok: true, value: { ok: true, value: undefined } })
    view.rerender(<SessionActionsPane session={session([workflow])} sessions={store} visible ports={updatePorts} />)
    expect(screen.getByText('No other live sessions work in the main copy.')).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Update' })))
    expect(call).toHaveBeenLastCalledWith('sessions.updateMain', { session: { kind: 'sessionId', sessionId: 's1' }, confirmLive: [] })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

it('shows each repository identity and sends its own checked message with one Finish press', async () => {
  const f = reviewFixture()
  const body = f.workflow.rounds[0].steps[0].body!
  if (body.kind !== 'commit') throw new Error('Expected review')
  body.repositories = ['front', 'apps'].map((repositoryName) => ({ root: `Q:/work/${repositoryName}`, repositoryName,
    repository: `https://svn/${repositoryName}`, expectedPrefix: `[${repositoryName}]`, paths: ['a.txt'],
    message: `[${repositoryName}] Fix`, source: 'person-local', acknowledged: [] }))
  render(<SessionActionsPane session={session([f.workflow])} sessions={store} visible ports={ports} />)
  await screen.findByLabelText('Commit message front (front)')
  expect(screen.getByLabelText('Commit message apps (apps)')).toHaveValue('[apps] Fix')
  const button = screen.getByRole('button', { name: 'Commit & merge' })
  await waitFor(() => expect(button).not.toBeDisabled())
  fireEvent.click(button)
  await waitFor(() => expect(ports.press).toHaveBeenCalledWith(expect.anything(), {}, expect.objectContaining({ repositories: [
    expect.objectContaining({ repositoryName: 'front', message: '[front] Fix' }), expect.objectContaining({ repositoryName: 'apps', message: '[apps] Fix' }),
  ] })))
})

it('keeps the mount label and the written message of the one repository left after a partial publication', async () => {
  // The draft holds the message the person wrote for the app in the earlier three-repository review.
  const app = { root: 'Q:/work', repositoryName: 'apps', repository: 'https://svn/apps', expectedPrefix: '[apps]', paths: ['a.txt'],
    message: '[apps] Run 2: config limit 30', source: 'person-local' as const, acknowledged: [] }
  const f = reviewFixture({ message: '', messageSource: 'unknown', proposedByAgent: false, repositories: [app] })
  const body = f.workflow.rounds[0].steps[0].body!
  if (body.kind !== 'commit') throw new Error('Expected review')
  body.repositories = [{ ...app, message: '', source: 'unknown' }]
  body.separateMessages = true
  render(<SessionActionsPane session={session([f.workflow])} sessions={store} visible ports={ports} />)
  await waitFor(() => expect(screen.getByLabelText('Commit message apps (.)')).toHaveValue('[apps] Run 2: config limit 30'))
  expect(screen.getByText('Project files (.)')).toBeTruthy()
  expect(screen.queryByLabelText('Commit message')).toBeNull()
  const button = screen.getByRole('button', { name: 'Commit & merge' })
  await waitFor(() => expect(button).not.toBeDisabled())
  fireEvent.click(button)
  await waitFor(() => expect(ports.press).toHaveBeenCalledWith(expect.anything(), {}, expect.objectContaining({ repositories: [
    expect.objectContaining({ repositoryName: 'apps', message: '[apps] Run 2: config limit 30' })] })))
})

function twinRepositories(app: { message: string; source: 'agent-proposal' | 'person-local' | 'unknown'; findings: { id: 'empty' | 'no-prefix' | 'chat-opening'; text: string; confirm?: true }[] }) {
  // The app and its external are two repositories of one name, as in UA1-J12.
  const repositories = [{ root: 'Q:/work/lib/ea', repository: 'https://svn/ea/j12', message: '[j12] EA change', source: 'person-local' as const, findings: [] },
    { root: 'Q:/work', repository: 'https://svn/app/j12', ...app }].map((row) => ({ ...row, repositoryName: 'j12', expectedPrefix: '[j12]', paths: ['a.txt'], acknowledged: [] }))
  const f = reviewFixture({ repositories, messageFindings: [{ id: 'no-prefix', text: 'No [Project] prefix', confirm: true }] })
  const body = f.workflow.rounds[0].steps[0].body!
  if (body.kind !== 'commit') throw new Error('Expected review')
  body.repositories = repositories.map(({ findings: _findings, ...row }) => row)
  return f
}

it('shows the findings and the source of an agent repository message and needs its own acknowledgement before Publish (UA1-J12-2)', async () => {
  const f = twinRepositories({ message: 'Here is the commit message for the change:\n[j12] J12 W4 app', source: 'agent-proposal',
    findings: [{ id: 'no-prefix', text: 'No [Project] prefix', confirm: true }, { id: 'chat-opening', text: 'Chat opening', confirm: true }] })
  const press = vi.fn<WorkflowPorts['press']>(async () => ({ kind: 'done' as const }))
  render(<SessionActionsPane session={session([f.workflow])} sessions={store} visible ports={{ ...ports, press }} />)
  const app = (await screen.findByLabelText('Commit message j12 (.)')).closest('.session-actions__repository') as HTMLElement
  await waitFor(() => expect(within(app).getByText('Chat opening')).toBeTruthy())
  expect(within(app).getByText('No [Project] prefix')).toBeTruthy()
  expect(within(app).getByText('Source: agent-proposal')).toBeTruthy()
  const ea = screen.getByLabelText('Commit message j12 (lib/ea)').closest('.session-actions__repository') as HTMLElement
  expect(within(ea).getByText('Source: person-local')).toBeTruthy()
  // The hidden top-level message asks nothing of the person.
  expect(screen.queryByLabelText('I checked this message')).toBeNull()
  const button = screen.getByRole('button', { name: 'Commit & merge' })
  expect(button).toBeDisabled()
  expect(screen.getByText('Check the message for j12 (.) and tick "I checked this repository message".')).toBeTruthy()
  fireEvent.click(within(app).getByLabelText('I checked this repository message'))
  await waitFor(() => expect(button).toBeEnabled())
  expect(screen.queryByText(/Check the message for/)).toBeNull()
  fireEvent.click(button)
  await waitFor(() => expect(press).toHaveBeenCalledWith(expect.anything(), {}, expect.objectContaining({ repositories: expect.arrayContaining([
    expect.objectContaining({ root: 'Q:/work', acknowledged: ['no-prefix', 'chat-opening'] })]) })))
})

it('says which repository a disabled Publish waits for (UA1-J12-7)', async () => {
  const f = twinRepositories({ message: '', source: 'unknown', findings: [{ id: 'empty', text: 'Enter a commit message' }] })
  render(<SessionActionsPane session={session([f.workflow])} sessions={store} visible ports={ports} />)
  await screen.findByLabelText('Commit message j12 (.)')
  await waitFor(() => expect(screen.getByText('Enter a commit message for j12 (.).')).toBeTruthy())
  expect(screen.getByRole('button', { name: 'Commit & merge' })).toBeDisabled()
})

it('labels each repository editor with its mount and lists the editors in the file list order', async () => {
  // Publication order puts externals first; two of them reuse the owner's repository name.
  const repositories = [['Q:/work/zeta', 'zlib'], ['Q:/work/shared', 'unit_test_files'], ['Q:/work', 'unit_test_files']].map(([root, repositoryName]) => ({
    root: root!, repositoryName: repositoryName!, repository: `https://svn/${repositoryName}`, expectedPrefix: `[${repositoryName}]`, paths: ['a.txt'],
    message: `[${repositoryName}] ${root}`, source: 'person-local' as const, acknowledged: [] }))
  const entry = (displayPath: string) => ({ fileId: displayPath, path: `Q:/work/${displayPath}`, displayPath, nodeKind: 'file' as const, status: 'modified' as const,
    location: 'workspace' as const, previousPath: null, previousDisplayPath: null, modifiedAt: 1, sources: ['vcs' as const], gitState: null })
  const f = reviewFixture({ repositories }, { entries: ['a.txt', 'shared/b.txt', 'zeta/c.txt'].map(entry), externalRoots: [
    { path: 'Q:/work/zeta', displayPath: 'zeta', fileIds: ['zeta/c.txt'] }, { path: 'Q:/work/shared', displayPath: 'shared', fileIds: ['shared/b.txt'] }] })
  const body = f.workflow.rounds[0].steps[0].body!
  if (body.kind !== 'commit') throw new Error('Expected review')
  body.repositories = repositories
  render(<SessionActionsPane session={session([f.workflow])} sessions={store} visible ports={ports} />)
  await screen.findByLabelText('Commit message unit_test_files (.)')
  const groups = within(await screen.findByRole('grid', { name: 'Commit files' })).getAllByText(/^External: /).map((heading) => heading.textContent)
  expect(groups).toEqual(['External: shared', 'External: zeta'])
  const editors = screen.getAllByRole('textbox').filter((editor) => editor.getAttribute('aria-label')?.startsWith('Commit message '))
  expect(editors.map((editor) => editor.getAttribute('aria-label')))
    .toEqual(['Commit message unit_test_files (.)', 'Commit message unit_test_files (shared)', 'Commit message zlib (zeta)'])
  expect(editors.map((editor) => (editor as HTMLTextAreaElement).value)).toEqual(['[unit_test_files] Q:/work', '[unit_test_files] Q:/work/shared', '[zlib] Q:/work/zeta'])
  const button = screen.getByRole('button', { name: 'Commit & merge' })
  await waitFor(() => expect(button).not.toBeDisabled())
  fireEvent.click(button)
  await waitFor(() => expect(ports.press).toHaveBeenCalledWith(expect.anything(), {}, expect.objectContaining({ repositories: [
    expect.objectContaining({ root: 'Q:/work/zeta' }), expect.objectContaining({ root: 'Q:/work/shared' }), expect.objectContaining({ root: 'Q:/work' }),
  ] })))
})

describe('SessionActionsScroll', () => {
  afterEach(cleanup)

  function Follower(props: { lines: string[] }): React.JSX.Element {
    const [element, setElement] = React.useState<HTMLElement | null>(null)
    SessionActionsScroll.useFollowEnd(element)
    return <section ref={setElement} data-testid="pane">{props.lines.map((line) => <p key={line}>{line}</p>)}</section>
  }

  function laidOut(pane: HTMLElement, height: () => number): void {
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, get: height })
    Object.defineProperty(pane, 'clientHeight', { configurable: true, get: () => 100 })
  }

  it('follows new entries at the end, stops while the person reads above, and resumes at the end', async () => {
    const view = render(<Follower lines={['a']} />)
    const pane = screen.getByTestId('pane')
    let height = 300
    laidOut(pane, () => height)

    height = 400
    view.rerender(<Follower lines={['a', 'b']} />)
    await waitFor(() => expect(pane.scrollTop).toBe(400))

    pane.scrollTop = 50
    fireEvent.scroll(pane)
    height = 500
    view.rerender(<Follower lines={['a', 'b', 'c']} />)
    await act(async () => { await Promise.resolve() })
    expect(pane.scrollTop).toBe(50)

    pane.scrollTop = 400
    fireEvent.scroll(pane)
    height = 600
    view.rerender(<Follower lines={['a', 'b', 'c', 'd']} />)
    await waitFor(() => expect(pane.scrollTop).toBe(600))
  })
})
