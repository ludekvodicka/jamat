import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { AtomicJsonFile } from './atomicJsonFile.js'

describe('app-host/app/shared/atomicJsonFile', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-atomic-'))
    directories.push(root)
    return root
  }

  it('creates a missing directory tree and rewrites a document', () => {
    const directory = join(workspace(), 'nested', 'deeper')
    const file = join(directory, 'host-state.json')

    AtomicJsonFile.ensureDirectory(directory)
    AtomicJsonFile.write(file, { schemaVersion: 1 })
    AtomicJsonFile.write(file, { schemaVersion: 2 })

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schemaVersion: 2 })
  })

  // The rename is what makes the write atomic, and it is also what must leave nothing behind: a
  // `.tmp` sibling per write would accumulate beside a document written on every resize.
  it('leaves no temporary sibling behind', () => {
    const directory = workspace()
    const file = join(directory, 'host-state.json')

    AtomicJsonFile.write(file, { schemaVersion: 1 })

    expect(readdirSync(directory)).toEqual(['host-state.json'])
  })

  /*
   * The whole point of writing through a temporary file. A write that dies part way must leave the
   * document that was there, because the alternative - a half-written file where a whole one was -
   * is what a reader would take for damage.
   */
  it('leaves the previous document whole when a write cannot finish', () => {
    const directory = workspace()
    const file = join(directory, 'host-state.json')
    AtomicJsonFile.write(file, { schemaVersion: 1 })
    // A directory at the temporary path: the write into it fails where a full disk would.
    mkdirSync(`${file}.tmp`)

    expect(() => AtomicJsonFile.write(file, { schemaVersion: 2 })).toThrow()

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schemaVersion: 1 })
  })

  /*
   * Writing a document used to end in two `icacls.exe` runs per call, on the main thread, on every
   * resize and every operation. This says it cannot come back - in this module or in ANY of the
   * five that write through it.
   *
   * Read off the source rather than mocked. A `vi.mock('node:child_process')` here applies to this
   * file's module graph, which is `atomicJsonFile.js` alone: the guard that stood here asserted
   * nothing, and stayed green with an `icacls` call re-introduced in any of the writers below.
   */
  it('spawns no process, in this module or in the five that write through it', () => {
    const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
    const writers = [
      'shared/atomicJsonFile.ts',
      'sessions/sessionStore.ts',
      'config/configIdentityStore.ts',
      'hostRuntime/hostLog.ts',
      'hostRuntime/hostProcessLock.ts',
      'hostRuntime/hostDescriptorStore.ts',
    ]

    for (const writer of writers) {
      const path = join(appRoot, writer)
      expect(existsSync(path), writer).toBe(true)
      const source = readFileSync(path, 'utf8')
      expect(source, writer).not.toContain('child_process')
      expect(source, writer).not.toContain('icacls')
    }
  })
})
