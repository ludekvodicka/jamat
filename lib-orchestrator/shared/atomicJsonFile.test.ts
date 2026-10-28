import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rename } from 'node:fs/promises'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AtomicJsonFile } from './atomicJsonFile'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, rename: vi.fn(fs.rename) }
})
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

describe('lib-orchestrator/shared/atomicJsonFile', () => {
  const roots: string[] = []
  beforeEach(() => { vi.mocked(rename).mockReset().mockImplementation(actual.rename) })

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('moves a complete JSON document into place', () => {
    const root = AtomicJsonFileTest.root(roots)
    const file = join(root, 'document.json')

    AtomicJsonFile.write(file, { value: 1 })

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ value: 1 })
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('does not reuse or remove another writer staging file', () => {
    const root = AtomicJsonFileTest.root(roots)
    const file = join(root, 'document.json')
    const foreignStaging = `${file}.tmp`
    writeFileSync(foreignStaging, 'foreign-writer', 'utf8')

    AtomicJsonFile.write(file, { value: 1 })

    expect(readFileSync(foreignStaging, 'utf8')).toBe('foreign-writer')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ value: 1 })
  })

  it('removes the temporary file when the final rename fails', () => {
    const root = AtomicJsonFileTest.root(roots)
    const file = join(root, 'document.json')
    mkdirSync(file)

    expect(() => AtomicJsonFile.write(file, { token: 'private' })).toThrow()
    expect(readdirSync(root)).toEqual(['document.json'])
  })

  it.skipIf(process.platform !== 'win32').each(['EPERM', 'EACCES', 'EBUSY'])('retries a transient Windows %s without removing the prior document', async (code) => {
    const root = AtomicJsonFileTest.root(roots), file = join(root, 'document.json')
    AtomicJsonFile.write(file, { value: 'old' })
    vi.mocked(rename).mockImplementationOnce(async () => {
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ value: 'old' })
      throw Object.assign(new Error('locked'), { code })
    })
    await AtomicJsonFile.writeAsync(file, { value: 'new' })
    expect(rename).toHaveBeenCalledTimes(2)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ value: 'new' })
    expect(readdirSync(root)).toEqual(['document.json'])
  })

  it.skipIf(process.platform !== 'win32')('bounds permanent Windows refusal and preserves the previous document', async () => {
    const root = AtomicJsonFileTest.root(roots), file = join(root, 'document.json')
    AtomicJsonFile.write(file, { value: 'old' })
    vi.mocked(rename).mockRejectedValue(Object.assign(new Error('denied'), { code: 'EPERM' }))
    await expect(AtomicJsonFile.writeAsync(file, { value: 'new' })).rejects.toMatchObject({ code: 'EPERM' })
    expect(rename).toHaveBeenCalledTimes(6)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ value: 'old' })
    expect(readdirSync(root)).toEqual(['document.json'])
  })

  it('does not retry an unrelated disk error', async () => {
    const root = AtomicJsonFileTest.root(roots), file = join(root, 'document.json')
    vi.mocked(rename).mockRejectedValue(Object.assign(new Error('I/O failed'), { code: 'EIO' }))
    await expect(AtomicJsonFile.writeAsync(file, {})).rejects.toMatchObject({ code: 'EIO' })
    expect(rename).toHaveBeenCalledOnce()
    expect(readdirSync(root)).toEqual([])
  })
})

class AtomicJsonFileTest {
  static root(roots: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-atomic-json-'))
    roots.push(root)
    return root
  }
}
