import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileViewerLimits } from '../fileViewerLimits'
import { FileContentReader } from './fileContentReader'

/**
 * `readFile` is watched rather than replaced, because what this file has to prove about the size
 * limit is not what it ANSWERS but WHEN it answers: a `too-large` returned after the read has
 * already pulled the whole file into the main process is the V1 defect this limit was written to
 * close, and it answers exactly the same thing.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

/**
 * The reader behind every text and chunk answer. It had no test file until 2026-08-24: moving the
 * `too-large` return after `readFile` left the whole library suite green.
 */
describe('lib-orchestrator/fileViewer/content/fileContentReader', () => {
  const roots: string[] = []

  async function root(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'jamat-content-reader-'))
    roots.push(path)
    return path
  }

  /** What the reader itself would have computed, so a test does not have to guess the version. */
  async function versionOf(reader: FileContentReader, path: string): Promise<string> {
    const inspected = await reader.inspect(path, false)
    if (inspected.contentVersion === null) throw new Error(`No content version for ${path}`)
    return inspected.contentVersion
  }

  beforeEach(() => { vi.mocked(readFile).mockClear() })

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  describe('how much text is read at all', () => {
    it('reads a file that sits exactly on the limit', async () => {
      const cwd = await root()
      const path = join(cwd, 'big.txt')
      await writeFile(path, 'a'.repeat(FileViewerLimits.fullTextBytes))
      const reader = new FileContentReader()

      const read = await reader.text(path, await versionOf(reader, path))

      expect(read.kind).to.equal('text')
    })

    it('refuses one byte past it WITHOUT reading the file', async () => {
      const cwd = await root()
      const path = join(cwd, 'bigger.txt')
      await writeFile(path, 'a'.repeat(FileViewerLimits.fullTextBytes + 1))
      const reader = new FileContentReader()
      vi.mocked(readFile).mockClear()

      const read = await reader.text(path, await versionOf(reader, path))

      expect(read).to.deep.equal({
        kind: 'too-large',
        size: FileViewerLimits.fullTextBytes + 1,
        limit: FileViewerLimits.fullTextBytes,
      })
      // The whole point of the limit: the bytes never entered this process.
      expect(vi.mocked(readFile).mock.calls.length).to.equal(0)
    })
  })

  describe('what the reader says instead of text', () => {
    it('says the file changed when the version it was asked for is not the one on disk', async () => {
      const cwd = await root()
      const path = join(cwd, 'a.txt')
      await writeFile(path, 'one')

      expect(await new FileContentReader().text(path, 'some-older-version'))
        .to.deep.equal({ kind: 'changed' })
    })

    it('says missing for a file that is not there', async () => {
      const cwd = await root()
      expect(await new FileContentReader().text(join(cwd, 'gone.txt'), null))
        .to.deep.equal({ kind: 'missing' })
    })

    it('says binary for NUL bytes and for text that is not UTF-8', async () => {
      const cwd = await root()
      const reader = new FileContentReader()
      const withNul = join(cwd, 'nul.bin')
      await writeFile(withNul, Buffer.from([65, 0, 66]))
      const notUtf8 = join(cwd, 'latin.txt')
      await writeFile(notUtf8, Buffer.from([0xc3, 0x28]))

      expect(await reader.text(withNul, await versionOf(reader, withNul)))
        .to.deep.include({ kind: 'binary' })
      expect(await reader.text(notUtf8, await versionOf(reader, notUtf8)))
        .to.deep.include({ kind: 'binary' })
    })
  })

  describe('paging a file that is too large to hand over whole', () => {
    it('refuses an offset that is not a whole number of bytes forward', async () => {
      const cwd = await root()
      const path = join(cwd, 'a.bin')
      await writeFile(path, Buffer.alloc(8, 1))

      expect(await new FileContentReader().chunk(path, null, -1))
        .to.deep.include({ kind: 'invalid-range' })
      expect(await new FileContentReader().chunk(path, null, 1.5))
        .to.deep.include({ kind: 'invalid-range' })
    })

    it('hands back one chunk at a time and says which one is the last', async () => {
      const cwd = await root()
      const path = join(cwd, 'payload.bin')
      await writeFile(path, Buffer.alloc(FileViewerLimits.chunkBytes + 16, 7))
      const reader = new FileContentReader()
      const version = await versionOf(reader, path)

      const first = await reader.chunk(path, version, 0)
      expect(first.kind).to.equal('chunk')
      if (first.kind !== 'chunk') return
      expect(first.value.length).to.equal(FileViewerLimits.chunkBytes)
      expect(first.value.eof).to.equal(false)

      const second = await reader.chunk(path, version, first.value.length)
      expect(second.kind === 'chunk' ? second.value.eof : null).to.equal(true)
    })
  })
})
