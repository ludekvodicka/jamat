import { expect, it, vi } from 'vitest'
import type { AppClientUiBridge } from '../../shared/appClientUiIpc'
import type { RemoteFileRequest } from '../../../lib-orchestrator/remoteControl/remoteContentApi.types'
import type { FileViewerDocumentKind } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import { FileViewerLimits } from '../../../lib-orchestrator/fileViewer/fileViewerLimits'
import { RemoteContentRead } from '../../shared/remoteContentRead'
import { RemoteFileViewerPorts } from './remoteFileViewerPorts'

const target = { kind: 'remote', remoteEndpointId: 'source', sessionId: 'session' } as const
const view = { viewId: 'view', viewerId: 'viewer', epoch: 'epoch', sessionId: 'session' }
const data = new TextEncoder().encode('Source only: příliš žluťoučký 🐱')
const document = { documentId: 'document', documentKey: 'key', source: { kind: 'workspace', sessionId: 'session', path: 'C:/same/a.txt' },
  path: 'C:/same/a.txt', name: 'a.txt', size: data.length, contentVersion: 'version', kind: { kind: 'text' }, modes: ['raw'] }

function fixture(content = data, kind: FileViewerDocumentKind = { kind: 'text' }, size = content.length) {
  let invalid = false
  let transfer = Buffer.alloc(0)
  const page = (offset: number) => ({ transferId: 'transfer', version: 'page-version', offset,
    totalBytes: transfer.length, base64: transfer.subarray(offset, offset + 64 * 1024).toString('base64') })
  const requestFiles = vi.fn(async (_endpoint: string, _view: string, request: RemoteFileRequest) => {
    let value
    if (request.kind === 'restore' || request.kind === 'open-entry') value = { ok: true, value: { ...document, kind, size } }
    else if (request.kind === 'bytes') {
      const chunk = content.slice(request.offset, request.offset + request.length)
      value = { ok: true, value: { base64: Buffer.from(chunk).toString('base64'), version: invalid ? 'changed' : 'version',
        offset: request.offset, length: chunk.length, totalSize: size, eof: request.offset + chunk.length === size } }
    }
    else if (request.kind === 'root-directory') value = { ok: true, value: { directoryId: 'directory', path: 'C:/same', rootPath: 'C:/same', relativePath: '', canGoParent: false, truncated: false, entries: [{ entryId: 'file', name: 'source-only.txt', path: 'C:/same/source-only.txt', nodeKind: 'file', targetKind: 'file', size: 1, modifiedAt: null, openable: true, detail: null }] } }
    else value = null
    transfer = Buffer.from(JSON.stringify(value))
    return { ok: true, value: { ok: true, value: page(0) } }
  })
  const readFilePage = vi.fn(async (_endpoint: string, _view: string, cursor: { offset: number }) => ({ ok: true, value: { ok: true, value: page(cursor.offset) } }))
  const ports = new RemoteFileViewerPorts(target, async () => view, { requestFiles, readFilePage } as unknown as AppClientUiBridge['remote'], vi.fn())
  return { ports, requestFiles, invalid: () => { invalid = true } }
}

it('reads source text, hex and directories without any local filesystem bridge', async () => {
  const f = fixture()
  expect(await f.ports.viewer.restore(document.source as never, false)).toMatchObject({ value: { value: { documentKey: expect.stringContaining('source') } } })
  expect(await f.ports.viewer.text('document')).toMatchObject({ value: { text: new TextDecoder().decode(data) } })
  const chunk = await f.ports.viewer.chunk('document', 0)
  expect(chunk.ok && chunk.value.ok && Array.from(chunk.value.value.bytes)).toEqual(Array.from(data))
  expect(await f.ports.directories.rootDirectory('session')).toMatchObject({ value: { value: { entries: [{ name: 'source-only.txt' }] } } })
  expect(await f.ports.directories.rootDirectory('foreign')).toMatchObject({ ok: false })
  expect(f.requestFiles.mock.calls.every(([endpoint, viewId]) => endpoint === 'source' && viewId === 'view')).toBe(true)
  f.invalid()
  expect(await f.ports.viewer.chunk('document', 0)).toMatchObject({ ok: false, error: 'Invalid remote byte range' })
})

it('assembles HTML above the ordinary text limit from remote byte ranges', async () => {
  const source = '<h1>Remote report</h1>' + ' '.repeat(FileViewerLimits.fullTextBytes) + 'žluťoučký 🐱'
  const f = fixture(new TextEncoder().encode(source), { kind: 'html' })
  await f.ports.viewer.restore(document.source as never, false)
  const result = await f.ports.viewer.text('document')
  expect(result.ok && result.value.ok && result.value.kind === 'text' && result.value.text === source).toBe(true)
  expect(f.requestFiles.mock.calls.filter(([, , request]) => request.kind === 'bytes').length).toBeGreaterThan(1)
})

it.each([{ kind: 'html' } as const, { kind: 'text' } as const])('refuses oversized $kind before requesting bytes', async (kind) => {
  const limit = kind.kind === 'html' ? FileViewerLimits.htmlBytes : FileViewerLimits.fullTextBytes
  const f = fixture(data, kind, limit + 1)
  await f.ports.viewer.restore(document.source as never, false)
  expect(await f.ports.viewer.text('document')).toMatchObject({ value: { kind: 'too-large', limit } })
  expect(f.requestFiles.mock.calls.some(([, , request]) => request.kind === 'bytes')).toBe(false)
})

it('rejects discontinuous, non-progressing and changed result pages before assembly', async () => {
  const first = { transferId: 'a', version: 'v', offset: 0, totalBytes: 2, base64: 'YQ==' }
  for (const invalid of [{ offset: 0 }, { version: 'other' }, { totalBytes: 3 }, { base64: '' }])
    await expect(RemoteContentRead.collect(first, async () => ({ ...first, offset: 1, base64: 'Yg==', ...invalid }))).rejects.toThrow('Invalid remote content page')
  expect(await RemoteContentRead.collect(first, async () => ({ ...first, offset: 1, base64: 'Yg==' }))).toEqual(new Uint8Array([97, 98]))
})


it('refuses malformed decoded documents before a pane can adopt them', async () => {
  const f = fixture()
  const encoded = new TextEncoder().encode(JSON.stringify({ ok: true, value: { documentId: 'bad' } }))
  f.requestFiles.mockResolvedValueOnce({ ok: true, value: { ok: true, value: { transferId: 't', version: 'v', offset: 0, totalBytes: encoded.length, base64: btoa(String.fromCharCode(...encoded)) } } })
  expect(await f.ports.viewer.restore(document.source as never, false)).toEqual({ ok: false, error: 'Malformed remote file response' })
})

it('rejects late adoption after source retirement and cleanup cannot reopen that view', async () => {
  const f = fixture()
  const pending = f.ports.viewer.restore(document.source as never, false)
  f.ports.clear()
  expect(await pending).toMatchObject({ ok: false, error: 'Remote content view closed' })
  const before = f.requestFiles.mock.calls.length
  await f.ports.viewer.release('document')
  expect(await f.ports.viewer.restore(document.source as never, false)).toMatchObject({ ok: false })
  expect(f.requestFiles).toHaveBeenCalledTimes(before)
})
