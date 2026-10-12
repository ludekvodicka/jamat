import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import type { GitResult, WorktreeFacts } from '../../git/git.types'
import { GitInvoker } from '../../git/gitInvoker'
import { GitWorktreeManager } from '../../git/gitWorktreeManager'
import { CommandInvoker } from '../../shared/commandInvoker'
import { ProductGroup } from '../../shared/productGroup'
import type { SvnCheckout, SvnResult } from '../../svn/svn.types'
import { SvnInvoker } from '../../svn/svnInvoker'
import { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { SessionWorktreePort, WorktreePlaceRequest, WorktreePlacement, WorktreePlacing, WorktreeRequest } from './sessionLifecycle'
import type { WorktreeOwnerDeps } from './worktreeOwner'
import { CheckpointsWorktreeProvisioner, GitWorktreeProvisioner, SvnWorktreeProvisioner } from './worktreeProvisioners'

describe('lib-orchestrator/sessionManager/lifecycle/worktreeProvisioners', () => {
  const projectConst = join('Q:', 'apps', 'Group')
  const memberConst = join(projectConst, 'Member')

  const placeRequest = (overrides: Partial<WorktreePlaceRequest> = {}): WorktreePlaceRequest =>
    ({ directory: projectConst, projectRoot: projectConst, ...overrides })

  const placement = (overrides: Partial<WorktreePlacement> = {}): WorktreePlacement =>
    ({ kind: 'svn', ownerDir: projectConst, cwdSubpath: '', catalogProject: projectConst, ...overrides })

  const request = (overrides: Partial<WorktreeRequest> = {}): WorktreeRequest =>
    ({ placement: placement(), folder: '014-fix-login', ...overrides })

  /** Every directory below `projectConst` is one versioned working copy rooted there, a group of its members. */
  const owners = (overrides: Partial<WorktreeOwnerDeps> = {}): WorktreeOwnerDeps => ({
    groupRootOf: () => projectConst,
    catalogProjectOf: () => projectConst,
    holdsCatalogProject: () => false,
    workingCopyRootOf: async () => ({ ok: true, value: projectConst }),
    ...overrides,
  })

  class FakeGit {
    readonly calls: { repositoryRoot: string; slug: string; baseRef?: string }[] = []
    outcome: GitResult<WorktreeFacts> = {
      ok: true,
      value: { worktreePath: join(projectConst, '.worktrees', '014-fix-login'), branch: 'jamat/014-fix-login', baseCommit: 'abc123', repositoryRoot: projectConst },
    }
    repositoryRoot: string | null = projectConst

    async create(repositoryRoot: string, slug: string, baseRef?: string): Promise<GitResult<WorktreeFacts>> {
      this.calls.push({ repositoryRoot, slug, baseRef })
      return this.outcome
    }

    async repositoryRootOf(): Promise<string | null> {
      return this.repositoryRoot
    }
  }

  class FakeSvn {
    readonly asked: { ownerDir: string; projectPath: string; holds: boolean }[] = []
    readonly reserved: { ownerDir: string; folder: string }[] = []
    readonly purged: { worktreePath: string; directoryId?: string }[] = []
    problem: string | null = null
    inSvn: SvnResult<boolean> = { ok: true, value: true }
    reservation: SvnResult<SvnCheckout> = {
      ok: true,
      value: { worktreePath: join(projectConst, '.worktrees', '014-fix-login'), url: 'file:///repository/Group', baseRevision: 41, directoryId: '1:2:3' },
    }
    purge: SvnResult<void> = { ok: true, value: undefined }

    async ownerProblem(input: { ownerDir: string; projectPath: string; holdsOtherProject: (dir: string) => boolean }): Promise<string | null> {
      this.asked.push({ ownerDir: input.ownerDir, projectPath: input.projectPath, holds: input.holdsOtherProject(input.ownerDir) })
      return this.problem
    }

    async reserve(input: { ownerDir: string; folder: string }): Promise<SvnResult<SvnCheckout>> {
      this.reserved.push(input)
      return this.reservation
    }

    async purgeReserved(location: { worktreePath: string; directoryId?: string }): Promise<SvnResult<void>> {
      this.purged.push(location)
      return this.purge
    }

    async inWorkingCopy(): Promise<SvnResult<boolean>> {
      return this.inSvn
    }
  }

  /** A placer that only says it was chosen. */
  function marker(kind: 'svn' | 'git'): Pick<SessionWorktreePort, 'place'> & { requests: WorktreePlaceRequest[] } {
    const requests: WorktreePlaceRequest[] = []
    return {
      requests,
      place: async (asked) => {
        requests.push(asked)
        return { ok: false, code: 'invalid-spec', detail: kind }
      },
    }
  }

  const detailOf = (placing: WorktreePlacing): string => placing.ok ? 'placed' : placing.detail

  describe('the Git worktree', () => {
    it('places a catalog project at its own root and cuts from it with the base ref', async () => {
      const git = new FakeGit()
      const provisioner = new GitWorktreeProvisioner(git)

      expect(await provisioner.place(placeRequest()))
        .toEqual({ ok: true, value: { kind: 'git', ownerDir: projectConst, cwdSubpath: '', catalogProject: projectConst } })
      const provision = await provisioner.create(request({ placement: placement({ kind: 'git' }), baseRef: 'main' }))

      expect(git.calls).toEqual([{ repositoryRoot: projectConst, slug: '014-fix-login', baseRef: 'main' }])
      expect(provision).toEqual({ ok: true, value: { worktree: { ...(git.outcome.ok ? git.outcome.value : {}), kind: 'git' }, checkout: null } })
    })

    it('refuses an owner and an ad-hoc directory, and maps git refusals', async () => {
      const git = new FakeGit()
      const provisioner = new GitWorktreeProvisioner(git)

      expect(await provisioner.place(placeRequest({ owner: memberConst }))).toMatchObject({ ok: false, code: 'invalid-spec' })
      expect(await provisioner.place(placeRequest({ directory: join('D:', 'work'), projectRoot: null })))
        .toMatchObject({ ok: false, code: 'invalid-spec', detail: expect.stringMatching(/catalog project.*SVN worktree of checkpoints mode/) })
      git.outcome = { ok: false, code: 'worktree-exists', detail: 'already exists' }
      expect(await provisioner.create(request({ placement: placement({ kind: 'git' }) }))).toEqual({ ok: false, code: 'worktree-exists', detail: 'already exists' })
    })
  })

  describe('the SVN worktree', () => {
    it('places any directory by the owner rule: the group, and the session at its place below', async () => {
      const svn = new FakeSvn()
      const provisioner = new SvnWorktreeProvisioner(svn, owners({ catalogProjectOf: () => null }))

      expect(await provisioner.place(placeRequest({ directory: join(memberConst, 'src'), projectRoot: null })))
        .toEqual({ ok: true, value: { kind: 'svn', ownerDir: projectConst, cwdSubpath: 'Member/src', catalogProject: null } })
      expect(svn.asked).toEqual([])
    })

    it('keeps the rule of an explicit owner: at or below the project, the session at the owner itself', async () => {
      const svn = new FakeSvn()
      const provisioner = new SvnWorktreeProvisioner(svn, owners({ holdsCatalogProject: () => true }))

      expect(await provisioner.place(placeRequest({ owner: memberConst })))
        .toEqual({ ok: true, value: { kind: 'svn', ownerDir: memberConst, cwdSubpath: '', catalogProject: projectConst } })
      expect(svn.asked).toEqual([{ ownerDir: memberConst, projectPath: projectConst, holds: true }])
      svn.problem = `${projectConst} is a working-copy root that holds other projects, not a project`
      expect(await provisioner.place(placeRequest({ owner: projectConst }))).toEqual({ ok: false, code: 'invalid-spec', detail: svn.problem })
      expect(await provisioner.place(placeRequest({ projectRoot: null, owner: memberConst })))
        .toMatchObject({ ok: false, code: 'invalid-spec', detail: expect.stringMatching(/at or below a catalog project/) })
    })

    it('reserves the folder and answers the record with URL, r<HEAD>, identity and subpath, and the checkout to run', async () => {
      const svn = new FakeSvn()
      const provision = await new SvnWorktreeProvisioner(svn, owners())
        .create(request({ placement: placement({ cwdSubpath: 'Member/src' }) }))

      expect(svn.reserved).toEqual([{ ownerDir: projectConst, folder: '014-fix-login' }])
      const worktreePath = join(projectConst, '.worktrees', '014-fix-login')
      expect(provision).toEqual({
        ok: true,
        value: {
          worktree: {
            worktreePath,
            branch: 'file:///repository/Group',
            baseCommit: 'r41',
            repositoryRoot: projectConst,
            kind: 'svn',
            directoryId: '1:2:3',
            cwdSubpath: 'Member/src',
          },
          checkout: { tool: 'svn', cwd: worktreePath, args: ['--non-interactive', 'checkout', '-q', '--', 'file:///repository/Group@41', '.'] },
        },
      })
    })

    it('leaves the identity out where the file system has none, and the subpath out at the owner', async () => {
      const svn = new FakeSvn()
      svn.reservation = { ok: true, value: { worktreePath: join(projectConst, '.worktrees', 'x'), url: 'file:///r', baseRevision: 1, directoryId: null } }

      const provision = await new SvnWorktreeProvisioner(svn, owners()).create(request())

      expect(provision.ok && 'directoryId' in provision.value.worktree).toBe(false)
      expect(provision.ok && 'cwdSubpath' in provision.value.worktree).toBe(false)
    })

    it('refuses a base ref before any reservation, and maps the refusals of a reservation and a purge', async () => {
      const svn = new FakeSvn()
      const provisioner = new SvnWorktreeProvisioner(svn, owners())

      expect(await provisioner.create(request({ baseRef: 'main' })))
        .toMatchObject({ ok: false, code: 'invalid-spec', detail: expect.stringMatching(/always starts at HEAD/) })
      expect(svn.reserved).toEqual([])
      svn.reservation = { ok: false, code: 'refused', detail: 'SVN does not ignore .worktrees' }
      expect(await provisioner.create(request())).toEqual({ ok: false, code: 'invalid-spec', detail: 'SVN does not ignore .worktrees' })
      svn.reservation = { ok: false, code: 'out-of-date', detail: 'E170013' }
      expect(await provisioner.create(request())).toMatchObject({ ok: false, code: 'svn-failed' })

      const worktree = { worktreePath: join(projectConst, '.worktrees', 'x'), branch: 'file:///r', baseCommit: 'r1', repositoryRoot: projectConst, kind: 'svn' as const, directoryId: '1:2:3' }
      expect(await provisioner.purgeReserved(worktree)).toEqual({ ok: true, value: undefined })
      svn.purge = { ok: false, code: 'refused', detail: 'another directory' }
      expect(await provisioner.purgeReserved(worktree)).toEqual({ ok: false, code: 'invalid-spec', detail: 'another directory' })
      expect(svn.purged).toEqual([{ worktreePath: worktree.worktreePath, directoryId: '1:2:3' }, { worktreePath: worktree.worktreePath, directoryId: '1:2:3' }])
    })
  })

  describe('checkpoints mode', () => {
    function subject(svn: FakeSvn, git: FakeGit) {
      const svnWorktrees = marker('svn')
      const gitWorktrees = marker('git')
      return { svnWorktrees, gitWorktrees, provisioner: new CheckpointsWorktreeProvisioner({ svn, git, svnWorktrees, gitWorktrees }) }
    }

    it('places an SVN worktree in an SVN working copy, also beside a human .git', async () => {
      const it_ = subject(new FakeSvn(), new FakeGit())
      expect(detailOf(await it_.provisioner.place(placeRequest()))).toBe('svn')
      expect(it_.gitWorktrees.requests).toEqual([])
    })

    it('places the Git worktree of git mode for a project with its own repository and no SVN', async () => {
      const svn = new FakeSvn()
      svn.inSvn = { ok: true, value: false }
      const it_ = subject(svn, new FakeGit())
      expect(detailOf(await it_.provisioner.place(placeRequest()))).toBe('git')
      expect(it_.gitWorktrees.requests).toEqual([placeRequest()])
    })

    it('sends an owner and an ad-hoc directory to SVN, which alone takes them', async () => {
      const svn = new FakeSvn()
      svn.inSvn = { ok: true, value: false }
      const it_ = subject(svn, new FakeGit())
      expect(detailOf(await it_.provisioner.place(placeRequest({ owner: memberConst })))).toBe('svn')
      expect(detailOf(await it_.provisioner.place(placeRequest({ directory: join('D:', 'work'), projectRoot: null })))).toBe('svn')
      expect(it_.gitWorktrees.requests).toEqual([])
    })

    it('refuses a project with neither, a checkpoint store being no repository of its own', async () => {
      const svn = new FakeSvn()
      svn.inSvn = { ok: true, value: false }
      const git = new FakeGit()
      git.repositoryRoot = null
      const it_ = subject(svn, git)

      expect(await it_.provisioner.place(placeRequest())).toEqual({
        ok: false,
        code: 'invalid-spec',
        detail: `${projectConst} is in no SVN working copy and no Git repository of its own, so checkpoints mode has no worktree for it`,
      })
      expect([...it_.svnWorktrees.requests, ...it_.gitWorktrees.requests]).toEqual([])
    })

    it('refuses by name when svn cannot answer, and never falls back to a Git worktree', async () => {
      const svn = new FakeSvn()
      svn.inSvn = { ok: false, code: 'svn-missing', detail: 'svn is not installed' }
      const it_ = subject(svn, new FakeGit())

      expect(await it_.provisioner.place(placeRequest())).toEqual({
        ok: false,
        code: 'svn-failed',
        detail: `Checkpoints mode cannot tell whether ${projectConst} is in an SVN working copy, so it makes no worktree: svn is not installed`,
      })
      expect([...it_.svnWorktrees.requests, ...it_.gitWorktrees.requests]).toEqual([])
    })
  })

  describe('against a disposable svnadmin repository', () => {
    const created: string[] = []
    afterEach(() => {
      for (const directory of created.splice(0))
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    })

    async function svnOk(cwd: string, args: string[]): Promise<void> {
      const author = args[0] === 'commit' || args[0] === 'mkdir' ? ['--username', 'fixture'] : []
      const outcome = await new SvnInvoker().run(cwd, [args[0], '--non-interactive', ...author, ...args.slice(1)])
      if (outcome.failure !== null || outcome.code !== 0) throw new Error(`svn ${args.join(' ')}: ${outcome.stderr || outcome.failure}`)
    }

    it('places a directory of a group member on the group, reserves it and checks it out as the run would, beside a human .git', { timeout: 120_000 }, async (context) => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'jamat-v3-provision-svn-')))
      created.push(root)
      const repository = join(root, 'repository')
      const admin = await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repository], cwd: root, env: process.env })
      if (admin.failure !== null || admin.code !== 0) context.skip()
      const url = pathToFileURL(repository).href
      await svnOk(root, ['mkdir', '--parents', '-m', 'layout', '--', `${url}/Group/Member/src`])
      const group = join(root, 'Group')
      await svnOk(root, ['checkout', '-q', '--', `${url}/Group`, group])
      await svnOk(group, ['propset', 'svn:global-ignores', '.worktrees', '--', '.'])
      await svnOk(group, ['propset', 'svn:global-ignores', '.worktrees', '--', 'Member'])
      writeFileSync(join(group, ProductGroup.markerConst), '', 'utf8')
      writeFileSync(join(group, 'Member', 'src', 'a.txt'), 'v1\n', 'utf8')
      await svnOk(group, ['add', '-q', '--', ProductGroup.markerConst, 'Member/src/a.txt'])
      await svnOk(group, ['commit', '-q', '-m', 'base', '--', '.'])
      expect((await new GitInvoker().run(group, ['init'])).code).toBe(0)
      mkdirSync(join(group, 'unversioned'))
      const svn = new SvnWorktreeManager(new SvnInvoker())
      const git = new GitWorktreeManager(new GitInvoker())
      const svnWorktrees = new SvnWorktreeProvisioner(svn, {
        groupRootOf: (dir) => ProductGroup.rootOf(dir),
        catalogProjectOf: () => null,
        holdsCatalogProject: () => false,
        workingCopyRootOf: (dir) => svn.workingCopyRootOf(dir),
      })
      const placer = new CheckpointsWorktreeProvisioner({ svn, git, svnWorktrees, gitWorktrees: new GitWorktreeProvisioner(git) })

      const placed = await placer.place({ directory: join(group, 'Member', 'src'), projectRoot: null })
      expect(placed).toEqual({ ok: true, value: { kind: 'svn', ownerDir: group, cwdSubpath: 'Member/src', catalogProject: null } })
      if (!placed.ok) return
      const provision = await svnWorktrees.create({ placement: placed.value, folder: '014-whole' })
      expect(provision).toMatchObject({ ok: true, value: { worktree: { kind: 'svn', branch: `${url}/Group`, worktreePath: join(group, '.worktrees', '014-whole'), repositoryRoot: group, cwdSubpath: 'Member/src' } } })
      if (!provision.ok || provision.value.checkout === null) throw new Error('no checkout to run')
      const checkout = provision.value.checkout
      expect(existsSync(join(checkout.cwd, '.svn'))).toBe(false)
      const ran = await new CommandInvoker().run({ command: 'svn', args: checkout.args, cwd: checkout.cwd, env: process.env })
      expect(ran.code).toBe(0)
      expect(existsSync(join(group, '.worktrees', '014-whole', 'Member', 'src', 'a.txt'))).toBe(true)
      expect(provision.value.worktree.baseCommit).toMatch(/^r\d+$/)

      // pp 7.3: an explicit member owner still makes the member worktree, the session at its root.
      const member = await placer.place({ directory: group, projectRoot: group, owner: join(group, 'Member') })
      expect(member).toEqual({ ok: true, value: { kind: 'svn', ownerDir: join(group, 'Member'), cwdSubpath: '', catalogProject: group } })
      expect(await placer.place({ directory: join(group, 'Member'), projectRoot: join(group, 'Member'), owner: group }))
        .toMatchObject({ ok: false, code: 'invalid-spec', detail: expect.stringMatching(/outside the project/) })
      expect(await placer.place({ directory: join(group, '.worktrees', '014-whole'), projectRoot: null }))
        .toMatchObject({ ok: false, code: 'invalid-spec', detail: expect.stringMatching(/inside a worktree/) })
      expect(await placer.place({ directory: join(group, 'unversioned'), projectRoot: null }))
        .toMatchObject({ ok: false, code: 'invalid-spec', detail: expect.stringMatching(/not a versioned SVN directory/) })
      expect(await placer.place({ directory: root, projectRoot: null }))
        .toMatchObject({ ok: false, code: 'invalid-spec', detail: expect.stringMatching(/in no SVN working copy/) })
    })
  })
})
