import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  FileChangeBaseline,
  FileChangeEntry,
  FileChangesWorkingTreeSnapshot,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { FileViewerDocument } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { AppClientUiBridge } from '../../shared/appClientUiIpc'
import { PanelSplitParams, type PanelSplitItem } from '../widgets/tabs/panelSplit'
import { FileViewerPane } from './fileViewerPane'
import type {
  FileChangesViewModel,
  FileChangesWorkingTreeViewModel,
} from './fileViewerPanel.types'

class FileViewerPaneHarness {
  static document(overrides: Partial<FileViewerDocument> = {}): FileViewerDocument {
    return {
      documentId: 'document-a',
      documentKey: 'key-a',
      source: { kind: 'workspace', sessionId: 'session-1', path: 'C:/work/a.md' },
      path: 'C:/work/a.md',
      name: 'a.md',
      size: 10,
      contentVersion: '10:1',
      kind: { kind: 'markdown', flavor: 'markdown' },
      modes: ['rendered', 'raw'],
      ...overrides,
    }
  }

  static item(document = FileViewerPaneHarness.document()): PanelSplitItem {
    return { key: document.documentKey, title: document.name, source: document.source }
  }

  static changes(): FileChangesViewModel {
    return {
      snapshot: null,
      groups: [],
      nextCursor: null,
      preferredVcs: null,
      loading: false,
      loadingMore: false,
      error: null,
      reload: vi.fn(async () => undefined),
      loadMore: vi.fn(async () => undefined),
    }
  }

  static workingTree(snapshot?: FileChangesWorkingTreeSnapshot): FileChangesWorkingTreeViewModel {
    return {
      snapshot: snapshot ?? null,
      snapshots: snapshot ? [snapshot] : [],
      selectedSource: snapshot?.source.selected ?? null,
      loading: false,
      error: null,
      requiredLoading: false,
      requiredError: null,
      select: vi.fn(),
      reload: vi.fn(async () => undefined),
      snapshotFor: () => snapshot ?? null,
    }
  }

  static install(documents: readonly FileViewerDocument[], text = 'body') {
    const queue = [...documents]
    const fileViewer = {
      restore: vi.fn(async () => ({
        ok: true as const,
        value: { ok: true as const, value: queue.shift() ?? documents[0]! },
      })),
      text: vi.fn(async () => ({
        ok: true as const,
        value: { ok: true as const, kind: 'text' as const, text, contentVersion: '10:1' },
      })),
      release: vi.fn(async () => ({ ok: true as const, value: undefined })),
      relativeResource: vi.fn(),
      openExternal: vi.fn(),
      copyPath: vi.fn(),
    }
    const fileChanges = {
      diff: vi.fn(async () => ({
        ok: true as const,
        value: { ok: false as const, code: 'source-unavailable' as const, detail: 'not needed' },
      })),
    }
    ;(window as unknown as { appClient: AppClientUiBridge }).appClient = {
      fileViewer,
      fileChanges,
    } as unknown as AppClientUiBridge
    return { fileViewer, fileChanges }
  }

  static entry(): FileChangeEntry {
    return {
      fileId: 'file-a',
      path: 'C:/work/a.md',
      displayPath: 'a.md',
      nodeKind: 'file',
      location: 'workspace',
      status: 'modified',
      previousPath: null,
      previousDisplayPath: null,
      modifiedAt: null,
      sources: ['vcs'],
      gitState: null,
    }
  }

  static workingSnapshot(): FileChangesWorkingTreeSnapshot {
    const baseline: FileChangeBaseline = {
      baselineId: 'baseline-checkpoint',
      kind: 'git-head',
      label: 'Checkpoint HEAD',
      revision: 'HEAD',
      createdAt: null,
    }
    return {
      snapshotId: 'snapshot-checkpoint',
      sessionId: 'session-1',
      createdAt: 1,
      source: {
        requested: 'checkpoint',
        selected: 'checkpoint',
        available: ['checkpoint'],
        fallbackReason: null,
      },
      defaultBaseline: baseline,
      entries: [FileViewerPaneHarness.entry()],
      warnings: [],
    }
  }
}

describe('app-client-ui/renderer/fileViewer/fileViewerPane', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  it('shows diff controls only for a diff-capable document and restores its working source hint', async () => {
    const document = FileViewerPaneHarness.document({
      kind: { kind: 'text' },
      modes: ['raw', 'diff'],
    })
    FileViewerPaneHarness.install([document])
    const snapshot = FileViewerPaneHarness.workingSnapshot()
    const item = {
      ...FileViewerPaneHarness.item(document),
      baselineHint: { kind: 'git-head' as const, revision: 'HEAD', workingTreeSource: 'checkpoint' as const },
    }

    render(
      <FileViewerPane
        backPath={null}
        onBack={vi.fn()}
        item={item}
        changes={FileViewerPaneHarness.changes()}
        workingTree={FileViewerPaneHarness.workingTree(snapshot)}
        onOpenItem={vi.fn(() => null)}
        onRefused={vi.fn()}
      />,
    )

    expect(await screen.findByRole('button', { name: 'Diff' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(screen.getByLabelText('Diff against')).toHaveValue(
      JSON.stringify(['git-head', 'HEAD', 'checkpoint']),
    ))
  })

  it('does not draw a diff selector for a document without diff mode', async () => {
    const document = FileViewerPaneHarness.document({ kind: { kind: 'text' }, modes: ['raw'] })
    FileViewerPaneHarness.install([document])

    render(
      <FileViewerPane
        backPath={null}
        onBack={vi.fn()}
        item={FileViewerPaneHarness.item(document)}
        changes={FileViewerPaneHarness.changes()}
        workingTree={FileViewerPaneHarness.workingTree()}
        onOpenItem={vi.fn(() => null)}
        onRefused={vi.fn()}
      />,
    )

    await screen.findByRole('button', { name: 'Raw' })
    expect(screen.queryByLabelText('Diff against')).toBeNull()
  })

  it('copies the active document path through its grant', async () => {
    const document = FileViewerPaneHarness.document()
    const { fileViewer } = FileViewerPaneHarness.install([document])

    render(
      <FileViewerPane
        backPath={null}
        onBack={vi.fn()}
        item={FileViewerPaneHarness.item(document)}
        changes={FileViewerPaneHarness.changes()}
        workingTree={FileViewerPaneHarness.workingTree()}
        onOpenItem={vi.fn(() => null)}
        onRefused={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Copy path' }))

    expect(fileViewer.copyPath).toHaveBeenCalledWith('document-a')
  })

  it('keeps a refused proof as readable pane text', async () => {
    const document = FileViewerPaneHarness.document()
    const { fileViewer } = FileViewerPaneHarness.install([document])
    fileViewer.restore.mockResolvedValue({
      ok: true,
      value: { ok: false, code: 'proof-expired', detail: 'Open the path again.' },
    } as never)

    const onBack = vi.fn()
    render(
      <FileViewerPane
        backPath="C:/work/previous.md"
        onBack={onBack}
        item={FileViewerPaneHarness.item(document)}
        changes={FileViewerPaneHarness.changes()}
        workingTree={FileViewerPaneHarness.workingTree()}
        onOpenItem={vi.fn(() => null)}
        onRefused={vi.fn()}
      />,
    )

    expect(await screen.findByText('proof-expired: Open the path again.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to previous document' }))
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('returns to the document replaced by a Markdown link and releases both grants', async () => {
    const current = FileViewerPaneHarness.document()
    const linked = FileViewerPaneHarness.document({
      documentId: 'document-b', documentKey: 'key-b', name: 'b.md', path: 'C:/work/b.md',
      source: { kind: 'workspace', sessionId: 'session-1', path: 'C:/work/b.md' },
    })
    const { fileViewer } = FileViewerPaneHarness.install([current, linked, linked, current], '[Other](b.md)')
    const initial = PanelSplitParams.opened(PanelSplitParams.default(), FileViewerPaneHarness.item(current))
    if (!initial.ok) throw new Error(initial.refusal)
    const initialState = initial.state

    function Split(): React.JSX.Element {
      const [state, setState] = useState(initialState)
      const item = state.items.find((candidate) => candidate.key === state.active)!
      return (
        <FileViewerPane
          key={item.key}
          item={item}
          changes={FileViewerPaneHarness.changes()}
          workingTree={FileViewerPaneHarness.workingTree()}
          backPath={PanelSplitParams.backTargetOf(state)?.source.path ?? null}
          onBack={() => {
            const step = PanelSplitParams.navigatedBack(state)
            if (!step.ok) throw new Error(step.refusal)
            setState(step.state)
          }}
          onOpenItem={(next) => {
            const step = PanelSplitParams.opened(state, next)
            if (!step.ok) return step.refusal
            setState(step.state)
            return null
          }}
          onRefused={(reason) => { throw new Error(reason) }}
        />
      )
    }

    const view = render(<Split />)
    expect(screen.getByRole('button', { name: 'Back to previous document' })).toBeDisabled()
    fireEvent.click(await screen.findByRole('link', { name: 'Other' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back to previous document' })).toBeEnabled())
    const back = screen.getByRole('button', { name: 'Back to previous document' })
    expect(back).toHaveAttribute('title', 'Back to C:/work/a.md')
    await waitFor(() => expect(fileViewer.restore).toHaveBeenCalledTimes(3))

    fireEvent.click(back)

    await waitFor(() => expect(fileViewer.restore).toHaveBeenLastCalledWith(current.source, true))
    expect(screen.getByRole('button', { name: 'Back to previous document' })).toBeDisabled()
    expect(fileViewer.release).toHaveBeenCalledWith('document-a')
    expect(fileViewer.release).toHaveBeenCalledWith('document-b')
    view.unmount()
  })

  it('opens a rendered-document link as a new item and reports a split refusal', async () => {
    const current = FileViewerPaneHarness.document()
    const linked = FileViewerPaneHarness.document({
      documentId: 'document-b',
      documentKey: 'key-b',
      source: { kind: 'workspace', sessionId: 'session-1', path: 'C:/work/b.md' },
      path: 'C:/work/b.md',
      name: 'b.md',
    })
    const { fileViewer } = FileViewerPaneHarness.install([current, linked], '[Other](b.md)')
    const onOpenItem = vi.fn(() => 'The split already holds 8 files.')
    const onRefused = vi.fn()

    render(
      <FileViewerPane
        backPath={null}
        onBack={vi.fn()}
        item={FileViewerPaneHarness.item(current)}
        changes={FileViewerPaneHarness.changes()}
        workingTree={FileViewerPaneHarness.workingTree()}
        onOpenItem={onOpenItem}
        onRefused={onRefused}
      />,
    )

    fireEvent.click(await screen.findByRole('link', { name: 'Other' }))
    await waitFor(() => expect(onOpenItem).toHaveBeenCalledWith({
      key: 'key-b',
      title: 'b.md',
      source: linked.source,
    }))
    expect(onRefused).toHaveBeenCalledWith('The split already holds 8 files.')
    expect(fileViewer.release).toHaveBeenCalledWith('document-b')
  })
})
