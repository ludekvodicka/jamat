import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  FileChangeEntry,
  FileChangesWorkingTreeSnapshot,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { FileViewerDocument } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { AppClientUiBridge } from '../../shared/appClientUiIpc'
import type { FileChangesWorkingTreeViewModel } from './fileViewerPanel.types'
import { FileChangesTreeWidget } from './fileChangesTreeWidget'

describe('app-client-ui/renderer/fileViewer/fileChangesTreeWidget', () => {
  afterEach(() => {
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  function entry(displayPath: string, nodeKind: 'file' | 'directory'): FileChangeEntry {
    return {
      fileId: displayPath,
      path: `Q:/repo/${displayPath}`,
      displayPath,
      nodeKind,
      location: 'workspace',
      status: nodeKind === 'file' ? 'modified' : 'modified',
      previousPath: null,
      previousDisplayPath: null,
      modifiedAt: null,
      sources: ['vcs'],
      gitState: null,
    }
  }

  function snapshot(): FileChangesWorkingTreeSnapshot {
    return {
      snapshotId: 'snapshot-1',
      sessionId: 'session-1',
      createdAt: 1,
      externalRoots: [],
      source: {
        requested: null,
        selected: 'checkpoint',
        available: ['checkpoint', 'svn'],
        fallbackReason: null,
      },
      defaultBaseline: {
        baselineId: 'baseline-1',
        kind: 'git-head',
        label: 'Checkpoint HEAD',
        revision: 'HEAD',
        createdAt: null,
      },
      entries: [entry('src', 'directory'), entry('src/a.ts', 'file')],
      warnings: [],
    }
  }

  function model(value = snapshot()): FileChangesWorkingTreeViewModel {
    return {
      snapshot: value,
      snapshots: [value],
      selectedSource: value.source.selected,
      loading: false,
      error: null,
      requiredLoading: false,
      requiredError: null,
      select: vi.fn(),
      reload: vi.fn(async () => undefined),
      snapshotFor: () => value,
    }
  }

  const documentConst: FileViewerDocument = {
    documentId: 'document-1',
    documentKey: 'key-1',
    source: { kind: 'workspace', sessionId: 'session-1', path: 'Q:/repo/src/a.ts' },
    path: 'Q:/repo/src/a.ts',
    name: 'a.ts',
    size: 1,
    contentVersion: '1:1',
    kind: { kind: 'code', language: 'typescript' },
    modes: ['raw', 'diff'],
  }

  it('renders an expanded accessible tree and opens a file with its durable source hint', async () => {
    const onOpen = vi.fn()
    ;(window as unknown as { appClient: AppClientUiBridge }).appClient = {
      fileChanges: {
        openFile: vi.fn(async () => ({ ok: true, value: { ok: true, value: documentConst } })),
      },
    } as unknown as AppClientUiBridge

    render(<FileChangesTreeWidget model={model()} onOpen={onOpen} />)

    expect(screen.getByRole('tree', { name: 'Changed files' })).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: /src/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('1 changed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('treeitem', { name: /a\.ts/ }).querySelector('button')!)
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({
      baselineHint: {
        kind: 'git-head',
        revision: 'HEAD',
        workingTreeSource: 'checkpoint',
      },
    })))
    expect(screen.queryByText(/reviewed/i)).not.toBeInTheDocument()
  })

  it('keeps a known directory collapsed across a refreshed snapshot', () => {
    const view = render(<FileChangesTreeWidget model={model()} onOpen={vi.fn()} />)
    const directory = screen.getByRole('treeitem', { name: /src/ })
    fireEvent.click(directory.querySelector('button')!)
    expect(directory).toHaveAttribute('aria-expanded', 'false')

    const refreshed = { ...snapshot(), snapshotId: 'snapshot-2' }
    view.rerender(<FileChangesTreeWidget model={model(refreshed)} onOpen={vi.fn()} />)

    expect(screen.getByRole('treeitem', { name: /src/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('releases a successful open superseded by a newer snapshot', async () => {
    let finish: ((value: unknown) => void) | null = null
    const release = vi.fn(async () => ({ ok: true as const, value: undefined }))
    ;(window as unknown as { appClient: AppClientUiBridge }).appClient = {
      fileChanges: {
        openFile: () => new Promise((resolve) => { finish = resolve }),
      },
      fileViewer: { release },
    } as unknown as AppClientUiBridge
    const onOpen = vi.fn()
    const view = render(<FileChangesTreeWidget model={model()} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('treeitem', { name: /a\.ts/ }).querySelector('button')!)
    const refreshed = { ...snapshot(), snapshotId: 'snapshot-2' }
    view.rerender(<FileChangesTreeWidget model={model(refreshed)} onOpen={onOpen} />)
    expect(screen.getByRole('treeitem', { name: /a\.ts/ }).querySelector('button'))
      .not.toBeDisabled()

    await act(async () => finish?.({ ok: true, value: { ok: true, value: documentConst } }))

    expect(onOpen).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledWith(documentConst.documentId)
  })

  it('lands only the last click and releases the earlier successful open', async () => {
    const pending: ((value: unknown) => void)[] = []
    const release = vi.fn(async () => ({ ok: true as const, value: undefined }))
    ;(window as unknown as { appClient: AppClientUiBridge }).appClient = {
      fileChanges: {
        openFile: () => new Promise((resolve) => { pending.push(resolve) }),
      },
      fileViewer: { release },
    } as unknown as AppClientUiBridge
    const current = snapshot()
    current.entries = [...current.entries, entry('src/b.ts', 'file')]
    const onOpen = vi.fn()
    render(<FileChangesTreeWidget model={model(current)} onOpen={onOpen} />)

    fireEvent.click(screen.getByRole('treeitem', { name: /a\.ts/ }).querySelector('button')!)
    fireEvent.click(screen.getByRole('treeitem', { name: /b\.ts/ }).querySelector('button')!)
    const secondDocument = {
      ...documentConst,
      documentId: 'document-2',
      documentKey: 'key-2',
      name: 'b.ts',
      path: 'Q:/repo/src/b.ts',
      source: { kind: 'workspace', sessionId: 'session-1', path: 'Q:/repo/src/b.ts' } as const,
    }
    await act(async () => pending[1]?.({
      ok: true,
      value: { ok: true, value: secondDocument },
    }))
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({
      document: secondDocument,
      fileId: 'src/b.ts',
    })))

    await act(async () => pending[0]?.({
      ok: true,
      value: { ok: true, value: documentConst },
    }))

    expect(onOpen).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledWith(documentConst.documentId)
  })

  it('releases a successful open that finishes after unmount', async () => {
    let finish: ((value: unknown) => void) | null = null
    const release = vi.fn(async () => ({ ok: true as const, value: undefined }))
    ;(window as unknown as { appClient: AppClientUiBridge }).appClient = {
      fileChanges: { openFile: () => new Promise((resolve) => { finish = resolve }) },
      fileViewer: { release },
    } as unknown as AppClientUiBridge
    const onOpen = vi.fn()
    const view = render(<FileChangesTreeWidget model={model()} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('treeitem', { name: /a\.ts/ }).querySelector('button')!)
    view.unmount()

    await act(async () => finish?.({ ok: true, value: { ok: true, value: documentConst } }))

    expect(onOpen).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledWith(documentConst.documentId)
  })
})
