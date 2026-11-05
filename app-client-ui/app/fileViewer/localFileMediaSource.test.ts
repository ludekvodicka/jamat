import { describe, expect, it, vi } from 'vitest'
import type { OrchestratorApi } from '../shared/orchestratorApi.types'
import { LocalFileMediaSource } from './localFileMediaSource'

function fixture() {
  const api: Pick<OrchestratorApi, 'mediaMetadata' | 'mediaOpen' | 'mediaCancel'> = {
    mediaMetadata: vi.fn<OrchestratorApi['mediaMetadata']>(async () => ({ kind: 'ready', mimeType: 'video/mp4', size: 10, version: 'v1' })),
    mediaOpen: vi.fn<OrchestratorApi['mediaOpen']>(async request => ({ ok: true, value: { bytes: new Uint8Array([1, 2]), offset: request.offset,
      length: 2, totalSize: 10, contentVersion: request.version, eof: false } })),
    mediaCancel: vi.fn(),
  }
  return { api, source: new LocalFileMediaSource(api) }
}

describe('LocalFileMediaSource', () => {
  it('does not dispatch a read whose request is already aborted', async () => {
    const { api, source } = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(source.read('resource', 'v1', 0, 2, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(api.mediaOpen).not.toHaveBeenCalled()
    expect(api.mediaCancel).not.toHaveBeenCalled()
  })

  it('sends only cloneable request data and removes its listener after a successful read', async () => {
    const { api, source } = fixture()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    expect(await source.read('resource', 'v1', 2, 2, controller.signal)).toEqual(new Uint8Array([1, 2]))
    const request = vi.mocked(api.mediaOpen).mock.calls[0]![0]
    expect(structuredClone(request)).toEqual(request)
    expect(Object.keys(request).sort()).toEqual(['length', 'offset', 'requestId', 'resourceId', 'version'])
    expect(request).toMatchObject({ resourceId: 'resource', version: 'v1', offset: 2, length: 2 })
    expect(remove).toHaveBeenCalledTimes(1)
    controller.abort()
    expect(api.mediaCancel).not.toHaveBeenCalled()
  })

  it('cancels by request ID and discards a late reply', async () => {
    const { api, source } = fixture()
    let reply!: (value: Awaited<ReturnType<OrchestratorApi['mediaOpen']>>) => void
    vi.mocked(api.mediaOpen).mockImplementationOnce(() => new Promise(resolve => { reply = resolve }))
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = source.read('resource', 'v1', 0, 2, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const id = vi.mocked(api.mediaOpen).mock.calls[0]![0].requestId
    controller.abort()
    expect(api.mediaCancel).toHaveBeenCalledExactlyOnceWith(id)
    reply({ ok: true, value: { bytes: new Uint8Array([1, 2]), offset: 0, length: 2, totalSize: 10, contentVersion: 'v1', eof: false } })
    await rejected
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('preserves read errors and releases the cancellation listener on rejection', async () => {
    const { api, source } = fixture()
    vi.mocked(api.mediaOpen).mockResolvedValueOnce({ ok: false, code: 'document-expired', detail: 'Resource was released during its read' })
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    await expect(source.read('resource', 'v1', 0, 2, controller.signal)).rejects.toThrow('Resource was released during its read')
    expect(remove).toHaveBeenCalledTimes(1)
    controller.abort()
    expect(api.mediaCancel).not.toHaveBeenCalled()
  })
})
