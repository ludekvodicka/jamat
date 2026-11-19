import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rename } from 'node:fs/promises'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AtomicJsonFile } from './atomicJsonFile'
import { WindowsHeldFile } from './windowsHeldFile'

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
    expect(rename).toHaveBeenCalledTimes(WindowsHeldFile.pausesMsConst.length + 1)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ value: 'old' })
    expect(readdirSync(root)).toEqual(['document.json'])
  })

  it.skipIf(process.platform !== 'win32')('replaces a document another program holds without delete sharing once it is released', async () => {
    const root = AtomicJsonFileTest.root(roots), file = join(root, 'document.json'), ready = join(root, 'held.ready')
    AtomicJsonFile.write(file, { value: 'old' })
    const holder = AtomicJsonFileTest.hold(file, ready, 400)
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 15_000, interval: 20 })
      const started = Date.now()
      AtomicJsonFile.write(file, { value: 'new' })
      expect(Date.now() - started).toBeGreaterThanOrEqual(100)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ value: 'new' })
      expect(readdirSync(root).sort()).toEqual(['document.json', 'held.ready'])
    } finally { await AtomicJsonFileTest.exited(holder) }
  }, 30_000)

  it('writes indented JSON by default and one line when asked for compact', async () => {
    const root = AtomicJsonFileTest.root(roots)
    const indented = join(root, 'indented.json'), compact = join(root, 'compact.json')
    await AtomicJsonFile.writeAsync(indented, { value: [1, 2] })
    await AtomicJsonFile.writeAsync(compact, { value: [1, 2] }, { compact: true })
    expect(readFileSync(indented, 'utf8')).toBe(JSON.stringify({ value: [1, 2] }, null, 2))
    expect(readFileSync(compact, 'utf8')).toBe('{"value":[1,2]}')
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
  /** A second process opens the file for reading without delete sharing, as a real-time scanner does. */
  static hold(file: string, ready: string, milliseconds: number): ChildProcess {
    const script = `$f = [IO.File]::Open('${file}', 'Open', 'Read', 'Read'); [IO.File]::WriteAllText('${ready}', ''); Start-Sleep -Milliseconds ${milliseconds}; $f.Dispose()`
    return spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' })
  }

  static async exited(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise((resolve) => child.once('exit', resolve))
  }

  static root(roots: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-atomic-json-'))
    roots.push(root)
    return root
  }
}
