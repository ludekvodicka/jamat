import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CommandOutcome, CommandRunner } from '../shared/commandInvoker.types'
import type { SvnRoot, SvnWorktreeLocation } from './svn.types'
import { SvnWorktreeManager } from './svnWorktreeManager'

/** Paths whose next purge fails, the way a file another process holds makes it fail. */
const purgeFailures = vi.hoisted(() => new Map<string, Error>())

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      const failure = purgeFailures.get(String(path))
      return failure === undefined ? actual.rm(path, options) : Promise.reject(failure)
    },
  }
})

const url = 'file:///repository/Project'
const repository = 'file:///repository'

type Reply = Partial<CommandOutcome> | undefined
type Handler = (cwd: string, args: string[]) => Reply | Promise<Reply>

/** A runner that answers by command; an unexpected command fails the test with its arguments. */
function scripted(handler: Handler) {
  const calls: { cwd: string; args: string[] }[] = []
  const runner: CommandRunner = { run: async (cwd, args) => {
    calls.push({ cwd, args })
    const reply = await handler(cwd, args)
    if (reply === undefined) throw new Error(`unexpected svn ${args.join(' ')} in ${cwd}`)
    return { code: 0, stdout: '', stderr: '', failure: null, ...reply }
  } }
  return { manager: new SvnWorktreeManager(runner), runner, calls }
}

const failed = (stderr: string): Reply => ({ code: 1, stderr })

function infoXml(options: { revision?: number; entryUrl?: string; wcRoot?: string; path?: string } = {}): string {
  const entryUrl = options.entryUrl ?? url
  return `<?xml version="1.0"?><info><entry kind="dir" path="${options.path ?? '.'}" revision="${options.revision ?? 41}">`
    + `<url>${entryUrl}</url><relative-url>^${entryUrl.slice(repository.length) || '/'}</relative-url>`
    + `<repository><root>${repository}</root></repository>`
    + (options.wcRoot === undefined ? '' : `<wc-info><wcroot-abspath>${options.wcRoot}</wcroot-abspath></wc-info>`)
    + '</entry></info>'
}

interface Entry { path: string; item: string; props?: string; revision?: number; changed?: number; tree?: true }

function statusXml(entries: readonly Entry[]): string {
  return '<?xml version="1.0"?><status><target path=".">' + entries.map((entry) =>
    `<entry path="${entry.path}"><wc-status item="${entry.item}" props="${entry.props ?? 'none'}"`
    + (entry.revision === undefined ? '' : ` revision="${entry.revision}"`)
    + (entry.tree === true ? ' tree-conflicted="true"' : '') + '>'
    + (entry.changed === undefined ? '' : `<commit revision="${entry.changed}"/>`)
    + '</wc-status></entry>').join('') + '</target></status>'
}

function logXml(revision: number, paths: readonly { action: string; path: string }[]): string {
  return `<?xml version="1.0"?><log><logentry revision="${revision}"><paths>`
    + paths.map((path) => `<path action="${path.action}" kind="file">${path.path}</path>`).join('')
    + '</paths></logentry></log>'
}

const has = (args: readonly string[], ...flags: string[]): boolean => flags.every((flag) => args.includes(flag))

describe('lib-orchestrator/svn/svnWorktreeManager', () => {
  let temporary: string

  beforeEach(async () => {
    temporary = await realpath(await mkdtemp(join(tmpdir(), 'jamat-v3-svn-worktree-manager-')))
  })

  afterEach(async () => {
    vi.useRealTimers()
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  })

  describe('owner', () => {
    it('accepts a versioned directory of the project and refuses one outside it, inside a worktree or unversioned', async () => {
      const project = join(temporary, 'Project')
      const member = join(project, 'Member')
      await mkdir(member, { recursive: true })
      const { manager } = scripted((cwd, args) => args[0] !== 'info' ? undefined
        : cwd === member ? { stdout: infoXml({ wcRoot: project }) }
        : failed(`svn: E155007: '${cwd}' is not a working copy`))
      const holdsOtherProject = (): boolean => { throw new Error('a directory below the working-copy root is never asked') }
      await expect(manager.ownerProblem({ ownerDir: member, projectPath: project, holdsOtherProject })).resolves.toBeNull()
      await expect(manager.ownerProblem({ ownerDir: temporary, projectPath: project, holdsOtherProject })).resolves.toMatch(/outside the project/)
      await expect(manager.ownerProblem({ ownerDir: join(project, '.worktrees', '014-x'), projectPath: project, holdsOtherProject }))
        .resolves.toMatch(/inside a worktree/)
      await expect(manager.ownerProblem({ ownerDir: join(project, 'absent'), projectPath: project, holdsOtherProject })).resolves.toMatch(/no directory/)
      await expect(manager.ownerProblem({ ownerDir: project, projectPath: project, holdsOtherProject }))
        .resolves.toBe(`checkpoints mode makes SVN worktrees and ${project} is in no SVN working copy`)
    })

    it('refuses a working-copy root that holds another project and accepts a product group or a standalone repository', async () => {
      const zone = join(temporary, 'Zone')
      await mkdir(zone)
      const { manager } = scripted(() => ({ stdout: infoXml({ wcRoot: zone.replaceAll(sep, '/') }) }))
      await expect(manager.ownerProblem({ ownerDir: zone, projectPath: zone, holdsOtherProject: () => true }))
        .resolves.toMatch(/working-copy root that holds other projects/)
      await expect(manager.ownerProblem({ ownerDir: zone, projectPath: zone, holdsOtherProject: () => false })).resolves.toBeNull()
    })

    it('checks that the owner still checks out the URL and the worktree is the checkout made for it', async () => {
      const owner = join(temporary, 'owner')
      const worktreePath = join(owner, '.worktrees', '014-x')
      await mkdir(join(worktreePath, '.svn'), { recursive: true })
      const directoryId = await SvnWorktreeManager.directoryIdOf(worktreePath) ?? undefined
      let ownerUrl = url
      const { manager } = scripted((cwd, args) => args[0] === 'info' ? { stdout: infoXml({ entryUrl: cwd === owner ? ownerUrl : url }) } : undefined)
      await expect(manager.ownerCheck({ worktreePath, ownerDir: owner, url, directoryId })).resolves.toEqual({ ok: true, value: undefined })
      if (directoryId !== undefined)
        await expect(manager.ownerCheck({ worktreePath, ownerDir: owner, url, directoryId: '1:2:3' }))
          .resolves.toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/another directory/) })
      ownerUrl = `${repository}/Other`
      await expect(manager.ownerCheck({ worktreePath, ownerDir: owner, url, directoryId }))
        .resolves.toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/checks out .*Other, not/) })
    })
  })

  describe('create', () => {
    function creating(_owner: string, options: { ignored?: boolean; checkoutFails?: boolean; whileChecking?: () => Promise<void> } = {}) {
      return scripted(async (cwd, args) => {
        // The owner stands at r40; its URL is at r41 on the server.
        if (args[0] === 'info') return { stdout: infoXml({ revision: args.at(-1) === url ? 41 : 40 }) }
        if (args[0] === 'status' && has(args, '--no-ignore', '--depth', 'immediates')) {
          await options.whileChecking?.()
          return { stdout: statusXml([{ path: '.worktrees', item: options.ignored === false ? 'unversioned' : 'ignored' }]) }
        }
        if (args[0] === 'checkout') {
          const target = join(cwd, args[args.length - 1])
          await mkdir(join(target, '.svn'), { recursive: true })
          return options.checkoutFails === true ? failed('svn: E170013: Unable to connect') : {}
        }
        return undefined
      })
    }

    it('reserves .worktrees/<folder> with the owner URL, the HEAD revision and the folder identity, and checks out nothing', async () => {
      const owner = join(temporary, 'owner')
      await mkdir(owner)
      const { manager, calls } = creating(owner)
      const reserved = await manager.reserve({ ownerDir: owner, folder: '014-fix-login' })
      const worktreePath = join(owner, '.worktrees', '014-fix-login')
      expect(reserved).toEqual({ ok: true, value: { worktreePath, url, baseRevision: 41, directoryId: expect.stringMatching(/^\d+:\d+:\d+$/) } })
      expect(calls.find((call) => call.args[0] === 'checkout')).toBeUndefined()
      expect(calls.filter((call) => call.args[0] === 'info').map((call) => call.args.at(-1))).toEqual(['.', url])
      expect(existsSync(worktreePath)).toBe(true)
      expect(existsSync(join(worktreePath, '.svn'))).toBe(false)
    })

    it('leaves nothing behind when the HEAD of the owner URL cannot be read', async () => {
      const owner = join(temporary, 'owner')
      await mkdir(owner)
      const { manager } = scripted((_cwd, args) => args[0] !== 'info' ? undefined
        : args.at(-1) === url ? failed('svn: E170013: Unable to connect') : { stdout: infoXml() })
      expect(await manager.reserve({ ownerDir: owner, folder: 'x' }))
        .toMatchObject({ ok: false, code: 'svn-failed', detail: expect.stringMatching(/HEAD revision.*E170013/s) })
      expect(existsSync(join(owner, '.worktrees'))).toBe(false)
    })

    it('checks the owner URL out at the reserved HEAD into the folder and names its revision and identity', async () => {
      const owner = join(temporary, 'owner')
      await mkdir(owner)
      const { manager, calls } = creating(owner)
      const created = await manager.create({ ownerDir: owner, folder: '014-fix-login' })
      const worktreePath = join(owner, '.worktrees', '014-fix-login')
      expect(created).toEqual({ ok: true, value: { worktreePath, url, baseRevision: 41, directoryId: expect.any(String) } })
      expect(calls.find((call) => call.args[0] === 'checkout')).toEqual({ cwd: worktreePath,
        args: ['checkout', '--non-interactive', '-q', '--', `${url}@41`, '.'] })
      expect(SvnWorktreeManager.checkoutArgsOf(url, 41, 'quiet')).toEqual(['checkout', '-q', '--', `${url}@41`, '.'])
      expect(SvnWorktreeManager.checkoutArgsOf(url, 41, 'listed')).toEqual(['checkout', '--', `${url}@41`, '.'])
    })

    it('takes the next free name when the folder or its .deleting rest is taken', async () => {
      const owner = join(temporary, 'owner')
      await mkdir(join(owner, '.worktrees', '014-fix-login'), { recursive: true })
      await mkdir(join(owner, '.worktrees', '014-fix-login-2.deleting'))
      const created = await creating(owner).manager.create({ ownerDir: owner, folder: '014-fix-login' })
      expect(created).toMatchObject({ ok: true, value: { worktreePath: join(owner, '.worktrees', '014-fix-login-3') } })
    })

    it('refuses a .worktrees directory SVN does not ignore and removes only what this call made', async () => {
      const owner = join(temporary, 'owner')
      await mkdir(owner)
      expect(await creating(owner, { ignored: false }).manager.create({ ownerDir: owner, folder: 'x' }))
        .toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/SVN does not ignore/) })
      expect(existsSync(join(owner, '.worktrees'))).toBe(false)
      await mkdir(join(owner, '.worktrees'))
      expect(await creating(owner, { ignored: false }).manager.create({ ownerDir: owner, folder: 'x' })).toMatchObject({ ok: false })
      expect(existsSync(join(owner, '.worktrees'))).toBe(true)
    })

    it('leaves no folder behind when the checkout fails', async () => {
      const owner = join(temporary, 'owner')
      await mkdir(owner)
      expect(await creating(owner, { checkoutFails: true }).manager.create({ ownerDir: owner, folder: 'x' }))
        .toMatchObject({ ok: false, code: 'svn-failed', detail: expect.stringMatching(/nothing was left behind.*E170013/s) })
      expect(existsSync(join(owner, '.worktrees'))).toBe(false)
    })

    it('names the folder a failed checkout leaves behind when it cannot be deleted', async () => {
      const owner = join(temporary, 'owner')
      await mkdir(owner)
      const worktreePath = join(owner, '.worktrees', 'x')
      purgeFailures.set(worktreePath, new Error('EBUSY: resource busy or locked'))
      try {
        expect(await creating(owner, { checkoutFails: true }).manager.create({ ownerDir: owner, folder: 'x' })).toMatchObject({
          ok: false,
          code: 'svn-failed',
          detail: expect.stringMatching(/is left behind \(EBUSY: resource busy or locked\); delete it by hand: .*E170013/s),
        })
      }
      finally { purgeFailures.clear() }
      expect(existsSync(worktreePath)).toBe(true)
    })

    // A finish removes the empty `.worktrees` of the same owner while a create is between making it
    // and reserving its folder there.
    it('keeps .worktrees while a create of the same owner is under way', async () => {
      const owner = join(temporary, 'owner')
      await mkdir(owner)
      let manager: SvnWorktreeManager | null = null
      const it_ = creating(owner, { whileChecking: () => manager!.removeEmptyWorktreesDir(owner) })
      manager = it_.manager

      expect(await it_.manager.create({ ownerDir: owner, folder: 'x' }))
        .toMatchObject({ ok: true, value: { worktreePath: join(owner, '.worktrees', 'x') } })
      await it_.manager.removeEmptyWorktreesDir(owner)
      expect(existsSync(join(owner, '.worktrees', 'x'))).toBe(true)
    })

    it('refuses a folder that is no slug', async () => {
      expect(await creating(temporary).manager.create({ ownerDir: temporary, folder: '../x' })).toMatchObject({ ok: false, code: 'refused' })
      expect(await creating(temporary).manager.reserve({ ownerDir: temporary, folder: '../x' })).toMatchObject({ ok: false, code: 'refused' })
    })
  })

  describe('a reserved folder', () => {
    it('is emptied for another checkout and keeps its identity', async () => {
      const worktreePath = join(temporary, 'owner', '.worktrees', 'x')
      await mkdir(join(worktreePath, '.svn', 'tmp'), { recursive: true })
      await writeFile(join(worktreePath, 'half.txt'), 'half\n', 'utf8')
      const directoryId = await SvnWorktreeManager.directoryIdOf(worktreePath) ?? undefined
      const { manager, calls } = scripted(() => undefined)

      expect(await manager.purgeReserved({ worktreePath, directoryId })).toEqual({ ok: true, value: undefined })
      expect(existsSync(join(worktreePath, '.svn'))).toBe(false)
      expect(existsSync(join(worktreePath, 'half.txt'))).toBe(false)
      expect(await SvnWorktreeManager.directoryIdOf(worktreePath)).toBe(directoryId ?? null)
      expect(calls).toEqual([])
    })

    it('is never emptied when it is another directory, carries no identity or is gone', async () => {
      const worktreePath = join(temporary, 'owner', '.worktrees', 'x')
      await mkdir(worktreePath, { recursive: true })
      await writeFile(join(worktreePath, 'keep.txt'), 'keep\n', 'utf8')
      const { manager } = scripted(() => undefined)

      expect(await manager.purgeReserved({ worktreePath, directoryId: '1:2:3' }))
        .toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/another directory.*nothing was deleted/) })
      expect(await manager.purgeReserved({ worktreePath }))
        .toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/no file ID.*nothing was deleted/) })
      expect(existsSync(join(worktreePath, 'keep.txt'))).toBe(true)
      expect(await manager.purgeReserved({ worktreePath: join(temporary, 'gone'), directoryId: '1:2:3' }))
        .toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/is gone/) })
    })
  })

  describe('working-copy root', () => {
    it('reads the root of the working copy holding a directory from svn info XML', async () => {
      const directory = join(temporary, 'Group', 'Member')
      await mkdir(directory, { recursive: true })
      const { manager } = scripted(() => ({ stdout: infoXml({ wcRoot: 'C:/Zone/R&amp;D' }) }))
      expect(await manager.workingCopyRootOf(directory)).toEqual({ ok: true, value: 'C:/Zone/R&D' })
    })

    it('answers no directory and an unversioned directory with their reasons', async () => {
      const { manager } = scripted(() => failed('svn: E155007: not a working copy'))
      expect(await manager.workingCopyRootOf(join(temporary, 'absent'))).toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/no directory/) })
      expect(await manager.workingCopyRootOf(temporary)).toMatchObject({ ok: false, code: 'not-a-working-copy' })
    })
  })

  // The update itself is a run of the SVN action now; these are the reads and writes around it.
  describe('around the update run', () => {
    const changedBefore: Entry[] = [{ path: 'src/a.txt', item: 'modified', revision: 5 }, { path: 'gone', item: 'missing', revision: 5 },
      { path: 'gone/inner.txt', item: 'missing', revision: 5 }, { path: 'mount', item: 'external' }]

    it('schedules each deletion from disk once, at its top, before the update', async () => {
      const { manager, calls } = scripted((cwd, args) => cwd !== temporary ? undefined
        : args[0] === 'status' ? { stdout: statusXml(changedBefore) } : args[0] === 'delete' ? {} : undefined)
      expect(await manager.scheduleMissing(temporary)).toEqual({ ok: true, value: undefined })
      expect(calls.map((call) => call.args)).toEqual([
        ['status', '--non-interactive', '--xml', '--', '.'],
        ['delete', '--non-interactive', '-q', '--force', '--', 'gone@'],
      ])
    })

    it('never schedules a file missing at or below a recorded conflict victim, and schedules one outside it', async () => {
      const { manager, calls } = scripted((cwd, args) => cwd !== temporary ? undefined
        : args[0] === 'status' ? { stdout: statusXml([...changedBefore, { path: '.aidocs/engines/t2/brief.md', item: 'missing', revision: 5 },
          { path: '.aidocs/engines', item: 'missing', revision: 5 }]) }
        : args[0] === 'delete' ? {} : undefined)
      expect(await manager.scheduleMissing(temporary, ['.aidocs/engines', 'src/catalog.ts'])).toEqual({ ok: true, value: undefined })
      expect(calls.map((call) => call.args)).toEqual([
        ['status', '--non-interactive', '--xml', '--', '.'],
        ['delete', '--non-interactive', '-q', '--force', '--', 'gone@'],
      ])
    })

    it('names a file deleted from disk whose name svn cannot take, and passes nothing', async () => {
      const { manager, calls } = scripted((_cwd, args) => args[0] === 'status'
        ? { stdout: statusXml([{ path: 'složka/ř.txt', item: 'missing', revision: 5 }]) } : undefined)
      expect(await manager.scheduleMissing(temporary)).toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/složka\/ř.txt/) })
      expect(calls).toHaveLength(1)
    })

    it('marks conflicts resolved as the files stand, in batches, and passes no name svn cannot take', async () => {
      const { manager, calls } = scripted((cwd, args) => cwd === temporary && args[0] === 'resolve' ? {} : undefined)
      const many = Array.from({ length: 51 }, (_, index) => `src/f${index}.txt`)
      expect(await manager.resolveWorking(temporary, ['a.txt', ...many])).toEqual({ ok: true, value: undefined })
      expect(calls.map((call) => call.args.slice(0, 6))).toEqual([
        ['resolve', '--non-interactive', '--accept', 'working', '--', 'a.txt@'],
        ['resolve', '--non-interactive', '--accept', 'working', '--', 'src/f49.txt@'],
      ])
      expect(calls.map((call) => call.args.length - 5)).toEqual([50, 2])

      const refused = scripted(() => undefined)
      expect(await refused.manager.resolveWorking(temporary, ['a.txt', 'složka/ř.txt']))
        .toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/složka\/ř.txt/) })
      expect(refused.calls).toEqual([])

      const failing = scripted(() => failed('svn: E155010: The node was not found'))
      expect(await failing.manager.resolveWorking(temporary, ['a.txt'])).toMatchObject({ ok: false, code: 'svn-failed' })
    })

    it('reads text conflicts apart from tree and property conflicts, and the changes beside them', async () => {
      const after: Entry[] = [{ path: 'src/a.txt', item: 'conflicted', revision: 9 }, { path: 'tree.txt', item: 'normal', tree: true },
        { path: 'props.txt', item: 'normal', props: 'conflicted' }, { path: 'src/b.txt', item: 'modified', revision: 9 }]
      const { manager } = scripted((_cwd, args) => args[0] === 'status' ? { stdout: statusXml(after) } : undefined)
      expect(await manager.status(temporary)).toEqual({ ok: true, value: {
        textConflicts: ['src/a.txt'],
        otherConflicts: ['tree.txt', 'props.txt'],
        changed: ['src/a.txt', 'props.txt', 'src/b.txt'],
      } })
    })

    it('reads incoming paths of a changed project from svn log -v between the BASE before and after, never its own commits', async () => {
      const { manager, calls } = scripted((_cwd, args) => {
        if (args[0] === 'info') return { stdout: infoXml({ revision: 9 }) }
        if (args[0] === 'log') return { stdout: '<?xml version="1.0"?><log>'
          + '<logentry revision="6"><paths><path action="M" kind="file">/Project/src/a.txt</path></paths></logentry>'
          + '<logentry revision="8"><paths><path action="M" kind="file">/Project/src/b.txt</path>'
          + '<path action="M" kind="file">/Project/.aidocs/n.md</path></paths></logentry></log>' }
        return undefined
      })
      expect(await manager.incoming(temporary, 5, ['src/a.txt'], [6])).toEqual({ ok: true, value: ['src/b.txt'] })
      expect(calls.find((call) => call.args[0] === 'log')?.args).toEqual(['log', '--non-interactive', '-v', '--xml', '-r', '6:9', '--', url])
      expect(await manager.incoming(temporary, 9, ['src/a.txt'], [])).toEqual({ ok: true, value: [] })
      expect(calls.filter((call) => call.args[0] === 'log')).toHaveLength(1)
    })

    it('in a product group counts only the member projects the session changed', async () => {
      await writeFile(join(temporary, '.appgroup'), '')
      const { manager } = scripted((_cwd, args) => args[0] === 'info' ? { stdout: infoXml({ revision: 9 }) }
        : args[0] === 'log' ? { stdout: logXml(8, [{ action: 'M', path: '/Project/MemberB/b.txt' }]) } : undefined)
      expect(await manager.incoming(temporary, 5, ['MemberA/a.txt'], [])).toEqual({ ok: true, value: [] })
      expect(await manager.incoming(temporary, 5, ['MemberB/x.txt'], [])).toEqual({ ok: true, value: ['MemberB/b.txt'] })
    })

    it('reads a working copy as locked by an svn lock error or a locked directory', async () => {
      const locked = scripted(() => failed(`svn: E155004: Working copy '${temporary}' locked.`)).manager
      expect(await locked.locked(temporary)).toBe(true)
      const marked = scripted(() => ({ stdout: `<status><target path="."><entry path="."><wc-status item="normal" props="none" wc-locked="true"/></entry></target></status>` })).manager
      expect(await marked.locked(temporary)).toBe(true)
      const free = scripted(() => ({ stdout: statusXml([{ path: 'a.txt', item: 'modified' }]) })).manager
      expect(await free.locked(temporary)).toBe(false)
      expect(await scripted(() => failed('svn: E170013: Unable to connect')).manager.locked(temporary)).toBe(false)
    })

    it('marks a mount whose external definition names a revision, and asks for definitions only when a mount exists', async () => {
      await mkdir(join(temporary, 'pinned', '.svn'), { recursive: true })
      await mkdir(join(temporary, 'floating', '.svn'), { recursive: true })
      const rows: Entry[] = [{ path: 'pinned', item: 'external' }, { path: 'floating', item: 'external' },
        { path: 'pinned/p.txt', item: 'modified', revision: 4 }]
      const { manager, calls } = scripted((_cwd, args) => args[0] === 'status' ? { stdout: statusXml(rows) }
        : args[0] === 'propget' ? { stdout: `<properties><target path="."><property name="svn:externals">^/libs/p@3 pinned\n^/libs/f floating</property></target></properties>` }
          : undefined)
      const roots = await manager.reviewRoots(temporary)
      expect(roots.ok && roots.value.map((root) => ({ own: root.own, pinned: root.pinned, changed: root.changed.length }))).toEqual([
        { own: 'floating', pinned: false, changed: 0 },
        { own: 'pinned', pinned: true, changed: 1 },
        { own: '', pinned: false, changed: 0 },
      ])
      expect(calls.find((call) => call.args[0] === 'propget')?.args).toEqual(['propget', '--non-interactive', 'svn:externals', '-R', '--xml', '--', '.'])

      const plain = scripted((_cwd, args) => args[0] === 'status' ? { stdout: statusXml([{ path: 'a.txt', item: 'modified' }]) } : undefined)
      expect(await plain.manager.reviewRoots(temporary)).toMatchObject({ ok: true, value: [{ own: '', pinned: false }] })
      expect(plain.calls.some((call) => call.args[0] === 'propget')).toBe(false)
    })

    it('fingerprints the worktree by its status and the size and time of each changed file', async () => {
      await writeFile(join(temporary, 'a.txt'), 'one\n')
      const { manager } = scripted((_cwd, args) => args[0] === 'status' ? { stdout: statusXml([{ path: 'a.txt', item: 'modified', revision: 5 }]) } : undefined)
      const first = await manager.fingerprint(temporary)
      expect(await manager.fingerprint(temporary)).toEqual(first)
      await writeFile(join(temporary, 'a.txt'), 'one and two\n')
      const second = await manager.fingerprint(temporary)
      expect(second.ok && first.ok && second.value !== first.value).toBe(true)
    })

    it('takes the working copies below a plain directory svn marks as external, never that directory itself', async () => {
      // `clients/coinGecko` and `clients/telegram` defined on `shared` make svn mark `shared/clients`,
      // a directory svn created and holds no node of; `shared/gone` names an external not on disk.
      for (const mount of [['shared', 'app'], ['shared', 'clients', 'coinGecko'], ['shared', 'clients', 'telegram']])
        await mkdir(join(temporary, ...mount, '.svn'), { recursive: true })
      const rows: Entry[] = [{ path: 'shared/app', item: 'external' }, { path: 'shared/clients', item: 'external' },
        { path: 'shared/gone', item: 'external' }, { path: 'shared/clients/telegram/t.ts', item: 'modified', revision: 4 }]
      const { manager } = scripted((cwd, args) => cwd === temporary && args[0] === 'status' ? { stdout: statusXml(rows) } : undefined)
      const telegram = [{ kind: 'item', conflict: false, path: 'shared/clients/telegram/t.ts' }]
      expect(await manager.roots(temporary)).toEqual({ ok: true, value: [
        { path: join(temporary, 'shared', 'clients', 'coinGecko'), own: 'shared/clients/coinGecko', changed: [] },
        { path: join(temporary, 'shared', 'clients', 'telegram'), own: 'shared/clients/telegram', changed: telegram },
        { path: join(temporary, 'shared', 'app'), own: 'shared/app', changed: [] },
        { path: temporary, own: '', changed: [] },
      ] })
    })

  })

  describe('merger handover', () => {
    it('hashes a file by content, a folder by the names and contents below it, and an absent path as missing, reading files only', async () => {
      await mkdir(join(temporary, 'src', 'deep'), { recursive: true })
      await writeFile(join(temporary, 'src', 'a.ts'), 'one\n')
      await writeFile(join(temporary, 'src', 'deep', 'b.ts'), 'two\n')
      const { manager, calls } = scripted(() => undefined)
      const first = await manager.hashes(temporary, ['src/a.ts', 'src', 'gone.ts'])
      expect(first.ok && first.value['src/a.ts']).toBe(createHash('sha256').update('one\n').digest('hex'))
      expect(first.ok && first.value['src']).toMatch(/^dir:[0-9a-f]{64}$/)
      expect(first.ok && first.value['gone.ts']).toBe('missing')
      await writeFile(join(temporary, 'src', 'deep', 'b.ts'), 'two changed\n')
      const second = await manager.hashes(temporary, ['src', 'src/a.ts'])
      expect(second.ok && second.value['src']).not.toBe(first.ok && first.value['src'])
      expect(second.ok && second.value['src/a.ts']).toBe(first.ok && first.value['src/a.ts'])
      expect(calls).toEqual([])
    })

    it('answers the highest BASE past a revision from status -v without externals, or null', async () => {
      const { manager, calls } = scripted((_cwd, args) => args[0] === 'status'
        ? { stdout: statusXml([{ path: temporary, item: 'normal', revision: 42 }, { path: join(temporary, 'a.txt'), item: 'normal', revision: 43 }]) }
        : undefined)
      expect(await manager.baseAbove(temporary, 42)).toEqual({ ok: true, value: 43 })
      expect(await manager.baseAbove(temporary, 43)).toEqual({ ok: true, value: null })
      expect(has(calls[0].args, 'status', '-v', '--xml', '--ignore-externals')).toBe(true)
    })
  })

  describe('conflict set', () => {
    const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex')
    const entry = (path: string, kind: string, inner = ''): string =>
      `<entry kind="${kind}" path="${path}" revision="9"><url>${url}/${path}</url><wc-info><schedule>normal</schedule>${inner}</wc-info>`
    const tree = '<tree-conflict reason="unversioned" victim="engines" action="add" operation="update" kind="dir">'
      + `<version side="source-right" kind="dir" revision="9" path-in-repos="Project/.aidocs/engines" repos-url="${repository}"/></tree-conflict>`

    it('reads every kind together, each victim in its parent, and passes svn no name it cannot take', async () => {
      await mkdir(join(temporary, '.aidocs', 'engines', 't1'), { recursive: true })
      await mkdir(join(temporary, '.aidocs', 'engines', 't2'), { recursive: true })
      await writeFile(join(temporary, '.aidocs', 'engines', 't1', 'brief.md'), 'session t1\n')
      await writeFile(join(temporary, '.aidocs', 'engines', 't2', 'brief.md'), 'session t2\n')
      const folder = join(temporary, 'složka')
      await mkdir(folder)
      await writeFile(join(folder, 'ř.txt.mine'), 'one\r\ntwo\r\n')
      await writeFile(join(folder, 'ř.txt.r9'), 'one\ntwo\n')
      const slash = (path: string): string => path.replaceAll(sep, '/')
      const status = statusXml([
        { path: '.aidocs/engines', item: 'deleted', revision: 9, tree: true },
        { path: '.aidocs/engines/t1', item: 'unversioned' },
        { path: 'složka/ř.txt', item: 'conflicted', revision: 9 },
        { path: 'a.txt', item: 'normal', props: 'conflicted', revision: 9 },
      ])
      const properties = (target: string, value: string): string =>
        `<properties><target path="${target}"><property name="svn:ignore">${value}</property></target></properties>`
      const { manager, calls } = scripted((cwd, args) => {
        if (args[0] === 'status') return { stdout: status }
        if (args[0] === 'info' && !args.includes('--depth')) return { stdout: infoXml({ revision: 9 }) }
        if (args[0] === 'info' && cwd === temporary)
          return { stdout: `<info>${entry('.', 'dir')}</entry>${entry('a.txt', 'file')}<conflict type="property"><prop-file>${slash(temporary)}/a.txt.prej</prop-file></conflict></entry></info>` }
        if (args[0] === 'info' && cwd === join(temporary, '.aidocs') && args.includes('immediates'))
          return { stdout: `<info>${entry('.', 'dir')}</entry>${entry('engines', 'dir')}${tree}</entry></info>` }
        if (args[0] === 'info' && cwd === join(temporary, '.aidocs') && args.includes('infinity'))
          return { stdout: `<info>${entry('engines', 'dir')}</entry>${entry('engines\\t2', 'dir')}</entry>`
            + `${entry('engines\\t2\\brief.md', 'file', `<checksum>${sha1('incoming\n')}</checksum>`)}</entry>`
            + `${entry('engines\\t2\\trail.md', 'file', `<checksum>${sha1('trail\n')}</checksum>`)}</entry></info>` }
        if (args[0] === 'info' && cwd === folder)
          return { stdout: `<info>${entry('.', 'dir')}</entry>${entry('ř.txt', 'file')}<conflict type="text">`
            + `<prev-base-file>${slash(folder)}/ř.txt.r5</prev-base-file><prev-wc-file>${slash(folder)}/ř.txt.mine</prev-wc-file>`
            + `<cur-base-file>${slash(folder)}/ř.txt.r9</cur-base-file></conflict></entry></info>` }
        if (args[0] === 'proplist' && args.includes(`${url}/.@5`)) return { stdout: properties(`${url}/.`, 'a\n') }
        if (args[0] === 'proplist' && args.includes('BASE')) return { stdout: properties('a.txt', 'a\nc\n') }
        if (args[0] === 'proplist') return { stdout: properties('a.txt', 'a\nb\n') }
        return undefined
      })

      const read = await manager.conflictSet(temporary, 5)
      expect(read).toMatchObject({ ok: true, value: { revision: 9 } })
      const facts = read.ok ? read.value.facts : []
      expect(facts.map((fact) => [fact.path, fact.kind, fact.takesArgument])).toEqual([
        ['.aidocs/engines', 'tree', true], ['složka/ř.txt', 'text', false], ['a.txt', 'property', true],
      ])
      expect(facts[0]).toMatchObject({
        tree: { reason: 'unversioned', action: 'added', localKind: 'dir', incomingKind: 'dir', incomingRevision: 9, localHistory: false },
        content: { files: { local: 2, incoming: 2, same: 0, differing: 1 } },
      })
      expect(facts[1]).toMatchObject({ sidecars: ['složka/ř.txt.r5', 'složka/ř.txt.mine', 'složka/ř.txt.r9'], content: { equal: 'eol' } })
      expect(facts[2]).toMatchObject({ sidecars: ['a.txt.prej'], properties: [{ name: 'svn:ignore', older: null, mine: 'a\nb\n', theirs: 'a\nc\n' }] })
      expect(read.ok && read.value.rows.filter((row) => row.conflict).map((row) => row.path)).toEqual(['.aidocs/engines', 'složka/ř.txt', 'a.txt'])
      expect(calls.find((call) => call.cwd === folder)?.args).toEqual(['info', '--non-interactive', '--xml', '--depth', 'immediates', '--', '.'])
      expect(calls.some((call) => call.args.some((arg) => /[^\x20-\x7e]/.test(arg)))).toBe(false)
    })

    it('reads the root alone with depth empty, and a property absent before the update from a parent svn did not have', async () => {
      const { manager, calls } = scripted((_cwd, args) => {
        if (args[0] === 'status') return { stdout: statusXml([{ path: '.', item: 'normal', props: 'conflicted', revision: 9 }]) }
        if (args[0] === 'info' && !args.includes('--depth')) return { stdout: infoXml({ revision: 9 }) }
        if (args[0] === 'info') return { stdout: `<info>${entry('.', 'dir')}<conflict type="property"/></entry></info>` }
        if (args[0] === 'proplist' && args.some((arg) => arg.endsWith('@5'))) return failed('svn: E160013: path not found')
        if (args[0] === 'proplist') return { stdout: `<properties><target path="."><property name="p">${args.includes('BASE') ? 'theirs' : 'mine'}</property></target></properties>` }
        return undefined
      })
      expect(await manager.conflictSet(temporary, 5)).toMatchObject({ ok: true, value: { facts: [{ path: '.', kind: 'property',
        properties: [{ name: 'p', older: null, mine: 'mine', theirs: 'theirs' }] }] } })
      expect(calls.find((call) => call.args.includes('--depth'))?.args).toEqual(['info', '--non-interactive', '--xml', '--depth', 'empty', '--', '.'])
    })

    it('answers a failed read as an svn failure and reads nothing more for a set without conflicts', async () => {
      expect(await scripted(() => failed('svn: E155037: Previous operation has not finished')).manager.conflictSet(temporary, 5))
        .toMatchObject({ ok: false, code: 'locked' })
      const clean = scripted((_cwd, args) => args[0] === 'status' ? { stdout: statusXml([{ path: 'a.txt', item: 'modified', revision: 9 }]) }
        : args[0] === 'info' ? { stdout: infoXml({ revision: 9 }) } : undefined)
      expect(await clean.manager.conflictSet(temporary, 5)).toEqual({ ok: true, value: { revision: 9, facts: [],
        rows: [{ path: 'a.txt', item: 'modified', conflict: false, base: 9 }] } })
      expect(clean.calls).toHaveLength(2)
    })
  })

  describe('proofs', () => {
    const fixture = (name: string, root: string, main: string): string =>
      readFileSync(join(import.meta.dirname, 'fixtures', 'worktree', name), 'utf8')
        .replaceAll('{ROOT}', root).replaceAll('{MAIN}', main).replaceAll('{REPO}', repository).replaceAll('\\', sep)
    const root = (path: string, changed: SvnRoot['changed'] = []): SvnRoot => ({ path, own: '', changed })

    it('finds the commits of the worktree itself since its checkout, confirmed by svn log -v', async () => {
      const worktree = join(temporary, 'worktree')
      const main = join(temporary, 'main')
      const { manager, calls } = scripted((cwd, args) => {
        if (cwd === worktree && args[0] === 'status') return { stdout: fixture('status-verbose-foreign.xml', worktree, main) }
        if (cwd === worktree && args[0] === 'info') return { stdout: fixture('info-worktree.xml', worktree, main) }
        if (args[0] === 'log') return { stdout: fixture(args.includes('6:6') ? 'log-committed.xml' : 'log-foreign.xml', worktree, main) }
        return undefined
      })
      expect(await manager.ownCommits(root(worktree))).toEqual({ ok: true, value: {
        repository, rows: [{ revision: 6, action: 'M', path: 'src/a.txt' }],
      } })
      expect(calls.filter((call) => call.args[0] === 'log')).toHaveLength(2)
      expect(calls.some((call) => call.cwd === main)).toBe(false)
    })

    it('reports a worktree directory present until it is gone', async () => {
      const { manager } = scripted(() => undefined)
      await mkdir(join(temporary, 'worktree'))

      expect(await manager.present(join(temporary, 'worktree'))).toBe(true)
      expect(await manager.present(join(temporary, 'gone'))).toBe(false)
    })

    it('reads the lower bounds once per repository and proves a review by its receipt or by BASE', async () => {
      const worktree = join(temporary, 'worktree')
      const mount = join(worktree, 'mount')
      const { manager, calls } = scripted((cwd, args) => {
        if (args[0] === 'info' && args.at(-1) === repository) return { stdout: infoXml({ revision: 5, entryUrl: repository }) }
        if (args[0] === 'info') return { stdout: infoXml({ revision: 5 }) }
        if (args[0] === 'log') return { stdout: logXml(6, [{ action: 'M', path: '/Project/src/a.txt' }]) }
        if (args[0] === 'status' && cwd === worktree)
          return { stdout: statusXml([{ path: 'src/a.txt', item: 'normal', revision: 6, changed: 6 }, { path: 'src', item: 'normal', revision: 5, changed: 4 }]) }
        return undefined
      })
      const roots = [{ path: mount, own: 'mount', changed: [] }, root(worktree, [{ kind: 'item', conflict: false, path: 'src/a.txt' }])]
      const bounds = await manager.lowerBounds(roots)
      expect(bounds).toEqual({ ok: true, value: {
        mount: { repository, base: '/Project', rootBase: 5, since: 5 },
        '': { repository, base: '/Project', rootBase: 5, since: 5 },
      } })
      expect(calls.filter((call) => call.args.at(-1) === repository)).toHaveLength(1)
      if (!bounds.ok) return
      expect(await manager.reviewed(roots[1], bounds.value, 6)).toEqual({ ok: true, value: [{ revision: 6, action: 'M', path: 'src/a.txt' }] })
      expect(await manager.reviewed(roots[1], bounds.value, 5)).toMatchObject({ ok: false, detail: expect.stringMatching(/pre-review/) })
      expect(await manager.proven(roots[1], bounds.value)).toEqual({ ok: true, value: [{ revision: 6, action: 'M', path: 'src/a.txt' }] })
    })

    it('answers a failed svn read inside a proof with its code', async () => {
      const { manager } = scripted(() => failed('svn: E170013: Unable to connect'))
      expect(await manager.ownCommits(root(temporary))).toMatchObject({ ok: false, code: 'svn-failed', detail: expect.stringMatching(/E170013/) })
    })
  })

  // Removed with the main-copy landing: no step writes the main copy after a commit any more.
  describe('removal', () => {
    async function worktree(name = '014-x'): Promise<SvnWorktreeLocation> {
      const owner = join(temporary, 'owner')
      const worktreePath = join(owner, '.worktrees', name)
      await mkdir(join(worktreePath, '.svn'), { recursive: true })
      await writeFile(join(worktreePath, 'a.txt'), 'a\n')
      return { worktreePath, ownerDir: owner, url, directoryId: await SvnWorktreeManager.directoryIdOf(worktreePath) ?? undefined }
    }
    const noSvn = (): Reply => undefined

    it('renames the worktree aside, purges it and removes the empty .worktrees', async () => {
      const location = await worktree()
      const { manager } = scripted(noSvn)
      expect(await manager.renameAside(location)).toEqual({ ok: true, value: 'renamed' })
      expect(existsSync(`${location.worktreePath}.deleting`)).toBe(true)
      expect(await manager.renameAside(location)).toEqual({ ok: true, value: 'renamed' })
      expect(await manager.purgeAside(location)).toEqual({ ok: true, value: 'removed' })
      await manager.removeEmptyWorktreesDir(location.ownerDir)
      expect(existsSync(join(location.ownerDir, '.worktrees'))).toBe(false)
      expect(await manager.renameAside(location)).toEqual({ ok: true, value: 'absent' })
    })

    it('refuses another directory at the recorded path', async () => {
      const location = await worktree()
      if (location.directoryId === undefined) return
      const { manager } = scripted(noSvn)
      expect(await manager.renameAside({ ...location, directoryId: '1:2:3' }))
        .toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/another directory/) })
      expect(existsSync(location.worktreePath)).toBe(true)
    })

    it('without a file ID decides by the URL the worktree checks out', async () => {
      const location = { ...await worktree(), directoryId: undefined }
      let checkedOut = `${repository}/Other`
      const { manager } = scripted((_cwd, args) => args[0] === 'info' ? { stdout: infoXml({ entryUrl: checkedOut }) } : undefined)
      expect(await manager.renameAside(location)).toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/Other, not/) })
      checkedOut = url
      expect(await manager.renameAside(location)).toEqual({ ok: true, value: 'renamed' })
    })

    it.skipIf(process.platform !== 'win32')('answers in-use while a process has its working directory inside', async () => {
      const location = await worktree()
      const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'],
        { cwd: location.worktreePath, stdio: ['ignore', 'pipe', 'ignore'] })
      try {
        // The child opens its working directory while it starts, after `spawn` already fired.
        await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject) })
        expect(await scripted(noSvn).manager.renameAside(location)).toEqual({ ok: true, value: 'in-use' })
        expect(await readFile(join(location.worktreePath, 'a.txt'), 'utf8')).toBe('a\n')
      }
      finally {
        const exited = new Promise((resolve) => child.once('exit', resolve))
        child.kill()
        await exited
      }
      expect(await scripted(noSvn).manager.renameAside(location)).toEqual({ ok: true, value: 'renamed' })
    })

    it('purges through the remover its composer hands in', async () => {
      const location = await worktree()
      const removed: string[] = []
      const manager = new SvnWorktreeManager(scripted(noSvn).runner, async (path) => {
        removed.push(path)
        await rm(path, { recursive: true, force: true })
      })
      expect(await manager.renameAside(location)).toEqual({ ok: true, value: 'renamed' })
      expect(await manager.purgeAside(location)).toEqual({ ok: true, value: 'removed' })
      expect(removed).toEqual([`${location.worktreePath}.deleting`])
    })

    it('answers undeleted when the remover fails, and keeps the rest for the next pass', async () => {
      const location = await worktree()
      const manager = new SvnWorktreeManager(scripted(noSvn).runner, async () => {
        throw new Error('EBUSY: resource busy or locked')
      })
      expect(await manager.renameAside(location)).toEqual({ ok: true, value: 'renamed' })
      expect(await manager.purgeAside(location)).toEqual({ ok: true, value: 'undeleted' })
      expect(existsSync(`${location.worktreePath}.deleting`)).toBe(true)
    })

    it('unlinks a junction into a shared store without touching the store, and removes a path beyond 260 characters', async () => {
      const store = join(temporary, 'store', 'package')
      await mkdir(store, { recursive: true })
      await writeFile(join(store, 'index.js'), 'shared\n')
      const location = await worktree()
      await mkdir(join(location.worktreePath, 'node_modules'))
      await symlink(store, join(location.worktreePath, 'node_modules', 'package'), 'junction')
      const deep = join(location.worktreePath, ...Array.from({ length: 6 }, (_, index) => `${index}`.padEnd(50, 'd')))
      expect(join(deep, 'file.txt').length).toBeGreaterThan(260)
      await mkdir(deep, { recursive: true })
      await writeFile(join(deep, 'file.txt'), 'deep\n')
      const { manager } = scripted(noSvn)
      expect(await manager.renameAside(location)).toEqual({ ok: true, value: 'renamed' })
      expect(await manager.purgeAside(location)).toEqual({ ok: true, value: 'removed' })
      expect(existsSync(`${location.worktreePath}.deleting`)).toBe(false)
      expect(await readFile(join(store, 'index.js'), 'utf8')).toBe('shared\n')
    })
  })

  describe('landed rows', () => {
    it('reads the root revision and repository of a main copy locally', async () => {
      const { manager, calls } = scripted((_cwd, args) => args[0] === 'info' ? { stdout: infoXml({ revision: 57 }) } : undefined)
      expect(await manager.rootRevisionOf(temporary)).toEqual({ ok: true, value: { repository, revision: 57 } })
      expect(calls.map((call) => call.args)).toEqual([['info', '--non-interactive', '--xml', '--', '.']])
    })

    it('counts the revisions after the root revision from svn log -q, and reads E160006 as none behind', async () => {
      const entries = '<?xml version="1.0"?><log><logentry revision="58"><author>a</author></logentry>'
        + '<logentry revision="60"><author>a</author></logentry><logentry\n   revision="61"></logentry></log>'
      const behind = scripted((_cwd, args) => {
        if (args[0] === 'info') return { stdout: infoXml({ revision: 57 }) }
        if (args[0] === 'log') return { stdout: entries }
        return undefined
      })
      expect(await behind.manager.behind(temporary)).toEqual({ ok: true, value: 3 })
      expect(behind.calls[1].args).toEqual(['log', '--non-interactive', '-q', '--xml', '-r', '58:HEAD', '--', '.'])
      const current = scripted((_cwd, args) => {
        if (args[0] === 'info') return { stdout: infoXml({ revision: 61 }) }
        if (args[0] === 'log') return { code: 1, stdout: '<?xml version="1.0"?>\n<log>\n', stderr: 'svn: E160006: No such revision 62' }
        return undefined
      })
      expect(await current.manager.behind(temporary)).toEqual({ ok: true, value: 0 })
      const offline = scripted((_cwd, args) => {
        if (args[0] === 'info') return { stdout: infoXml({ revision: 61 }) }
        if (args[0] === 'log') return failed('svn: E170013: Unable to connect to a repository')
        return undefined
      })
      expect(await offline.manager.behind(temporary)).toMatchObject({ ok: false, code: 'svn-failed' })
    })

    it('lists the working copies of the mounts below a main copy, never the main copy itself', async () => {
      await mkdir(join(temporary, 'shared', 'frontend', '.svn'), { recursive: true })
      const rows: Entry[] = [{ path: 'shared/frontend', item: 'external' }, { path: 'a.txt', item: 'modified', revision: 3 }]
      const { manager } = scripted((_cwd, args) => args[0] === 'status' ? { stdout: statusXml(rows) } : undefined)
      expect(await manager.mountRootsOf(temporary)).toEqual({ ok: true, value: [join(temporary, 'shared', 'frontend')] })
    })
  })

  describe('facts', () => {
    it('counts diff lines per working copy and each file of an unversioned directory, never an ignored one', async () => {
      await mkdir(join(temporary, 'newdir', 'inner'), { recursive: true })
      await writeFile(join(temporary, 'newdir', 'one.txt'), '1\n')
      await writeFile(join(temporary, 'newdir', 'inner', 'two.txt'), '2\n')
      await writeFile(join(temporary, 'u.txt'), 'u\n')
      await mkdir(join(temporary, 'src'))
      await mkdir(join(temporary, 'mount', '.svn'), { recursive: true })
      const status = statusXml([{ path: 'a.txt', item: 'modified', revision: 3 }, { path: 'newdir', item: 'unversioned' },
        { path: 'u.txt', item: 'unversioned' }, { path: 'build', item: 'ignored' }, { path: 'src', item: 'normal', props: 'modified', revision: 3 },
        { path: 'mount', item: 'external' }, { path: 'mount/l.txt', item: 'modified', revision: 2 }])
      const diff = ['Index: a.txt', '='.repeat(67), '--- a.txt\t(revision 3)', '+++ a.txt\t(working copy)', '@@ -1,2 +1,3 @@',
        ' keep', '-old', '+new', '+++ a line that begins with two pluses', 'Property changes on: src', '_'.repeat(67),
        'Added: svn:ignore', '## -0,0 +1 ##', '+build', ''].join('\n')
      const { manager, calls } = scripted((cwd, args) => {
        if (args[0] === 'status') return { stdout: status }
        if (args[0] === 'diff') return { stdout: cwd === temporary ? diff : 'Index: l.txt\n@@ -1 +1 @@\n-l\n+m\n' }
        return undefined
      })
      expect(await manager.facts(temporary)).toEqual({ ok: true, value: { added: 3, removed: 2, changedFiles: 6 } })
      expect(calls.some((call) => call.args.includes('--no-ignore'))).toBe(false)
      expect(calls.filter((call) => call.args[0] === 'diff').map((call) => call.cwd)).toEqual([join(temporary, 'mount'), temporary])
    })
  })
})
