import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  FileViewerDirectory,
  FileViewerDocument,
} from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { AppClientUiBridge } from '../../shared/appClientUiIpc'
import { FileViewerPanel, type FileViewerPanelProps } from './fileViewerPanel'
import { PanelFileToolsRegistry } from './panelFileToolsRegistry'

/**
 * The panel itself, which three renderer test files existed beside and none rendered.
 *
 * Deleting the effect that releases the document grant on unmount left every web suite green - and a
 * grant nobody holds still costs a slot in a store of 256 for the sliding two-hour TTL, which
 * `fileViewerGrantStore.test.ts` is the other half of.
 */
class PanelHarness {
  static document(overrides: Partial<FileViewerDocument> = {}): FileViewerDocument {
    return {
      documentId: 'document-1',
      documentKey: 'key-1',
      source: { kind: 'workspace', sessionId: 'session-1', path: 'C:/work/a.ts' },
      path: 'C:/work/a.ts',
      name: 'a.ts',
      size: 24,
      contentVersion: '24:1',
      kind: { kind: 'code', language: 'typescript' },
      modes: ['raw'],
      ...overrides,
    }
  }

  static install(documents: readonly FileViewerDocument[] = [PanelHarness.document()]) {
    const queue = [...documents]
    const directory: FileViewerDirectory = {
      directoryId: 'directory-root',
      rootPath: 'C:/work',
      path: 'C:/work',
      relativePath: '',
      canGoParent: false,
      entries: [{
        entryId: 'file-entry',
        name: 'b.ts',
        path: 'C:/work/b.ts',
        nodeKind: 'file',
        targetKind: 'file',
        size: 24,
        modifiedAt: 1,
        openable: true,
        detail: null,
      }],
      truncated: false,
    }
    const fileViewer = {
      restore: vi.fn(async () => ({
        ok: true as const,
        value: { ok: true as const, value: queue.shift() ?? PanelHarness.document() },
      })),
      text: vi.fn(async () => ({
        ok: true as const,
        value: {
          ok: true as const,
          kind: 'text' as const,
          text: 'export const answer = 42',
          contentVersion: '24:1',
        },
      })),
      version: vi.fn(async () => ({
        ok: true as const,
        value: { ok: true as const, kind: 'unchanged' as const },
      })),
      release: vi.fn(async () => ({ ok: true as const, value: undefined })),
      rootDirectory: vi.fn(async () => ({
        ok: true as const,
        value: { ok: true as const, value: directory },
      })),
      documentDirectory: vi.fn(async () => ({
        ok: true as const,
        value: { ok: true as const, value: directory },
      })),
      openEntry: vi.fn(async () => ({
        ok: true as const,
        value: { ok: true as const, value: PanelHarness.document() },
      })),
      relativeResource: vi.fn(),
      openExternal: vi.fn(),
      copyPath: vi.fn(),
    }
    const fileChanges = {
      list: vi.fn(async () => ({
        ok: true as const,
        value: { ok: false as const, code: 'no-vcs' as const, detail: 'nothing here' },
      })),
      history: vi.fn(),
    }
    ;(window as unknown as { appClient: AppClientUiBridge }).appClient = {
      fileViewer,
      fileChanges,
    } as unknown as AppClientUiBridge
    return { fileViewer, fileChanges }
  }

  static panel(params: Record<string, unknown>): {
    props: FileViewerPanelProps
    emit(patch: Record<string, unknown>): void
    updateParameters: ReturnType<typeof vi.fn>
  } {
    const listeners: ((next: Record<string, unknown>) => void)[] = []
    const updateParameters = vi.fn((next: Record<string, unknown>) => {
      for (const listener of [...listeners]) listener(next)
    })
    const props = {
      params,
      api: {
        id: 'panel-1',
        setTitle: vi.fn(),
        getParameters: () => ({}),
        updateParameters,
        onDidParametersChange: (listener: (next: Record<string, unknown>) => void) => {
          listeners.push(listener)
          return {
            dispose: () => {
              const at = listeners.indexOf(listener)
              if (at >= 0) listeners.splice(at, 1)
            },
          }
        },
      },
      fileTools: new PanelFileToolsRegistry(),
    } as unknown as FileViewerPanelProps
    return {
      props,
      updateParameters,
      emit: (patch) => {
        for (const listener of [...listeners]) listener(patch)
      },
    }
  }

  static props(params: Record<string, unknown>): FileViewerPanelProps {
    return PanelHarness.panel(params).props
  }

  static workspaceParams(path = 'C:/work/a.ts'): Record<string, unknown> {
    return {
      sessionId: 'session-1',
      source: { kind: 'workspace', sessionId: 'session-1', path },
    }
  }
}

describe('app-client-ui/renderer/fileViewer/fileViewerPanel', () => {
  // Unmounted BEFORE the bridge goes: a panel still on screen releases its grant in a cleanup
  // effect, and testing-library's own afterEach runs after this one.
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  it('restores what the layout remembered, reads it, and gives the grant back on unmount', async () => {
    const { fileViewer } = PanelHarness.install()
    const view = render(<FileViewerPanel {...PanelHarness.props(PanelHarness.workspaceParams())} />)

    expect(await screen.findByText('export const answer = 42')).toBeInTheDocument()
    expect(fileViewer.restore).toHaveBeenCalledWith(
      { kind: 'workspace', sessionId: 'session-1', path: 'C:/work/a.ts' },
      true,
    )
    expect(fileViewer.text).toHaveBeenCalledWith('document-1')
    expect(fileViewer.release).not.toHaveBeenCalled()

    view.unmount()

    expect(fileViewer.release).toHaveBeenCalledWith('document-1')
  })

  it('keeps the zoom of this panel in the layout and draws the document at it', async () => {
    PanelHarness.install()
    const panel = PanelHarness.panel(PanelHarness.workspaceParams())
    render(<FileViewerPanel {...panel.props} />)

    expect(await screen.findByText('export const answer = 42')).toBeInTheDocument()
    const viewer = screen.getByLabelText('File viewer')
    expect(viewer.style.getPropertyValue('--file-viewer-zoom')).to.equal('1')

    fireEvent.click(screen.getByLabelText('Zoom in'))

    expect(panel.updateParameters).toHaveBeenCalledWith(expect.objectContaining({
      zoomPercent: 110,
    }))
    await waitFor(() =>
      expect(screen.getByLabelText('File viewer').style.getPropertyValue('--file-viewer-zoom'))
        .to.equal('1.1'))
    expect(screen.getByTitle('Reset the zoom to 100 %')).toHaveTextContent('110 %')
  })

  it('opens a remembered zoom and reads a hand-written one onto the ladder', async () => {
    PanelHarness.install()
    render(<FileViewerPanel {...PanelHarness.props({
      ...PanelHarness.workspaceParams(),
      zoomPercent: 130,
    })} />)

    expect(await screen.findByText('export const answer = 42')).toBeInTheDocument()
    expect(screen.getByLabelText('File viewer').style.getPropertyValue('--file-viewer-zoom'))
      .to.equal('1.25')
  })

  it('reads the file from disk again when the reload button is pressed', async () => {
    const { fileViewer } = PanelHarness.install([
      PanelHarness.document(),
      PanelHarness.document({ documentId: 'document-2' }),
    ])
    render(<FileViewerPanel {...PanelHarness.props(PanelHarness.workspaceParams())} />)

    expect(await screen.findByText('export const answer = 42')).toBeInTheDocument()
    expect(fileViewer.restore).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('Reload'))

    await waitFor(() => expect(fileViewer.restore).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(fileViewer.release).toHaveBeenCalledWith('document-1'))
    expect(fileViewer.text).toHaveBeenCalledWith('document-2')
  })

  /*
   * A panel is rebuilt from what the layout file holds, so its source can be one this build does not
   * know - a kind added later, a kind removed again, a hand-edited file. Throwing takes the whole
   * window down, and the layout brings the same panel back on every start, so the window would never
   * come back.
   */
  it('says what it could not read rather than taking the window down with it', () => {
    PanelHarness.install()

    render(<FileViewerPanel {...PanelHarness.props({ sessionId: 's1', source: { kind: 'moon' } })} />)

    expect(screen.getByText(/Unknown file viewer source/)).toBeInTheDocument()
  })

  it('says why the restore was refused and asks for no text', async () => {
    const { fileViewer } = PanelHarness.install()
    fileViewer.restore.mockResolvedValue({
      ok: true as const,
      value: { ok: false as const, code: 'not-found' as const, detail: 'it moved' },
    } as never)

    render(<FileViewerPanel {...PanelHarness.props(PanelHarness.workspaceParams())} />)

    expect(await screen.findByText('not-found: it moved')).toBeInTheDocument()
    expect(fileViewer.text).not.toHaveBeenCalled()
  })

  /*
   * `diff === null` carried three different states and drew one sentence for all of them. A session
   * whose VCS read failed opened in diff mode with a calm invitation to choose a baseline, and
   * nowhere at all to learn why there was nothing to choose from - the reason lived in the sidebar
   * widget, which is only on screen when that tab is open.
   */
  it('says the change list could not be read rather than inviting a choice', async () => {
    const { fileChanges } = PanelHarness.install([PanelHarness.document({
      modes: ['diff'],
      kind: { kind: 'text' },
    })])
    fileChanges.list.mockResolvedValue({ ok: false, error: 'the git binary is not there' } as never)

    render(<FileViewerPanel {...PanelHarness.props(PanelHarness.workspaceParams())} />)

    expect(await screen.findByText(/The change list could not be read/))
      .toHaveTextContent('the git binary is not there')
    expect(screen.queryByText('Select a diff baseline.')).toBeNull()
  })

  it('invites a choice when the change list is there and nothing is chosen', async () => {
    const { fileChanges } = PanelHarness.install([
      PanelHarness.document({ modes: ['diff'], kind: { kind: 'text' } }),
    ])
    // A listing that worked and offers no baseline for this file: nothing to choose, and nothing
    // wrong either.
    fileChanges.list.mockResolvedValue({
      ok: true,
      value: {
        ok: true,
        value: {
          snapshotId: 'snapshot-1',
          sessionId: 'session-1',
          createdAt: 1,
          vcs: { vcsId: null, available: [] },
          defaultBaseline: null,
          entries: [],
          history: { groups: [], nextCursor: null },
          warnings: [],
        },
      },
    } as never)

    render(<FileViewerPanel {...PanelHarness.props(PanelHarness.workspaceParams())} />)

    expect(await screen.findByText('Select a diff baseline.')).toBeInTheDocument()
  })

  it('releases the document it was holding when the layout points it at another one', async () => {
    const { fileViewer } = PanelHarness.install([
      PanelHarness.document(),
      PanelHarness.document({
        documentId: 'document-2',
        name: 'b.ts',
        path: 'C:/work/b.ts',
        source: { kind: 'workspace', sessionId: 'session-1', path: 'C:/work/b.ts' },
      }),
    ])
    const view = render(
      <FileViewerPanel {...PanelHarness.props(PanelHarness.workspaceParams())} />,
    )
    await screen.findByText('export const answer = 42')

    view.rerender(
      <FileViewerPanel {...PanelHarness.props(PanelHarness.workspaceParams('C:/work/b.ts'))} />,
    )

    await waitFor(() => expect(fileViewer.release).toHaveBeenCalledWith('document-1'))
    expect(fileViewer.restore).toHaveBeenCalledTimes(2)
    expect(fileViewer.text).toHaveBeenLastCalledWith('document-2')

    view.unmount()
    expect(fileViewer.release).toHaveBeenCalledWith('document-2')
  })

  it('keeps newer live parameters when an explorer open finishes before React rerenders', async () => {
    const opened = PanelHarness.document({
      documentId: 'document-2',
      documentKey: 'key-2',
      name: 'b.ts',
      path: 'C:/work/b.ts',
      source: { kind: 'workspace', sessionId: 'session-1', path: 'C:/work/b.ts' },
    })
    const { fileViewer } = PanelHarness.install()
    let finish = (): void => undefined
    fileViewer.openEntry.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ ok: true, value: { ok: true, value: opened } })
    }))
    const panel = PanelHarness.panel({
      ...PanelHarness.workspaceParams(),
      sidebar: { visible: true, width: 440, activeView: 'directoryExplorer' },
    })
    render(<FileViewerPanel {...panel.props} />)
    fireEvent.click(await screen.findByRole('button', { name: /b\.ts/ }))

    act(() => panel.emit({ newerParameter: 'keep-me' }))
    await act(async () => finish())

    await waitFor(() => expect(panel.updateParameters).toHaveBeenCalled())
    expect(panel.updateParameters).toHaveBeenLastCalledWith(expect.objectContaining({
      newerParameter: 'keep-me',
      source: opened.source,
    }))
  })
})
