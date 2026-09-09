import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type {
  TerminalDetectionHit,
  TerminalDetector,
} from '../../../lib-orchestrator/terminalDetector/terminalDetector'
import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import type { ServiceTerminalIpc } from './serviceTerminalIpc'
import { TerminalDetectorLimits } from '../../../lib-orchestrator/terminalDetector/terminalDetectorLimits'
import { ServiceTerminalMenuIpc } from './serviceTerminalMenuIpc'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      electronMock.handlers.set(channel, handler),
  },
}))

const launcherMock = vi.hoisted(() => ({ opens: [] as { path: string; line: number | null }[] }))

vi.mock('./vsCodeLauncher', () => ({
  VsCodeLauncher: {
    open: (path: string, line: number | null) => launcherMock.opens.push({ path, line }),
  },
}))

const desktopMock = vi.hoisted(() => ({ opens: [] as string[], refusal: null as string | null }))

vi.mock('./externalOpener', () => ({
  ExternalOpener: {
    open: (path: string) => {
      desktopMock.opens.push(path)
      return Promise.resolve(desktopMock.refusal)
    },
  },
}))

/** A window as this service sees one: an identity and the two ways it can lose its renderer. */
class FakeSender {
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  private destroyed = false

  on(channel: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(channel, [...(this.listeners.get(channel) ?? []), listener])
  }

  countOf(channel: string): number {
    return this.listeners.get(channel)?.length ?? 0
  }

  /** Electron hands `did-start-navigation` four arguments, the fourth of which is `isMainFrame`. */
  fire(channel: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(channel) ?? []) listener(...args)
  }

  destroy(): void {
    this.destroyed = true
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  asSender(): WebContents {
    return this as unknown as WebContents
  }
}

describe('app-client-ui/app/terminals/serviceTerminalMenuIpc', () => {
  const roots: string[] = []
  const requestIdConst = 'request-1'
  let owner: FakeSender
  let other: FakeSender
  let workspace: string
  let elsewhere: string
  let hits: Map<string, TerminalDetectionHit>
  let detected: { sessionId: string; capture: unknown }[]
  let markedOpen: { path: string; kind: string }[]
  let attachSession: string | null
  let attachOwner: FakeSender

  async function root(prefix: string): Promise<string> {
    const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
    roots.push(path)
    return path
  }

  beforeEach(async () => {
    electronMock.handlers.clear()
    launcherMock.opens = []
    desktopMock.opens = []
    desktopMock.refusal = null
    owner = new FakeSender()
    other = new FakeSender()
    hits = new Map()
    detected = []
    markedOpen = []
    attachSession = 'session-1'
    attachOwner = owner
    workspace = await root('jamat-menu-workspace-')
    elsewhere = await root('jamat-menu-elsewhere-')
    const detector = {
      detect: (sessionId: string, capture: unknown) => {
        detected.push({ sessionId, capture })
        // A fresh id per detect, the way the real one mints them. While every answer carried the
        // same id the owner map never held more than one entry, so the eviction below it could not
        // run at all - the fixture made the branch unreachable rather than the code being safe.
        const requestId = detected.length === 1 ? requestIdConst : `request-${detected.length}`
        return Promise.resolve({ requestId, detections: [] })
      },
      pathOf: (requestId: string, detectionId: string) =>
        requestId.startsWith('request') ? hits.get(detectionId) ?? null : null,
      markOpened: (path: string, kind: string) => markedOpen.push({ path, kind }),
    } as unknown as TerminalDetector
    const sessions = {
      workingContext: (sessionId: string) => Promise.resolve(sessionId === 'session-gone'
        ? { ok: false as const, code: 'unknown-session', detail: 'no such session' }
        : { ok: true as const, value: { sessionId, cwd: workspace, agent: null, worktree: null } }),
    } as unknown as SessionManager
    const terminals = {
      ownsAttach: (sender: WebContents, attachId: string) =>
        attachId === 'a1' && sender === attachOwner.asSender(),
      sessionOfAttach: (attachId: string) => attachId === 'a1' ? attachSession : null,
    } as unknown as ServiceTerminalIpc
    new ServiceTerminalMenuIpc(
      detector,
      new FileViewer(),
      sessions,
      terminals,
      (sender) => sender === owner.asSender() ? 'window-1' : null,
    ).initialize()
  })

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  async function invoke(
    channel: keyof AppClientUiIpcInvokeMap,
    sender: FakeSender,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = electronMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler({ sender: sender.asSender() } as IpcMainInvokeEvent, ...args)
  }

  async function detect(sender: FakeSender): Promise<unknown> {
    return invoke('terminal:menu-detect', sender, 'a1', {
      token: 'notes.md',
      selection: null,
      contextText: 'notes.md',
      fallbackToken: null,
    })
  }

  it('registers a handler for every channel it declares', () => {
    expect([...electronMock.handlers.keys()].sort())
      .toEqual(Object.keys(ServiceTerminalMenuIpc.channelsConst).sort())
  })

  it('detects for the renderer that owns the attach and derives the session itself', async () => {
    expect(await detect(owner))
      .toEqual({ ok: true, value: { requestId: requestIdConst, detections: [] } })
    expect(detected).toEqual([{
      sessionId: 'session-1',
      capture: {
        token: 'notes.md',
        selection: null,
        contextText: 'notes.md',
        fallbackToken: null,
      },
    }])
  })

  it('refuses to detect for a renderer that does not own the attach', async () => {
    expect(await detect(other)).toEqual({
      ok: false,
      error: 'Terminal attach is not owned by this renderer: a1',
    })
    expect(detected).toEqual([])
  })

  it('refuses to detect for an attach that no longer names a session', async () => {
    attachSession = null

    expect(await detect(owner)).toEqual({
      ok: false,
      error: 'Terminal attach has no session: a1',
    })
  })

  it('refuses every action naming a request another renderer opened', async () => {
    attachOwner = other
    await detect(other)
    const refusal = { ok: false, error: `Terminal detection is not owned by this renderer: ${requestIdConst}` }

    expect(await invoke('terminal:menu-open-file', owner, requestIdConst, 'd1')).toEqual(refusal)
    expect(await invoke('terminal:menu-open-directory', owner, requestIdConst, 'd1')).toEqual(refusal)
    expect(await invoke('terminal:menu-open-vscode', owner, requestIdConst, 'd1')).toEqual(refusal)
    expect(markedOpen).toEqual([])
    expect(launcherMock.opens).toEqual([])
  })

  it('refuses a detection id the store no longer knows', async () => {
    await detect(owner)

    expect(await invoke('terminal:menu-open-file', owner, requestIdConst, 'gone')).toEqual({
      ok: true,
      value: {
        ok: false,
        code: 'proof-expired',
        detail: 'The terminal detection behind this file is gone; open it from the terminal again',
      },
    })
    expect(await invoke('terminal:menu-open-directory', owner, requestIdConst, 'gone')).toEqual({
      ok: true,
      value: {
        ok: false,
        code: 'expired',
        detail: 'The terminal detection behind this directory is gone; open it from the terminal again',
      },
    })
    expect(await invoke('terminal:menu-open-vscode', owner, requestIdConst, 'gone'))
      .toEqual({ ok: true, value: false })
    expect(markedOpen).toEqual([])
  })

  it('opens a file inside the session cwd as a workspace document and records the open', async () => {
    const path = join(workspace, 'notes.md')
    await writeFile(path, '# Notes\n')
    hits.set('d1', { sessionId: 'session-1', path, kind: 'file', line: 12, opensExternally: false })
    await detect(owner)

    const answer = await invoke('terminal:menu-open-file', owner, requestIdConst, 'd1') as {
      ok: true
      value: { ok: true; value: { source: unknown } }
    }

    expect(answer.value.value.source)
      .toEqual({ kind: 'workspace', sessionId: 'session-1', path })
    expect(markedOpen).toEqual([{ path, kind: 'file' }])
  })

  // The reach the user asked for: a session whose working context is gone still opens its file, and
  // it is the register that carries the panel across a remount afterwards. Which source the cascade
  // picks for a LIVE cwd is the file viewer's own test.
  it('opens a file whose session has no working context as a detected document', async () => {
    const path = join(elsewhere, 'report.md')
    await writeFile(path, '# Report\n')
    hits.set('d1', { sessionId: 'session-gone', path, kind: 'file', line: null, opensExternally: false })
    await detect(owner)

    const answer = await invoke('terminal:menu-open-file', owner, requestIdConst, 'd1') as {
      ok: true
      value: { ok: true; value: { source: unknown } }
    }

    expect(answer.value.value.source)
      .toEqual({ kind: 'detected', sessionId: 'session-gone', path })
    expect(markedOpen).toEqual([{ path, kind: 'file' }])
  })

  it('refuses to open a directory detection as a file', async () => {
    hits.set('d1', { sessionId: 'session-1', path: workspace, kind: 'directory', line: null, opensExternally: false })
    await detect(owner)

    expect(await invoke('terminal:menu-open-file', owner, requestIdConst, 'd1')).toEqual({
      ok: true,
      value: { ok: false, code: 'not-file', detail: 'The detection is a directory' },
    })
  })

  it('answers a directory with the panel identity the file viewer derives', async () => {
    const path = join(workspace, 'src')
    await mkdir(path)
    hits.set('d1', { sessionId: 'session-1', path, kind: 'directory', line: null, opensExternally: false })
    await detect(owner)

    expect(await invoke('terminal:menu-open-directory', owner, requestIdConst, 'd1')).toEqual({
      ok: true,
      value: {
        ok: true,
        value: {
          sessionId: 'session-1',
          path,
          directoryKey: FileViewer.panelKeyOf('session-1', path),
        },
      },
    })
    expect(markedOpen).toEqual([{ path, kind: 'directory' }])
  })

  // What goes into the register is what `directory-at` proves a later remount against, and that
  // proof is taken on the real path: a link recorded as itself would refuse its own panel.
  it('registers a linked directory under the path it really resolves to', async () => {
    const link = join(workspace, 'logs')
    await symlink(elsewhere, link, process.platform === 'win32' ? 'junction' : 'dir')
    hits.set('d1', { sessionId: 'session-1', path: link, kind: 'directory', line: null, opensExternally: false })
    await detect(owner)

    expect(await invoke('terminal:menu-open-directory', owner, requestIdConst, 'd1')).toEqual({
      ok: true,
      value: {
        ok: true,
        value: {
          sessionId: 'session-1',
          path: elsewhere,
          directoryKey: FileViewer.panelKeyOf('session-1', elsewhere),
        },
      },
    })
    expect(markedOpen).toEqual([{ path: elsewhere, kind: 'directory' }])
  })

  it('registers nothing for a detected directory that is already gone', async () => {
    hits.set('d1', { sessionId: 'session-1', path: join(workspace, 'gone'), kind: 'directory', line: null, opensExternally: false })
    await detect(owner)

    expect(await invoke('terminal:menu-open-directory', owner, requestIdConst, 'd1')).toEqual({
      ok: true,
      value: {
        ok: false,
        code: 'not-directory',
        detail: 'The detected directory no longer exists',
      },
    })
    expect(markedOpen).toEqual([])
  })

  it('refuses to open a file detection as a directory', async () => {
    hits.set('d1', { sessionId: 'session-1', path: join(workspace, 'notes.md'), kind: 'file', line: null, opensExternally: false })
    await detect(owner)

    expect(await invoke('terminal:menu-open-directory', owner, requestIdConst, 'd1')).toEqual({
      ok: true,
      value: { ok: false, code: 'not-directory', detail: 'The detection is a file' },
    })
  })

  it('launches VS Code on a file with its line, on a directory without one, and never on a URL', async () => {
    hits.set('file', { sessionId: 'session-1', path: join(workspace, 'a.ts'), kind: 'file', line: 12, opensExternally: false })
    hits.set('directory', { sessionId: 'session-1', path: workspace, kind: 'directory', line: null, opensExternally: false })
    hits.set('url', { sessionId: 'session-1', path: 'https://example.test/a', kind: 'url', line: null, opensExternally: false })
    await detect(owner)

    expect(await invoke('terminal:menu-open-vscode', owner, requestIdConst, 'file'))
      .toEqual({ ok: true, value: true })
    expect(await invoke('terminal:menu-open-vscode', owner, requestIdConst, 'directory'))
      .toEqual({ ok: true, value: true })
    expect(await invoke('terminal:menu-open-vscode', owner, requestIdConst, 'url'))
      .toEqual({ ok: true, value: false })
    expect(launcherMock.opens).toEqual([
      { path: join(workspace, 'a.ts'), line: 12 },
      { path: workspace, line: null },
    ])
  })

  /**
   * The desktop runs whatever it is handed, so this channel opens only what the detector itself
   * called an outside file - and that is the same answer the row the person clicked was drawn from.
   */
  it('hands a pdf to the desktop and refuses every other detection', async () => {
    hits.set('pdf', { sessionId: 'session-1', path: join(workspace, 'report.pdf'), kind: 'file', line: null, opensExternally: true })
    hits.set('code', { sessionId: 'session-1', path: join(workspace, 'a.ts'), kind: 'file', line: 12, opensExternally: false })
    await detect(owner)

    expect(await invoke('terminal:menu-open-external', owner, requestIdConst, 'pdf'))
      .toEqual({ ok: true, value: { ok: true } })
    expect(await invoke('terminal:menu-open-external', owner, requestIdConst, 'code')).toEqual({
      ok: true,
      value: { ok: false, code: 'not-external', detail: 'The detection is not opened outside' },
    })
    expect(desktopMock.opens).toEqual([join(workspace, 'report.pdf')])
  })

  /** A machine with no reader for the type refuses, and a row that did nothing would look dead. */
  it('passes on what the desktop said when it refused the file', async () => {
    desktopMock.refusal = 'No application is associated with this file'
    hits.set('pdf', { sessionId: 'session-1', path: join(workspace, 'report.pdf'), kind: 'file', line: null, opensExternally: true })
    await detect(owner)

    expect(await invoke('terminal:menu-open-external', owner, requestIdConst, 'pdf')).toEqual({
      ok: true,
      value: { ok: false, code: 'failed', detail: 'No application is associated with this file' },
    })
  })

  it('answers a forgotten detection with the expiry sentence rather than opening anything', async () => {
    await detect(owner)

    expect(await invoke('terminal:menu-open-external', owner, requestIdConst, 'gone')).toEqual({
      ok: true,
      value: {
        ok: false,
        code: 'expired',
        detail: 'The terminal detection behind this file is gone; open it from the terminal again',
      },
    })
    expect(desktopMock.opens).toEqual([])
  })

  // The project path is the session's own, so the renderer naming a different one changes nothing.
  it('opens the project of a session at the cwd its working context reports', async () => {
    expect(await invoke('terminal:menu-open-project-vscode', owner, 'session-1'))
      .toEqual({ ok: true, value: true })
    expect(launcherMock.opens).toEqual([{ path: workspace, line: null }])

    expect(await invoke('terminal:menu-open-project-vscode', owner, 'session-gone'))
      .toEqual({ ok: true, value: false })
    expect(launcherMock.opens).toHaveLength(1)
  })

  it('refuses a project launch from an unknown workspace', async () => {
    expect(await invoke('terminal:menu-open-project-vscode', other, 'session-1')).toEqual({
      ok: false,
      error: 'Terminal menu request came from an unknown workspace',
    })
    expect(launcherMock.opens).toEqual([])
  })

  // A forgotten request is a WebContents this map would hold for the life of the process.
  it('forgets the requests of a renderer that goes, and wires each way out once', async () => {
    await detect(owner)
    await detect(owner)
    expect(owner.countOf('destroyed')).toBe(1)
    expect(owner.countOf('did-start-navigation')).toBe(1)

    owner.fire('destroyed')

    // Forgotten, not somebody else's: the same window asking again gets the expiry refusal, and the
    // thrown channel stays for the case it names - a request another renderer opened.
    expect(await invoke('terminal:menu-open-file', owner, requestIdConst, 'd1')).toEqual({
      ok: true,
      value: {
        ok: false,
        code: 'proof-expired',
        detail: 'The terminal detection behind this file is gone; open it from the terminal again',
      },
    })
  })

  /**
   * The ring that keeps one window's request map from growing forever. Past its ceiling the oldest
   * owner is dropped, and an id that outlived its owner entry has to read as expired: `provenHit`
   * throws for a request owned by somebody else, and that wording is for a renderer out of contract,
   * not for a person who right-clicked seventeen times.
   */
  it('answers an evicted request with a refusal, not a thrown channel', async () => {
    await detect(owner)
    for (let index = 0; index < TerminalDetectorLimits.requestsMax; index++)
      await detect(owner)

    const answer = await invoke('terminal:menu-open-file', owner, requestIdConst, 'd1')

    expect(answer).toEqual({
      ok: true,
      value: {
        ok: false,
        code: 'proof-expired',
        detail: 'The terminal detection behind this file is gone; open it from the terminal again',
      },
    })
  })

  /**
   * The detect is the slow tier and the window can go while it is out. Claiming afterwards stored a
   * WebContents whose `destroyed` had already fired, so nothing would ever release it: the leak the
   * two listeners exist to prevent, arriving through the one path that runs after them.
   */
  it('claims nothing for a window that went away while the detection was out', async () => {
    owner.destroy()

    await detect(owner)

    expect(owner.countOf('destroyed')).toBe(0)
    expect(owner.countOf('did-start-navigation')).toBe(0)
  })

  /**
   * `did-start-navigation` fires for a subframe and for a same-document navigation too, not only for
   * the reload this listener is written for. The window bookkeeping beside this service already
   * filters on `isMainFrame`; dropping every request of a window on a fragment change would answer a
   * later action with a thrown channel rather than an expired one.
   */
  it('keeps its requests through a navigation that is not the main frame', async () => {
    await detect(owner)

    owner.fire('did-start-navigation', {}, 'about:blank#x', true, false)

    expect(await invoke('terminal:menu-open-file', owner, requestIdConst, 'd1'))
      .toMatchObject({ ok: true })

    owner.fire('did-start-navigation', {}, 'about:blank', false, true)

    expect(await invoke('terminal:menu-open-file', owner, requestIdConst, 'd1')).toEqual({
      ok: true,
      value: {
        ok: false,
        code: 'proof-expired',
        detail: 'The terminal detection behind this file is gone; open it from the terminal again',
      },
    })
  })
})
