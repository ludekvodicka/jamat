import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CommandInvoker } from '../shared/commandInvoker'
import type { CommandRunner } from '../shared/commandInvoker.types'
import { SvnAssemblyReader } from './svnAssembly'
import { SvnInvoker } from './svnInvoker'

const testRoot = 'Q:/UnitTestFiles/NodeJs/Applications/Jamat/worktrees'

/** A worktree of 120 files with an external of 40 files, a translated file and one local change of each kind. */
async function fixture(name: string) {
  const root = await mkdtemp(join(testRoot, `${name}-`)), svn = new SvnInvoker()
  const run = async (cwd: string, args: string[]) => {
    const result = await svn.run(cwd, args)
    expect(result.code, result.stderr).toBe(0)
    return result.stdout
  }
  const repo = join(root, 'repo'), wc = join(root, 'wc'), seed = join(root, 'seed')
  expect((await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repo], cwd: root, env: process.env })).code).toBe(0)
  const url = pathToFileURL(repo).href
  await run(root, ['mkdir', '--parents', '-m', 'Fixture layout', `${url}/trunk/app`, `${url}/shared/lib`])
  await run(root, ['checkout', `${url}/shared/lib`, seed])
  for (let index = 0; index < 40; index++) await writeFile(join(seed, `lib${index}.txt`), `lib ${index}\n`)
  await run(seed, ['add', '--force', '.'])
  await run(seed, ['commit', '-m', 'Fixture library'])
  await run(root, ['checkout', `${url}/trunk`, wc])
  for (const directory of ['app', 'app/deep']) {
    await mkdir(join(wc, directory), { recursive: true })
    for (let index = 0; index < 60; index++) await writeFile(join(wc, directory, `file${index}.txt`), `${directory} ${index}\n`)
  }
  await writeFile(join(wc, 'app', 'eol.txt'), 'one\ntwo\n')
  await run(wc, ['add', '--force', '.'])
  await run(wc, ['propset', 'svn:eol-style', 'CRLF', 'app/eol.txt'])
  await run(wc, ['propset', 'svn:externals', '^/shared/lib lib', 'app'])
  await run(wc, ['commit', '-m', 'Fixture application'])
  await run(wc, ['update'])
  await writeFile(join(wc, 'app', 'file1.txt'), 'changed\n')
  await run(wc, ['delete', 'app/file2.txt'])
  await writeFile(join(wc, 'app', 'new.txt'), 'new\n')
  await run(wc, ['add', 'app/new.txt'])
  await mkdir(join(wc, 'loose'))
  await writeFile(join(wc, 'loose', 'u.txt'), 'unversioned\n')
  await writeFile(join(wc, 'app', 'lib', 'lib3.txt'), 'external change\n')
  return { root, wc, svn }
}

describe.skipIf(process.platform !== 'win32' || !existsSync(testRoot))('SvnAssemblyReader on a real working copy', () => {
  it('reads every root, translated and unversioned node, the same on each read, with at most its svn bound at once', async () => {
    const { root, wc, svn } = await fixture('native-assembly-read')
    try {
      let running = 0, peak = 0
      const counted: CommandRunner = { run: async (cwd, args, options) => {
        peak = Math.max(peak, ++running)
        try { return await svn.run(cwd, args, options) } finally { running-- }
      } }
      const first = await new SvnAssemblyReader(counted).read(wc)
      const second = await new SvnAssemblyReader(svn).read(wc)
      expect(second).toEqual(first)
      const paths = first.nodes.map((node) => node.path)
      expect(paths).toEqual(expect.arrayContaining(['@mount/.', '@mount/app/lib', 'app/eol.txt', 'app/deep/file59.txt', 'app/file2.txt',
        'app/new.txt', 'app/lib/lib39.txt', 'loose', 'loose/u.txt']))
      expect(first.nodes.find((node) => node.path === 'app/file2.txt')?.content).toBe('')
      expect(peak).toBeGreaterThan(1)
      expect(peak).toBeLessThanOrEqual(SvnAssemblyReader.svnProcessesConst)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('names the first unsettled node in status order and leaves no svn running after the failure', async () => {
    const { root, wc, svn } = await fixture('native-assembly-unsettled')
    try {
      await rm(join(wc, 'app', 'deep', 'file7.txt'))
      await rm(join(wc, 'app', 'file9.txt'))
      let running = 0
      const counted: CommandRunner = { run: async (cwd, args, options) => {
        running++
        try { return await svn.run(cwd, args, options) } finally { running-- }
      } }
      await expect(new SvnAssemblyReader(counted).read(wc)).rejects.toThrow('Unsettled SVN node: app/deep/file7.txt')
      expect(running).toBe(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
