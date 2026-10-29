import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { GitCommitManager } from './gitCommitManager'
import { GitInvoker } from './gitInvoker'

describe('GitCommitManager with real Git', () => {
  const roots: string[] = []
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5 }) })

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'jamat-selected-commit-'))
    roots.push(root)
    const invoker = new GitInvoker()
    const git = async (...args: string[]) => {
      const result = await invoker.run(root, args)
      expect(result, args.join(' ')).toMatchObject({ code: 0, failure: null })
      return result.stdout
    }
    await git('init')
    await git('config', 'user.name', 'Commit Fixture')
    await git('config', 'user.email', 'fixture@example.invalid')
    await git('config', 'commit.gpgsign', 'false')
    await git('config', 'core.autocrlf', 'false')
    await git('config', 'core.hooksPath', '.git/hooks')
    const messageFile = join(root, '.git', 'fixture-message.txt')
    await writeFile(messageFile, 'Selected changes\n\nUnicode message: příliš žluťoučký.\n')
    return { root, git, invoker, messageFile, manager: new GitCommitManager(invoker) }
  }

  it('commits a large exact selection and preserves unrelated index and working content', async () => {
    const { root, git, manager, messageFile } = await fixture()
    const initial = ['modified.txt', 'deleted.txt', 'staged.txt', 'unstaged.txt', 'literalb.txt']
    for (const name of initial) await writeFile(join(root, name), 'base\n')
    await git('add', '-A')
    await git('commit', '-F', messageFile)
    const base = (await git('rev-parse', 'HEAD')).trim()
    await writeFile(join(root, 'staged.txt'), 'staged content\n')
    await git('add', '--', 'staged.txt')
    await writeFile(join(root, 'staged.txt'), 'unstaged content on staged file\n')
    await writeFile(join(root, 'unstaged.txt'), 'unrelated unstaged\n')
    await writeFile(join(root, 'literalb.txt'), 'must not match brackets\n')
    await writeFile(join(root, 'modified.txt'), 'selected modification\n')
    await rm(join(root, 'deleted.txt'))
    await writeFile(join(root, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(root, 'ignored.txt'), 'ignored\n')
    const names = Array.from({ length: 700 }, (_, index) => `selected ${index.toString().padStart(4, '0')} ${'x'.repeat(65)}.txt`)
    names.push('literal[b].txt', '-leading.txt', 'český soubor.txt', 'ampersand&percent%.txt', "single'quote.txt")
    await Promise.all(names.map((name) => writeFile(join(root, name), 'selected addition\n')))
    const selected = [...names, 'modified.txt', 'deleted.txt']
    expect(selected.join(' ').length).toBeGreaterThan(32_767)
    const stagedBefore = await git('show', ':staged.txt')
    const result = await manager.commit(root, selected.map((name) => join(root, name)), messageFile)
    if (!result.ok) throw new Error(result.detail)
    expect(result.value.hash).toBe((await git('rev-parse', 'HEAD')).trim())
    expect(result.value.hash).not.toBe(base)
    const committed = (await git('diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD')).split('\0').filter(Boolean)
    expect(committed.sort()).toEqual(selected.sort())
    expect(await git('show', ':staged.txt')).toBe(stagedBefore)
    expect(await readFile(join(root, 'staged.txt'), 'utf8')).toBe('unstaged content on staged file\n')
    expect(await readFile(join(root, 'unstaged.txt'), 'utf8')).toBe('unrelated unstaged\n')
    expect(await git('show', 'HEAD:literalb.txt')).toBe('base\n')
    expect(await git('diff', '--cached', '--name-only')).toBe('staged.txt\n')
    expect(await git('ls-files', '--', 'ignored.txt')).toBe('')
    expect(await git('log', '-1', '--format=%an <%ae>')).toBe('Commit Fixture <fixture@example.invalid>\n')
    expect(await git('log', '-1', '--format=%B')).toContain('příliš žluťoučký.')
  }, 120_000)

  it('keeps a rejecting hook effective and allows an explicit retry', async () => {
    const { root, git, manager, messageFile } = await fixture()
    await writeFile(join(root, 'base.txt'), 'base\n')
    await git('add', '-A')
    await git('commit', '-F', messageFile)
    const base = (await git('rev-parse', 'HEAD')).trim()
    const hook = join(root, '.git', 'hooks', 'pre-commit')
    await mkdir(join(root, '.git', 'hooks'), { recursive: true })
    await writeFile(hook, '#!/bin/sh\necho "fixture hook refused" >&2\nexit 1\n')
    await chmod(hook, 0o755)
    const selected = join(root, 'new [file].txt')
    await writeFile(selected, 'new\n')
    expect(await manager.commit(root, [selected], messageFile)).toMatchObject({ ok: false, detail: expect.stringContaining('fixture hook refused') })
    expect((await git('rev-parse', 'HEAD')).trim()).toBe(base)
    await writeFile(hook, '#!/bin/sh\nexit 0\n')
    const result = await manager.commit(root, [selected], messageFile)
    expect(result).toMatchObject({ ok: true })
    expect(await git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe('new [file].txt\n')
    expect(await git('status', '--porcelain')).toBe('')
  }, 120_000)

  it('commits and reverts an exact selection through a directory alias', async () => {
    const { root, git, manager, messageFile } = await fixture()
    await mkdir(join(root, 'scope'))
    await writeFile(join(root, 'scope', 'deleted.txt'), 'base\n')
    await writeFile(join(root, 'scope', 'kept.txt'), 'base\n')
    await git('add', '-A')
    await git('commit', '-F', messageFile)
    const alias = join(root, 'alias')
    await symlink(join(root, 'scope'), alias, 'junction')
    await rm(join(root, 'scope', 'deleted.txt'))
    await writeFile(join(root, 'scope', 'new.txt'), 'new\n')
    await writeFile(join(root, 'scope', 'kept.txt'), 'local\n')
    expect(await manager.commit(alias, [join(alias, 'deleted.txt'), join(alias, 'new.txt')], messageFile))
      .toMatchObject({ ok: true })
    expect((await git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).trim().split('\n'))
      .toEqual(['scope/deleted.txt', 'scope/new.txt'])
    expect(await readFile(join(root, 'scope', 'kept.txt'), 'utf8')).toBe('local\n')
    expect(await manager.revertFile(alias, join(alias, 'kept.txt'))).toEqual({ ok: true, value: undefined })
    expect(await readFile(join(root, 'scope', 'kept.txt'), 'utf8')).toBe('base\n')
  }, 120_000)
})
