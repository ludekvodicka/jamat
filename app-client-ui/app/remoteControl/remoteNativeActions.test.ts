import { EventEmitter } from 'node:events'
import type { NativeImage, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { FileViewerResourceResult } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import { RemoteFileMediaSource } from '../fileViewer/remoteFileMediaSource'
import { WindowPorts } from '../processes/windowPorts'
import type { RemoteContentClient } from './remoteContentClient'
import { RemoteNativeActions } from './remoteNativeActions'

vi.mock('electron', () => ({ MessageChannelMain: class { port1 = { close: vi.fn() }; port2 = { close: vi.fn() } } }))

const resource = { resourceId: 'source', mimeType: 'image/png', size: 4, contentVersion: 'v1' }
const view = { viewId: 'view', epoch: 'peer-epoch', sessionId: 'session', viewerId: 'viewer' }
const icon = { isEmpty: () => false } as NativeImage
class Contents extends EventEmitter {
  id = 7
  postMessage = vi.fn()
  startDrag = vi.fn()
  isDestroyed(): boolean { return false }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture() {
  const contents = new Contents(), sender = contents as unknown as WebContents
  const broker = new WindowPorts({ open: vi.fn(), close: vi.fn(), setAccepting: vi.fn(), acceptsRenderer: () => true, authorize: async () => null, report: vi.fn() })
  broker.watch(sender); contents.emit('did-finish-load')
  const signal = broker.signal(broker.identity(sender)!)!
  const answer = vi.fn(async (..._args: Parameters<RemoteContentClient['read']>): Promise<unknown> => ({ ok: true, value: resource }))
  const content: Pick<RemoteContentClient, 'read'> = { read: async <T>(...args: Parameters<RemoteContentClient['read']>) => await answer(...args) as T }
  const media = new RemoteFileMediaSource(content, () => true)
  const issue = vi.spyOn(media, 'issue'), release = vi.spyOn(media, 'releaseToken')
  vi.spyOn(media, 'metadata').mockResolvedValue({ kind: 'ready', mimeType: resource.mimeType, size: 4, version: 'v1' })
  const copy = vi.fn(async () => 'temporary.png'), getIcon = vi.fn(async () => icon)
  const selectFile = vi.fn(async () => ({ canceled: false, filePath: 'chosen.png' })), save = vi.fn(async () => {})
  const actions = new RemoteNativeActions({ content, media, drag: { copy }, icon: getIcon, selectFile, save, accepts: () => true })
  const navigate = () => { contents.emit('did-start-navigation', {}, '', false, true); contents.emit('did-finish-load') }
  return { contents, sender, broker, signal, answer, media, issue, release, copy, getIcon, selectFile, save, actions, navigate }
}

describe('RemoteNativeActions current window epoch', () => {
  for (const action of ['media', 'relative', 'drag', 'export'] as const)
    it(`does not issue a resource after delayed ${action} content crosses navigation`, async () => {
      const f = fixture(), pending = deferred<FileViewerResourceResult>()
      f.answer.mockReturnValue(pending.promise)
      let result: Promise<unknown>
      switch (action) {
        case 'media': result = f.actions.mediaResource('endpoint', view, 'document', null, f.signal); break
        case 'relative': result = f.actions.mediaResource('endpoint', view, 'document', 'image.png', f.signal); break
        case 'drag': result = f.actions.startImageDrag(f.sender, 'endpoint', view, 'document', f.signal); break
        case 'export': result = f.actions.exportFile(f.sender, 'endpoint', view, 'document', 'name', f.signal); break
        default: throw new Error('Unknown action')
      }
      const rejected = expect(result).rejects.toThrow()
      f.navigate(); pending.resolve({ ok: true, value: resource })
      await rejected
      expect(f.signal.aborted).toBe(true)
      expect(f.broker.signal(f.broker.identity(f.sender)!)!.aborted).toBe(false)
      expect(f.issue).not.toHaveBeenCalled()
      expect(f.contents.startDrag).not.toHaveBeenCalled()
      expect(f.selectFile).not.toHaveBeenCalled()
      expect(f.save).not.toHaveBeenCalled()
      f.broker.stop()
    })

  for (const boundary of ['copy', 'icon', 'metadata'] as const)
    it(`releases the token and prevents drag after navigation during ${boundary}`, async () => {
      const f = fixture(), pending = deferred<unknown>(), entered = deferred<void>()
      const wait = async () => { entered.resolve(); return pending.promise }
      if (boundary === 'copy') f.copy.mockImplementation(async () => await wait() as string)
      else if (boundary === 'icon') f.getIcon.mockImplementation(async () => await wait() as NativeImage)
      else if (boundary === 'metadata') vi.mocked(f.media.metadata).mockImplementation(async () => await wait() as Awaited<ReturnType<RemoteFileMediaSource['metadata']>>)
      else throw new Error('Unknown boundary')
      const result = f.actions.startImageDrag(f.sender, 'endpoint', view, 'document', f.signal)
      const rejected = expect(result).rejects.toThrow()
      await entered.promise
      const token = f.issue.mock.results[0]!.value.resourceId
      expect(f.media.owns(token)).toBe(true)
      f.navigate()
      expect(f.media.owns(token)).toBe(false)
      pending.resolve(boundary === 'copy' ? 'temporary.png' : boundary === 'icon' ? icon : { kind: 'ready' })
      await rejected
      expect(f.contents.startDrag).not.toHaveBeenCalled()
      expect(f.release).toHaveBeenCalledWith(token)
      f.broker.stop()
    })

  it('does not save after a pending native dialog returns to a new window epoch', async () => {
    const f = fixture(), pending = deferred<{ canceled: boolean; filePath: string }>(), entered = deferred<void>()
    f.selectFile.mockImplementation(() => { entered.resolve(); return pending.promise })
    const result = f.actions.exportFile(f.sender, 'endpoint', view, 'document', 'a/b.png', f.signal)
    const rejected = expect(result).rejects.toThrow()
    await entered.promise
    expect(f.selectFile).toHaveBeenCalledWith('a_b.png')
    const token = f.issue.mock.results[0]!.value.resourceId
    f.navigate(); pending.resolve({ canceled: false, filePath: 'chosen.png' })
    await rejected
    expect(f.save).not.toHaveBeenCalled()
    expect(f.media.owns(token)).toBe(false)
    f.broker.stop()
  })

  it('performs authorized drag and export and keeps issued media available', async () => {
    const f = fixture()
    expect(await f.actions.startImageDrag(f.sender, 'endpoint', view, 'document', f.signal)).toBe(true)
    expect(f.contents.startDrag).toHaveBeenCalledWith({ file: 'temporary.png', icon })
    expect(await f.actions.exportFile(f.sender, 'endpoint', view, 'document', 'name', f.signal)).toBe(true)
    expect(f.save).toHaveBeenCalledWith(f.issue.mock.results[1]!.value.resourceId, 'chosen.png', f.signal)
    expect(f.media.owns(f.issue.mock.results[0]!.value.resourceId)).toBe(false)
    expect(f.media.owns(f.issue.mock.results[1]!.value.resourceId)).toBe(false)
    const result = await f.actions.mediaResource('endpoint', view, 'document', null, f.signal)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.detail)
    expect(f.media.owns(result.value.resourceId)).toBe(true)
    f.media.releaseToken(result.value.resourceId); f.broker.stop()
  })
})
