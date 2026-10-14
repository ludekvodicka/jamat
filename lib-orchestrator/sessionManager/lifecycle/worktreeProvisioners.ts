import type { GitWorktreeManager } from '../../git/gitWorktreeManager'
import { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { SessionRecordWorktree } from '../records/sessionRecord.types'
import type { SessionsOpResult } from '../sessionManagerApi.types'
import { GitCodes } from './gitCodes'
import type { SessionWorktreePort, WorktreePlaceRequest, WorktreePlacing, WorktreeProvision, WorktreeRequest } from './sessionLifecycle'
import { SvnCodes } from './svnCodes'
import { WorktreeOwner, type WorktreeOwnerDeps } from './worktreeOwner'

/** The worktree of `git` mode: a branch of the catalog project's own repository. */
export class GitWorktreeProvisioner implements Pick<SessionWorktreePort, 'place' | 'create'> {
  private readonly git: Pick<GitWorktreeManager, 'create'>

  constructor(git: Pick<GitWorktreeManager, 'create'>) {
    this.git = git
  }

  async place(request: WorktreePlaceRequest): Promise<WorktreePlacing> {
    if (request.owner !== undefined)
      return {
        ok: false,
        code: 'invalid-spec',
        detail: 'A worktree owner names the directory an SVN worktree checks out; a Git worktree is cut '
          + 'from the repository of the project',
      }
    if (request.projectRoot === null)
      return {
        ok: false,
        code: 'invalid-spec',
        detail: `A Git worktree is cut from the repository of a catalog project, and ${request.directory} is none; `
          + 'a worktree of any directory is an SVN worktree of checkpoints mode',
      }
    return { ok: true, value: { kind: 'git', ownerDir: request.projectRoot, cwdSubpath: '', catalogProject: request.projectRoot } }
  }

  async create(request: WorktreeRequest): Promise<WorktreeProvision> {
    const created = await this.git.create(request.placement.ownerDir, request.folder, request.baseRef)
    if (!created.ok) return { ok: false, code: GitCodes.sessionCodeOf(created.code), detail: created.detail }
    return { ok: true, value: { worktree: { ...created.value, kind: 'git' }, checkout: null } }
  }
}

/**
 * An SVN worktree: the folder `<owner>/.worktrees/<folder>` reserved at create, and the checkout of
 * the owner at the HEAD read then as the first run of the session's before chain.
 */
export class SvnWorktreeProvisioner implements SessionWorktreePort {
  private readonly svn: Pick<SvnWorktreeManager, 'ownerProblem' | 'reserve' | 'purgeReserved'>
  private readonly owners: WorktreeOwnerDeps

  constructor(svn: Pick<SvnWorktreeManager, 'ownerProblem' | 'reserve' | 'purgeReserved'>, owners: WorktreeOwnerDeps) {
    this.svn = svn
    this.owners = owners
  }

  /** An explicit owner keeps the rule pp 7.3 relies on: at or below the catalog project, and the session starts at it. */
  async place(request: WorktreePlaceRequest): Promise<WorktreePlacing> {
    if (request.owner === undefined) {
      const owner = await WorktreeOwner.of(request.directory, this.owners)
      if (!owner.ok) return owner
      return { ok: true, value: { kind: 'svn', ownerDir: owner.ownerDir, cwdSubpath: owner.cwdSubpath, catalogProject: owner.catalogProject } }
    }
    if (request.projectRoot === null)
      return { ok: false, code: 'invalid-spec', detail: `A worktree owner lies at or below a catalog project, and ${request.directory} is none` }
    const problem = await this.svn.ownerProblem({
      ownerDir: request.owner,
      projectPath: request.projectRoot,
      holdsOtherProject: (dir) => this.owners.holdsCatalogProject(dir),
    })
    if (problem !== null) return { ok: false, code: 'invalid-spec', detail: problem }
    return { ok: true, value: { kind: 'svn', ownerDir: request.owner, cwdSubpath: '', catalogProject: request.projectRoot } }
  }

  async create(request: WorktreeRequest): Promise<WorktreeProvision> {
    if (request.baseRef !== undefined)
      return { ok: false, code: 'invalid-spec', detail: 'An SVN worktree always starts at HEAD; a base ref applies to Git worktrees' }
    const { ownerDir, cwdSubpath } = request.placement
    const reserved = await this.svn.reserve({ ownerDir, folder: request.folder })
    if (!reserved.ok) return { ok: false, code: SvnCodes.sessionCodeOf(reserved.code), detail: reserved.detail }
    const { worktreePath, url, baseRevision, directoryId } = reserved.value
    return {
      ok: true,
      value: {
        worktree: {
          worktreePath,
          branch: url,
          baseCommit: `r${baseRevision}`,
          repositoryRoot: ownerDir,
          kind: 'svn',
          ...(directoryId === null ? {} : { directoryId }),
          ...(cwdSubpath === '' ? {} : { cwdSubpath }),
        },
        checkout: { tool: 'svn', cwd: worktreePath, args: ['--non-interactive', ...SvnWorktreeManager.checkoutArgsOf(url, baseRevision, 'listed')] },
      },
    }
  }

  async purgeReserved(worktree: SessionRecordWorktree): Promise<SessionsOpResult> {
    const purged = await this.svn.purgeReserved({ worktreePath: worktree.worktreePath, directoryId: worktree.directoryId })
    return purged.ok ? { ok: true, value: undefined } : { ok: false, code: SvnCodes.sessionCodeOf(purged.code), detail: purged.detail }
  }
}

/**
 * Where `checkpoints` mode places a worktree. An SVN working copy decides first, also beside a human
 * `.git`; a catalog project in none that has a Git repository of its own gets the worktree of `git`
 * mode. A repository reached only through `.checkpoints/store.git` is not its own: git never finds
 * it. An owner or an ad-hoc directory names an SVN worktree, so it always goes to SVN.
 */
export class CheckpointsWorktreeProvisioner implements Pick<SessionWorktreePort, 'place'> {
  private readonly svn: Pick<SvnWorktreeManager, 'inWorkingCopy'>
  private readonly git: Pick<GitWorktreeManager, 'repositoryRootOf'>
  private readonly svnWorktrees: Pick<SessionWorktreePort, 'place'>
  private readonly gitWorktrees: Pick<SessionWorktreePort, 'place'>

  constructor(deps: {
    svn: Pick<SvnWorktreeManager, 'inWorkingCopy'>
    git: Pick<GitWorktreeManager, 'repositoryRootOf'>
    svnWorktrees: Pick<SessionWorktreePort, 'place'>
    gitWorktrees: Pick<SessionWorktreePort, 'place'>
  }) {
    this.svn = deps.svn
    this.git = deps.git
    this.svnWorktrees = deps.svnWorktrees
    this.gitWorktrees = deps.gitWorktrees
  }

  async place(request: WorktreePlaceRequest): Promise<WorktreePlacing> {
    const projectRoot = request.projectRoot
    if (request.owner !== undefined || projectRoot === null) return this.svnWorktrees.place(request)
    const inSvn = await this.svn.inWorkingCopy(projectRoot)
    // Without an answer the project may still be an SVN working copy, and a Git worktree there would
    // be the wrong kind for good.
    if (!inSvn.ok)
      return {
        ok: false,
        code: SvnCodes.sessionCodeOf(inSvn.code),
        detail: `Checkpoints mode cannot tell whether ${projectRoot} is in an SVN working copy, so it makes no worktree: ${inSvn.detail}`,
      }
    if (inSvn.value) return this.svnWorktrees.place(request)
    if (await this.git.repositoryRootOf(projectRoot) !== null) return this.gitWorktrees.place(request)
    return {
      ok: false,
      code: 'invalid-spec',
      detail: `${projectRoot} is in no SVN working copy and no Git repository of its own, so checkpoints `
        + 'mode has no worktree for it',
    }
  }
}
