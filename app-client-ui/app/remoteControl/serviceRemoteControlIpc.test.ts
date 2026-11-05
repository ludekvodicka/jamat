import { bindService } from '../shared/serviceIpcTestHarness'
import type { WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceRemoteControlIpc, type ServiceRemoteControlIpcDeps } from './serviceRemoteControlIpc'

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>() }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => ipc.handlers.set(channel, handler) } }))

describe('ServiceRemoteControlIpc native ownership', () => {
  const view = { viewId: 'view', epoch: 'peer-epoch', sessionId: 'session', viewerId: 'viewer' }
  let lifetime: AbortController
  let deps: ServiceRemoteControlIpcDeps
  const sender = { isDestroyed: () => false } as WebContents
  const invoke = (channel: string, ...args: unknown[]) => ipc.handlers.get(channel)!({ sender }, ...args)
  beforeEach(() => {
    ipc.handlers.clear()
    lifetime = new AbortController()
    deps = { authorizeView: vi.fn(async () => ({ view, signal: lifetime.signal })), acceptsRenderer: vi.fn(() => true),
      startImageDrag: vi.fn(async () => true), exportFile: vi.fn(async () => true),
      mediaResource: vi.fn(async () => ({ ok: false as const, code: 'not-found' as const, detail: 'missing' })) }
    bindService(new ServiceRemoteControlIpc(deps)).initialize()
  })

  it('registers exactly the three native channels and passes the authorized epoch lifetime', async () => {
    expect([...ipc.handlers.keys()].sort()).toEqual(Object.keys(ServiceRemoteControlIpc.channelsConst).sort())
    expect([...ipc.handlers.keys()].sort()).toEqual(['remote:export-file', 'remote:media-resource', 'remote:start-image-drag'])
    expect(await invoke('remote:start-image-drag', 'endpoint', 'view', 'document')).toEqual({ ok: true, value: true })
    expect(await invoke('remote:export-file', 'endpoint', 'view', 'document', 'name')).toEqual({ ok: true, value: true })
    await invoke('remote:media-resource', 'endpoint', 'view', 'document', 'relative')
    expect(deps.authorizeView).toHaveBeenCalledTimes(3)
    expect(deps.authorizeView).toHaveBeenCalledWith(sender, 'endpoint', 'view')
    expect(deps.startImageDrag).toHaveBeenCalledWith(sender, 'endpoint', view, 'document', lifetime.signal)
    expect(deps.exportFile).toHaveBeenCalledWith(sender, 'endpoint', view, 'document', 'name', lifetime.signal)
    expect(deps.mediaResource).toHaveBeenCalledWith('endpoint', view, 'document', 'relative', lifetime.signal)
  })

  it('rejects a lost view and a closing renderer before any native action', async () => {
    vi.mocked(deps.authorizeView).mockResolvedValue(null)
    expect(await invoke('remote:start-image-drag', 'endpoint', 'view', 'document')).toMatchObject({ ok: false, error: expect.stringContaining('not owned') })
    vi.mocked(deps.acceptsRenderer).mockReturnValue(false)
    expect(await invoke('remote:export-file', 'endpoint', 'view', 'document', 'name')).toMatchObject({ ok: false, error: expect.stringContaining('closing') })
    expect(deps.authorizeView).toHaveBeenCalledTimes(1)
    expect(deps.startImageDrag).not.toHaveBeenCalled()
    expect(deps.exportFile).not.toHaveBeenCalled()
  })

  it('rejects authorization completed after navigation even when the same WebContents accepts new work', async () => {
    let resolve!: (value: { view: typeof view; signal: AbortSignal }) => void
    vi.mocked(deps.authorizeView).mockReturnValue(new Promise(done => { resolve = done }))
    const pending = invoke('remote:media-resource', 'endpoint', 'view', 'document', null)
    lifetime.abort(new Error('Navigated'))
    resolve({ view, signal: lifetime.signal })
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('not owned') })
    expect(deps.mediaResource).not.toHaveBeenCalled()
  })
})
