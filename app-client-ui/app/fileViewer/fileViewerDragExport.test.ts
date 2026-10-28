import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileViewerDragExport } from './fileViewerDragExport'

it('copies only bounded source images and removes its copies without touching unrelated files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-drag-'))
  try {
    const data = Buffer.from('source-image')
    let mimeType = 'image/png', size = data.length
    const read = vi.fn(async (_token: string, _version: string, offset: number, length: number) => data.subarray(offset, offset + length))
    const source = { metadata: async () => ({ kind: 'ready' as const, mimeType, size, version: 'v' }), read }
    const store = new FileViewerDragExport(root, source)
    await writeFile(join(root, 'user.txt'), 'preserve')
    const path = await store.copy('source', new AbortController().signal)
    expect(await readFile(path)).toEqual(data)
    expect(path).toMatch(/\.png$/)
    mimeType = 'text/plain'
    await expect(store.copy('source', new AbortController().signal)).rejects.toThrow('Only source images')
    mimeType = 'image/png'; size = 33 * 1024 * 1024
    await expect(store.copy('source', new AbortController().signal)).rejects.toThrow('32 MiB')
    expect(read).toHaveBeenCalledOnce()
    await store.dispose()
    expect(await readdir(root)).toEqual(['user.txt'])
    await expect(store.copy('source', new AbortController().signal)).rejects.toThrow('closing')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not leave a partial copy after a revoked source read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-drag-revoked-'))
  try {
    const store = new FileViewerDragExport(root, {
      metadata: async () => ({ kind: 'ready', mimeType: 'image/gif', size: 10, version: 'v' }),
      read: async () => { throw new Error('View revoked') },
    })
    await expect(store.copy('source', new AbortController().signal)).rejects.toThrow('revoked')
    expect(await readdir(root)).toEqual([])
    await store.dispose()
  } finally { await rm(root, { recursive: true, force: true }) }
})
