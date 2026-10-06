import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import type { GitResult, WorktreeFacts } from '../../git/git.types'
import { GitInvoker } from '../../git/gitInvoker'
import { GitWorktreeManager } from '../../git/gitWorktreeManager'
import { CommandInvoker } from '../../shared/commandInvoker'
import type { SvnCheckout, SvnResult } from '../../svn/svn.types'
import { SvnInvoker } from '../../svn/svnInvoker'
import { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { SessionWorktreePort, WorktreeProvision, WorktreeRequest } from './sessionLifecycle'
import { CheckpointsWorktreeProvisioner, GitWorktreeProvisioner, SvnWorktreeProvisioner } from './worktreeProvisioners'

describe('lib-orchestrator/sessionManager/lifecycle/worktreeProvisioners', () => {
  const projectConst = join('Q:', 'apps', 'Group')
  const memberConst = join(projectConst, 'Member')

  const request = (overrides: Partial<WorktreeRequest> = {}): WorktreeRequest =>
    ({ projectRoot: projectConst, folder: '014-fix-login', ...overrides })

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
    readonly created: { ownerDir: string; folder: string }[] = []
    problem: string | null = null
    inSvn: SvnResult<boolean> = { ok: true, value: true }
    checkout: SvnResult<SvnCheckout> = {
      ok: true,
      value: { worktreePath: join(projectConst, '.worktrees', '014-fix-login'), url: 'file:///repository/Group', baseRevision: 41, directoryId: '1:2:3' },
    }

    async ownerProblem(input: { ownerDir: string; projectPath: string; holdsOtherProject: (dir: string) => boolean }): Promise<string | null> {
      this.asked.push({ ownerDir: input.ownerDir, projectPath: input.projectPath, holds: input.holdsOtherProject(input.ownerDir) })
      return this.problem
    }

    async create(input: { ownerDir: string; folder: string }): Promise<SvnResult<SvnCheckout>> {
      this.created.push(input)
      return this.checkout
    }

    async inWorkingCopy(): Promise<SvnResult<boolean>> {
      return this.inSvn
    }
  }

  /** A provisioner that only says it was chosen. */
  function marker(kind: 'svn' | 'git'): SessionWorktreePort & { requests: WorktreeRequest[] } {
    const requests: WorktreeRequest[] = []
    return {
      requests,
      create: async (asked) => {
        requests.push(asked)
        return { ok: false, code: 'invalid-spec', detail: kind }
      },
    }
  }

  const detailOf = (provision: WorktreeProvision): string => provision.ok ? 'created' : provision.detail

  describe('the Git worktree', () => {
    it('cuts from the project repository and records the kind', async () => {
      const git = new FakeGit()

      const provision = await new GitWorktreeProvisioner(git).create(request({ baseRef: 'main' }))

      expect(git.calls).toEqual([{ repositoryRoot: projectConst, slug: '014-fix-login', baseRef: 'main' }])
      expect(provision).toEqual({ ok: true, value: { ...(git.outcome.ok ? git.outcome.value : {}), kind: 'git' } })
    })

    it('refuses an owner, which only names an SVN checkout, and maps git refusals', async () => {
      const git = new FakeGit()
      const provisioner = new GitWorktreeProvisioner(git)

      expect(await provisioner.create(request({ owner: memberConst }))).toMatchObject({ ok: false, code: 'invalid-spec' })
      expect(git.calls).toEqual([])
      git.outcome = { ok: false, code: 'worktree-exists', detail: 'already exists' }
      expect(await provisioner.create(request())).toEqual({ ok: false, code: 'worktree-exists', detail: 'already exists' })
    })
  })

  describe('the SVN worktree', () => {
    it('checks out the owner at HEAD and records URL, revision and identity', async () => {
      const svn = new FakeSvn()
      svn.checkout = { ok: true, value: { worktreePath: join(memberConst, '.worktrees', '014-fix-login'), url: 'file:///repository/Group/Member', baseRevision: 41, directoryId: '1:2:3' } }

      const provision = await new SvnWorktreeProvisioner(svn, () => false).create(request({ owner: memberConst }))

      expect(svn.asked).toEqual([{ ownerDir: memberConst, projectPath: projectConst, holds: false }])
      expect(svn.created).toEqual([{ ownerDir: memberConst, folder: '014-fix-login' }])
      expect(provision).toEqual({
        ok: true,
        value: {
          worktreePath: join(memberConst, '.worktrees', '014-fix-login'),
          branch: 'file:///repository/Group/Member',
          baseCommit: 'r41',
          repositoryRoot: memberConst,
          kind: 'svn',
          directoryId: '1:2:3',
        },
      })
    })

    it('leaves the identity out where the file system has none', async () => {
      const svn = new FakeSvn()
      svn.checkout = { ok: true, value: { worktreePath: join(projectConst, '.worktrees', 'x'), url: 'file:///r', baseRevision: 1, directoryId: null } }

      const provision = await new SvnWorktreeProvisioner(svn, () => false).create(request())

      expect(provision.ok && 'directoryId' in provision.value).toBe(false)
    })

    it('refuses a base ref and an owner problem before any checkout', async () => {
      const svn = new FakeSvn()
      const provisioner = new SvnWorktreeProvisioner(svn, () => true)

      expect(await provisioner.create(request({ baseRef: 'main' })))
        .toMatchObject({ ok: false, code: 'invalid-spec', detail: expect.stringMatching(/always starts at HEAD/) })
      svn.problem = `${projectConst} is a working-copy root that holds other projects, not a project`
      expect(await provisioner.create(request())).toEqual({ ok: false, code: 'invalid-spec', detail: svn.problem })
      expect(svn.asked[0].holds).toBe(true)
      expect(svn.created).toEqual([])
    })

    it('maps the refusals of a checkout to the session codes', async () => {
      const svn = new FakeSvn()
      const provisioner = new SvnWorktreeProvisioner(svn, () => false)

      svn.checkout = { ok: false, code: 'refused', detail: 'SVN does not ignore .worktrees' }
      expect(await provisioner.create(request())).toEqual({ ok: false, code: 'invalid-spec', detail: 'SVN does not ignore .worktrees' })
      svn.checkout = { ok: false, code: 'out-of-date', detail: 'E170004' }
      expect(await provisioner.create(request())).toMatchObject({ ok: false, code: 'svn-failed' })
    })
  })

  describe('checkpoints mode', () => {
    function subject(svn: FakeSvn, git: FakeGit) {
      const svnWorktrees = marker('svn')
      const gitWorktrees = marker('git')
      return { svnWorktrees, gitWorktrees, provisioner: new CheckpointsWorktreeProvisioner({ svn, git, svnWorktrees, gitWorktrees }) }
    }

    it('makes an SVN worktree in an SVN working copy, also beside a human .git', async () => {
      const it_ = subject(new FakeSvn(), new FakeGit())
      expect(detailOf(await it_.provisioner.create(request()))).toBe('svn')
      expect(it_.gitWorktrees.requests).toEqual([])
    })

    it('makes the Git worktree of git mode for a project with its own repository and no SVN', async () => {
      const svn = new FakeSvn()
      svn.inSvn = { ok: true, value: false }
      const it_ = subject(svn, new FakeGit())
      expect(detailOf(await it_.provisioner.create(request({ baseRef: 'main' })))).toBe('git')
      expect(it_.gitWorktrees.requests).toEqual([request({ baseRef: 'main' })])
    })

    it('sends an owner to SVN, which alone takes one', async () => {
      const svn = new FakeSvn()
      svn.inSvn = { ok: true, value: false }
      const it_ = subject(svn, new FakeGit())
      expect(detailOf(await it_.provisioner.create(request({ owner: memberConst })))).toBe('svn')
    })

    it('refuses a project with neither, a checkpoint store being no repository of its own', async () => {
      const svn = new FakeSvn()
      svn.inSvn = { ok: true, value: false }
      const git = new FakeGit()
      git.repositoryRoot = null
      const it_ = subject(svn, git)

      expect(await it_.provisioner.create(request())).toEqual({
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

      expect(await it_.provisioner.create(request())).toEqual({
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

    it('checks out the project or a member at HEAD in checkpoints mode, beside a human .git', { timeout: 120_000 }, async (context) => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'jamat-v3-provision-svn-')))
      created.push(root)
      const repository = join(root, 'repository')
      const admin = await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repository], cwd: root, env: process.env })
      if (admin.failure !== null || admin.code !== 0) context.skip()
      const url = pathToFileURL(repository).href
      await svnOk(root, ['mkdir', '--parents', '-m', 'layout', '--', `${url}/Group/Member`])
      const project = join(root, 'Group')
      await svnOk(root, ['checkout', '-q', '--', `${url}/Group`, project])
      await svnOk(project, ['propset', 'svn:global-ignores', '.worktrees', '--', '.'])
      await svnOk(project, ['propset', 'svn:global-ignores', '.worktrees', '--', 'Member'])
      writeFileSync(join(project, 'Member', 'a.txt'), 'v1\n', 'utf8')
      await svnOk(project, ['add', '-q', '--', 'Member/a.txt'])
      await svnOk(project, ['commit', '-q', '-m', 'base', '--', '.'])
      expect((await new GitInvoker().run(project, ['init'])).code).toBe(0)
      const svn = new SvnWorktreeManager(new SvnInvoker())
      const git = new GitWorktreeManager(new GitInvoker())
      const provisioner = new CheckpointsWorktreeProvisioner({
        svn,
        git,
        svnWorktrees: new SvnWorktreeProvisioner(svn, () => false),
        gitWorktrees: new GitWorktreeProvisioner(git),
      })

      const whole = await provisioner.create({ projectRoot: project, folder: '014-whole' })
      const member = await provisioner.create({ projectRoot: project, owner: join(project, 'Member'), folder: '015-member' })
      const outside = await provisioner.create({ projectRoot: join(project, 'Member'), owner: project, folder: '016-outside' })
      const nested = await provisioner.create({ projectRoot: project, owner: join(project, '.worktrees', '014-whole'), folder: '017-nested' })

      expect(whole).toMatchObject({ ok: true, value: { kind: 'svn', branch: `${url}/Group`, worktreePath: join(project, '.worktrees', '014-whole'), repositoryRoot: project } })
      expect(member).toMatchObject({ ok: true, value: { kind: 'svn', branch: `${url}/Group/Member`, worktreePath: join(project, 'Member', '.worktrees', '015-member') } })
      expect(existsSync(join(project, 'Member', '.worktrees', '015-member', 'a.txt'))).toBe(true)
      expect(outside).toMatchObject({ ok: false, code: 'invalid-spec', detail: expect.stringMatching(/outside the project/) })
      expect(nested).toMatchObject({ ok: false, code: 'invalid-spec', detail: expect.stringMatching(/inside a worktree/) })
      expect(member.ok && member.value.baseCommit).toMatch(/^r\d+$/)
    })
  })
})
