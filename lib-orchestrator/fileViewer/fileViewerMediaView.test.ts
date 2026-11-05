import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileViewer } from './fileViewer'
import { FileViewerMediaView, type FileViewerMediaRequest } from './fileViewerMediaView'
import { FileContentReader } from './content/fileContentReader'
import { FileViewerGrantBoundary } from './access/fileViewerGrantBoundary'
import { FileViewerLimits } from './fileViewerLimits'

describe('FileViewerMediaView', () => {
  const roots: string[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'jamat-file-media-'))
    roots.push(root)
    const path = join(root, 'bytes.bin')
    await writeFile(path, Buffer.alloc(FileViewerLimits.chunkBytes + 10, 65))
    const viewer = new FileViewer()
    const document = await viewer.openWorkspace('owner', 'session', root, path)
    if (!document.ok) throw new Error(document.detail)
    const resource = await viewer.exportResource('owner', document.value.documentId)
    if (!resource.ok) throw new Error(resource.detail)
    const media = new FileViewerMediaView(viewer)
    const request: FileViewerMediaRequest = { requestId: 'read-1', resourceId: resource.value.resourceId,
      version: resource.value.contentVersion, offset: 0, length: FileViewerLimits.chunkBytes }
    return { viewer, media, request, path, documentId: document.value.documentId }
  }

  function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
  }

  function holdRead() {
    const entered = deferred(), release = deferred()
    let bytesRead = 0
    const original = FileContentReader.prototype.range
    const read = vi.spyOn(FileContentReader.prototype, 'range').mockImplementationOnce(async function (this: FileContentReader, ...args) {
      const answer = await original.apply(this, args)
      if (answer.kind === 'chunk') bytesRead += answer.value.bytes.length
      entered.resolve()
      await release.promise
      return answer
    })
    return { entered: entered.promise, release: release.resolve, read, bytesRead: () => bytesRead }
  }

  it('returns cloneable metadata and at most one bounded byte chunk without grant details', async () => {
    const { media, request } = await fixture()
    const metadata = await media.metadata(request.resourceId)
    expect(metadata).toEqual({ kind: 'ready', mimeType: 'application/octet-stream', size: 65546, version: request.version })
    expect(structuredClone(metadata)).toEqual(metadata)
    const answer = await media.open(structuredClone(request))
    expect(answer.ok).toBe(true)
    if (!answer.ok) throw new Error(answer.detail)
    expect(answer.value.bytes.length).toBe(65536)
    expect([...structuredClone(answer).value.bytes]).toEqual([...answer.value.bytes])
    expect(answer.value.eof).toBe(false)
    expect(Object.keys(metadata).sort()).toEqual(['kind', 'mimeType', 'size', 'version'])
  })

  it.each([0, 65537, -1, 1.5])('rejects an unbounded or invalid chunk length %s before reading', async length => {
    const { viewer, media, request } = await fixture()
    const read = vi.spyOn(viewer, 'readResourceBytes')
    expect(await media.open({ ...request, length })).toMatchObject({ ok: false, code: 'invalid-range' })
    expect(read).not.toHaveBeenCalled()
  })

  it('retains the released-during-read error and removes the completed request', async () => {
    const { viewer, media, request, documentId } = await fixture()
    const held = holdRead()
    const pending = media.open(request)
    await held.entered
    viewer.release('owner', documentId)
    held.release()
    expect(await pending).toEqual({ ok: false, code: 'document-expired', detail: 'Resource was released during its read' })
    expect(await media.open(request)).toMatchObject({ ok: false, code: 'document-expired' })
  })

  it('registers cancellation before awaited metadata and reads no bytes after cancellation', async () => {
    const { viewer, media, request } = await fixture()
    const entered = deferred(), release = deferred()
    const original = viewer.resourceMetadata.bind(viewer)
    vi.spyOn(viewer, 'resourceMetadata').mockImplementationOnce(async (...args) => {
      entered.resolve()
      await release.promise
      return original(...args)
    })
    const read = vi.spyOn(FileContentReader.prototype, 'range')
    const pending = media.open(request)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await entered.promise
    media.cancel(request.requestId)
    release.resolve()
    await rejected
    expect(read).not.toHaveBeenCalled()
    expect((await media.open(request)).ok).toBe(true)
  })

  it('rejects duplicate active IDs and discards a cancelled late reply after one chunk', async () => {
    const { media, request } = await fixture()
    const held = holdRead()
    const pending = media.open(request)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await held.entered
    await expect(media.open(request)).rejects.toThrow('Media request is already active')
    media.cancel(request.requestId)
    media.cancel(request.requestId)
    held.release()
    await rejected
    expect(held.read).toHaveBeenCalledTimes(1)
    expect(held.read.mock.calls[0]![3]).toBe(65536)
    expect(held.read.mock.calls[0]![4]!.aborted).toBe(true)
    expect(held.bytesRead()).toBe(65536)
    expect((await media.open(request)).ok).toBe(true)
  })

  it('keeps the version check between chunk calls', async () => {
    const { media, request, path } = await fixture()
    expect((await media.open(request)).ok).toBe(true)
    await writeFile(path, Buffer.alloc(65547, 66))
    expect(await media.open({ ...request, requestId: 'read-2', offset: 65536, length: 10 }))
      .toEqual({ ok: false, code: 'document-changed', detail: 'Resource changed' })
  })

  it('retains containment revalidation after the physical read', async () => {
    const { media, request } = await fixture()
    const held = holdRead()
    const pending = media.open(request)
    await held.entered
    vi.spyOn(FileViewerGrantBoundary, 'insideGrant').mockResolvedValueOnce(false)
    held.release()
    expect(await pending).toEqual({ ok: false, code: 'outside-root', detail: 'Resource moved outside its grant' })
  })

  it('aborts active work on owner shutdown and refuses subsequent reads', async () => {
    const { media, request } = await fixture()
    const held = holdRead()
    const pending = media.open(request)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await held.entered
    media.stop()
    media.stop()
    held.release()
    await rejected
    await expect(media.open({ ...request, requestId: 'later' })).rejects.toThrow('File media is stopping')
    expect(await media.metadata(request.resourceId)).toEqual({ kind: 'missing' })
  })

  it('refuses a grant released while the final containment check is pending', async () => {
    const { viewer, media, request, documentId } = await fixture()
    const entered = deferred(), release = deferred()
    const original = FileViewerGrantBoundary.insideGrant
    let checks = 0
    vi.spyOn(FileViewerGrantBoundary, 'insideGrant').mockImplementation(async (...args) => {
      const inside = await original(...args)
      if (++checks === 2) {
        entered.resolve()
        await release.promise
      }
      return inside
    })
    const pending = media.open(request)
    await entered.promise
    viewer.release('owner', documentId)
    release.resolve()
    expect(await pending).toEqual({ ok: false, code: 'document-expired', detail: 'Resource was released during its read' })
  })
})
