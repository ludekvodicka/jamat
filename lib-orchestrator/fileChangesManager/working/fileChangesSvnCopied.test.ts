import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FileChangesVcsEntry } from '../vcs/fileChangesVcs.types'
import { FileChangesSvnCopied, type FileChangesSvnCopiedDeps } from './fileChangesSvnCopied'

describe('lib-orchestrator/fileChangesManager/working/fileChangesSvnCopied', () => {
  const roots: string[] = []
  afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

  /** The shape `svn status --xml --verbose` prints for a directory made by `svn copy`. */
  function statusXml(directory: string, children: readonly { path: string; item: string }[]): string {
    const entry = (path: string, item: string, copied: boolean): string =>
      `<entry path="${path}"><wc-status item="${item}" props="none"${copied ? ' copied="true"' : ''}>`
      + '<commit revision="193"><author>someone</author><date>2026-09-22T06:10:21.401580Z</date></commit></wc-status></entry>'
    return '<?xml version="1.0" encoding="UTF-8"?><status><target path=".">'
      + entry(directory, 'added', true)
      + children.map((child) => entry(join(directory, child.path), child.item, true)).join('')
      + '</target></status>'
  }

  async function fixture(children: readonly { path: string; item: string }[]) {
    const root = await mkdtemp(join(tmpdir(), 'jamat-svn-copied-'))
    roots.push(root)
    const directory = join(root, 'react')
    await mkdir(directory, { recursive: true })
    for (const child of children) {
      if (child.path.includes('/')) await mkdir(join(directory, child.path.replace(/\/[^/]+$/, '')), { recursive: true })
      await writeFile(join(directory, child.path), 'body\n')
    }
    const run = vi.fn(async () => ({ code: 0, failure: null, stdout: statusXml(directory, children), stderr: '' }))
    const deps: FileChangesSvnCopiedDeps = { svn: { run } }
    const entry: FileChangesVcsEntry = { absolutePath: directory, repositoryPath: 'react', nodeKind: 'directory', status: 'added', previousAbsolutePath: null, previousRepositoryPath: null, gitState: null }
    return { root, directory, run, entry, reader: new FileChangesSvnCopied(deps) }
  }

  it('lists what a copied directory carries, which plain status never mentions', async () => {
    const f = await fixture([
      { path: 'axClientOnly.tsx', item: 'normal' },
      { path: 'axReactTypes.ts', item: 'normal' },
    ])
    const entries = await f.reader.expand([f.entry])
    expect(entries.map((entry) => relative(f.root, entry.absolutePath).replace(/\\/g, '/')).sort())
      .toEqual(['react', 'react/axClientOnly.tsx', 'react/axReactTypes.ts'])
    expect(entries.find((entry) => entry.repositoryPath === 'react/axClientOnly.tsx'))
      .toMatchObject({ status: 'copied', nodeKind: 'file' })
    expect(entries.find((entry) => entry.repositoryPath === 'react')).toMatchObject({ status: 'added' })
  })

  /**
   * The one row under a copy that is not decoration. `--depth empty` on the parent publishes the
   * subtree as the copy source had it, so an edit made after the copy needs its own target and must
   * keep the status it arrived with.
   */
  it('leaves a file modified after the copy as its own target', async () => {
    const f = await fixture([
      { path: 'axClientOnly.tsx', item: 'normal' },
      { path: 'axReactTypes.ts', item: 'modified' },
    ])
    const edited: FileChangesVcsEntry = { ...f.entry, absolutePath: join(f.directory, 'axReactTypes.ts'), repositoryPath: 'react/axReactTypes.ts', nodeKind: 'file', status: 'modified' }
    const entries = await f.reader.expand([f.entry, edited])
    expect(entries.find((entry) => entry.repositoryPath === 'react/axReactTypes.ts')).toMatchObject({ status: 'modified' })
    expect(entries.filter((entry) => entry.status === 'copied').map((entry) => entry.repositoryPath))
      .toEqual(['react/axClientOnly.tsx'])
  })

  it('walks a copied directory and nothing else', async () => {
    const f = await fixture([{ path: 'nested/deep.ts', item: 'normal' }])
    const untracked: FileChangesVcsEntry = { ...f.entry, absolutePath: join(f.root, 'fresh'), repositoryPath: 'fresh', status: 'untracked' }
    const modified: FileChangesVcsEntry = { ...f.entry, absolutePath: join(f.root, 'other.ts'), repositoryPath: 'other.ts', nodeKind: 'file', status: 'modified' }
    const entries = await f.reader.expand([f.entry, untracked, modified])
    expect(f.run).toHaveBeenCalledTimes(1)
    expect(entries.find((entry) => entry.repositoryPath === 'react/nested/deep.ts')).toMatchObject({ status: 'copied', nodeKind: 'file' })
  })

  it('reports an SVN failure instead of pretending the copy is empty', async () => {
    const f = await fixture([])
    f.run.mockResolvedValueOnce({ code: 1, failure: null, stdout: '', stderr: 'svn: E155007: not a working copy' })
    await expect(f.reader.expand([f.entry])).rejects.toThrow('E155007')
  })
})
