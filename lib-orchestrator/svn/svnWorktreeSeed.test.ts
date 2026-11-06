import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CommandOutcome, CommandRunner } from '../shared/commandInvoker.types'
import { SvnWorktreeSeed } from './svnWorktreeSeed'

const url = 'file:///repository/Project'
const repository = 'file:///repository'
const uuid = '11111111-1111-1111-1111-111111111111'

type Reply = Partial<CommandOutcome> | undefined

function infoXml(options: { revision?: number; entryUrl?: string; root?: string; uuid?: string; wcRoot?: string } = {}): string {
  const entryUrl = options.entryUrl ?? url
  return `<?xml version="1.0"?><info><entry kind="dir" path="." revision="${options.revision ?? 41}"><url>${entryUrl}</url>`
    + `<relative-url>^${entryUrl.slice((options.root ?? repository).length) || '/'}</relative-url>`
    + `<repository><root>${options.root ?? repository}</root><uuid>${options.uuid ?? uuid}</uuid></repository>`
    + (options.wcRoot === undefined ? '' : `<wc-info><wcroot-abspath>${options.wcRoot}</wcroot-abspath></wc-info>`) + '</entry></info>'
}

interface Entry { path: string; item: string; props?: string; revision?: number; locked?: true; switched?: true; tree?: true }

function statusXml(entries: readonly Entry[]): string {
  return '<?xml version="1.0"?><status><target path=".">' + entries.map((entry) =>
    `<entry path="${entry.path}"><wc-status item="${entry.item}" props="${entry.props ?? 'none'}"`
    + (entry.revision === undefined ? '' : ` revision="${entry.revision}"`)
    + (entry.locked === true ? ' wc-locked="true"' : '') + (entry.switched === true ? ' switched="true"' : '')
    + (entry.tree === true ? ' tree-conflicted="true"' : '') + '></wc-status></entry>').join('') + '</target></status>'
}

const noExternals = '<?xml version="1.0"?><properties></properties>'

describe('lib-orchestrator/svn/svnWorktreeSeed', () => {
  let root: string
  let owner: string
  let seed: string
  let target: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'jamat-v3-seed-'))
    owner = join(root, 'owner')
    seed = SvnWorktreeSeed.pathOf(owner)
    target = join(owner, '.worktrees', '014-fix')
    await mkdir(join(seed, '.svn'), { recursive: true })
    await writeFile(join(seed, 'a.txt'), 'a\n')
    await writeFile(join(seed, '.svn', 'wc.db'), 'db')
    await mkdir(target)
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  /** A runner answering the seed's and the owner's `svn info` by cwd, and whatever else `more` answers. */
  function scripted(options: { seedInfo?: string; more?: (cwd: string, args: string[]) => Reply } = {}) {
    const calls: { cwd: string; args: string[] }[] = []
    const runner: CommandRunner = { run: async (cwd, args) => {
      calls.push({ cwd, args })
      const reply = args[0] === 'info' && cwd === seed ? { stdout: options.seedInfo ?? infoXml({ wcRoot: seed.replace(/\\/g, '/') }) }
        : args[0] === 'info' && cwd === owner ? { stdout: infoXml({ revision: 40, wcRoot: owner.replace(/\\/g, '/') }) }
          : options.more?.(cwd, args)
      if (reply === undefined) throw new Error(`unexpected svn ${args.join(' ')} in ${cwd}`)
      return { code: 0, stdout: '', stderr: '', failure: null, ...reply }
    } }
    return { runner, calls }
  }

  const copies: { from: string; to: string }[] = []
  const nodeCopy = async (from: string, to: string): Promise<void> => {
    copies.push({ from, to })
    await cp(from, to, { recursive: true, preserveTimestamps: true })
  }
  beforeEach(() => { copies.length = 0 })

  describe('copyInto', () => {
    it('copies the seed with its .svn into the empty reserved folder and names the seed revision', async () => {
      const result = await new SvnWorktreeSeed(scripted().runner, nodeCopy).copyInto({ ownerDir: owner, worktreePath: target, url })
      expect(result).toMatchObject({ ok: true, value: { seed, revision: 41 } })
      expect((await readdir(target)).sort()).toEqual(['.svn', 'a.txt'])
      expect(existsSync(join(target, SvnWorktreeSeed.markerConst))).toBe(false)
      expect(existsSync(join(owner, '.worktrees', '.seed.lock'))).toBe(false)
    })

    it.each([
      ['no seed', async () => { await rm(seed, { recursive: true }) }, {}, /there is no seed/],
      ['a half-copied seed', async () => { await writeFile(join(seed, SvnWorktreeSeed.markerConst), 'x') }, {}, /half copied/],
      ['a folder that is not empty', async () => { await writeFile(join(target, 'x'), 'x') }, {}, /not empty/],
      ['another URL', async () => {}, { seedInfo: infoXml({ entryUrl: `${repository}/Other` }) }, /checks out file:\/\/\/repository\/Other/],
      ['another repository', async () => {}, { seedInfo: infoXml({ uuid: 'other' }) }, /belongs to the repository/],
      ['a seed inside another working copy', async () => {}, { seedInfo: infoXml({ wcRoot: 'C:/elsewhere' }) }, /no working-copy root/],
    ] as const)('falls back for %s, copying nothing', async (_name, arrange, options, reason) => {
      await arrange()
      const before = await readdir(target)
      const result = await new SvnWorktreeSeed(scripted(options).runner, nodeCopy)
        .copyInto({ ownerDir: owner, worktreePath: target, url })
      expect(result).toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(reason) })
      expect(copies).toEqual([])
      expect(await readdir(target)).toEqual(before)
    })

    it('falls back without waiting while another live process holds the seed', async () => {
      const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
      try {
        await writeFile(join(owner, '.worktrees', '.seed.lock'), JSON.stringify({ pid: holder.pid, at: Date.now() }))
        const result = await new SvnWorktreeSeed(scripted().runner, nodeCopy).copyInto({ ownerDir: owner, worktreePath: target, url })
        expect(result).toMatchObject({ ok: false, code: 'refused', detail: expect.stringContaining(`in use by process ${holder.pid}`) })
        expect(copies).toEqual([])
        expect(existsSync(join(owner, '.worktrees', '.seed.lock'))).toBe(true)
      } finally { holder.kill() }
    })

    it('takes over the lock of a holder that is gone', async () => {
      await writeFile(join(owner, '.worktrees', '.seed.lock'), JSON.stringify({ pid: 2 ** 30, at: Date.now() }))
      expect(await new SvnWorktreeSeed(scripted().runner, nodeCopy).copyInto({ ownerDir: owner, worktreePath: target, url })).toMatchObject({ ok: true })
      expect(existsSync(join(owner, '.worktrees', '.seed.lock'))).toBe(false)
    })

    it('reports a failed copy with the marker left, so the caller empties the folder', async () => {
      const result = await new SvnWorktreeSeed(scripted().runner, async () => { throw new Error('disk full') })
        .copyInto({ ownerDir: owner, worktreePath: target, url })
      expect(result).toMatchObject({ ok: false, code: 'io-failed', detail: expect.stringContaining('disk full') })
      expect(await new SvnWorktreeSeed(scripted().runner).interrupted(target)).toBe(true)
    })

    it('copies one seed for two creates at once one after the other, never both together', async () => {
      const second = join(owner, '.worktrees', '015-other')
      await mkdir(second)
      let running = 0
      let overlapped = false
      const slowCopy = async (from: string, to: string): Promise<void> => {
        running += 1
        overlapped ||= running > 1
        await new Promise((done) => setTimeout(done, 30))
        await nodeCopy(from, to)
        running -= 1
      }
      const seeds = new SvnWorktreeSeed(scripted().runner, slowCopy)
      const results = await Promise.all([target, second].map((worktreePath) => seeds.copyInto({ ownerDir: owner, worktreePath, url })))
      expect(results.map((result) => result.ok)).toEqual([true, true])
      expect(overlapped).toBe(false)
      expect(copies.map((copy) => copy.to)).toEqual([target, second])
    })
  })

  describe('problemsOf and proof', () => {
    it('accepts externals and untouched nodes and names everything a fresh checkout never shows', () => {
      const xml = statusXml([
        { path: 'mount', item: 'external' },
        { path: 'old.txt', item: 'normal', revision: 3, locked: true },
        { path: 'ignored.log', item: 'ignored' },
        { path: 'loose.txt', item: 'unversioned' },
        { path: 'edited.txt', item: 'modified', revision: 41 },
        { path: 'props.txt', item: 'normal', props: 'modified', revision: 41 },
        { path: 'locked', item: 'normal', revision: 41, locked: true },
        { path: 'switched', item: 'normal', revision: 41, switched: true },
        { path: 'tree.txt', item: 'normal', revision: 41, tree: true },
      ])
      expect(SvnWorktreeSeed.problemsOf(xml, root, 41)).toEqual(['edited.txt', 'ignored.log', 'locked', 'loose.txt', 'old.txt', 'props.txt', 'switched', 'tree.txt'])
      expect(SvnWorktreeSeed.problemsOf(statusXml([{ path: 'mount', item: 'external' }]), root, 41)).toEqual([])
    })

    it('proves a clean root at the revision and names a dirty status or another revision', async () => {
      const run = (status: string, revision: number) => scripted({ more: (_cwd, args) => args[0] === 'status' ? { stdout: status }
        : args[0] === 'info' ? { stdout: infoXml({ revision }) } : args[0] === 'propget' ? { stdout: noExternals } : undefined }).runner
      expect(await new SvnWorktreeSeed(run(statusXml([{ path: 'mount', item: 'external' }]), 42)).proof(target, 42)).toBeNull()
      expect(await new SvnWorktreeSeed(run(statusXml([{ path: 'node_modules', item: 'ignored' }]), 42)).proof(target, 42)).toMatch(/node_modules/)
      expect(await new SvnWorktreeSeed(run(statusXml([]), 41)).proof(target, 42)).toMatch(/at r41, not r42/)
    })

    it('names an external the definitions name and the disk lacks', async () => {
      const { runner } = scripted({ more: (_cwd, args) => {
        if (args[0] === 'status') return { stdout: statusXml([]) }
        if (args[0] === 'propget') return { stdout: '<?xml version="1.0"?><properties><target path="."><property name="svn:externals">^/Lib lib</property></target></properties>' }
        if (args[0] === 'info' && args.includes('HEAD')) return { stdout: infoXml({ entryUrl: `${repository}/Lib`, revision: 9 }) }
        if (args[0] === 'info') return { stdout: infoXml({ revision: 42 }) }
        return undefined
      } })
      expect(await new SvnWorktreeSeed(runner).proof(target, 42)).toMatch(/externals are missing: .*lib/)
    })
  })

  describe('adopt and refreshLater', () => {
    it('replaces the seed with a copy of the proven checkout, and deletes a copy that is not clean', async () => {
      await writeFile(join(target, 'b.txt'), 'b\n')
      await mkdir(join(target, '.svn'))
      let status = statusXml([])
      const { runner, calls } = scripted({ seedInfo: infoXml({ revision: 42 }), more: (_cwd, args) => args[0] === 'status' ? { stdout: status }
        : args[0] === 'info' ? { stdout: infoXml({ revision: 42 }) } : args[0] === 'propget' ? { stdout: noExternals } : undefined })
      const seeds = new SvnWorktreeSeed(runner, nodeCopy)
      expect(await seeds.adopt({ ownerDir: owner, worktreePath: target, revision: 42 })).toEqual({ ok: true, value: undefined })
      expect((await readdir(seed)).sort()).toEqual(['.svn', 'b.txt'])
      expect(calls.every((call) => call.cwd === seed)).toBe(true)
      status = statusXml([{ path: 'b.txt', item: 'modified', revision: 42 }])
      expect(await seeds.adopt({ ownerDir: owner, worktreePath: target, revision: 42 })).toMatchObject({ ok: false, detail: expect.stringContaining('b.txt') })
      expect(existsSync(seed)).toBe(false)
    })

    it('updates the seed to HEAD in the background with exclusive locking, once for a burst of creates', async () => {
      const { runner, calls } = scripted({ more: (_cwd, args) => args[0] === 'update' ? {} : args[0] === 'status' ? { stdout: statusXml([]) }
        : args[0] === 'propget' ? { stdout: noExternals } : undefined })
      const seeds = new SvnWorktreeSeed(runner, nodeCopy)
      seeds.refreshLater(owner)
      seeds.refreshLater(owner)
      await seeds.settled()
      const updates = calls.filter((call) => call.args[0] === 'update')
      expect(updates).toHaveLength(1)
      expect(updates[0]).toEqual({ cwd: seed, args: ['update', '--non-interactive', '--config-option', 'config:working-copy:exclusive-locking=true', '-q', '--accept', 'postpone', '--', '.'] })
      expect(existsSync(seed)).toBe(true)
    })

    it('deletes a seed whose update fails, so the next slow checkout makes a new one', async () => {
      const { runner } = scripted({ more: (_cwd, args) => args[0] === 'update' ? { code: 1, stderr: 'svn: E170013: Unable to connect' } : undefined })
      const seeds = new SvnWorktreeSeed(runner, nodeCopy)
      seeds.refreshLater(owner)
      await seeds.settled()
      expect(existsSync(seed)).toBe(false)
    })
  })
})
