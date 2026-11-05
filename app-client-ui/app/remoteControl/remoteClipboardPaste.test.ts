import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlPasteFileConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { RemoteClipboardPaste } from './remoteClipboardPaste'
import { GatewayOutboundClient } from '../../../app-orchestrator/app/remoteControl/gatewayOutboundClient'
import { ProcessCalls } from '../../../lib-orchestrator/shared/processCalls'

const clipboardMock = vi.hoisted(() => ({
  text: '',
  fileDrop: '',
  image: null as Uint8Array | null,
}))

vi.mock('electron', () => ({
  clipboard: {
    readText: () => clipboardMock.text,
    readBuffer: (format: string) => format === 'FileNameW' && clipboardMock.fileDrop.length > 0
      ? Buffer.from(`${clipboardMock.fileDrop}\u0000`, 'utf16le')
      : Buffer.alloc(0),
    readImage: () => ({
      isEmpty: () => clipboardMock.image === null,
      toPNG: () => clipboardMock.image,
    }),
  },
}))

interface SentChunk {
  uploadId: string
  fileName: string
  size: number
  offset: number
  bytes: number
}

class FakeOutbound {
  readonly chunks: SentChunk[] = []
  readonly images: string[] = []
  refusal: { code: 'forbidden' | 'operation-failed'; detail: string } | null = null

  async terminalPasteImage(_endpointId: string, _attachId: string, data: string): Promise<RemoteControlStepResult<{ path: string }>> {
    if (this.refusal !== null) return { ok: false, error: this.refusal }
    this.images.push(data)
    return { ok: true, value: { path: 'D:/remote/clip board.png' } }
  }

  async terminalPasteFile(
    _endpointId: string,
    _attachId: string,
    chunk: { uploadId: string; fileName: string; size: number; offset: number; data: string },
  ): Promise<RemoteControlStepResult<{ path: string | null }>> {
    if (this.refusal !== null) return { ok: false, error: this.refusal }
    const bytes = Buffer.from(chunk.data, 'base64').length
    this.chunks.push({ uploadId: chunk.uploadId, fileName: chunk.fileName, size: chunk.size, offset: chunk.offset, bytes })
    return { ok: true, value: { path: chunk.offset + bytes === chunk.size ? `D:/remote/${chunk.fileName}` : null } }
  }
}

describe('app-client-ui/app/remoteControl/remoteClipboardPaste', () => {
  let directory: string
  let outbound: FakeOutbound
  let paste: RemoteClipboardPaste

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jamat-v3-remote-paste-'))
    clipboardMock.text = ''
    clipboardMock.fileDrop = ''
    clipboardMock.image = null
    outbound = new FakeOutbound()
    paste = new RemoteClipboardPaste(outbound)
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('pastes text that names no file as it is, and sends nothing', async () => {
    const file = join(directory, 'a.txt')
    writeFileSync(file, 'x')
    clipboardMock.text = `${file}\nand a sentence`
    expect(await paste.paste('e1', 'a1')).toEqual({ ok: true, value: { kind: 'text', text: `${file}\nand a sentence` } })
    expect(outbound.chunks).toEqual([])
  })

  it('sends a copied file path in chunks and pastes its path on the other computer', async () => {
    const file = join(directory, 'log.txt')
    const size = RemoteControlPasteFileConst.chunkBytesConst * 2 + 10
    writeFileSync(file, Buffer.alloc(size, 7))
    clipboardMock.text = `"${file}"\r\n`

    expect(await paste.paste('e1', 'a1')).toEqual({ ok: true, value: { kind: 'text', text: 'D:/remote/log.txt' } })
    expect(outbound.chunks.map((chunk) => [chunk.offset, chunk.bytes])).toEqual([
      [0, RemoteControlPasteFileConst.chunkBytesConst],
      [RemoteControlPasteFileConst.chunkBytesConst, RemoteControlPasteFileConst.chunkBytesConst],
      [RemoteControlPasteFileConst.chunkBytesConst * 2, 10],
    ])
    expect(new Set(outbound.chunks.map((chunk) => chunk.uploadId)).size).toBe(1)
    expect(outbound.chunks.every((chunk) => chunk.fileName === 'log.txt' && chunk.size === size)).toBe(true)
  })

  it('stops reading and forwarding file chunks when its window or claim lifetime is revoked', async () => {
    const file = join(directory, 'cancelled.bin')
    writeFileSync(file, Buffer.alloc(RemoteControlPasteFileConst.chunkBytesConst * 2 + 1))
    clipboardMock.text = file
    const lifetime = new AbortController(), original = outbound.terminalPasteFile.bind(outbound)
    const send = vi.spyOn(outbound, 'terminalPasteFile').mockImplementation(async (...args) => {
      const answer = await original(...args)
      lifetime.abort(new Error('Claim replaced'))
      return answer
    })
    await expect(paste.paste('endpoint', 'private-claim', lifetime.signal)).rejects.toThrow('Claim replaced')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]!.slice(0, 2)).toEqual(['endpoint', 'private-claim'])
    expect(outbound.chunks).toHaveLength(1)
  })

  it('pastes the local path with the reason for a file over the limit, and sends the others', async () => {
    const large = join(directory, 'dump.bin')
    const small = join(directory, 'empty.txt')
    writeFileSync(large, '')
    truncateSync(large, RemoteControlPasteFileConst.bytesMaxConst + 1)
    writeFileSync(small, '')
    clipboardMock.text = `${large}\n${small}`

    expect(await paste.paste('e1', 'a1')).toEqual({
      ok: true,
      value: { kind: 'text', text: `${large} (not transferred: 20.0 MB, the limit is 20.0 MB) D:/remote/empty.txt` },
    })
    expect(outbound.chunks).toEqual([expect.objectContaining({ fileName: 'empty.txt', size: 0, offset: 0, bytes: 0 })])
  })

  it('sends the file Explorer copied, which the clipboard holds as no text at all', async () => {
    const file = join(directory, 'report.pdf')
    writeFileSync(file, 'pdf')
    clipboardMock.fileDrop = file

    expect(await paste.paste('e1', 'a1')).toEqual({ ok: true, value: { kind: 'text', text: 'D:/remote/report.pdf' } })
  })

  it('sends a clipboard image and pastes its saved path, quoted for its space', async () => {
    clipboardMock.image = Uint8Array.from([0x89, 0x50])

    expect(await paste.paste('e1', 'a1')).toEqual({ ok: true, value: { kind: 'text', text: '"D:/remote/clip board.png"' } })
    expect(outbound.images).toEqual([Buffer.from([0x89, 0x50]).toString('base64')])
  })

  it('reads the native clipboard in main and sends image and file data through the private window authority route', async () => {
    let gateway!: ProcessCalls
    const sent: unknown[][] = []
    const main = new ProcessCalls({ send: message => gateway.receive(structuredClone(message)), invoke: async () => {}, event: () => {}, report: message => { throw new Error(message) } })
    gateway = new ProcessCalls({ send: message => main.receive(structuredClone(message)), invoke: async (target, method, args) => {
      sent.push([target, method, args]); return { ok: true, value: { path: 'remote-file' } }
    }, event: () => {}, report: message => { throw new Error(message) } })
    const client = new GatewayOutboundClient(main, () => [], () => {}, () => {}), window = { windowId: '7', epoch: 'document-epoch' }
    const native = new RemoteClipboardPaste({ terminalPasteImage: (...args) => client.pasteImage(window, ...args),
      terminalPasteFile: (...args) => client.pasteFile(window, ...args) })
    try {
      clipboardMock.image = Uint8Array.from([1, 2, 3])
      expect(await native.paste('peer', 'private-claim')).toEqual({ ok: true, value: { kind: 'text', text: 'remote-file' } })
      expect(sent[0]).toEqual(['windows', 'remote-paste-image', ['7', 'document-epoch', 'peer', 'private-claim', 'AQID']])
      const file = join(directory, 'copy.txt'); writeFileSync(file, 'file-bytes'); clipboardMock.text = file
      expect(await native.paste('peer', 'private-claim')).toEqual({ ok: true, value: { kind: 'text', text: 'remote-file' } })
      expect(sent[1]).toEqual(['windows', 'remote-paste-file', ['7', 'document-epoch', 'peer', 'private-claim',
        { uploadId: expect.any(String), fileName: 'copy.txt', size: 10, offset: 0, data: Buffer.from('file-bytes').toString('base64') }]])
    } finally { main.close(); gateway.close() }
  })

  it('answers empty for an empty clipboard', async () => {
    expect(await paste.paste('e1', 'a1')).toEqual({ ok: true, value: { kind: 'empty' } })
  })

  it('names the computer to update when the other side never offered the operation', async () => {
    const file = join(directory, 'a.txt')
    writeFileSync(file, 'x')
    clipboardMock.text = file
    outbound.refusal = { code: 'forbidden', detail: 'Remote peer did not grant terminal.pasteFile' }

    expect(await paste.paste('e1', 'a1')).toEqual({
      ok: false,
      error: { code: 'forbidden', detail: 'The remote computer runs a Jamat without image and file paste; update it' },
    })
  })
})
