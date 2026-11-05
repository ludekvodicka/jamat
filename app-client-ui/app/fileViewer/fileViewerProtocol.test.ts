import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  FileViewerGrantedFile,
} from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import {
  FileContentReader,
} from '../../../lib-orchestrator/fileViewer/content/fileContentReader'
import { FileViewerProtocol } from './fileViewerProtocol'
import { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import { FileViewerMediaView } from '../../../lib-orchestrator/fileViewer/fileViewerMediaView'
import { LocalFileMediaSource } from './localFileMediaSource'

const protocolMock = vi.hoisted(() => ({
  registrations: [] as unknown[],
  handler: null as ((request: Request) => Promise<Response>) | null,
}))

vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: (value: unknown) => protocolMock.registrations.push(value),
    handle: (_scheme: string, handler: (request: Request) => Promise<Response>) => {
      protocolMock.handler = handler
    },
  },
}))

describe('app-client-ui/app/fileViewer/fileViewerProtocol', () => {
  let directory: string
  let resource: FileViewerGrantedFile

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'jamat-v3-file-protocol-'))
    const path = join(directory, 'media.bin')
    await writeFile(path, 'abcdefghij')
    const info = await stat(path)
    resource = {
      path,
      mimeType: 'application/octet-stream',
      size: info.size,
      // Minted the way the reader mints it. Written by hand here and in the protocol, the two
      // spellings would drift the moment `versionOf` gained an inode or a hash, and every
      // `jamat-file://resource/...` would answer 409 for a file nobody touched.
      contentVersion: FileContentReader.versionOf(info.size, info.mtimeMs, info),
    }
    protocolMock.registrations = []
    protocolMock.handler = null
  })

  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  function initialize(): (request: Request) => Promise<Response> {
    new FileViewerProtocol({
      metadata: async (token) => {
        if (token !== 'token') return { kind: 'missing' }
        let info
        try { info = await stat(resource.path) } catch { return { kind: 'missing' } }
        if (!info.isFile() || FileContentReader.versionOf(info.size, info.mtimeMs, info) !== resource.contentVersion) return { kind: 'changed' }
        return { kind: 'ready', mimeType: resource.mimeType, size: resource.size, version: resource.contentVersion }
      },
      read: async (_token, version, offset, length, signal) => {
        const result = await new FileContentReader().range(resource.path, version, offset, length, signal)
        if (result.kind !== 'chunk') throw new Error(result.kind)
        return result.value.bytes
      },
    }).initialize()
    if (!protocolMock.handler) throw new Error('Protocol handler was not installed')
    return protocolMock.handler
  }

  it('registers a secure standard streaming scheme before Electron becomes ready', () => {
    FileViewerProtocol.registerScheme()
    expect(protocolMock.registrations).toEqual([[
      {
        scheme: 'jamat-v3-file',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          stream: true,
        },
      },
    ]])
  })

  it('streams only granted resources and supports a single byte range', async () => {
    const handle = initialize()
    const full = await handle(new Request('jamat-v3-file://resource/token'))
    expect(full.status).toBe(200)
    expect(full.headers.get('content-type')).toBe('application/octet-stream')
    expect(full.headers.get('content-length')).toBe('10')
    expect(full.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await full.text()).toBe('abcdefghij')
    const head = await handle(new Request('jamat-v3-file://resource/token', { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('10')
    expect(await head.text()).toBe('')
    const response = await handle(new Request('jamat-v3-file://resource/token', {
      headers: { Range: 'bytes=2-5' },
    }))
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await response.text()).toBe('cdef')
    expect((await handle(new Request('jamat-v3-file://resource/unknown'))).status).toBe(404)
  })

  it('refuses invalid ranges and resources changed after the token was issued', async () => {
    const handle = initialize()
    expect((await handle(new Request('jamat-v3-file://resource/token', {
      headers: { Range: 'bytes=30-40' },
    }))).status).toBe(416)
    expect((await handle(new Request('jamat-v3-file://resource/token', {
      headers: { Range: 'bytes=0-1,4-5' },
    }))).status).toBe(416)
    await writeFile(resource.path, 'changed')
    expect((await handle(new Request('jamat-v3-file://resource/token'))).status).toBe(409)
  })

  async function localProtocol() {
    await writeFile(resource.path, Buffer.alloc(65546, 65))
    const viewer = new FileViewer()
    const document = await viewer.openWorkspace('owner', 'session', directory, resource.path)
    if (!document.ok) throw new Error(document.detail)
    const granted = await viewer.exportResource('owner', document.value.documentId)
    if (!granted.ok) throw new Error(granted.detail)
    const media = new FileViewerMediaView(viewer)
    const open = vi.fn((request: Parameters<FileViewerMediaView['open']>[0]) => media.open(structuredClone(request)))
    const cancel = vi.fn((id: string) => media.cancel(id))
    new FileViewerProtocol(new LocalFileMediaSource({ mediaMetadata: token => media.metadata(token), mediaOpen: open, mediaCancel: cancel })).initialize()
    if (!protocolMock.handler) throw new Error('Protocol handler was not installed')
    return { handle: protocolMock.handler, media, open, cancel, url: `jamat-v3-file://resource/${granted.value.resourceId}` }
  }

  it('keeps HEAD and range rejection free of byte reads through the local request boundary', async () => {
    const { handle, open, url } = await localProtocol()
    const head = await handle(new Request(url, { method: 'HEAD', headers: { Range: 'bytes=2-5' } }))
    expect(head.status).toBe(206)
    expect(head.headers.get('content-range')).toBe('bytes 2-5/65546')
    expect(head.headers.get('content-length')).toBe('4')
    expect(await head.text()).toBe('')
    expect((await handle(new Request(url, { headers: { Range: 'bytes=90000-' } }))).status).toBe(416)
    expect((await handle(new Request(url, { method: 'POST' }))).status).toBe(405)
    expect(open).not.toHaveBeenCalled()
  })

  it('cancels a Range read by ID within its one active chunk and drops the late reply', async () => {
    const { handle, media, open, cancel, url } = await localProtocol()
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    open.mockImplementationOnce(async request => {
      const answer = await media.open(structuredClone(request))
      entered()
      await released
      return answer
    })
    const controller = new AbortController()
    const response = await handle(new Request(url, { headers: { Range: 'bytes=0-65545' }, signal: controller.signal }))
    expect(response.status).toBe(206)
    expect(open).not.toHaveBeenCalled()
    const pending = response.body!.getReader().read()
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await started
    controller.abort()
    expect(cancel).toHaveBeenCalledExactlyOnceWith(open.mock.calls[0]![0].requestId)
    release()
    await rejected
    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0]![0].length).toBe(65536)
  })

  it('ends the local stream when the content version changes between chunks', async () => {
    const { handle, open, url } = await localProtocol()
    const response = await handle(new Request(url))
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(first.value!.length).toBe(65536)
    await writeFile(resource.path, Buffer.alloc(65547, 66))
    await expect(reader.read()).rejects.toThrow('Resource changed')
    expect(open).toHaveBeenCalledTimes(2)
    expect(open.mock.calls.map(([request]) => [request.offset, request.length])).toEqual([[0, 65536], [65536, 10]])
  })
})
