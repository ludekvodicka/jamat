import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { SvnSmokeIsolation } from './svnSmokeIsolation.js'

async function fixture(work: (root: string) => Promise<void>): Promise<void> {
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'jamat-smoke-isolation-'))
  try { await work(root) }
  finally {
    assert.equal(dirname(await realpath(root)), parent)
    await rm(root, { recursive: true, force: true })
  }
}

test('accepts an external test parent without inherited repository or group metadata', async () => {
  await fixture(async (root) => {
    assert.equal(await SvnSmokeIsolation.parent(root), await realpath(root))
  })
})

for (const marker of ['.svn', '.git', '.appgroup'])
  test(`refuses a test parent below ${marker} before creating fixtures`, async () => {
    await fixture(async (root) => {
      const parent = join(root, 'project', '.aidocs', 'temp')
      await mkdir(parent, { recursive: true })
      if (marker === '.svn') await mkdir(join(root, marker))
      else await writeFile(join(root, marker), marker === '.git' ? 'gitdir: elsewhere' : '{"kind":"collection"}')
      await assert.rejects(SvnSmokeIsolation.parent(parent), /Unsafe SVN smoke test root/)
      await assert.rejects(SvnSmokeIsolation.parent(root), /Unsafe SVN smoke test root/)
    })
  })

test('refuses an alias into a project even when the lexical parent is outside it', async () => {
  await fixture(async (root) => {
    const project = join(root, 'project'), alias = join(root, 'alias')
    await mkdir(join(project, 'temp'), { recursive: true })
    await writeFile(join(project, '.appgroup'), '{"kind":"product"}')
    await symlink(join(project, 'temp'), alias, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(SvnSmokeIsolation.parent(alias), /Unsafe SVN smoke test root/)
  })
})

test('admits fixture owners but refuses prefix siblings and aliased escapes before reservation', async () => {
  await fixture(async (root) => {
    const boundary = join(root, 'fixture'), owner = join(boundary, 'main'), sibling = join(root, 'fixture-other')
    await mkdir(owner, { recursive: true })
    await mkdir(sibling)
    await SvnSmokeIsolation.owner(boundary, owner)
    await assert.rejects(SvnSmokeIsolation.owner(boundary, sibling), /owner escaped its fixture/)
    const alias = join(boundary, 'alias')
    await symlink(sibling, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(SvnSmokeIsolation.owner(boundary, alias), /owner escaped its fixture/)
  })
})

for (const [script, args] of [
  ['svn-worktree.ts', []],
  ['worktreesAcceptance.ts', []],
  ['ui.ts', ['finish']],
  ['ui.ts', ['worktree-extensions']],
] as const)
  test(`${script} refuses an inherited group before a build, process or fixture starts`, async () => {
    await fixture(async (root) => {
      const parent = join(root, 'project', '.aidocs', 'temp')
      await mkdir(parent, { recursive: true })
      await writeFile(join(root, '.appgroup'), '{"kind":"collection"}')
      try {
        await promisify(execFile)(process.execPath, ['--import', 'tsx', join(import.meta.dirname, script), ...args, '--test-root', parent],
          { cwd: join(import.meta.dirname, '..', '..'), timeout: 15000, windowsHide: true })
        assert.fail('The unsafe smoke command must fail')
      } catch (error) {
        const result = error as Error & { code?: number; killed?: boolean; stdout?: string; stderr?: string }
        assert.equal(result.code, 1)
        assert.notEqual(result.killed, true)
        assert.match(result.stderr ?? '', /Unsafe SVN smoke test root/)
        assert.equal(result.stdout, '')
      }
      assert.deepEqual(await readdir(parent), [])
      assert.deepEqual(await readdir(join(root, 'project')), ['.aidocs'])
    })
  })
