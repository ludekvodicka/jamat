import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FileChangeEntry, FileChangesWorkingTreeSnapshot } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { VersioningCommitDraftDto } from '../../shared/versioningCommit'
import type { CommitPanePorts } from './commitPanePorts'
import { CommitPane } from './commitPane'
import { CommitTargetsTree } from './commitTargetsTree'

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
  it('uses the external viewer without allocating a split item and reports its refusal', async () => {
    const f = CommitPaneTest.fixture()
    vi.mocked(f.ports.versioning.getSettings).mockResolvedValue({ ok: true, value: { mode: 'checkpoints', diffTool: { kind: 'external', command: 'tool', argumentTemplate: '%base %mine' } } })
    vi.mocked(f.ports.versioning.externalDiff).mockResolvedValue({ ok: true, value: { ok: false, detail: 'Tool is missing' } })
    const open = vi.fn(() => null)
    render(<CommitPane sessionId="session" item={f.item} ports={f.ports} onClose={vi.fn()} onOpenChanged={open} onOpenSeparately={vi.fn()} />)
    await screen.findByLabelText('Include a.txt')
    fireEvent.doubleClick(screen.getByText('a.txt'))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Tool is missing'))
    expect(f.ports.versioning.externalDiff).toHaveBeenCalledWith({ snapshotId: 'snapshot', fileId: 'a.txt', baselineId: 'base' })
    expect(f.ports.openFile).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
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

  it('shows required added ancestors without compressing them away', () => {
    const f = CommitPaneTest.fixture()
    const snapshot = { ...f.snapshot, externalRoots: [], entries: [CommitPaneTest.entry('new', 'added', 'directory'), CommitPaneTest.entry('new/nested', 'added', 'directory'), CommitPaneTest.entry('new/nested/a.txt', 'added')] }
    render(<CommitTargetsTree snapshot={snapshot} checked={new Set(['new/nested/a.txt'])} disabled={false} onChange={vi.fn()} onOpen={vi.fn()} onOpenSeparately={vi.fn()} />)
    expect(screen.getByLabelText('Include new')).toBeChecked()
    expect(screen.getByLabelText('Include new')).toBeDisabled()
    expect(screen.getByLabelText('Include nested')).toBeChecked()
    expect(screen.getByLabelText('Include nested')).toBeDisabled()
  })
})
