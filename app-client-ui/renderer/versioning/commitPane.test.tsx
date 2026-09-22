import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FileChangeEntry, FileChangesWorkingTreeSnapshot } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { VersioningCommitDraftDto } from '../../shared/versioningCommit'
import type { CommitPanePorts } from './commitPanePorts'
import { CommitPane } from './commitPane'
import { CommitTargetsList } from './commitTargetsList'

class CommitPaneTest {
  static entry(path: string, status: FileChangeEntry['status'] = 'modified', nodeKind: FileChangeEntry['nodeKind'] = 'file'): FileChangeEntry {
    return { fileId: path, path: `Q:/app/${path}`, displayPath: path, nodeKind, status,
      location: 'workspace', previousPath: null, previousDisplayPath: null, modifiedAt: 1, sources: ['vcs'], gitState: null }
  }

  static fixture(vcs: VersioningCommitDraftDto['vcs'] = 'svn') {
    let draft: VersioningCommitDraftDto = { draftId: 'draft', sessionId: 'session', vcs, source: vcs, scopeRoot: 'Q:/app',
      scopeTooltip: 'Q:/app', message: 'Proposed message', proposedByAgent: true, editedByPerson: false, phase: { kind: 'editing' }, revision: 1 }
    const snapshot: FileChangesWorkingTreeSnapshot = { snapshotId: 'snapshot', sessionId: 'session', createdAt: 1,
      source: { requested: vcs, selected: vcs, available: [vcs], fallbackReason: null }, defaultBaseline: { kind: vcs === 'svn' ? 'svn-base' : 'git-head', revision: null, label: 'BASE', baselineId: 'base', createdAt: null },
      entries: [CommitPaneTest.entry('a.txt'), CommitPaneTest.entry('b.txt'), CommitPaneTest.entry('conflict.txt', 'conflicted'), CommitPaneTest.entry('shared/external.txt')],
      externalRoots: [{ path: 'Q:/app/shared', displayPath: 'shared', fileIds: ['shared/external.txt'] }], warnings: [] }
    const subscribers = new Set<() => void>()
    const emit = (): void => { for (const subscriber of subscribers) subscriber() }
    const ports: CommitPanePorts = {
      versioning: {
        openTortoise: vi.fn(async () => ({ ok: true as const, value: { ok: true as const } })),
        revertCommitFile: vi.fn(async () => ({ ok: true as const, value: { ok: true as const, reverted: true } })),
        getSettings: vi.fn(async () => ({ ok: true as const, value: { mode: 'checkpoints' as const, diffTool: { kind: 'internal' as const } } })),
        saveSettings: vi.fn(async () => ({ ok: true as const, value: { ok: true as const } })),
        externalDiff: vi.fn(async () => ({ ok: true as const, value: { ok: true as const } })),
        openDraft: vi.fn<CommitPanePorts['versioning']['openDraft']>(async () => ({ ok: true, value: { ok: true, value: { draftId: 'draft', scopeRoot: 'Q:/app', title: 'Commit SVN' }, messageApplied: false } })),
        readCommit: vi.fn<CommitPanePorts['versioning']['readCommit']>(async () => ({ ok: true, value: structuredClone(draft) })),
        commitFiles: vi.fn<CommitPanePorts['versioning']['commitFiles']>(async () => ({ ok: true, value: { ok: true, value: snapshot } })),
        setCommitMessage: vi.fn<CommitPanePorts['versioning']['setCommitMessage']>(async (_id, message) => { draft = { ...draft, message, editedByPerson: true, revision: draft.revision + 1 }; emit(); return { ok: true, value: true } }),
        runCommit: vi.fn<CommitPanePorts['versioning']['runCommit']>(async () => { draft = { ...draft, revision: draft.revision + 1, phase: { kind: 'done', revision: 'r4', output: 'Committed revision 4.', finishedAt: 2 } }; emit(); return { ok: true, value: { ok: true, revision: 'r4' } } }),
        closeCommit: vi.fn<CommitPanePorts['versioning']['closeCommit']>(async () => ({ ok: true, value: undefined })),
      },
      openFile: vi.fn<CommitPanePorts['openFile']>(async () => ({ ok: true, value: { ok: true, value: { documentId: 'document', documentKey: 'a', path: 'Q:/app/a.txt', name: 'a.txt',
        source: { kind: 'workspace', sessionId: 'session', path: 'Q:/app/a.txt' }, size: 1, contentVersion: 'v1', kind: { kind: 'text', language: 'plaintext' }, modes: ['raw', 'diff'] } } })),
      releaseFile: vi.fn<CommitPanePorts['releaseFile']>(async () => ({ ok: true, value: undefined })),
      subscribe: (fn) => { subscribers.add(fn); return () => { subscribers.delete(fn) } },
      reportError: vi.fn(),
    }
    return { ports, snapshot, item: { kind: 'commit' as const, key: `${vcs}-app`, title: `Commit ${vcs.toUpperCase()}`, vcs, scopeRoot: 'Q:/app' } }
  }
}

afterEach(async () => { cleanup(); await act(async () => { await Promise.resolve() }) })

describe('app-client-ui/renderer/versioning/commitPane', () => {
  it('remembers the resized split for another commit and a remounted pane', async () => {
    const f = CommitPaneTest.fixture()
    let commitSplitRatio = 0.6
    vi.mocked(f.ports.versioning.getSettings).mockImplementation(async () => ({ ok: true, value: { mode: 'checkpoints', diffTool: { kind: 'internal' }, commitSplitRatio } }))
    vi.mocked(f.ports.versioning.saveSettings).mockImplementation(async (value, field) => {
      expect(field).toBe('commitSplitRatio')
      commitSplitRatio = value.commitSplitRatio!
      return { ok: true, value: { ok: true } }
    })
    const first = render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '60'))
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' })
    await waitFor(() => expect(commitSplitRatio).toBeCloseTo(0.55))
    first.unmount()
    await act(async () => { await Promise.resolve() })
    render(<CommitPane sessionId="another-session" item={{ ...f.item, key: 'another', vcs: 'git' }} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '55'))
  })

  it('keeps a user resize when the initial settings read arrives late and reports a save failure', async () => {
    const f = CommitPaneTest.fixture()
    let finish!: (value: Awaited<ReturnType<CommitPanePorts['versioning']['getSettings']>>) => void
    vi.mocked(f.ports.versioning.getSettings).mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    vi.mocked(f.ports.versioning.saveSettings).mockResolvedValue({ ok: true, value: { ok: false, code: 'config-latched', detail: 'Cannot save layout' } })
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    const separator = await screen.findByRole('separator')
    fireEvent.keyDown(separator, { key: 'ArrowUp' })
    await act(async () => finish({ ok: true, value: { mode: 'checkpoints', diffTool: { kind: 'internal' }, commitSplitRatio: 0.3 } }))
    expect(separator).toHaveAttribute('aria-valuenow', '70')
    expect(f.ports.reportError).toHaveBeenCalledWith('Cannot save layout')
  })

  it('closes an agent-cancelled review without reopening or running a commit', async () => {
    const f = CommitPaneTest.fixture()
    const read = f.ports.versioning.readCommit
    vi.mocked(read).mockImplementation(async () => ({ ok: true, value: { draftId: 'cancelled', sessionId: 'session', vcs: 'svn',
      scopeRoot: 'Q:/app', scopeTooltip: 'Q:/app', source: 'svn', message: 'Keep this', editedByPerson: true,
      proposedByAgent: true, phase: { kind: 'cancelled' }, revision: 2 } }))
    const onClose = vi.fn()
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={onClose} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(f.ports.versioning.openDraft).toHaveBeenCalledOnce()
    expect(f.ports.versioning.runCommit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Commit files' })).toBeDisabled()
  })
  it('refreshes an expired commit snapshot and opens the same path with fresh tokens while preserving the selection', async () => {
    const f = CommitPaneTest.fixture()
    const open = vi.fn(() => null)
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={open} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    fireEvent.click(screen.getByLabelText('Include b.txt'))
    const fresh = { ...f.snapshot, snapshotId: 'fresh', entries: f.snapshot.entries.map((entry) => ({ ...entry, fileId: `fresh-${entry.fileId}` })),
      defaultBaseline: { ...f.snapshot.defaultBaseline!, baselineId: 'fresh-base' } }
    vi.mocked(f.ports.versioning.commitFiles).mockResolvedValue({ ok: true, value: { ok: true, value: fresh } })
    vi.mocked(f.ports.openFile).mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'snapshot-expired', detail: 'Expired' } })
    fireEvent.doubleClick(screen.getByText('a.txt'))
    await waitFor(() => expect(open).toHaveBeenCalledWith(expect.objectContaining({ snapshot: fresh, fileId: 'fresh-a.txt' })))
    expect(f.ports.openFile).toHaveBeenNthCalledWith(1, 'snapshot', 'a.txt')
    expect(f.ports.openFile).toHaveBeenNthCalledWith(2, 'fresh', 'fresh-a.txt')
    expect(screen.getByLabelText('Include b.txt')).not.toBeChecked()
    expect(screen.getByRole('textbox')).toHaveValue('Proposed message')
    expect(screen.getByRole('status')).not.toHaveTextContent('snapshot-expired')
    expect(f.ports.releaseFile).toHaveBeenCalledWith('document')
  })

  it('stops after one snapshot renewal and reports a file that disappeared', async () => {
    const f = CommitPaneTest.fixture()
    const open = vi.fn(() => null)
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={open} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    vi.mocked(f.ports.versioning.commitFiles).mockResolvedValue({ ok: true, value: { ok: true, value: { ...f.snapshot, snapshotId: 'fresh', entries: [] } } })
    vi.mocked(f.ports.openFile).mockResolvedValue({ ok: true, value: { ok: false, code: 'snapshot-expired', detail: 'Expired' } })
    fireEvent.doubleClick(screen.getByText('a.txt'))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('no longer in the refreshed changes'))
    expect(f.ports.openFile).toHaveBeenCalledOnce()
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['snapshot-expired', 'access-denied'] as const)('bounds snapshot recovery and leaves %s refusals visible', async (code) => {
    const f = CommitPaneTest.fixture()
    const open = vi.fn(() => null)
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={open} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    const reads = vi.mocked(f.ports.versioning.commitFiles).mock.calls.length
    vi.mocked(f.ports.versioning.commitFiles).mockResolvedValue({ ok: true, value: { ok: true, value: { ...f.snapshot, snapshotId: 'fresh' } } })
    vi.mocked(f.ports.openFile).mockResolvedValue({ ok: true, value: { ok: false, code, detail: 'Still unavailable' } })
    fireEvent.doubleClick(screen.getByText('a.txt'))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Still unavailable'))
    expect(f.ports.openFile).toHaveBeenCalledTimes(code === 'snapshot-expired' ? 2 : 1)
    expect(f.ports.versioning.commitFiles).toHaveBeenCalledTimes(reads + (code === 'snapshot-expired' ? 1 : 0))
    expect(open).not.toHaveBeenCalled()
  })

  it('resizes the file list and message together without changing the draft or file selection', async () => {
    const f = CommitPaneTest.fixture()
    const view = render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    fireEvent.click(screen.getByLabelText('Include b.txt'))
    const splitter = screen.getByRole('separator', { name: 'Resize file list and commit message' })
    const editor = view.container.querySelector<HTMLElement>('.commit-editor')!
    vi.spyOn(editor, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 408))
    vi.spyOn(splitter, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 300, 600, 8))

    fireEvent.pointerDown(splitter, { pointerId: 1, clientY: 304 })
    fireEvent.pointerMove(splitter, { pointerId: 2, clientY: 204 })
    expect(splitter).toHaveAttribute('aria-valuenow', '75')
    fireEvent.pointerMove(splitter, { pointerId: 1, clientY: 204 })
    expect(splitter).toHaveAttribute('aria-valuenow', '50')
    expect(view.container.querySelector('.commit-editor-files')).toHaveStyle({ flexGrow: 0.5 })
    expect(view.container.querySelector('.commit-editor-message')).toHaveStyle({ flexGrow: 0.5 })
    fireEvent.pointerMove(splitter, { pointerId: 1, clientY: 244 })
    expect(splitter).toHaveAttribute('aria-valuenow', '60')
    expect(f.ports.versioning.saveSettings).not.toHaveBeenCalled()
    fireEvent.pointerUp(splitter, { pointerId: 1 })
    expect(f.ports.versioning.saveSettings).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ commitSplitRatio: 0.6 }), 'commitSplitRatio')
    fireEvent.pointerMove(splitter, { pointerId: 1, clientY: 400 })
    expect(splitter).toHaveAttribute('aria-valuenow', '60')
    expect(screen.getByRole('textbox')).toHaveValue('Proposed message')
    expect(screen.getByLabelText('Include a.txt')).toBeChecked()
    expect(screen.getByLabelText('Include b.txt')).not.toBeChecked()
    expect(f.ports.versioning.runCommit).not.toHaveBeenCalled()
  })

  it.each(['pointerCancel', 'lostPointerCapture'] as const)('ends resizing on %s and keeps both sections within bounds', async (ending) => {
    const f = CommitPaneTest.fixture()
    const view = render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    const splitter = screen.getByRole('separator')
    vi.spyOn(view.container.querySelector<HTMLElement>('.commit-editor')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 408))
    vi.spyOn(splitter, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 300, 600, 8))
    fireEvent.pointerDown(splitter, { pointerId: 1, clientY: 304 })
    fireEvent.pointerMove(splitter, { pointerId: 1, clientY: -1000 })
    expect(splitter).toHaveAttribute('aria-valuenow', '15')
    fireEvent.pointerMove(splitter, { pointerId: 1, clientY: 1000 })
    expect(splitter).toHaveAttribute('aria-valuenow', '85')
    fireEvent[ending](splitter, { pointerId: 1 })
    fireEvent.pointerMove(splitter, { pointerId: 1, clientY: 304 })
    expect(splitter).toHaveAttribute('aria-valuenow', '85')
    fireEvent.keyDown(splitter, { key: 'ArrowUp' })
    expect(splitter).toHaveAttribute('aria-valuenow', '80')
    fireEvent.keyDown(splitter, { key: 'ArrowDown' })
    fireEvent.keyDown(splitter, { key: 'ArrowDown' })
    expect(splitter).toHaveAttribute('aria-valuenow', '85')
    expect(f.ports.versioning.runCommit).not.toHaveBeenCalled()
  })

  it('shows progress immediately during preflight and removes it after a refusal', async () => {
    const f = CommitPaneTest.fixture()
    let finish!: (value: Awaited<ReturnType<CommitPanePorts['versioning']['runCommit']>>) => void
    vi.mocked(f.ports.versioning.runCommit).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Commit files' }))
    expect(screen.getByRole('progressbar', { name: 'Checking selected files...' })).not.toHaveAttribute('value')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await act(async () => finish({ ok: true, value: { ok: false, code: 'stale', detail: 'Review changed files' } }))
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Review changed files')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('commits on Enter, keeps Shift+Enter for message lines and ignores repeats and composition', async () => {
    const f = CommitPaneTest.fixture()
    const close = vi.fn()
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={close} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    const message = screen.getByRole('textbox')
    fireEvent.keyDown(message, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(message, { key: 'Enter', repeat: true })
    fireEvent.keyDown(message, { key: 'Enter', isComposing: true })
    expect(f.ports.versioning.runCommit).not.toHaveBeenCalled()
    fireEvent.keyDown(message, { key: 'Enter' })
    await waitFor(() => expect(f.ports.versioning.runCommit).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
  })

  it('keeps a successful commit open when automatic closing is disabled', async () => {
    const f = CommitPaneTest.fixture()
    const close = vi.fn()
    vi.mocked(f.ports.versioning.getSettings).mockResolvedValue({ ok: true, value: {
      mode: 'checkpoints', diffTool: { kind: 'internal' }, closeCommitOnSuccess: false,
    } })
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={close} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Commit files' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Committed'))
    await waitFor(() => expect(f.ports.versioning.getSettings).toHaveBeenCalled())
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps the result visible if reading the automatic closing setting fails', async () => {
    const f = CommitPaneTest.fixture()
    const close = vi.fn()
    vi.mocked(f.ports.versioning.getSettings).mockResolvedValue({ ok: false, error: 'Settings unavailable' })
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={close} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Commit files' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Settings unavailable'))
    expect(screen.getByRole('status')).toHaveTextContent('Committed r4')
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled()
  })

  it('Escape closes without committing and Enter obeys the disabled Commit files state', async () => {
    const f = CommitPaneTest.fixture()
    const close = vi.fn()
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={close} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    fireEvent.click(screen.getByText('Select none'))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(f.ports.versioning.runCommit).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
    expect(f.ports.versioning.runCommit).not.toHaveBeenCalled()
  })
  it('includes directory property changes in the main and external selections', async () => {
    const f = CommitPaneTest.fixture()
    f.snapshot.entries = [CommitPaneTest.entry('src', 'modified', 'directory'), CommitPaneTest.entry('src/a.txt'),
      CommitPaneTest.entry('new', 'untracked', 'directory'), CommitPaneTest.entry('added', 'added', 'directory'),
      CommitPaneTest.entry('deleted', 'deleted', 'directory'), CommitPaneTest.entry('missing', 'missing', 'directory'),
      CommitPaneTest.entry('shared/app', 'modified', 'directory'), CommitPaneTest.entry('shared/app/hub', 'modified', 'directory'),
      CommitPaneTest.entry('shared/app/hub/app.ts'), CommitPaneTest.entry('shared/app/new', 'untracked', 'directory'),
      CommitPaneTest.entry('shared/app/deleted', 'deleted', 'directory')]
    f.snapshot.externalRoots = [{ path: 'Q:/app/shared/app', displayPath: 'shared/app',
      fileIds: f.snapshot.entries.filter((entry) => entry.displayPath.startsWith('shared/app')).map((entry) => entry.fileId) }]
    const separately = vi.fn()
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={separately} />)
    await screen.findByLabelText('Include src/a.txt')
    for (const path of ['src', 'shared/app', 'shared/app/hub'])
      expect(screen.getByLabelText(`Include ${path}`)).toBeChecked()
    for (const path of ['src/a.txt', 'new', 'added', 'deleted', 'missing'])
      expect(screen.getByLabelText(`Include ${path}`)).toBeChecked()
    for (const path of ['shared/app/hub/app.ts', 'shared/app/new', 'shared/app/deleted'])
      expect(screen.getByLabelText(`Include ${path}`)).toBeChecked()
    expect(screen.getAllByText('11 selected')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Commit separately' }))
    expect(separately).toHaveBeenCalledWith('Q:/app/shared/app')
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }))
    expect(screen.getByRole('button', { name: 'Commit files' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getAllByText('11 selected')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Commit files' }))
    await waitFor(() => expect(f.ports.versioning.runCommit).toHaveBeenCalledWith(expect.objectContaining({
      fileIds: f.snapshot.entries.map((entry) => entry.fileId),
      includeExternals: true,
    })))
  })

  it('commits a property-only selection without selecting modified children', async () => {
    const f = CommitPaneTest.fixture()
    f.snapshot.entries = [CommitPaneTest.entry('shared', 'modified', 'directory'), CommitPaneTest.entry('shared/file.txt')]
    f.snapshot.externalRoots = []
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include shared')
    expect(screen.getByLabelText('Commits directory properties only; select its files individually')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Include shared/file.txt'))
    expect(screen.getByLabelText('Include shared')).toBeChecked()
    expect(screen.getAllByText('1 selected')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Commit files' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Commit files' }))
    await waitFor(() => expect(f.ports.versioning.runCommit).toHaveBeenCalledWith(expect.objectContaining({ fileIds: ['shared'] })))
  })

  it('selects rows independently of commit checkboxes and opens the selected file from its menu', async () => {
    const f = CommitPaneTest.fixture()
    const open = vi.fn(() => null)
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={open} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    const a = screen.getByRole('row', { name: 'Include a.txt modified a.txt' })
    const b = screen.getByRole('row', { name: 'Include b.txt modified b.txt' })
    fireEvent.click(within(a).getByText('a.txt'))
    expect(a).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('Include a.txt')).toBeChecked()
    expect(f.ports.openFile).not.toHaveBeenCalled()
    fireEvent.keyDown(a, { key: 'ArrowDown' })
    expect(b).toHaveFocus()
    fireEvent.contextMenu(a, { clientX: 20, clientY: 30 })
    expect(a).toHaveAttribute('aria-selected', 'true')
    expect(b).toHaveAttribute('aria-selected', 'false')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show diff' }))
    await waitFor(() => expect(f.ports.openFile).toHaveBeenCalledWith('snapshot', 'a.txt'))
    expect(f.ports.versioning.runCommit).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Include b.txt')).toBeChecked()
  })

  it('groups file actions on the right and reloads after Tortoise closes without running a Jamat commit', async () => {
    const f = CommitPaneTest.fixture()
    let close!: () => void
    vi.mocked(f.ports.versioning.openTortoise).mockImplementation(() => new Promise((resolve) => { close = () => resolve({ ok: true, value: { ok: true } }) }))
    const view = render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    expect(within(view.container.querySelector<HTMLElement>('.commit-actions-left')!).getAllByRole('button').map((button) => button.textContent))
      .toEqual(['Commit files', 'Cancel'])
    expect(within(view.container.querySelector<HTMLElement>('.commit-actions-right')!).getAllByRole('button').map((button) => button.textContent))
      .toEqual(['Reload', 'Revert selected (2)…', 'Open in Tortoise'])
    const reads = vi.mocked(f.ports.versioning.commitFiles).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Open in Tortoise' }))
    expect(f.ports.versioning.openTortoise).toHaveBeenCalledExactlyOnceWith('draft', 'Proposed message')
    expect(screen.getByRole('button', { name: 'Commit files' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Revert selected (2)…' })).toBeDisabled()
    expect(f.ports.versioning.commitFiles).toHaveBeenCalledTimes(reads)
    await act(async () => { close() })
    await waitFor(() => expect(f.ports.versioning.commitFiles).toHaveBeenCalledTimes(reads + 1))
    expect(screen.getByRole('button', { name: 'Commit files' })).toBeEnabled()
    expect(f.ports.versioning.runCommit).not.toHaveBeenCalled()
  })

  it.each(['svn', 'git'] as const)('closes the %s pane after Tortoise closes and its refreshed list is empty', async (vcs) => {
    const f = CommitPaneTest.fixture(vcs)
    const close = vi.fn()
    let finishTortoise!: () => void
    let finishRead!: (answer: Awaited<ReturnType<CommitPanePorts['versioning']['commitFiles']>>) => void
    vi.mocked(f.ports.versioning.openTortoise).mockImplementation(() => new Promise((resolve) => {
      finishTortoise = () => resolve({ ok: true, value: { ok: true } })
    }))
    const view = render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={close} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit files' })).toBeEnabled())
    vi.mocked(f.ports.versioning.commitFiles).mockImplementation(() => new Promise((resolve) => { finishRead = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Open in Tortoise' }))
    expect(close).not.toHaveBeenCalled()
    await act(async () => { finishTortoise() })
    expect(close).not.toHaveBeenCalled()
    await act(async () => { finishRead({ ok: true, value: { ok: true, value: {
      ...f.snapshot, snapshotId: 'empty', entries: [],
    } } }) })
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(f.ports.versioning.runCommit).not.toHaveBeenCalled()
    view.unmount()
    await waitFor(() => expect(f.ports.versioning.closeCommit).toHaveBeenCalledExactlyOnceWith('draft'))
  })

  it('keeps remaining external changes and closes after Reload removes the last visible row', async () => {
    const f = CommitPaneTest.fixture()
    const close = vi.fn()
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={close} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit files' })).toBeEnabled())
    vi.mocked(f.ports.versioning.commitFiles).mockResolvedValue({ ok: true, value: { ok: true, value: {
      ...f.snapshot, snapshotId: 'external-only', entries: [CommitPaneTest.entry('shared/external.txt')],
    } } })
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(screen.queryByLabelText('Include a.txt')).toBeNull())
    expect(screen.getByRole('button', { name: 'Commit separately' })).toBeEnabled()
    expect(close).not.toHaveBeenCalled()
    vi.mocked(f.ports.versioning.commitFiles).mockResolvedValue({ ok: true, value: { ok: true, value: {
      ...f.snapshot, snapshotId: 'properties-only', entries: [CommitPaneTest.entry('shared', 'modified', 'directory')],
    } } })
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await screen.findByLabelText('Include shared')
    expect(screen.getByRole('button', { name: 'Commit files' })).toBeEnabled()
    expect(close).not.toHaveBeenCalled()
    vi.mocked(f.ports.versioning.commitFiles).mockResolvedValue({ ok: true, value: { ok: true, value: {
      ...f.snapshot, snapshotId: 'empty', entries: [],
    } } })
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
  })

  it('does not close an initially empty list or treat a failed read as an empty refresh', async () => {
    const f = CommitPaneTest.fixture()
    const close = vi.fn()
    vi.mocked(f.ports.versioning.commitFiles).mockResolvedValue({ ok: true, value: { ok: true, value: {
      ...f.snapshot, entries: [],
    } } })
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={close} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled())
    expect(close).not.toHaveBeenCalled()
    vi.mocked(f.ports.versioning.commitFiles).mockResolvedValue({ ok: true, value: { ok: true, value: f.snapshot } })
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await screen.findByLabelText('Include a.txt')
    vi.mocked(f.ports.versioning.commitFiles).mockResolvedValue({ ok: false, error: 'Cannot read the working copy' })
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Cannot read the working copy'))
    expect(close).not.toHaveBeenCalled()
    vi.mocked(f.ports.versioning.commitFiles).mockResolvedValue({ ok: true, value: { ok: true, value: {
      ...f.snapshot, snapshotId: 'empty', entries: [],
    } } })
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
  })

  it('keeps operation errors visible even if their automatic refresh has no visible rows', async () => {
    const f = CommitPaneTest.fixture()
    const close = vi.fn()
    vi.mocked(f.ports.versioning.runCommit).mockResolvedValue({ ok: true, value: {
      ok: false, code: 'vcs-failed', detail: 'SVN update failed', reloadRequired: true,
    } })
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={close} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit files' })).toBeEnabled())
    vi.mocked(f.ports.versioning.commitFiles).mockResolvedValue({ ok: true, value: { ok: true, value: {
      ...f.snapshot, snapshotId: 'empty', entries: [],
    } } })
    fireEvent.click(screen.getByRole('button', { name: 'Commit files' }))
    await waitFor(() => expect(screen.queryByLabelText('Include a.txt')).toBeNull())
    expect(screen.getByRole('status')).toHaveTextContent('SVN update failed')
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
  })

  it('reverts only the context row and reloads after confirmation, keeping other checkboxes', async () => {
    const f = CommitPaneTest.fixture()
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    fireEvent.click(screen.getByLabelText('Include b.txt'))
    vi.mocked(f.ports.versioning.commitFiles).mockResolvedValue({ ok: true, value: { ok: true, value: {
      ...f.snapshot, snapshotId: 'refreshed', entries: f.snapshot.entries.filter((entry) => entry.fileId !== 'a.txt'),
    } } })
    fireEvent.contextMenu(screen.getByText('a.txt'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revert…' }))
    await waitFor(() => expect(f.ports.versioning.revertCommitFile).toHaveBeenCalledWith({ draftId: 'draft', snapshotId: 'snapshot', fileIds: ['a.txt'] }))
    await waitFor(() => expect(screen.queryByLabelText('Include a.txt')).toBeNull())
    expect(screen.getByLabelText('Include b.txt')).not.toBeChecked()
    expect(f.ports.versioning.runCommit).not.toHaveBeenCalled()
    vi.mocked(f.ports.versioning.revertCommitFile).mockResolvedValue({ ok: true, value: { ok: true, reverted: false } })
    const reads = vi.mocked(f.ports.versioning.commitFiles).mock.calls.length
    fireEvent.contextMenu(screen.getByText('b.txt'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revert…' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled())
    expect(f.ports.versioning.commitFiles).toHaveBeenCalledTimes(reads)
  })

  it('reverts checked supported files from the footer and keeps the edited message', async () => {
    const f = CommitPaneTest.fixture()
    f.snapshot.entries = [...f.snapshot.entries, CommitPaneTest.entry('new.txt', 'added'), CommitPaneTest.entry('folder', 'modified', 'directory'), CommitPaneTest.entry('keep.txt')]
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include keep.txt')
    fireEvent.click(screen.getByLabelText('Include keep.txt'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), { target: { value: 'Keep this message' } })
    vi.mocked(f.ports.versioning.commitFiles).mockResolvedValue({ ok: true, value: { ok: true, value: {
      ...f.snapshot, snapshotId: 'refreshed', entries: f.snapshot.entries.filter((entry) => !['a.txt', 'b.txt'].includes(entry.fileId)),
    } } })
    fireEvent.click(screen.getByRole('button', { name: 'Revert selected (2)…' }))
    await waitFor(() => expect(f.ports.versioning.revertCommitFile).toHaveBeenCalledExactlyOnceWith({ draftId: 'draft', snapshotId: 'snapshot', fileIds: ['a.txt', 'b.txt'] }))
    await waitFor(() => expect(screen.queryByLabelText('Include a.txt')).toBeNull())
    expect(screen.getByLabelText('Include keep.txt')).not.toBeChecked()
    expect(screen.getByLabelText('Include new.txt')).toBeChecked()
    expect(screen.getByRole('textbox', { name: 'Commit message' })).toHaveValue('Keep this message')
    expect(screen.getByRole('button', { name: 'Revert selected (0)…' })).toBeDisabled()
    expect(f.ports.versioning.runCommit).not.toHaveBeenCalled()
  })

  it('reloads after a partial revert failure and reports its progress', async () => {
    const f = CommitPaneTest.fixture()
    vi.mocked(f.ports.versioning.revertCommitFile).mockResolvedValue({ ok: true, value: { ok: false, code: 'vcs-failed', detail: 'Reverted 1 of 2 files. b.txt: File is locked' } })
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    const reads = vi.mocked(f.ports.versioning.commitFiles).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Revert selected (2)…' }))
    await waitFor(() => expect(f.ports.versioning.commitFiles).toHaveBeenCalledTimes(reads + 1))
    expect(screen.getByRole('status')).toHaveTextContent('Reverted 1 of 2 files.')
  })

  it('disables revert for conflicts and external rows and diff while a write is running', async () => {
    const f = CommitPaneTest.fixture()
    const { rerender } = render(<CommitTargetsList snapshot={f.snapshot} checked={new Set()} disabled={false}
      onChange={vi.fn()} onOpen={vi.fn()} onMenuOpen={vi.fn()} onOpenExternal={vi.fn()} onRevert={vi.fn()} onOpenSeparately={vi.fn()} />)
    for (const name of ['conflict.txt', 'shared/external.txt']) {
      fireEvent.contextMenu(screen.getByText(name))
      expect(screen.getByRole('menuitem', { name: 'Revert…' })).toBeDisabled()
      expect(screen.getByRole('menuitem', { name: 'Show external diff' })).toBeEnabled()
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    }
    rerender(<CommitTargetsList snapshot={f.snapshot} checked={new Set()} disabled
      onChange={vi.fn()} onOpen={vi.fn()} onMenuOpen={vi.fn()} onOpenExternal={vi.fn()} onRevert={vi.fn()} onOpenSeparately={vi.fn()} />)
    fireEvent.contextMenu(screen.getByText('a.txt'))
    expect(screen.getByRole('menuitem', { name: 'Show diff' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Show external diff' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Revert…' })).toBeDisabled()
  })

  it('uses the external viewer without allocating a split item and reports its refusal', async () => {
    const f = CommitPaneTest.fixture()
    vi.mocked(f.ports.versioning.getSettings).mockResolvedValue({ ok: true, value: { mode: 'checkpoints', diffTool: { kind: 'external', command: 'tool', argumentTemplate: '"$1" "$2"' } } })
    vi.mocked(f.ports.versioning.externalDiff).mockResolvedValue({ ok: true, value: { ok: false, detail: 'Tool is missing' } })
    const open = vi.fn(() => null)
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={open} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    fireEvent.contextMenu(screen.getByText('a.txt'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Show external diff' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Tool is missing'))
    expect(f.ports.versioning.externalDiff).toHaveBeenCalledWith({ snapshotId: 'snapshot', fileId: 'a.txt', baselineId: 'base' })
    expect(f.ports.openFile).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('refreshes external availability on each menu opening and keeps double-click and Show diff internal', async () => {
    const f = CommitPaneTest.fixture()
    const open = vi.fn(() => null)
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={open} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    fireEvent.contextMenu(screen.getByText('a.txt'))
    await waitFor(() => expect(f.ports.versioning.getSettings).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('menuitem', { name: 'Show external diff' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    vi.mocked(f.ports.versioning.getSettings).mockResolvedValue({ ok: true, value: { mode: 'checkpoints', diffTool: { kind: 'external', command: 'tool', argumentTemplate: '$1 $2' } } })
    fireEvent.keyDown(screen.getByRole('row', { name: 'Include a.txt modified a.txt' }), { key: 'F10', shiftKey: true })
    expect(await screen.findByRole('menuitem', { name: 'Show external diff' })).toBeEnabled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show diff' }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    fireEvent.doubleClick(screen.getByText('a.txt'))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2))
    expect(f.ports.versioning.externalDiff).not.toHaveBeenCalled()
    vi.mocked(f.ports.versioning.getSettings).mockResolvedValue({ ok: true, value: { mode: 'checkpoints', diffTool: { kind: 'internal' } } })
    fireEvent.contextMenu(screen.getByText('a.txt'))
    await waitFor(() => expect(f.ports.versioning.getSettings).toHaveBeenCalledTimes(4))
    expect(screen.queryByRole('menuitem', { name: 'Show external diff' })).toBeNull()
  })
  it('keeps conflicts unchecked and commits checked main and external files with the edited message', async () => {
    const f = CommitPaneTest.fixture()
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Include a.txt')).toBeChecked())
    expect(screen.getByLabelText('Include conflict.txt')).toBeDisabled()
    expect(screen.getByLabelText('Include shared/external.txt')).toBeChecked()
    fireEvent.click(screen.getByLabelText('Include b.txt'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), { target: { value: 'Human message\n\nDetails' } })
    fireEvent.click(screen.getByRole('button', { name: 'Commit files' }))
    await waitFor(() => expect(f.ports.versioning.runCommit).toHaveBeenCalledWith({ draftId: 'draft', snapshotId: 'snapshot',
      fileIds: ['a.txt', 'shared/external.txt'], message: 'Human message\n\nDetails', includeExternals: true }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Committed revision 4.'))
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Commit files' })).toBeNull()
  })

  it('removes an external from the shared selection when choosing a separate message tab', async () => {
    const f = CommitPaneTest.fixture()
    const separate = vi.fn()
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={separate} />)
    await screen.findByLabelText('Include shared/external.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Commit separately' }))
    expect(separate).toHaveBeenCalledExactlyOnceWith('Q:/app/shared')
    expect(screen.getByLabelText('Include shared/external.txt')).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Commit files' }))
    await waitFor(() => expect(f.ports.versioning.runCommit).toHaveBeenCalledExactlyOnceWith({
      draftId: 'draft', snapshotId: 'snapshot', fileIds: ['a.txt', 'b.txt'], message: 'Proposed message', includeExternals: true,
    }))
  })

  it('opens external files by double-click, Show diff and the configured external viewer from the main pane', async () => {
    const f = CommitPaneTest.fixture()
    const open = vi.fn(() => null)
    vi.mocked(f.ports.versioning.getSettings).mockResolvedValue({ ok: true, value: {
      mode: 'checkpoints', diffTool: { kind: 'external', command: 'tool', argumentTemplate: '$1 $2' },
    } })
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={open} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include shared/external.txt')
    fireEvent.doubleClick(screen.getByText('shared/external.txt'))
    await waitFor(() => expect(open).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'shared/external.txt' })))
    expect(f.ports.openFile).toHaveBeenCalledWith('snapshot', 'shared/external.txt')
    fireEvent.contextMenu(screen.getByText('shared/external.txt'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show diff' }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2))
    fireEvent.contextMenu(screen.getByText('shared/external.txt'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Show external diff' }))
    await waitFor(() => expect(f.ports.versioning.externalDiff).toHaveBeenCalledExactlyOnceWith({
      snapshotId: 'snapshot', fileId: 'shared/external.txt', baselineId: 'base',
    }))
    expect(f.ports.versioning.runCommit).not.toHaveBeenCalled()
  })

  it('refreshes a partially committed batch without retrying and retains the message and remaining choices', async () => {
    const f = CommitPaneTest.fixture()
    const close = vi.fn()
    const detail = 'Committed: shared 42. Main scope failed. Review the remaining files.'
    vi.mocked(f.ports.versioning.runCommit).mockResolvedValue({ ok: true, value: {
      ok: false, code: 'vcs-failed', detail, reloadRequired: true,
    } })
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={close} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit files' })).toBeEnabled())
    fireEvent.click(screen.getByLabelText('Include a.txt'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Shared message' } })
    vi.mocked(f.ports.versioning.commitFiles).mockResolvedValue({ ok: true, value: { ok: true, value: {
      ...f.snapshot, snapshotId: 'remaining', entries: f.snapshot.entries.filter((entry) => entry.fileId !== 'shared/external.txt'),
    } } })
    fireEvent.click(screen.getByRole('button', { name: 'Commit files' }))
    await waitFor(() => expect(screen.queryByLabelText('Include shared/external.txt')).toBeNull())
    expect(screen.getByLabelText('Include a.txt')).not.toBeChecked()
    expect(screen.getByLabelText('Include b.txt')).toBeChecked()
    expect(screen.getByRole('textbox')).toHaveValue('Shared message')
    expect(screen.getByRole('status')).toHaveTextContent(detail)
    expect(f.ports.versioning.runCommit).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Commit files' }))
    await waitFor(() => expect(f.ports.versioning.runCommit).toHaveBeenNthCalledWith(2, {
      draftId: 'draft', snapshotId: 'remaining', fileIds: ['b.txt'], message: 'Shared message', includeExternals: true,
    }))
  })

  it('shows the diff cap refusal and releases the temporary document grant', async () => {
    const f = CommitPaneTest.fixture()
    const open = vi.fn(() => 'The split already holds 8 files. Close one before opening another.')
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={open} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    fireEvent.doubleClick(screen.getByText('a.txt'))
    await waitFor(() => expect(open).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'a.txt' })))
    expect(screen.getByRole('status')).toHaveTextContent('The split already holds 8 files.')
    expect(f.ports.releaseFile).toHaveBeenCalledWith('document')
  })

  it('offers Reload after a stale refusal and keeps selection by path across fresh IDs', async () => {
    const f = CommitPaneTest.fixture()
    vi.mocked(f.ports.versioning.runCommit).mockResolvedValue({ ok: true, value: { ok: false, code: 'stale', detail: 'a.txt changed since you looked; reload the list' } })
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    fireEvent.click(screen.getByLabelText('Include b.txt'))
    fireEvent.click(screen.getByRole('button', { name: 'Commit files' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('stale:'))
    const refreshed = { ...f.snapshot, snapshotId: 'snapshot2', entries: f.snapshot.entries.map((entry) => ({ ...entry, fileId: `${entry.fileId}-2` })),
      externalRoots: [{ ...f.snapshot.externalRoots[0], fileIds: ['shared/external.txt-2'] }] }
    vi.mocked(f.ports.versioning.commitFiles).mockResolvedValue({ ok: true, value: { ok: true, value: refreshed } })
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled())
    expect(screen.getByLabelText('Include a.txt')).toBeChecked()
    expect(screen.getByLabelText('Include b.txt')).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }))
    expect(screen.getByRole('button', { name: 'Commit files' })).toBeDisabled()
  })

  it.each(['svn', 'git'] as const)('reloads an invalid %s list and waits for an explicit retry with the refreshed selection', async (vcs) => {
    const f = CommitPaneTest.fixture(vcs)
    const close = vi.fn()
    vi.mocked(f.ports.versioning.runCommit).mockResolvedValueOnce({ ok: true,
      value: { ok: false, code: 'invalid-target', detail: 'The file list does not belong to this dialog; reload it', reloadRequired: true } })
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={close} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit files' })).toBeEnabled())
    fireEvent.click(screen.getByLabelText('Include b.txt'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep this review message' } })
    const reads = vi.mocked(f.ports.versioning.commitFiles).mock.calls.length
    let finish!: (value: Awaited<ReturnType<CommitPanePorts['versioning']['commitFiles']>>) => void
    vi.mocked(f.ports.versioning.commitFiles).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Commit files' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Reloading the file list...'))
    expect(screen.getByRole('button', { name: 'Commit files' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(f.ports.versioning.runCommit).toHaveBeenCalledTimes(1)
    const refreshed = { ...f.snapshot, snapshotId: 'refreshed',
      entries: [...f.snapshot.entries.map((entry) => ({ ...entry, fileId: `${entry.fileId}-2` })), CommitPaneTest.entry('new.txt', 'untracked')],
      externalRoots: [{ ...f.snapshot.externalRoots[0], fileIds: ['shared/external.txt-2'] }] }
    await act(async () => { finish({ ok: true, value: { ok: true, value: refreshed } }) })
    expect(screen.getByRole('status')).toHaveTextContent('File list reloaded. Review the files and selection, then click Commit files again.')
    expect(screen.getByRole('textbox')).toHaveValue('Keep this review message')
    expect(screen.getByLabelText('Include a.txt')).toBeChecked()
    expect(screen.getByLabelText('Include b.txt')).not.toBeChecked()
    expect(screen.getByLabelText('Include new.txt')).toBeChecked()
    expect(f.ports.versioning.commitFiles).toHaveBeenCalledTimes(reads + 1)
    expect(f.ports.versioning.runCommit).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Include new.txt'))
    fireEvent.click(screen.getByRole('button', { name: 'Commit files' }))
    await waitFor(() => expect(f.ports.versioning.runCommit).toHaveBeenNthCalledWith(2, {
      draftId: 'draft', snapshotId: 'refreshed', fileIds: ['a.txt-2', 'shared/external.txt-2'], message: 'Keep this review message',
      ...(vcs === 'svn' ? { includeExternals: true } : {}),
    }))
  })

  it('reports a failed automatic reload and blocks committing the old list until a reload succeeds', async () => {
    const f = CommitPaneTest.fixture()
    vi.mocked(f.ports.versioning.runCommit).mockResolvedValueOnce({ ok: true,
      value: { ok: false, code: 'invalid-target', detail: 'Reload the list', reloadRequired: true } })
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit files' })).toBeEnabled())
    vi.mocked(f.ports.versioning.commitFiles).mockResolvedValueOnce({ ok: false, error: 'Cannot read the working copy' })
    fireEvent.click(screen.getByRole('button', { name: 'Commit files' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Cannot read the working copy'))
    expect(screen.getByRole('status')).not.toHaveTextContent('File list reloaded')
    expect(screen.getByRole('button', { name: 'Commit files' })).toBeDisabled()
    expect(f.ports.versioning.runCommit).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit files' })).toBeEnabled())
    expect(f.ports.versioning.runCommit).toHaveBeenCalledTimes(1)
  })

  it('does not reload after an unrelated invalid target refusal', async () => {
    const f = CommitPaneTest.fixture()
    vi.mocked(f.ports.versioning.runCommit).mockResolvedValue({ ok: true,
      value: { ok: false, code: 'invalid-target', detail: 'Too many commit targets' } })
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit files' })).toBeEnabled())
    const reads = vi.mocked(f.ports.versioning.commitFiles).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Commit files' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Too many commit targets'))
    expect(f.ports.versioning.commitFiles).toHaveBeenCalledTimes(reads)
  })

  it('reloads after SVN recovery, reports its result and preserves the message and unchecked paths', async () => {
    const f = CommitPaneTest.fixture()
    const close = vi.fn()
    const detail = 'SVN update left conflicts in app/file.ts. Original commit error: E155011'
    vi.mocked(f.ports.versioning.runCommit).mockResolvedValue({ ok: true, value: { ok: false, code: 'vcs-failed', detail, reloadRequired: true } })
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={close} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    fireEvent.click(screen.getByLabelText('Include b.txt'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep my message' } })
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Keep my message'))
    const reads = vi.mocked(f.ports.versioning.commitFiles).mock.calls.length
    vi.mocked(f.ports.versioning.commitFiles).mockResolvedValue({ ok: true, value: { ok: true, value: {
      ...f.snapshot, snapshotId: 'new', entries: f.snapshot.entries.map((entry) => ({ ...entry, fileId: `${entry.fileId}-2` })),
    } } })
    fireEvent.click(screen.getByRole('button', { name: 'Commit files' }))
    await waitFor(() => expect(f.ports.versioning.commitFiles).toHaveBeenCalledTimes(reads + 1))
    expect(screen.getByRole('status')).toHaveTextContent(detail)
    expect(screen.getByRole('textbox')).toHaveValue('Keep my message')
    expect(screen.getByLabelText('Include b.txt')).not.toBeChecked()
    expect(f.ports.versioning.runCommit).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
  })

  it('shows update progress and keeps commit and cancellation disabled while updating', async () => {
    const f = CommitPaneTest.fixture()
    const current = await f.ports.versioning.readCommit('draft')
    if (!current.ok || current.value === null) throw new Error('No fixture draft')
    vi.mocked(f.ports.versioning.readCommit).mockResolvedValue({ ok: true, value: { ...current.value,
      phase: { kind: 'running', startedAt: 1, detail: 'SVN is out of date. Updating this commit scope...' } } })
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Updating this commit scope'))
    expect(screen.getByRole('button', { name: 'Commit files' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('shares a lease across StrictMode remount and two panes, closing it only after the last pane', async () => {
    const f = CommitPaneTest.fixture()
    const pane = <StrictMode><CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={vi.fn()} /></StrictMode>
    const first = render(pane)
    const second = render(pane)
    await waitFor(() => expect(screen.getAllByRole('textbox')).toHaveLength(2))
    expect(f.ports.versioning.openDraft).toHaveBeenCalledTimes(1)
    first.unmount()
    await act(async () => { await Promise.resolve() })
    expect(f.ports.versioning.closeCommit).not.toHaveBeenCalled()
    second.unmount()
    await waitFor(() => expect(f.ports.versioning.closeCommit).toHaveBeenCalledWith('draft'))
  })

  it.each(['added', 'untracked'] as const)('keeps required %s ancestors checked and counted in the flat list', (status) => {
    const f = CommitPaneTest.fixture()
    const snapshot = { ...f.snapshot, externalRoots: [], entries: [CommitPaneTest.entry('new', status, 'directory'), CommitPaneTest.entry('new/nested', status, 'directory'), CommitPaneTest.entry('new/nested/a.txt', status)] }
    render(<CommitTargetsList snapshot={snapshot} checked={new Set(['new/nested/a.txt'])} disabled={false} onChange={vi.fn()} onOpen={vi.fn()} onMenuOpen={vi.fn()} onOpenExternal={null} onRevert={vi.fn()} onOpenSeparately={vi.fn()} />)
    expect(screen.getByLabelText('Include new')).toBeChecked()
    expect(screen.getByLabelText('Include new')).toBeDisabled()
    expect(screen.getByLabelText('Include new/nested')).toBeChecked()
    expect(screen.getByLabelText('Include new/nested')).toBeDisabled()
    expect(screen.getByText('3 selected')).toBeInTheDocument()
  })

  it('opens a new child diff and excludes an unchecked sibling from the commit request', async () => {
    const f = CommitPaneTest.fixture()
    f.snapshot.externalRoots = []
    f.snapshot.entries = [CommitPaneTest.entry('new', 'untracked', 'directory'), CommitPaneTest.entry('new/chosen.txt', 'untracked'), CommitPaneTest.entry('new/unchecked.txt', 'untracked')]
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include new/unchecked.txt')
    fireEvent.click(screen.getByLabelText('Include new/unchecked.txt'))
    expect(screen.getByText('2 selected', { selector: '.commit-selection span' })).toBeInTheDocument()
    fireEvent.doubleClick(screen.getByText('new/chosen.txt'))
    await waitFor(() => expect(f.ports.openFile).toHaveBeenCalledWith('snapshot', 'new/chosen.txt'))
    fireEvent.click(screen.getByRole('button', { name: 'Commit files' }))
    await waitFor(() => expect(f.ports.versioning.runCommit).toHaveBeenCalledWith(expect.objectContaining({ fileIds: ['new', 'new/chosen.txt'] })))
  })
})
