import { ServiceFileViewerShellIpc } from '../shell/serviceFileViewerShellIpc'
import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import { FileViewerAccess } from '../../../app-orchestrator/app/fileViewer/fileViewerAccess'
import { ServiceFileViewerIpc } from '../../../app-orchestrator/app/fileViewer/serviceFileViewerIpc'
import { ServiceVersioningCommitIpc } from '../../../app-orchestrator/app/versioning/serviceVersioningCommitIpc'
import type { VersioningCommitManager } from '../../../app-orchestrator/app/versioning/versioningCommitManager'
import { IpcServiceTransport } from './ipcServiceTransport'
import type { ServiceCaller } from './serviceTransport.types'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
  icon: vi.fn(),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>) => mocks.handlers.set(channel, handler) },
  app: { getFileIcon: mocks.icon }, clipboard: {}, shell: {},
}))

class Renderer extends EventEmitter {
  mainFrame: object
  destroyed: boolean
  readonly sent: unknown[][]
  readonly startDrag: ReturnType<typeof vi.fn>
  constructor() {
    super()
    this.mainFrame = {}
    this.destroyed = false
    this.sent = []
    this.startDrag = vi.fn()
  }
  isDestroyed(): boolean { return this.destroyed }
  send(...args: unknown[]): void { this.sent.push(args) }
  contents(): WebContents { return this as unknown as WebContents }
  event(): IpcMainInvokeEvent { return { sender: this.contents(), senderFrame: this.mainFrame } as IpcMainInvokeEvent }
  navigate(): void {
    this.emit('did-start-navigation', {}, 'file:///app', false, true)
    this.mainFrame = {}
    this.emit('did-frame-navigate', {}, 'file:///app', 200, 'OK', true)
    this.emit('did-finish-load')
  }
}

const roots: string[] = []
beforeEach(() => { mocks.handlers.clear(); mocks.icon.mockReset() })
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const invoke = (channel: string, renderer: Renderer, ...args: unknown[]) => mocks.handlers.get(channel)!(renderer.event(), ...args)

describe('IpcServiceTransport', () => {
  it('derives both roles from trusted registration and refuses unknown renderers and subframes', async () => {
    const transport = new IpcServiceTransport()
    const received: ServiceCaller[] = []
    transport.handle('clipboard:write-text', caller => { received.push(caller) })
    for (const role of ['main', 'workspace'] as const) {
      const renderer = new Renderer()
      transport.watch(renderer.contents(), { windowId: role, role })
      expect(await invoke('clipboard:write-text', renderer, 'text')).toEqual({ ok: true, value: undefined })
      expect(received.at(-1)).toMatchObject({ windowId: role, role })
      expect(await mocks.handlers.get('clipboard:write-text')!({ ...renderer.event(), senderFrame: {} } as IpcMainInvokeEvent, 'text'))
        .toEqual({ ok: false, error: 'Service requests require the main renderer frame' })
    }
    expect(await invoke('clipboard:write-text', new Renderer(), 'text')).toEqual({ ok: false, error: 'Unknown or departed renderer' })
    expect(received).toHaveLength(2)
  })

  it('publishes only to the selected lifetime and orders reload departure before the new load', async () => {
    const transport = new IpcServiceTransport()
    const one = new Renderer(), two = new Renderer()
    transport.watch(one.contents(), { windowId: 'one', role: 'workspace' })
    transport.watch(two.contents(), { windowId: 'two', role: 'workspace' })
    let caller!: ServiceCaller
    transport.handle('clipboard:write-text', value => { caller = value })
    await invoke('clipboard:write-text', one, '')
    const old = caller
    const events: string[] = []
    const stopGone = transport.onCaller('gone', (value, reason) => events.push(`gone:${value.id}:${reason}`))
    transport.onCaller('loaded', value => events.push(`loaded:${value.id}`))
    transport.publish('app:error', caller, 'only one')
    expect(one.sent).toEqual([['app:error', 'only one']])
    expect(two.sent).toEqual([])
    one.emit('did-start-navigation', {}, '#hash', true, true)
    one.emit('did-start-navigation', {}, 'file:///child', false, false)
    expect(transport.isCurrent(old)).toBe(true)
    one.navigate()
    await invoke('clipboard:write-text', one, '')
    expect(events).toEqual([`gone:${old.id}:reload`, `loaded:${caller.id}`])
    expect(caller.id).not.toBe(old.id)
    transport.publish('app:error', old, 'stale')
    transport.publish('app:error', { ...caller, windowId: 'two' }, 'forged')
    expect(one.sent).toHaveLength(1)
    transport.publish('app:error', 'all', 'both')
    expect(one.sent.at(-1)).toEqual(['app:error', 'both'])
    expect(two.sent).toEqual([['app:error', 'both']])
    one.destroyed = true
    one.emit('destroyed')
    expect(transport.isCurrent(caller)).toBe(false)
    expect(events.at(-1)).toBe(`gone:${caller.id}:closed`)
    stopGone()
    two.emit('destroyed')
    expect(events).toHaveLength(3)
  })

  async function viewerFixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'jamat-service-transport-')))
    roots.push(root)
    await writeFile(join(root, 'file.txt'), 'owned text')
    const viewer = new FileViewer()
    const context = { ok: true as const, value: { sessionId: 'session', cwd: root, agent: null, worktree: null } }
    const workingContext = vi.fn(async () => context)
    const access = new FileViewerAccess({ viewer, sessions: { workingContext, scriptLogOf: vi.fn() },
      restoreExternal: vi.fn(), restoreDetected: vi.fn(), allowsDetected: () => false, restoreWorkingTree: vi.fn() })
    const transport = new IpcServiceTransport()
    const one = new Renderer(), two = new Renderer()
    transport.watch(one.contents(), { windowId: 'one', role: 'workspace' })
    transport.watch(two.contents(), { windowId: 'two', role: 'workspace' })
    const service = new ServiceFileViewerIpc(viewer, access, caller => transport.isCurrent(caller) ? caller.windowId : null)
    service.setTransport(transport).initialize()
    new ServiceFileViewerShellIpc({ path: async (...args) => viewer.path(...args), imageDragPath: (...args) => viewer.imageDragPath(...args) }, sender => sender === one.contents() ? 'one' : sender === two.contents() ? 'two' : null)
      .setTransport(transport).setCallerAccess(transport).initialize()
    return { root, viewer, one, two, workingContext, context }
  }

  it('refuses a grant from another window and revokes it on reload and close', async () => {
    const { viewer, one, two } = await viewerFixture()
    const opened = await invoke('fileViewer:open-workspace', one, 'session', 'file.txt', false) as { value: { value: { documentId: string } } }
    const id = opened.value.value.documentId
    expect(await invoke('fileViewer:text', two, id)).toMatchObject({ ok: true, value: { ok: false, code: 'wrong-owner' } })
    one.navigate()
    expect(await viewer.text('one', id)).toMatchObject({ ok: false, code: 'document-expired' })
    const reopened = await invoke('fileViewer:open-workspace', one, 'session', 'file.txt', false) as typeof opened
    one.destroyed = true
    one.emit('destroyed')
    expect(await viewer.text('one', reopened.value.value.documentId)).toMatchObject({ ok: false, code: 'document-expired' })
  })

  it('discards a late grant without revoking a replacement renderer grant', async () => {
    const { viewer, one, workingContext, context } = await viewerFixture()
    let resolve!: (value: typeof context) => void
    workingContext.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const releases = vi.spyOn(viewer, 'releaseGrant')
    const pending = invoke('fileViewer:open-workspace', one, 'session', 'file.txt', false)
    one.navigate()
    const current = await invoke('fileViewer:open-workspace', one, 'session', 'file.txt', false) as { value: { value: { documentId: string } } }
    resolve(context)
    expect(await pending).toEqual({ ok: false, error: 'The renderer is no longer available' })
    expect(releases).toHaveBeenCalledTimes(1)
    expect(await viewer.text('one', releases.mock.calls[0][1])).toMatchObject({ ok: false, code: 'document-expired' })
    expect(await viewer.text('one', current.value.value.documentId)).toMatchObject({ ok: true, text: 'owned text' })
  })

  it('never starts native dragging after reload during icon retrieval', async () => {
    const { viewer, one } = await viewerFixture()
    vi.spyOn(viewer, 'imageDragPath').mockResolvedValue('C:/fixture/image.png')
    mocks.icon.mockImplementation(async () => { one.navigate(); return { isEmpty: () => false } })
    expect(await invoke('fileViewer:start-image-drag', one, 'image')).toEqual({ ok: true, value: false })
    expect(one.startDrag).not.toHaveBeenCalled()
  })

  it('releases a preparation completed after reload and retains already attached drafts until close', async () => {
    const transport = new IpcServiceTransport()
    const renderer = new Renderer()
    transport.watch(renderer.contents(), { windowId: 'workspace', role: 'workspace' })
    let finish!: (value: unknown) => void
    const prepare = vi.fn().mockResolvedValueOnce({ ok: true, value: { draftId: 'attached' } })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const manager = { prepare, attach: vi.fn(), releaseUnattached: vi.fn(), revokeOwner: vi.fn() } as unknown as VersioningCommitManager
    new ServiceVersioningCommitIpc(manager, caller => caller.windowId, { workingTree: vi.fn() }, vi.fn())
      .setTransport(transport).initialize()
    await invoke('versioning:commit-open-draft', renderer, 'session', 'svn')
    const pending = invoke('versioning:commit-open-draft', renderer, 'session', 'svn')
    renderer.navigate()
    expect(manager.revokeOwner).not.toHaveBeenCalled()
    finish({ ok: true, value: { draftId: 'late' } })
    await pending
    expect(manager.attach).toHaveBeenCalledExactlyOnceWith('attached', 'workspace')
    expect(manager.releaseUnattached).toHaveBeenCalledExactlyOnceWith('late')
    renderer.destroyed = true
    renderer.emit('destroyed')
    expect(manager.revokeOwner).toHaveBeenCalledExactlyOnceWith('workspace')
  })
})
