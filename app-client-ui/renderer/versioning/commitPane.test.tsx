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

  static fixture() {
    let draft: VersioningCommitDraftDto = { draftId: 'draft', sessionId: 'session', vcs: 'svn', source: 'svn', scopeRoot: 'Q:/app',
      scopeDisplay: 'Q:/app', message: 'Proposed message', proposedByAgent: true, editedByPerson: false, phase: { kind: 'editing' }, revision: 1 }
    const snapshot: FileChangesWorkingTreeSnapshot = { snapshotId: 'snapshot', sessionId: 'session', createdAt: 1,
      source: { requested: 'svn', selected: 'svn', available: ['svn'], fallbackReason: null }, defaultBaseline: { kind: 'svn-base', revision: null, label: 'BASE', baselineId: 'base', createdAt: null },
      entries: [CommitPaneTest.entry('a.txt'), CommitPaneTest.entry('b.txt'), CommitPaneTest.entry('conflict.txt', 'conflicted'), CommitPaneTest.entry('shared/external.txt')],
      externalRoots: [{ path: 'Q:/app/shared', displayPath: 'shared', fileIds: ['shared/external.txt'] }], warnings: [] }
    const subscribers = new Set<() => void>()
    const emit = (): void => { for (const subscriber of subscribers) subscriber() }
    const ports: CommitPanePorts = {
      versioning: {
        openTortoise: vi.fn(async () => ({ ok: true as const, value: { ok: true as const } })),
        revertCommitFile: vi.fn(async () => ({ ok: true as const, value: { ok: true as const, reverted: true } })),
        getSettings: vi.fn(async () => ({ ok: true as const, value: { mode: 'checkpoints' as const, diffTool: { kind: 'internal' as const } } })),
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
    return { ports, snapshot, item: { kind: 'commit' as const, key: 'svn-app', title: 'Commit SVN', vcs: 'svn' as const, scopeRoot: 'Q:/app' } }
  }
}

afterEach(async () => { cleanup(); await act(async () => { await Promise.resolve() }) })

describe('app-client-ui/renderer/versioning/commitPane', () => {
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
    expect(close).not.toHaveBeenCalled()
  })

  it('Escape closes without committing and Enter obeys the disabled OK state', async () => {
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
  it('omits modified directories in the main and external lists and never submits their hidden IDs', async () => {
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
      expect(screen.queryByLabelText(`Include ${path}`)).toBeNull()
    for (const path of ['src/a.txt', 'new', 'added', 'deleted', 'missing'])
      expect(screen.getByLabelText(`Include ${path}`)).toBeChecked()
    for (const path of ['shared/app/hub/app.ts', 'shared/app/new', 'shared/app/deleted'])
      expect(screen.getByLabelText(`Include ${path}`)).toBeDisabled()
    expect(screen.getAllByText('5 selected')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Commit separately' }))
    expect(separately).toHaveBeenCalledWith('Q:/app/shared/app')
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }))
    expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getAllByText('5 selected')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(f.ports.versioning.runCommit).toHaveBeenCalledWith(expect.objectContaining({
      fileIds: ['src/a.txt', 'new', 'added', 'deleted', 'missing'],
    })))
  })

  it('keeps OK disabled when only modified directories remain', async () => {
    const f = CommitPaneTest.fixture()
    f.snapshot.entries = [CommitPaneTest.entry('src', 'modified', 'directory')]
    f.snapshot.externalRoots = []
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await screen.findByRole('button', { name: 'Select all' })
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getAllByText('0 selected')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled()
    expect(f.ports.versioning.runCommit).not.toHaveBeenCalled()
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

  it('groups file actions on the left and reloads after Tortoise closes without running a Jamat commit', async () => {
    const f = CommitPaneTest.fixture()
    let close!: () => void
    vi.mocked(f.ports.versioning.openTortoise).mockImplementation(() => new Promise((resolve) => { close = () => resolve({ ok: true, value: { ok: true } }) }))
    const view = render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    expect(within(view.container.querySelector<HTMLElement>('.commit-actions-left')!).getAllByRole('button').map((button) => button.textContent))
      .toEqual(['Reload', 'Revert selected (2)…', 'Open in Tortoise'])
    expect(within(view.container.querySelector<HTMLElement>('.commit-actions-right')!).getAllByRole('button').map((button) => button.textContent))
      .toEqual(['OK', 'Cancel'])
    const reads = vi.mocked(f.ports.versioning.commitFiles).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Open in Tortoise' }))
    expect(f.ports.versioning.openTortoise).toHaveBeenCalledExactlyOnceWith('draft', 'Proposed message')
    expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Revert selected (2)…' })).toBeDisabled()
    expect(f.ports.versioning.commitFiles).toHaveBeenCalledTimes(reads)
    await act(async () => { close() })
    await waitFor(() => expect(f.ports.versioning.commitFiles).toHaveBeenCalledTimes(reads + 1))
    expect(screen.getByRole('button', { name: 'OK' })).toBeEnabled()
    expect(f.ports.versioning.runCommit).not.toHaveBeenCalled()
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
      if (name === 'shared/external.txt') expect(screen.getByRole('menuitem', { name: 'Show external diff' })).toBeDisabled()
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
    await waitFor(() => expect(f.ports.versioning.getSettings).toHaveBeenCalledTimes(1))
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
    await waitFor(() => expect(f.ports.versioning.getSettings).toHaveBeenCalledTimes(3))
    expect(screen.queryByRole('menuitem', { name: 'Show external diff' })).toBeNull()
  })
  it('keeps conflicts and externals unchecked, sends only checked IDs with the edited message, then shows output', async () => {
    const f = CommitPaneTest.fixture()
    const separate = vi.fn()
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={() => null} onOpenSeparately={separate} />)
    await waitFor(() => expect(screen.getByLabelText('Include a.txt')).toBeChecked())
    expect(screen.getByLabelText('Include conflict.txt')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Commit separately' }))
    expect(separate).toHaveBeenCalledWith('Q:/app/shared')
    fireEvent.click(screen.getByLabelText('Include b.txt'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), { target: { value: 'Human message\n\nDetails' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(f.ports.versioning.runCommit).toHaveBeenCalledWith({ draftId: 'draft', snapshotId: 'snapshot', fileIds: ['a.txt'], message: 'Human message\n\nDetails' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Committed revision 4.'))
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'OK' })).toBeNull()
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
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('stale:'))
    const refreshed = { ...f.snapshot, snapshotId: 'snapshot2', entries: f.snapshot.entries.map((entry) => ({ ...entry, fileId: `${entry.fileId}-2` })),
      externalRoots: [{ ...f.snapshot.externalRoots[0], fileIds: ['shared/external.txt-2'] }] }
    vi.mocked(f.ports.versioning.commitFiles).mockResolvedValue({ ok: true, value: { ok: true, value: refreshed } })
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled())
    expect(screen.getByLabelText('Include a.txt')).toBeChecked()
    expect(screen.getByLabelText('Include b.txt')).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }))
    expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled()
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
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(f.ports.versioning.runCommit).toHaveBeenCalledWith(expect.objectContaining({ fileIds: ['new', 'new/chosen.txt'] })))
  })
})
