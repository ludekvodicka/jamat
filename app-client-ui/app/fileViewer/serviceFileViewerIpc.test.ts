import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'

import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import type { FileChangesManager } from '../../../lib-orchestrator/fileChangesManager/fileChangesManager'
import type { FileChangesWorkingTreeSnapshot } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import { ServiceFileChangesIpc } from '../fileChanges/serviceFileChangesIpc'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import { ServiceFileViewerIpc } from './serviceFileViewerIpc'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  copied: [] as string[],
  opened: [] as string[],
  getFileIcon: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getFileIcon: electronMock.getFileIcon },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      electronMock.handlers.set(channel, handler),
  },
  clipboard: {
    writeText: (value: string) => electronMock.copied.push(value),
    readText: () => electronMock.copied.at(-1) ?? '',
  },
  shell: { openExternal: (value: string) => { electronMock.opened.push(value); return Promise.resolve() } },
}))

describe('app-client-ui/app/fileViewer/serviceFileViewerIpc', () => {
  const startDrag = vi.fn()
  const isDestroyed = vi.fn(() => false)
  const sender = { startDrag, isDestroyed } as unknown as WebContents
  const imageDragPath = vi.fn<FileViewer['imageDragPath']>()
  const icon = { isEmpty: () => false }
  const rejected = {} as WebContents
  const document = {
    documentId: 'document-1',
    documentKey: 'key-1',
    source: { kind: 'detected', sessionId: 'session-1', path: 'C:/elsewhere/a.ts' },
  }
  /** This package's own root, which is a REAL directory and on a different drive from the temp one. */
  const packageRootConst = process.cwd()
  const crossRootConst = parse(packageRootConst).root.toLowerCase()
    !== parse(tmpdir()).root.toLowerCase()
  const roots: string[] = []
  let calls: { method: string; args: unknown[] }[]
  let sessionCwd: string
  /** The register `AppHub` hands the service, standing in for `TerminalDetector.wasOpened`. */
  let openedByDetection: Set<string>

  async function root(): Promise<string> {
    const path = await realpath(await mkdtemp(join(tmpdir(), 'jamat-file-viewer-ipc-')))
    roots.push(path)
    return path
  }

  beforeEach(() => {
    electronMock.handlers.clear()
    electronMock.copied = []
    electronMock.opened = []
    electronMock.getFileIcon.mockReset().mockResolvedValue(icon)
    imageDragPath.mockReset().mockResolvedValue('C:/work/picture.png')
    startDrag.mockReset()
    isDestroyed.mockReset().mockReturnValue(false)
    calls = []
    sessionCwd = 'C:/work'
    openedByDetection = new Set()
    const record = (method: string, value: unknown) => (...args: unknown[]) => {
      calls.push({ method, args })
      return value
    }
    const viewer = {
      openWorkspace: record('openWorkspace', Promise.resolve({ ok: false, code: 'not-found', detail: 'x' })),
      openFilesystem: record('openFilesystem', Promise.resolve({ ok: false, code: 'not-found', detail: 'x' })),
      openDetected: record('openDetected', Promise.resolve({ ok: true, value: document })),
      directoryAt: record('directoryAt', Promise.resolve({ ok: false, code: 'not-found', detail: 'x' })),
      text: record('text', Promise.resolve({ ok: true, kind: 'text', text: 'a', contentVersion: '1:1' })),
      chunk: record('chunk', Promise.resolve({ ok: false, code: 'missing', detail: 'x' })),
      rootDirectory: record('rootDirectory', Promise.resolve({ ok: false, code: 'not-found', detail: 'x' })),
      projectDirectory: record('projectDirectory', Promise.resolve({ ok: false, code: 'not-found', detail: 'x' })),
      directoryForDocument: record('directoryForDocument', Promise.resolve({ ok: false, code: 'document-expired', detail: 'x' })),
      directoryEntry: record('directoryEntry', Promise.resolve({ ok: false, code: 'directory-expired', detail: 'x' })),
      parentDirectory: record('parentDirectory', Promise.resolve({ ok: false, code: 'directory-expired', detail: 'x' })),
      openFileEntry: record('openFileEntry', Promise.resolve({ ok: false, code: 'not-found', detail: 'x' })),
      mediaResource: record('mediaResource', Promise.resolve({ ok: false, code: 'not-found', detail: 'x' })),
      relativeResource: record('relativeResource', Promise.resolve({ ok: false, code: 'not-found', detail: 'x' })),
      path: record('path', { ok: true, path: 'C:/work/a.ts' }),
      imageDragPath,
      release: record('release', undefined),
    } as unknown as FileViewer
    const sessions = {
      workingContext: (sessionId: string) => Promise.resolve({
        ok: true as const,
        value: { sessionId, cwd: sessionCwd, agent: null, worktree: null },
      }),
    } as unknown as SessionManager
    new ServiceFileViewerIpc(
      viewer,
      sessions,
      (value) => value === sender ? 'window-1' : null,
      async (ownerId, source, supportsDiff) => {
        calls.push({ method: 'restoreExternal', args: [ownerId, source, supportsDiff] })
        return { ok: false, code: 'not-found', detail: 'x' }
      },
      // The shape `AppHub` wires: the register decides, and a detected path it does not hold is
      // refused rather than reopened.
      async (ownerId, source, supportsDiff) => {
        calls.push({ method: 'restoreDetected', args: [ownerId, source, supportsDiff] })
        if (!openedByDetection.has(source.path))
          return { ok: false, code: 'proof-expired', detail: 'gone' }
        return viewer.openDetected(ownerId, source.sessionId, null, source.path, supportsDiff)
      },
      (path) => openedByDetection.has(path),
      async (ownerId, source) => {
        calls.push({ method: 'restoreWorkingTree', args: [ownerId, source] })
        return { ok: false, code: 'not-found', detail: 'fixture' }
      },
    ).initialize()
  })

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  async function invoke(
    channel: keyof AppClientUiIpcInvokeMap,
    source: WebContents,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = electronMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler({ sender: source } as IpcMainInvokeEvent, ...args)
  }

  it.each([false, true])('reopens a scoped commit file through both IPC services, missing=%s', async (missing) => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'jamat-viewer-origin-')))
    const scopeRoot = await realpath(await mkdtemp(join(tmpdir(), 'jamat-viewer-scope-')))
    roots.push(cwd, scopeRoot)
    const path = join(scopeRoot, 'changed.txt')
    if (!missing) await writeFile(path, 'outside content')
    const snapshot: FileChangesWorkingTreeSnapshot = {
      snapshotId: 'scoped-snapshot', sessionId: 'session-1', createdAt: 1, externalRoots: [], warnings: [],
      source: { requested: 'svn', selected: 'svn', available: ['svn'], fallbackReason: null },
      defaultBaseline: null,
      entries: [{ fileId: 'changed', path, displayPath: 'changed.txt', nodeKind: 'file', location: 'workspace',
        status: missing ? 'missing' : 'modified', previousPath: null, previousDisplayPath: null,
        modifiedAt: null, sources: ['vcs'], gitState: null }],
    }
    const viewer = new FileViewer()
    const sessions = { workingContext: async () => ({ ok: true, value: { sessionId: 'session-1', cwd, agent: null, worktree: null } }) } as unknown as SessionManager
    const workingTree = vi.fn(async () => ({ ok: true, value: snapshot }))
    const manager = { workingTree, fileAccess: () => ({ ok: true, value: { sessionId: 'session-1', cwd: scopeRoot, path, nodeKind: 'file' } }) } as unknown as FileChangesManager
    const files = new ServiceFileChangesIpc(manager, viewer, sessions, {} as ConfigStore, () => 'window-1')
    files.initialize()
    new ServiceFileViewerIpc(viewer, sessions, () => 'window-1', vi.fn(), vi.fn(), () => false,
      (owner, source) => files.restoreWorkingTree(owner, source)).initialize()
    await files.workingTree('window-1', 'session-1', 'svn', scopeRoot, true)
    const opened = await electronMock.handlers.get('fileChanges:open-file')!({ sender }, snapshot.snapshotId, 'changed') as {
      ok: true; value: { ok: true; value: import('../../../lib-orchestrator/fileViewer/fileViewerApi.types').FileViewerDocument }
    }
    expect(opened).toMatchObject({ ok: true, value: { ok: true } })
    const document = opened.value.value
    expect(document.source.workingTree).toEqual({ scopeRoot, source: 'svn' })
    viewer.release('window-1', document.documentId)
    const restored = await invoke('fileViewer:restore', sender, JSON.parse(JSON.stringify(document.source)), true)
    expect(restored).toMatchObject({ ok: true, value: { ok: true, value: {
      path, kind: { kind: missing ? 'missing' : 'text' }, modes: expect.arrayContaining(['diff']),
    } } })
    // The fourth argument is r4361, "Read only the selected file when opening commit diffs": a scoped
    // restore narrows the scan to the one file instead of rescanning the whole scope root. Named here
    // rather than dropped, so the narrowing stays asserted.
    expect(workingTree).toHaveBeenLastCalledWith({ sessionId: 'session-1', cwd: scopeRoot, agent: null, worktree: null }, 'svn', true, path)
    expect(await invoke('fileViewer:open-workspace', sender, 'session-1', path, true)).toMatchObject({ ok: true, value: { ok: false } })
    expect(await files.scopedWorkingTree('window-1', { ...document.source, path: join(cwd, 'unapproved.txt') })).toMatchObject({ ok: false })
  })

  it('opens workspace files and directories only against the trusted session cwd', async () => {
    await invoke('fileViewer:open-workspace', sender, 'session-1', 'a.ts', true)
    await invoke('fileViewer:root-directory', sender, 'session-1')
    await invoke('fileViewer:project-directory', sender, 'session-1')
    expect(calls.slice(0, 3)).toEqual([
      { method: 'openWorkspace', args: ['window-1', 'session-1', 'C:/work', 'a.ts', true] },
      { method: 'rootDirectory', args: ['window-1', 'session-1', 'C:/work'] },
      { method: 'projectDirectory', args: ['window-1', 'session-1', 'C:/work'] },
    ])
  })

  it('restores filesystem files only against the current session filesystem root', async () => {
    const source = { kind: 'filesystem' as const, sessionId: 'session-1', path: 'C:/outside/a.ts' }

    await invoke('fileViewer:restore', sender, source, true)

    expect(calls).toContainEqual({
      method: 'openFilesystem',
      args: ['window-1', 'session-1', 'C:/work', 'C:/outside/a.ts', true],
    })
  })

  it('restores a detected file only while the register still holds it', async () => {
    const elsewhere = await root()
    const path = join(elsewhere, 'a.ts')
    await writeFile(path, 'export const answer = 42\n')
    sessionCwd = packageRootConst
    const source = { kind: 'detected' as const, sessionId: 'session-1', path }

    expect(await invoke('fileViewer:restore', sender, source, false)).toEqual({
      ok: true,
      value: { ok: false, code: 'proof-expired', detail: 'gone' },
    })
    expect(calls).toContainEqual({
      method: 'restoreDetected',
      args: ['window-1', source, false],
    })

    openedByDetection.add(path)
    expect(await invoke('fileViewer:restore', sender, source, false))
      .toEqual({ ok: true, value: { ok: true, value: document } })
    expect(calls).toContainEqual({
      method: 'openDetected',
      args: ['window-1', 'session-1', null, path, false],
    })
  })

  /*
   * The pair of proofs a detected DIRECTORY panel already had: a file on the session's own
   * filesystem root is one `open-workspace` and a restored filesystem panel both reach, so asking
   * the register for it would refuse a tab after every restart for no reach it does not have.
   */
  it('restores a detected file on the session filesystem root without asking the register', async () => {
    sessionCwd = packageRootConst
    const path = await realpath(join(packageRootConst, 'package.json'))
    const source = { kind: 'detected' as const, sessionId: 'session-1', path }

    await invoke('fileViewer:restore', sender, source, false)

    expect(calls).toContainEqual({
      method: 'openDetected',
      args: ['window-1', 'session-1', null, path, false],
    })
    expect(calls.filter((call) => call.method === 'restoreDetected')).toEqual([])
  })

  it('opens a directory inside the session filesystem root with no detection at all', async () => {
    sessionCwd = packageRootConst
    const target = await realpath(join(packageRootConst, 'app'))

    await invoke('fileViewer:directory-at', sender, 'session-1', target)

    expect(calls).toContainEqual({
      method: 'directoryAt',
      args: ['window-1', 'session-1', target, parse(target).root],
    })
  })

  // The second proof, and the only one a target the session's own root cannot vouch for has.
  it.skipIf(!crossRootConst)(
    'refuses a directory on another filesystem root, and takes it once a detection opened it',
    async () => {
      sessionCwd = await root()
      const target = await realpath(packageRootConst)

      expect(await invoke('fileViewer:directory-at', sender, 'session-1', target)).toEqual({
        ok: true,
        value: {
          ok: false,
          code: 'proof-expired',
          detail: 'The terminal detection behind this directory is gone; open it from the terminal again',
        },
      })
      expect(calls.filter((call) => call.method === 'directoryAt')).toEqual([])

      openedByDetection.add(target)
      await invoke('fileViewer:directory-at', sender, 'session-1', target)
      expect(calls).toContainEqual({
        method: 'directoryAt',
        args: ['window-1', 'session-1', target, parse(target).root],
      })
    },
  )

  /*
   * The reproduction: a junction inside the session cwd whose target is on another volume. The
   * lexical path passes containment on the session's drive while the grant root is derived from
   * where it really lands, so the proof has to be taken on the real path or it authorizes a drive
   * nobody proved.
   */
  it.skipIf(!crossRootConst)(
    'refuses a junction inside the session root that crosses to another volume',
    async () => {
      sessionCwd = await root()
      const link = join(sessionCwd, 'crossdrive')
      await symlink(packageRootConst, link, process.platform === 'win32' ? 'junction' : 'dir')

      expect(await invoke('fileViewer:directory-at', sender, 'session-1', link)).toEqual({
        ok: true,
        value: {
          ok: false,
          code: 'proof-expired',
          detail: 'The terminal detection behind this directory is gone; open it from the terminal again',
        },
      })
      expect(calls.filter((call) => call.method === 'directoryAt')).toEqual([])
    },
  )

  it('refuses a directory that does not exist without asking either proof', async () => {
    sessionCwd = packageRootConst

    expect(await invoke(
      'fileViewer:directory-at',
      sender,
      'session-1',
      join(packageRootConst, 'no-such-directory'),
    )).toEqual({
      ok: true,
      value: { ok: false, code: 'not-found', detail: 'The directory does not exist' },
    })
    expect(calls.filter((call) => call.method === 'directoryAt')).toEqual([])
  })

  /*
   * Every channel, because the owner check is written once per channel and the test that covered it
   * invoked one of the seventeen. Rewriting `open-external`'s registration as
   * `(_event, url) => this.openExternal(url)` - any renderer, known workspace or not, driving
   * `shell.openExternal` - left the node suite green: its owner check is a bare statement whose value
   * is discarded, which makes it the one a cleanup pass deletes.
   */
  it('rejects every capability operation from an unknown workspace', async () => {
    const channels = Object.keys(ServiceFileViewerIpc.channelsConst) as
      (keyof AppClientUiIpcInvokeMap)[]
    expect(channels.length).toBe(18)

    for (const channel of channels)
      expect(await invoke(channel, rejected, 'https://example.test/a', 'second', true), channel)
        .toEqual({ ok: false, error: 'File viewer request came from an unknown workspace' })

    // Refused before anything was reached: no library call, no clipboard, no browser.
    expect(calls).toEqual([])
    expect(electronMock.opened).toEqual([])
    expect(electronMock.copied).toEqual([])
    expect(imageDragPath).not.toHaveBeenCalled()
    expect(startDrag).not.toHaveBeenCalled()
  })

  it('starts a native file drag with the granted image and OS file icon', async () => {
    expect(await invoke('fileViewer:start-image-drag', sender, 'document-1'))
      .toEqual({ ok: true, value: true })
    expect(imageDragPath).toHaveBeenCalledWith('window-1', 'document-1')
    expect(electronMock.getFileIcon).toHaveBeenCalledWith('C:/work/picture.png', { size: 'normal' })
    expect(startDrag).toHaveBeenCalledWith({ file: 'C:/work/picture.png', icon })
  })

  it('refuses unavailable images before consulting the OS', async () => {
    imageDragPath.mockResolvedValue(null)
    expect(await invoke('fileViewer:start-image-drag', sender, 'document-1'))
      .toEqual({ ok: true, value: false })
    expect(electronMock.getFileIcon).not.toHaveBeenCalled()
    expect(startDrag).not.toHaveBeenCalled()
  })

  it('rechecks the image after waiting for its OS icon', async () => {
    imageDragPath.mockResolvedValueOnce('C:/work/picture.png').mockResolvedValue(null)
    expect(await invoke('fileViewer:start-image-drag', sender, 'document-1'))
      .toEqual({ ok: true, value: false })
    expect(startDrag).not.toHaveBeenCalled()
  })

  it('does not start dragging after the window closes during icon retrieval', async () => {
    electronMock.getFileIcon.mockImplementationOnce(async () => {
      isDestroyed.mockReturnValue(true)
      return icon
    })
    expect(await invoke('fileViewer:start-image-drag', sender, 'document-1'))
      .toEqual({ ok: true, value: false })
    expect(startDrag).not.toHaveBeenCalled()
  })

  it('reports a native drag failure through the IPC result', async () => {
    startDrag.mockImplementationOnce(() => { throw new Error('Drag unavailable') })
    expect(await invoke('fileViewer:start-image-drag', sender, 'document-1'))
      .toEqual({ ok: false, error: 'Drag unavailable' })
  })

  /*
   * `crossRootConst` is `parse(cwd).root !== parse(tmpdir()).root`. On Linux and macOS both are `/`,
   * so there is no second volume to cross and the guard cannot be exercised at all - correctly
   * skipped. On Windows it is an accident of where the repository and the temp directory sit, and a
   * silent skip there is the two proofs quietly not running on the one platform they are about.
   */
  it('runs the two cross-volume proofs, or says why it could not', () => {
    if (crossRootConst) return
    expect(
      process.platform,
      'the cross-volume proofs were skipped: put the repository and the temp directory on '
        + 'different drives, or they never run',
    ).not.toBe('win32')
  })

  it('copies granted paths and opens only HTTP links in the system browser', async () => {
    expect(await invoke('fileViewer:copy-path', sender, 'document-1'))
      .toEqual({ ok: true, value: true })
    expect(electronMock.copied).toEqual(['C:/work/a.ts'])
    expect(await invoke('fileViewer:open-external', sender, 'https://example.test/a'))
      .toEqual({ ok: true, value: true })
    expect(await invoke('fileViewer:open-external', sender, 'file:///C:/work/a.ts'))
      .toEqual({ ok: true, value: false })
    expect(electronMock.opened).toEqual(['https://example.test/a'])
  })
})
