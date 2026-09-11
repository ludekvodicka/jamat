import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { FileChangesLimits } from '../fileChangesLimits'
import type { FileChangesVcsEntry } from '../vcs/fileChangesVcs.types'
import { FileChangesSvnUntracked, type FileChangesSvnUntrackedDeps } from './fileChangesSvnUntracked'

describe('lib-orchestrator/fileChangesManager/working/fileChangesSvnUntracked', () => {
  const roots: string[] = []
  afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'jamat-svn-untracked-'))
    roots.push(root)
    const directory = join(root, 'new')
    await mkdir(join(directory, 'nested'), { recursive: true })
    await writeFile(join(directory, 'nested', 'chosen.txt'), 'chosen\n')
    await writeFile(join(directory, 'nested', 'unchecked.txt'), 'unchecked\n')
    await writeFile(join(directory, '.hidden'), 'hidden\n')
    const deps: FileChangesSvnUntrackedDeps = {
      git: { run: vi.fn(async () => ({ code: 128, failure: null, stdout: '', stderr: 'not a git repository' })) },
      checkpointStore: { existingContextOf: vi.fn(async () => ({ ok: true as const, value: null })) },
      svn: { run: vi.fn(async () => ({ code: 0, failure: null, stdout: '<properties/>', stderr: '' })) },
      configFile: join(root, 'config'),
    }
    const entry: FileChangesVcsEntry = { absolutePath: directory, repositoryPath: 'new', nodeKind: 'directory', status: 'untracked', previousAbsolutePath: null, previousRepositoryPath: null, gitState: null }
    return { root, directory, deps, entry, reader: new FileChangesSvnUntracked(deps) }
  }

  it('expands every new directory before review, including dotfiles and empty directories', async () => {
    const f = await fixture()
    await mkdir(join(f.directory, 'empty'))
    await mkdir(join(f.directory, '.svn'))
    await writeFile(join(f.directory, '.svn', 'wc.db'), 'admin')
    const entries = await f.reader.expand([f.entry])
    expect(entries.map((entry) => relative(f.root, entry.absolutePath).replace(/\\/g, '/')).sort())
      .toEqual(['new', 'new/.hidden', 'new/empty', 'new/nested', 'new/nested/chosen.txt', 'new/nested/unchecked.txt'])
    expect(entries.find((entry) => entry.repositoryPath === 'new/nested/chosen.txt')).toMatchObject({ status: 'untracked', nodeKind: 'file' })
    expect(entries.find((entry) => entry.repositoryPath === 'new/empty')).toMatchObject({ nodeKind: 'directory' })
  })

  it('applies Subversion configured and inherited ignore rules without entering ignored directories', async () => {
    const f = await fixture()
    await writeFile(f.deps.configFile, '[miscellany]\nglobal-ignores = node_modules *.tmp\n[other]\nvalue = yes\n')
    await mkdir(join(f.directory, 'node_modules'))
    await writeFile(join(f.directory, 'node_modules', 'dependency.js'), 'ignored')
    await writeFile(join(f.directory, 'scratch.tmp'), 'ignored')
    await writeFile(join(f.directory, 'nested', 'inherited.log'), 'ignored')
    f.deps.svn.run = vi.fn(async () => ({ code: 0, failure: null, stderr: '', stdout: '<properties><target path="parent"><inherited_property name="svn:global-ignores">*.log</inherited_property></target></properties>' }))
    const entries = await f.reader.expand([f.entry])
    expect(entries.some((entry) => /node_modules|\.tmp$|\.log$/.test(entry.absolutePath))).toBe(false)
    expect(entries).toHaveLength(5)
  })

  it.each([false, true])('uses the Git file list and required parents (checkpoint: %s)', async (checkpoint) => {
    const f = await fixture()
    f.deps.git.run = vi.fn(async (_cwd, args) => args.includes('--show-toplevel')
      ? { code: checkpoint ? 128 : 0, failure: null, stderr: '', stdout: f.root }
      : { code: 0, failure: null, stderr: '', stdout: 'nested/chosen.txt\0nested/chosen.txt\0' })
    if (checkpoint) f.deps.checkpointStore.existingContextOf = vi.fn(async () => ({ ok: true as const, value: { root: f.root, gitDirArgs: ['--git-dir', 'store'], storeDir: 'store' } }))
    const entries = await f.reader.expand([f.entry])
    expect(entries.map((entry) => entry.repositoryPath)).toEqual(['new', 'new/nested', 'new/nested/chosen.txt'])
    expect(f.deps.git.run).toHaveBeenLastCalledWith(f.directory, [...(checkpoint ? ['--git-dir', 'store'] : []), 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'])
    expect(f.deps.svn.run).not.toHaveBeenCalled()
  })

  it('does not follow a directory link into an unrelated tree', async () => {
    const f = await fixture()
    const outside = join(f.root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'outside')
    await symlink(outside, join(f.directory, 'linked'), 'junction')
    const entries = await f.reader.expand([f.entry])
    expect(entries.some((entry) => entry.absolutePath.endsWith('secret.txt'))).toBe(false)
    await expect(f.reader.expand([{ ...f.entry, absolutePath: join(f.directory, 'linked') }])).rejects.toThrow('regular directory')
  })

  it('omits deleted Git index paths that cannot be added to SVN', async () => {
    const f = await fixture()
    f.deps.git.run = vi.fn(async (_cwd, args) => ({ code: 0, failure: null, stderr: '',
      stdout: args.includes('--show-toplevel') ? f.root : 'nested/chosen.txt\0deleted/no-longer-here.txt\0' }))
    expect((await f.reader.expand([f.entry])).map((entry) => entry.repositoryPath))
      .toEqual(['new', 'new/nested', 'new/nested/chosen.txt'])
  })

  it('fails the entire read on enumeration failure or overflow', async () => {
    const f = await fixture()
    f.deps.svn.run = vi.fn(async () => ({ code: 1, failure: null, stdout: '', stderr: 'cannot read ignores' }))
    await expect(f.reader.expand([f.entry])).rejects.toThrow('cannot read ignores')
    f.deps.svn.run = vi.fn(async () => ({ code: 0, failure: null, stdout: '<properties/>', stderr: '' }))
    const tooMany = Array.from({ length: FileChangesLimits.listingEntriesMax + 1 }, (_, index) => ({ ...f.entry, absolutePath: join(f.root, `entry-${index}`) }))
    await expect(f.reader.expand(tooMany)).rejects.toThrow('exceeds 5000 entries')
  })
})
