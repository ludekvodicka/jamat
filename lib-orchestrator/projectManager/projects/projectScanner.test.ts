import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { RuntimeCategory } from '../catalog/catalog.types'
import { ProjectScanner } from './projectScanner'
import type { ScanDirectoryEntry, ScannerFileSystem, ScanResult } from './projectScanner'

describe('lib-orchestrator/projectManager/projects/projectScanner', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-scan-'))
    created.push(root)
    return root
  }

  function category(path: string, overrides?: Partial<RuntimeCategory>): RuntimeCategory {
    return {
      id: 'nodejs',
      label: 'NodeJs',
      path,
      comparablePath: path.replace(/\\/g, '/').toLowerCase(),
      hiddenFolders: new Set(),
      flattenFolders: new Set(),
      virtualFolders: [],
      afterCreate: null,
      ...overrides,
    }
  }

  function namesOf(result: ScanResult): string[] {
    return result.entries.map((entry) => entry.name).sort()
  }

  function directoryEntry(name: string): ScanDirectoryEntry {
    return { name, isDirectory: () => true, isSymbolicLink: () => false }
  }

  function symbolicLinkEntry(name: string): ScanDirectoryEntry {
    return { name, isDirectory: () => false, isSymbolicLink: () => true }
  }

  it('lists directories one level down, skipping dot names, Archived, hidden folders and files', async () => {
    const root = makeRoot()
    for (const name of ['AppOne', 'AppTwo', '.git', 'Archived', 'node_modules'])
      mkdirSync(join(root, name))
    writeFileSync(join(root, 'readme.md'), 'x', 'utf8')

    const result = await new ProjectScanner()
      .scan(category(root, { hiddenFolders: new Set(['node_modules']) }))

    expect(namesOf(result)).toEqual(['AppOne', 'AppTwo'])
    expect(result.truncated).toBe(false)
    expect(result.available).toBe(true)
    expect(result.entries[0].path).toBe(join(root, result.entries[0].name))
  })

  it('unfolds a flattened container one level and skips its dot children', async () => {
    const root = makeRoot()
    mkdirSync(join(root, 'AppOne'))
    mkdirSync(join(root, 'Plugins'))
    mkdirSync(join(root, 'Plugins', 'foo'))
    mkdirSync(join(root, 'Plugins', '.cache'))
    writeFileSync(join(root, 'Plugins', 'notes.txt'), 'x', 'utf8')

    const result = await new ProjectScanner()
      .scan(category(root, { flattenFolders: new Set(['Plugins']) }))

    expect(namesOf(result)).toEqual(['AppOne', 'Plugins/foo'])
    const flattened = result.entries.find((entry) => entry.name === 'Plugins/foo')
    expect(flattened?.path).toBe(join(root, 'Plugins', 'foo'))
    // The facade fills this in from provider history; the scanner opens no provider store.
    expect(flattened?.lastActivity).toBeNull()
  })

  it('stops at the cap and reports the listing as truncated', async () => {
    const root = makeRoot()
    for (let index = 0; index < 2001; index += 1)
      mkdirSync(join(root, `project-${index}`))

    const result = await new ProjectScanner().scan(category(root))

    expect(result.entries).toHaveLength(2000)
    expect(result.truncated).toBe(true)
    expect(result.available).toBe(true)
  })

  it('reports an unreadable root as unavailable, and does not cache that', async () => {
    const parent = makeRoot()
    const root = join(parent, 'not-mounted-yet')
    const scanner = new ProjectScanner()

    expect(await scanner.scan(category(root))).toEqual({
      entries: [],
      truncated: false,
      available: false,
    })

    mkdirSync(root)
    mkdirSync(join(root, 'AppOne'))
    const second = await scanner.scan(category(root))
    expect(second.available).toBe(true)
    expect(namesOf(second)).toEqual(['AppOne'])
  })

  it('skips a symbolic link whose target is gone and keeps one that resolves to a directory', async () => {
    const fileSystem: ScannerFileSystem = {
      readdir: async () => [symbolicLinkEntry('broken'), symbolicLinkEntry('linked'), directoryEntry('plain')],
      stat: async (path) => {
        if (path.endsWith('broken')) throw new Error('ENOENT: no such file or directory')
        return { isDirectory: () => true }
      },
    }

    const result = await new ProjectScanner(fileSystem).scan(category('Q:/root'))

    expect(namesOf(result)).toEqual(['linked', 'plain'])
  })

  it('discards a walk that was invalidated while it ran and walks again', async () => {
    let calls = 0
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fileSystem: ScannerFileSystem = {
      readdir: async () => {
        calls += 1
        if (calls === 1) await gate
        return [directoryEntry(`pass-${calls}`)]
      },
      stat: async () => ({ isDirectory: () => true }),
    }
    const scanner = new ProjectScanner(fileSystem)

    const scanning = scanner.scan(category('Q:/root'))
    expect(calls).toBe(1)
    scanner.invalidate('nodejs')
    release()

    expect(namesOf(await scanning)).toEqual(['pass-2'])
    // Nothing of the discarded walk survived: the cache now answers with the second pass.
    expect(namesOf(await scanner.scan(category('Q:/root')))).toEqual(['pass-2'])
    expect(calls).toBe(2)
  })

  it('walks the file system once for two concurrent scans', async () => {
    let calls = 0
    const fileSystem: ScannerFileSystem = {
      readdir: async () => {
        calls += 1
        await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
        return [directoryEntry('AppOne')]
      },
      stat: async () => ({ isDirectory: () => true }),
    }
    const scanner = new ProjectScanner(fileSystem)

    const [first, second] = await Promise.all([
      scanner.scan(category('Q:/root')),
      scanner.scan(category('Q:/root')),
    ])

    expect(calls).toBe(1)
    expect(first).toBe(second)
  })

  it('answers from the cache until something invalidates the category', async () => {
    let calls = 0
    const fileSystem: ScannerFileSystem = {
      readdir: async () => {
        calls += 1
        return [directoryEntry('AppOne')]
      },
      stat: async () => ({ isDirectory: () => true }),
    }
    const scanner = new ProjectScanner(fileSystem)

    await scanner.scan(category('Q:/root'))
    await scanner.scan(category('Q:/root'))
    expect(calls).toBe(1)

    scanner.invalidate()
    await scanner.scan(category('Q:/root'))
    expect(calls).toBe(2)
  })
})
