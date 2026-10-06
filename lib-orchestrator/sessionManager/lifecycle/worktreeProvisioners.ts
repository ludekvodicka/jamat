import type { GitWorktreeManager } from '../../git/gitWorktreeManager'
import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import { GitCodes } from './gitCodes'
import type { SessionWorktreePort, WorktreeProvision, WorktreeRequest } from './sessionLifecycle'
import { SvnCodes } from './svnCodes'

/** The worktree of `git` mode: a branch of the project's own repository. */
export class GitWorktreeProvisioner implements SessionWorktreePort {
  private readonly git: Pick<GitWorktreeManager, 'create'>

  constructor(git: Pick<GitWorktreeManager, 'create'>) {
    this.git = git
  }

  async create(request: WorktreeRequest): Promise<WorktreeProvision> {
    if (request.owner !== undefined)
      return {
        ok: false,
        code: 'invalid-spec',
        detail: 'A worktree owner names the directory an SVN worktree checks out; a Git worktree is cut '
          + 'from the repository of the project',
      }
    const created = await this.git.create(request.projectRoot, request.folder, request.baseRef)
    if (!created.ok) return { ok: false, code: GitCodes.sessionCodeOf(created.code), detail: created.detail }
    return { ok: true, value: { ...created.value, kind: 'git' } }
  }
}

/** A fresh checkout of the owner at HEAD in `<owner>/.worktrees/<folder>`. */
export class SvnWorktreeProvisioner implements SessionWorktreePort {
  private readonly svn: Pick<SvnWorktreeManager, 'ownerProblem' | 'create'>
  /** Whether a catalog project lies at or below the directory, which makes it no project of its own. */
  private readonly holdsOtherProject: (dir: string) => boolean

  constructor(svn: Pick<SvnWorktreeManager, 'ownerProblem' | 'create'>, holdsOtherProject: (dir: string) => boolean) {
    this.svn = svn
    this.holdsOtherProject = holdsOtherProject
  }

  async create(request: WorktreeRequest): Promise<WorktreeProvision> {
    if (request.baseRef !== undefined)
      return { ok: false, code: 'invalid-spec', detail: 'An SVN worktree always starts at HEAD; a base ref applies to Git worktrees' }
    const ownerDir = request.owner ?? request.projectRoot
    const problem = await this.svn.ownerProblem({
      ownerDir,
      projectPath: request.projectRoot,
      holdsOtherProject: this.holdsOtherProject,
    })
    if (problem !== null) return { ok: false, code: 'invalid-spec', detail: problem }
    const checkout = await this.svn.create({ ownerDir, folder: request.folder })
    if (!checkout.ok) return { ok: false, code: SvnCodes.sessionCodeOf(checkout.code), detail: checkout.detail }
    return {
      ok: true,
      value: {
        worktreePath: checkout.value.worktreePath,
        branch: checkout.value.url,
        baseCommit: `r${checkout.value.baseRevision}`,
        repositoryRoot: ownerDir,
        kind: 'svn',
        ...(checkout.value.directoryId === null ? {} : { directoryId: checkout.value.directoryId }),
      },
    }
  }
}

/**
 * The worktree of `checkpoints` mode. An SVN working copy decides first, also beside a human
 * `.git`; a project in none that has a Git repository of its own gets the worktree of `git` mode.
 * A repository reached only through `.checkpoints/store.git` is not its own: git never finds it.
 * An owner below the project names an SVN worktree, so it always goes to SVN.
 */
export class CheckpointsWorktreeProvisioner implements SessionWorktreePort {
  private readonly svn: Pick<SvnWorktreeManager, 'inWorkingCopy'>
  private readonly git: Pick<GitWorktreeManager, 'repositoryRootOf'>
  private readonly svnWorktrees: SessionWorktreePort
  private readonly gitWorktrees: SessionWorktreePort

  constructor(deps: {
    svn: Pick<SvnWorktreeManager, 'inWorkingCopy'>
    git: Pick<GitWorktreeManager, 'repositoryRootOf'>
    svnWorktrees: SessionWorktreePort
    gitWorktrees: SessionWorktreePort
  }) {
    this.svn = deps.svn
    this.git = deps.git
    this.svnWorktrees = deps.svnWorktrees
    this.gitWorktrees = deps.gitWorktrees
  }

  async create(request: WorktreeRequest): Promise<WorktreeProvision> {
    if (request.owner !== undefined) return this.svnWorktrees.create(request)
    const inSvn = await this.svn.inWorkingCopy(request.projectRoot)
    // Without an answer the project may still be an SVN working copy, and a Git worktree there would
    // be the wrong kind for good.
    if (!inSvn.ok)
      return {
        ok: false,
        code: SvnCodes.sessionCodeOf(inSvn.code),
        detail: `Checkpoints mode cannot tell whether ${request.projectRoot} is in an SVN working copy, so it makes no worktree: ${inSvn.detail}`,
      }
    if (inSvn.value) return this.svnWorktrees.create(request)
    if (await this.git.repositoryRootOf(request.projectRoot) !== null) return this.gitWorktrees.create(request)
    return {
      ok: false,
      code: 'invalid-spec',
      detail: `${request.projectRoot} is in no SVN working copy and no Git repository of its own, so checkpoints `
        + 'mode has no worktree for it',
    }
  }
}
