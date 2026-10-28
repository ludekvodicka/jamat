import { expect, it, vi } from 'vitest'
import type { RemoteFileRequest } from '../../../lib-orchestrator/remoteControl/remoteContentApi.types'
import type { RemoteContentClient } from '../remoteControl/remoteContentClient'
import { RemoteFileMediaSource } from './remoteFileMediaSource'
import { FileViewerExport } from './fileViewerExport'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const view = { viewId: 'view', viewerId: 'viewer', epoch: 'epoch', sessionId: 'session' }
const resource = { resourceId: 'source-resource', size: 10, contentVersion: 'version', mimeType: 'image/gif' }

it('binds opaque media tokens to their source view and exact range/version', async () => {
  let connected = true
  let changed = false
  const read = vi.fn(async (_endpoint: string, held: typeof view, request: RemoteFileRequest) => {
    expect(held).toEqual(view)
    if (request.kind === 'resource-metadata') return changed ? { kind: 'changed' } : { kind: 'ready', resource }
    if (request.kind !== 'resource-bytes') throw new Error('Unexpected operation')
    return { ok: true, value: { version: 'version', offset: request.offset, length: request.length, totalSize: 10,
      eof: request.offset + request.length === 10, base64: Buffer.from('abcdefghij').subarray(request.offset, request.offset + request.length).toString('base64') } }
  })
  const media = new RemoteFileMediaSource({ read } as unknown as Pick<RemoteContentClient, 'read'>, () => connected)
  const token = media.issue('endpoint', view, 'document', resource).resourceId
  expect(token).not.toBe(resource.resourceId)
  expect(await media.metadata(resource.resourceId)).toEqual({ kind: 'missing' })
  expect(await media.metadata(token)).toMatchObject({ kind: 'ready', size: 10 })
  expect(Buffer.from(await media.read(token, 'version', 2, 4, new AbortController().signal)).toString()).toBe('cdef')
  await expect(media.read(token, 'other', 0, 1, new AbortController().signal)).rejects.toThrow('expired or changed')
  changed = true
  expect(await media.metadata(token)).toEqual({ kind: 'changed' })
  connected = false
  media.reconcile()
  expect(await media.metadata(token)).toEqual({ kind: 'missing' })
})

it('limits endpoint reads to four and cancels a queued fifth without waiting for active reads', async () => {
  const pending: (() => void)[] = []
  const read = vi.fn(async (_endpoint: string, _view: unknown, request: RemoteFileRequest) => {
    if (request.kind !== 'resource-bytes') throw new Error('Expected bytes')
    await new Promise<void>((resolve) => pending.push(resolve))
    return { ok: true, value: { version: 'version', offset: 0, length: 1, totalSize: 10, eof: false, base64: 'YQ==' } }
  })
  const media = new RemoteFileMediaSource({ read } as unknown as Pick<RemoteContentClient, 'read'>, () => true)
  const token = media.issue('endpoint', view, 'document', resource).resourceId
  const active = Array.from({ length: 4 }, () => media.read(token, 'version', 0, 1, new AbortController().signal))
  const controller = new AbortController()
  const queued = media.read(token, 'version', 0, 1, controller.signal)
  expect(read).toHaveBeenCalledTimes(4)
  controller.abort(new Error('cancelled'))
  await expect(queued).rejects.toThrow('cancelled')
  expect(read).toHaveBeenCalledTimes(4)
  pending.splice(0).forEach((resolve) => resolve())
  await Promise.all(active)
  expect((media as unknown as { slots: Map<string, unknown> }).slots.size).toBe(0)
})

it('revokes only the named view and discards a read completed after revocation', async () => {
  let finish!: () => void
  let signal: AbortSignal | undefined
  const read = vi.fn(async (_endpoint: string, _view: unknown, _request: unknown, input: AbortSignal) => {
    signal = input
    await new Promise<void>((resolve) => { finish = resolve })
    return { ok: true, value: { version: 'version', offset: 0, length: 1, totalSize: 10, eof: false, base64: 'YQ==' } }
  })
  const media = new RemoteFileMediaSource({ read } as unknown as Pick<RemoteContentClient, 'read'>, () => true)
  const token = media.issue('endpoint', view, 'document', resource).resourceId
  const other = media.issue('endpoint', { ...view, viewId: 'other' }, 'document', resource).resourceId
  const pending = media.read(token, 'version', 0, 1, new AbortController().signal)
  media.releaseView('endpoint', 'view')
  expect(signal?.aborted).toBe(true)
  expect(media.owns(other)).toBe(true)
  finish()
  await expect(pending).rejects.toThrow()
})

it('keeps equal view ids on different endpoints independent', () => {
  const media = new RemoteFileMediaSource({ read: vi.fn() }, () => true)
  const one = media.issue('one', view, 'document', resource).resourceId
  const two = media.issue('two', view, 'document', resource).resourceId
  media.releaseView('one', view.viewId)
  expect(media.owns(one)).toBe(false)
  expect(media.owns(two)).toBe(true)
})

it('exports exact source bytes only to the explicit destination and removes partial output on change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-export-'))
  const data = Buffer.from('source 🐱'.repeat(12000))
  let changed = false
  const source = { metadata: async () => ({ kind: 'ready' as const, size: data.length, version: changed ? 'changed' : 'version', mimeType: 'application/octet-stream' }),
    read: async (_token: string, _version: string, offset: number, length: number) => data.subarray(offset, offset + length) }
  try {
    const destination = join(root, 'copy.bin')
    await new FileViewerExport(source).save('token', destination, new AbortController().signal)
    expect(await readFile(destination)).toEqual(data)
    expect(await readdir(root)).toEqual(['copy.bin'])
    source.read = async (_token, _version, offset, length) => { changed = true; return data.subarray(offset, offset + length) }
    await expect(new FileViewerExport(source).save('token', join(root, 'failed.bin'), new AbortController().signal)).rejects.toThrow('changed')
    expect(await readdir(root)).toEqual(['copy.bin'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
