import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CommandOutcome, CommandRunner } from '../shared/commandInvoker.types'
import type { SvnLoggedRow, SvnRoot, SvnWorktreeLocation } from './svn.types'
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
  return { manager: new SvnWorktreeManager(runner), calls }
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
    function creating(owner: string, options: { ignored?: boolean; checkoutFails?: boolean; whileChecking?: () => Promise<void> } = {}) {
      return scripted(async (cwd, args) => {
        if (args[0] === 'info') return { stdout: infoXml({ revision: cwd === owner ? 40 : 41 }) }
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

    it('checks the owner URL out at HEAD into .worktrees/<folder> and names its revision and identity', async () => {
      const owner = join(temporary, 'owner')
      await mkdir(owner)
      const { manager, calls } = creating(owner)
      const created = await manager.create({ ownerDir: owner, folder: '014-fix-login' })
      const worktreePath = join(owner, '.worktrees', '014-fix-login')
      expect(created).toEqual({ ok: true, value: { worktreePath, url, baseRevision: 41, directoryId: expect.any(String) } })
      if (created.ok) expect(created.value.directoryId).toMatch(/^\d+:\d+:\d+$/)
      expect(calls.find((call) => call.args[0] === 'checkout')).toEqual({ cwd: join(owner, '.worktrees'),
        args: ['checkout', '--non-interactive', '-q', '--', `${url}@HEAD`, '014-fix-login'] })
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
    })
  })

  describe('update of the worktree', () => {
    const changedBefore: Entry[] = [{ path: 'src/a.txt', item: 'modified', revision: 5 }, { path: 'gone', item: 'missing', revision: 5 },
      { path: 'gone/inner.txt', item: 'missing', revision: 5 }, { path: 'mount', item: 'external' }]

    function updating(worktree: string, after: readonly Entry[], updateText: string, before: readonly Entry[] = changedBefore) {
      let updated = false
      return scripted((cwd, args) => {
        if (cwd !== worktree) return undefined
        if (args[0] === 'status') return { stdout: statusXml(updated ? after : before) }
        if (args[0] === 'delete') return {}
        if (args[0] === 'update') {
          updated = true
          return { stdout: updateText }
        }
        if (args[0] === 'info') return { stdout: infoXml({ revision: 9 }) }
        return undefined
      })
    }

    it('schedules a deletion from disk before the update and answers the changed roots, mounts first', async () => {
      const after: Entry[] = [{ path: 'src/a.txt', item: 'modified', revision: 9 }, { path: 'gone', item: 'deleted', revision: 9 },
        { path: 'mount', item: 'external' }, { path: 'mount/l.txt', item: 'modified', revision: 4 }]
      const { manager, calls } = updating(temporary, after, 'Updating \'.\':\nAt revision 9.\n')
      const result = await manager.updateWorktree(temporary)
      expect(calls.map((call) => call.args)).toEqual([
        ['status', '--non-interactive', '--xml', '--', '.'],
        ['delete', '--non-interactive', '-q', '--force', '--', 'gone@'],
        ['update', '--non-interactive', '--accept', 'postpone', '--', '.'],
        ['status', '--non-interactive', '--xml', '--', '.'],
      ])
      expect(result).toEqual({ ok: true, value: { kind: 'current',
        changed: [{ kind: 'item', conflict: false, path: 'src/a.txt' }, { kind: 'item', conflict: false, path: 'gone' },
          { kind: 'item', conflict: false, path: 'mount/l.txt' }],
        roots: [
          { path: join(temporary, 'mount'), own: 'mount', changed: [{ kind: 'item', conflict: false, path: 'mount/l.txt' }] },
          { path: temporary, own: '', changed: [{ kind: 'item', conflict: false, path: 'src/a.txt' }, { kind: 'item', conflict: false, path: 'gone' }] },
        ] } })
    })

    it('answers updated with the incoming paths of a changed project, and conflict with the conflicted paths', async () => {
      const after: Entry[] = [{ path: 'src/a.txt', item: 'modified', revision: 9 }]
      expect(await updating(temporary, after, `U    src${sep}b.txt\nU    .aidocs${sep}n.md\nAt revision 9.\n`, after).manager.updateWorktree(temporary))
        .toEqual({ ok: true, value: { kind: 'updated', toRevision: 9, paths: ['src/b.txt'] } })
      const conflicted: Entry[] = [{ path: 'src/a.txt', item: 'conflicted', revision: 9 }, { path: 'tree.txt', item: 'normal', tree: true }]
      expect(await updating(temporary, conflicted, `C    src${sep}a.txt\n`, after).manager.updateWorktree(temporary))
        .toEqual({ ok: true, value: { kind: 'conflict', paths: ['src/a.txt', 'tree.txt'] } })
    })

    it('in a product group counts only the member projects the session changed', async () => {
      await writeFile(join(temporary, '.appgroup'), '')
      const after: Entry[] = [{ path: 'MemberA/a.txt', item: 'modified', revision: 9 }]
      expect(await updating(temporary, after, `U    MemberB${sep}b.txt\n`, after).manager.updateWorktree(temporary))
        .toMatchObject({ ok: true, value: { kind: 'current' } })
      expect(await updating(temporary, after, `U    MemberA${sep}b.txt\n`, after).manager.updateWorktree(temporary))
        .toMatchObject({ ok: true, value: { kind: 'updated', paths: ['MemberA/b.txt'] } })
    })

    it('names a file deleted from disk whose name svn cannot take, and passes nothing', async () => {
      const { manager, calls } = updating(temporary, [], '', [{ path: 'složka/ř.txt', item: 'missing', revision: 5 }])
      expect(await manager.updateWorktree(temporary)).toMatchObject({ ok: false, code: 'refused', detail: expect.stringMatching(/složka\/ř.txt/) })
      expect(calls).toHaveLength(1)
    })
  })

  describe('proofs', () => {
    const fixture = (name: string, root: string, main: string): string =>
      readFileSync(join(import.meta.dirname, 'fixtures', 'worktree', name), 'utf8')
        .replaceAll('{ROOT}', root).replaceAll('{MAIN}', main).replaceAll('{REPO}', repository).replaceAll('\\', sep)
    const root = (path: string, changed: SvnRoot['changed'] = []): SvnRoot => ({ path, own: '', changed })

    it('recovers a clean commit from the worktree that the main copy lacks, reading the main copy by relative names', async () => {
      const worktree = join(temporary, 'worktree')
      const main = join(temporary, 'main')
      await mkdir(join(main, 'src'), { recursive: true })
      await writeFile(join(main, 'src', 'a.txt'), 'main\n')
      await writeFile(join(main, 'src', 'b.txt'), 'main\n')
      const { manager, calls } = scripted((cwd, args) => {
        if (cwd === worktree && args[0] === 'status') return { stdout: fixture('status-verbose-foreign.xml', worktree, main) }
        if (cwd === join(worktree, 'mount') && args[0] === 'status') return { stdout: statusXml([]) }
        if (cwd === worktree && args[0] === 'info') return { stdout: fixture('info-worktree.xml', worktree, main) }
        if (args[0] === 'log') return { stdout: fixture(args.includes('6:6') ? 'log-committed.xml' : 'log-foreign.xml', worktree, main) }
        if (cwd === main && args[0] === 'info') return { stdout: fixture('info-main.xml', worktree, main) }
        return undefined
      })
      expect(await manager.recoverable(root(worktree), main)).toEqual({ ok: true, value: [{ revision: 6, action: 'M', path: 'src/a.txt' }] })
      expect(calls.find((call) => call.cwd === main)?.args).toEqual(['info', '--xml', '--non-interactive', '--', 'src/a.txt@'])
      expect(await manager.unlanded(worktree, main)).toEqual({ ok: true, value: [{ path: 'src/a.txt', revision: 6 }] })
      expect(calls.filter((call) => call.args[0] === 'log')).toHaveLength(2)
    })

    it('finds nothing unlanded once the main copy holds the revision, without asking the server', async () => {
      const worktree = join(temporary, 'worktree')
      const main = join(temporary, 'main')
      await mkdir(join(main, 'src'), { recursive: true })
      await writeFile(join(main, 'src', 'a.txt'), 'main\n')
      await writeFile(join(main, 'src', 'b.txt'), 'main\n')
      const { manager, calls } = scripted((cwd, args) => {
        if (cwd === worktree && args[0] === 'status') return { stdout: fixture('status-verbose-foreign.xml', worktree, main) }
        if (cwd === join(worktree, 'mount') && args[0] === 'status') return { stdout: statusXml([]) }
        if (cwd === main && args[0] === 'info') {
          const target = args.at(-1)!.replace(/@$/, '')
          return { stdout: infoXml({ revision: 7, path: join(...target.split('/')), entryUrl: `${url}/${target}` }) }
        }
        return undefined
      })

      expect(await manager.unlanded(worktree, main)).toEqual({ ok: true, value: [] })
      expect(calls.some((call) => call.args[0] === 'log' || call.args.some((arg) => arg.startsWith('file:')))).toBe(false)
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
      expect(await manager.recoverable(root(temporary), temporary)).toMatchObject({ ok: false, code: 'svn-failed', detail: expect.stringMatching(/E170013/) })
    })
  })

  describe('main-copy update', () => {
    const landed: SvnLoggedRow[] = [
      { revision: 6, action: 'M', path: 'src/a.txt' },
      { revision: 6, action: 'M', path: 'src' },
      { revision: 6, action: 'A', path: 'new' },
      { revision: 6, action: 'A', path: 'new/n.txt' },
      { revision: 6, action: 'D', path: 'old.txt' },
    ]

    function mainCopy(states: readonly Entry[], update: (args: string[]) => Reply = () => ({})) {
      return scripted((_cwd, args) => {
        if (args[0] === 'update') return update(args)
        if (args[0] === 'status') return { stdout: statusXml(states.filter((state) => args.includes(state.path === '.' ? '.' : `${state.path}@`))) }
        return undefined
      })
    }

    it('updates added and deleted paths whole, modified ones flat, and names a merge', async () => {
      const { manager, calls } = mainCopy([{ path: 'src/a.txt', item: 'modified', revision: 6 }, { path: 'src', item: 'normal', revision: 6 },
        { path: 'new', item: 'normal', revision: 6 }, { path: 'new/n.txt', item: 'normal', revision: 6 }])
      expect(await manager.updateMain(temporary, landed)).toEqual({ ok: true, value: { main: 'merged:1', lines: ['MAIN MERGED src/a.txt'] } })
      expect(calls.filter((call) => call.args[0] === 'update').map((call) => call.args)).toEqual([
        ['update', '--non-interactive', '--parents', '--accept', 'postpone', '--', 'new@', 'old.txt@'],
        ['update', '--non-interactive', '--depth', 'empty', '--accept', 'postpone', '--', 'src/a.txt@', 'src@'],
      ])
    })

    it('names conflicts, paths the main copy did not take and names svn cannot take', async () => {
      const { manager } = mainCopy([{ path: 'src/a.txt', item: 'conflicted', revision: 6 }, { path: 'src', item: 'normal', revision: 5 },
        { path: 'new', item: 'normal', revision: 6 }, { path: 'new/n.txt', item: 'normal', tree: true, revision: 6 },
        { path: 'old.txt', item: 'normal', revision: 5 }])
      const result = await manager.updateMain(temporary, [...landed, { revision: 6, action: 'A', path: 'new/ž.txt' }])
      expect(result).toEqual({ ok: true, value: { main: 'conflict:5', lines: [
        'MAIN SKIPPED new/ž.txt: svn cannot take this name',
        'MAIN CONFLICT src/a.txt',
        'MAIN SKIPPED src: the main copy did not take r6',
        'MAIN CONFLICT new/n.txt',
        'MAIN SKIPPED old.txt: the main copy still holds it',
      ] } })
    })

    it('answers updated for a clean update and none without landed paths', async () => {
      const { manager } = mainCopy([{ path: '.', item: 'normal', props: 'normal', revision: 7 }])
      expect(await manager.updateMain(temporary, [{ revision: 7, action: 'M', path: '.' }])).toEqual({ ok: true, value: { main: 'updated', lines: [] } })
      expect(await manager.updateMain(temporary, [])).toEqual({ ok: true, value: { main: 'none', lines: [] } })
    })

    it('waits out a working-copy lock, then names the paths to update by hand', async () => {
      vi.useFakeTimers()
      let attempts = 0
      const locked = (): Reply => {
        attempts += 1
        return failed(`svn: E155004: Run 'svn cleanup' to remove locks\nsvn: E155004: Working copy '${temporary}' locked.`)
      }
      const { manager } = mainCopy([], locked)
      const pending = manager.updateMain(temporary, [{ revision: 6, action: 'A', path: 'new' }])
      await vi.runAllTimersAsync()
      const result = await pending
      expect(attempts).toBe(4)
      expect(result).toMatchObject({ ok: true, value: { main: 'failed' } })
      if (result.ok) expect(result.value.lines.slice(0, 2)).toEqual([
        `MAIN UPDATE FAILED: svn update in ${temporary} failed; the commit stands. Update these paths by hand:`, '  new'])

      attempts = 0
      const recovering = mainCopy([{ path: 'new', item: 'normal', revision: 6 }], () => attempts++ === 0 ? locked() : {}).manager
        .updateMain(temporary, [{ revision: 6, action: 'A', path: 'new' }])
      await vi.runAllTimersAsync()
      expect(await recovering).toEqual({ ok: true, value: { main: 'updated', lines: [] } })
    })
  })

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

  describe('facts', () => {
    it('counts diff lines per working copy and each file of an unversioned directory, never an ignored one', async () => {
      await mkdir(join(temporary, 'newdir', 'inner'), { recursive: true })
      await writeFile(join(temporary, 'newdir', 'one.txt'), '1\n')
      await writeFile(join(temporary, 'newdir', 'inner', 'two.txt'), '2\n')
      await writeFile(join(temporary, 'u.txt'), 'u\n')
      await mkdir(join(temporary, 'src'))
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
