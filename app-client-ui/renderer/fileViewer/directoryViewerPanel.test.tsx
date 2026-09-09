import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  FileViewerDirectory,
  FileViewerDirectoryEntry,
  FileViewerDirectoryResult,
  FileViewerDocument,
} from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { AppClientUiBridge } from '../../shared/appClientUiIpc'
import { DirectoryExplorer } from './directoryExplorer'
import {
  DirectoryViewerPanel,
  type DirectoryViewerPanelProps,
  DirectoryViewerPanelState,
} from './directoryViewerPanel'

class DirectoryViewerHarness {
  static install(
    root: FileViewerDirectory = DirectoryViewerHarness.root(),
    nested: FileViewerDirectory = DirectoryViewerHarness.nested(),
    parents: readonly FileViewerDirectory[] = [],
    at: FileViewerDirectoryResult = { ok: true, value: DirectoryViewerHarness.detected() },
  ) {
    const document = DirectoryViewerHarness.document()
    const parentQueue = [...parents]
    const fileViewer = {
      rootDirectory: vi.fn(async () => ({
        ok: true as const,
        value: { ok: true as const, value: root },
      })),
      projectDirectory: vi.fn(async () => ({
        ok: true as const,
        value: { ok: true as const, value: root },
      })),
      directoryAt: vi.fn(async () => ({ ok: true as const, value: at })),
      documentDirectory: vi.fn(),
      directoryEntry: vi.fn(async () => ({
        ok: true as const,
        value: { ok: true as const, value: nested },
      })),
      parentDirectory: vi.fn(async () => {
        const parent = parentQueue.shift()
        return parent
          ? { ok: true as const, value: { ok: true as const, value: parent } }
          : {
            ok: true as const,
            value: {
              ok: false as const,
              code: 'outside-root' as const,
              detail: 'The explorer is already at its root',
            },
          }
      }),
      openEntry: vi.fn(async () => ({
        ok: true as const,
        value: { ok: true as const, value: document },
      })),
      release: vi.fn(async () => ({ ok: true as const, value: undefined })),
    }
    ;(window as unknown as { appClient: AppClientUiBridge }).appClient = {
      fileViewer,
    } as unknown as AppClientUiBridge
    return { document, fileViewer }
  }

  static root(): FileViewerDirectory {
    return {
      directoryId: 'directory-root',
      rootPath: 'C:/',
      path: 'C:/work',
      relativePath: 'work',
      canGoParent: true,
      entries: [
        DirectoryViewerHarness.entry('directory-entry', 'src', 'directory'),
        DirectoryViewerHarness.entry('file-entry', 'readme.md', 'file'),
      ],
      truncated: false,
    }
  }

  static nested(): FileViewerDirectory {
    return {
      directoryId: 'directory-src',
      rootPath: 'C:/',
      path: 'C:/work/src',
      relativePath: 'work/src',
      canGoParent: true,
      entries: [DirectoryViewerHarness.entry('nested-file', 'main.ts', 'file')],
      truncated: false,
    }
  }

  /** Another drive entirely: what a terminal detection reaches and the project folder never does. */
  static detected(): FileViewerDirectory {
    return {
      directoryId: 'directory-detected',
      rootPath: 'D:/',
      path: 'D:/logs',
      relativePath: 'logs',
      canGoParent: true,
      entries: [DirectoryViewerHarness.entry('detected-file', 'run.log', 'file')],
      truncated: false,
    }
  }

  static volume(): FileViewerDirectory {
    return {
      directoryId: 'directory-volume',
      rootPath: 'C:/',
      path: 'C:/',
      relativePath: '',
      canGoParent: false,
      entries: [],
      truncated: false,
    }
  }

  static document(): FileViewerDocument {
    return {
      documentId: 'document-readme',
      documentKey: 'stable-readme',
      source: { kind: 'filesystem', sessionId: 'session-1', path: 'C:/work/readme.md' },
      path: 'C:/work/readme.md',
      name: 'readme.md',
      size: 10,
      contentVersion: '10:1',
      kind: { kind: 'markdown', flavor: 'markdown' },
      modes: ['rendered', 'raw'],
    }
  }

  private static entry(
    entryId: string,
    name: string,
    targetKind: 'file' | 'directory',
  ): FileViewerDirectoryEntry {
    return {
      entryId,
      name,
      path: `C:/work/${name}`,
      nodeKind: targetKind,
      targetKind,
      size: targetKind === 'file' ? 10 : null,
      modifiedAt: 1,
      openable: true,
      detail: null,
    }
  }
}

describe('app-client-ui/renderer/fileViewer/directoryViewerPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  it('opens a file from View in another FileViewer flow and releases the temporary grant', async () => {
    const { document, fileViewer } = DirectoryViewerHarness.install()
    const openFile = vi.fn()
    const props = {
      params: { sessionId: 'session-1' },
      openFile,
    } as unknown as DirectoryViewerPanelProps
    render(<DirectoryViewerPanel {...props} />)
    const file = await screen.findByRole('button', { name: /readme\.md/ })

    fireEvent.contextMenu(file, { clientX: 20, clientY: 30 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))

    await waitFor(() => expect(openFile).toHaveBeenCalledWith(
      document.source,
      document.documentKey,
    ))
    expect(fileViewer.openEntry).toHaveBeenCalledWith('directory-root', 'file-entry')
    expect(fileViewer.release).toHaveBeenCalledWith(document.documentId)
    expect(fileViewer.projectDirectory).toHaveBeenCalledWith('session-1')
    expect(screen.getByRole('button', { name: /readme\.md/ })).toBeInTheDocument()
  })

  it('uses View on a directory to navigate inside the same panel', async () => {
    const { fileViewer } = DirectoryViewerHarness.install()
    const props = {
      params: { sessionId: 'session-1' },
      openFile: vi.fn(),
    } as unknown as DirectoryViewerPanelProps
    render(<DirectoryViewerPanel {...props} />)
    const directory = await screen.findByRole('button', { name: /src/ })

    fireEvent.contextMenu(directory, { clientX: 20, clientY: 30 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))

    expect(await screen.findByRole('button', { name: /main\.ts/ })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Directory path' }))
      .toHaveAttribute('title', 'C:/work/src')
    expect(fileViewer.directoryEntry).toHaveBeenCalledWith('directory-root', 'directory-entry')
  })

  /**
   * Two clicks into two directories, the first of them slow - a network path, or one with tens of
   * thousands of entries. The later ANSWER used to win rather than the later click, and nothing
   * refused: every `openDirectory` mints a fresh id and the old one stays valid, so the list, the
   * breadcrumb and every click after it silently belonged to the directory nobody chose last.
   */
  it('shows the directory that was clicked last, not the answer that came back last', async () => {
    const { fileViewer } = DirectoryViewerHarness.install()
    const slow = DirectoryViewerHarness.nested()
    const quick = { ...DirectoryViewerHarness.nested(), directoryId: 'directory-quick', path: 'C:/work/quick' }
    let releaseSlow: () => void = () => undefined
    fileViewer.directoryEntry
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { releaseSlow = () => resolve() })
        return { ok: true as const, value: { ok: true as const, value: slow } }
      })
      .mockImplementationOnce(async () => ({
        ok: true as const,
        value: { ok: true as const, value: quick },
      }))
    const props = {
      params: { sessionId: 'session-1' },
      openFile: vi.fn(),
    } as unknown as DirectoryViewerPanelProps
    render(<DirectoryViewerPanel {...props} />)
    const directory = await screen.findByRole('button', { name: /src/ })

    fireEvent.contextMenu(directory, { clientX: 20, clientY: 30 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
    fireEvent.contextMenu(directory, { clientX: 20, clientY: 30 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))

    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Directory path' }))
      .toHaveAttribute('title', 'C:/work/quick'))

    releaseSlow()

    await waitFor(() => expect(fileViewer.directoryEntry).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('navigation', { name: 'Directory path' }))
      .toHaveAttribute('title', 'C:/work/quick')
  })

  it('keeps the sidebar explorer without the View menu and opens a file on one click', async () => {
    const { fileViewer } = DirectoryViewerHarness.install()
    const onOpen = vi.fn()
    render(
      <DirectoryExplorer
        sessionId="session-1"
        documentId={null}
        targetPath={null}
        place="sidebar"
        onOpen={onOpen}
      />,
    )
    const file = await screen.findByRole('button', { name: /readme\.md/ })

    fireEvent.contextMenu(file, { clientX: 20, clientY: 30 })

    expect(screen.queryByRole('menuitem', { name: 'View' })).toBeNull()
    expect(fileViewer.rootDirectory).toHaveBeenCalledWith('session-1')
    expect(fileViewer.projectDirectory).not.toHaveBeenCalled()
    fireEvent.click(file)
    await waitFor(() => expect(onOpen).toHaveBeenCalledOnce())
    fireEvent.doubleClick(file)
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('releases a successful file open superseded by another navigation', async () => {
    const { document, fileViewer } = DirectoryViewerHarness.install()
    let finish = (): void => undefined
    fileViewer.openEntry.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ ok: true, value: { ok: true, value: document } })
    }))
    const onOpen = vi.fn()
    render(
      <DirectoryExplorer
        sessionId="session-1"
        documentId={null}
        targetPath={null}
        place="sidebar"
        onOpen={onOpen}
      />,
    )
    const file = await screen.findByRole('button', { name: /readme\.md/ })
    fireEvent.click(file)
    fireEvent.click(screen.getByRole('button', { name: /src/ }))

    await act(async () => finish())

    expect(onOpen).not.toHaveBeenCalled()
    expect(fileViewer.release).toHaveBeenCalledWith(document.documentId)
  })

  it('releases a successful file open that finishes after unmount', async () => {
    const { document, fileViewer } = DirectoryViewerHarness.install()
    let finish = (): void => undefined
    fileViewer.openEntry.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ ok: true, value: { ok: true, value: document } })
    }))
    const onOpen = vi.fn()
    const view = render(
      <DirectoryExplorer
        sessionId="session-1"
        documentId={null}
        targetPath={null}
        place="sidebar"
        onOpen={onOpen}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /readme\.md/ }))
    view.unmount()

    await act(async () => finish())

    expect(onOpen).not.toHaveBeenCalled()
    expect(fileViewer.release).toHaveBeenCalledWith(document.documentId)
  })

  it('rejects restored directory panels without a session', () => {
    expect(() => DirectoryViewerPanelState.sessionIdOf({})).toThrow(/has no session/)
    expect(DirectoryViewerPanelState.sessionIdOf({ sessionId: 'session-1' })).toBe('session-1')
  })

  it('reads the durable path as an address and refuses an unreadable one', () => {
    expect(DirectoryViewerPanelState.pathOf({ sessionId: 'session-1' })).toBeNull()
    expect(DirectoryViewerPanelState.pathOf({ sessionId: 'session-1', path: 'D:/logs' }))
      .toBe('D:/logs')
    expect(() => DirectoryViewerPanelState.pathOf({ path: 7 })).toThrow(/unreadable path/)
    expect(() => DirectoryViewerPanelState.pathOf({ path: '' })).toThrow(/unreadable path/)
  })

  it('asks directory-at for the path it holds instead of the session project folder', async () => {
    const { fileViewer } = DirectoryViewerHarness.install()
    const props = {
      params: { sessionId: 'session-1', path: 'D:/logs' },
      openFile: vi.fn(),
    } as unknown as DirectoryViewerPanelProps

    render(<DirectoryViewerPanel {...props} />)

    expect(await screen.findByRole('button', { name: /run\.log/ })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Directory path' }))
      .toHaveAttribute('title', 'D:/logs')
    expect(fileViewer.directoryAt).toHaveBeenCalledWith('session-1', 'D:/logs')
    expect(fileViewer.projectDirectory).not.toHaveBeenCalled()
  })

  it('says what to do when the proof behind a restored directory is gone', async () => {
    const { fileViewer } = DirectoryViewerHarness.install(
      DirectoryViewerHarness.root(),
      DirectoryViewerHarness.nested(),
      [],
      {
        ok: false,
        code: 'proof-expired',
        detail: 'The detection behind this directory is gone; open it from the terminal again',
      },
    )
    const props = {
      params: { sessionId: 'session-1', path: 'D:/logs' },
      openFile: vi.fn(),
    } as unknown as DirectoryViewerPanelProps

    render(<DirectoryViewerPanel {...props} />)

    expect(await screen.findByText(/open it from the terminal again/))
      .toHaveClass('file-tools-error')
    expect(screen.queryByRole('button', { name: /run\.log/ })).toBeNull()
    expect(fileViewer.directoryAt).toHaveBeenCalledWith('session-1', 'D:/logs')
  })

  it('shows the full project path and an explicit empty state', async () => {
    const { fileViewer } = DirectoryViewerHarness.install({
      ...DirectoryViewerHarness.root(),
      entries: [],
    })
    const props = {
      params: { sessionId: 'session-1' },
      openFile: vi.fn(),
    } as unknown as DirectoryViewerPanelProps

    render(<DirectoryViewerPanel {...props} />)

    expect(await screen.findByRole('navigation', { name: 'Directory path' }))
      .toHaveAttribute('title', 'C:/work')
    expect(screen.getByText('This directory is empty.')).toBeInTheDocument()
    expect(fileViewer.projectDirectory).toHaveBeenCalledWith('session-1')
    expect(fileViewer.directoryAt).not.toHaveBeenCalled()
  })

  it('uses breadcrumb entry tokens to navigate directly to a selected ancestor', async () => {
    const current = {
      ...DirectoryViewerHarness.nested(),
      rootPath: 'C:\\',
      path: 'C:\\Projects\\ClaudeUsage',
      relativePath: 'Projects/ClaudeUsage',
      entries: [],
    }
    const parent = {
      ...DirectoryViewerHarness.root(),
      rootPath: 'C:\\',
      path: 'C:\\Projects',
      relativePath: 'Projects',
      entries: [],
    }
    const volume = {
      ...DirectoryViewerHarness.volume(),
      rootPath: 'C:\\',
      path: 'C:\\',
    }
    const { fileViewer } = DirectoryViewerHarness.install(
      current,
      DirectoryViewerHarness.nested(),
      [parent, volume],
    )
    const props = {
      params: { sessionId: 'session-1' },
      openFile: vi.fn(),
    } as unknown as DirectoryViewerPanelProps
    render(<DirectoryViewerPanel {...props} />)

    const root = await screen.findByRole('button', { name: 'C:\\' })
    expect(screen.getByRole('button', { name: 'Projects' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'ClaudeUsage' }))
      .toHaveAttribute('aria-current', 'page')
    fireEvent.click(root)

    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Directory path' }))
      .toHaveAttribute('title', 'C:\\'))
    expect(fileViewer.parentDirectory.mock.calls).toEqual([
      ['directory-src'],
      ['directory-root'],
    ])
    expect(screen.getByRole('button', { name: 'Parent directory' })).toBeDisabled()
  })
})
