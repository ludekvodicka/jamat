import { basename, resolve, posix } from 'node:path'
import { SvnCommitMessageCheck } from '../../svn/svnCommitMessageCheck'
import { PathPresence } from '../../shared/pathPresence'
import { ProductGroup } from '../../shared/productGroup'
import { PathCompare } from '../../shared/pathCompare'
import { SvnCommitGate } from '../../svn/svnCommitGate'
import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import type { WorktreeRepositoryReview, WorktreeReviewSnapshot } from '../worktreeState'
import type { WorktreeSvnCommands } from '../worktreeSvnCommands'

export interface ReviewRow { path: string; origin: 'worker' | 'setup'; checked: boolean }
export interface ReviewRepository { root: string; repositoryName: string; expectedPrefix: string; rows: ReviewRow[];
  message: string; source: WorktreeReviewSnapshot['source'] }
export type ReviewApproval = { ok: true; review: WorktreeReviewSnapshot } | { ok: false; code: 'review-stale'; detail: string; changed: string[] }
  | { ok: false; code: 'message-unchecked'; detail: string }

export class ReviewCandidates {
  private readonly deps: { records: SessionRecordsStore; svn: Pick<SvnWorktreeManager, 'changes' | 'commitHashes' | 'reviewRoots' | 'lowerBounds'>;
    proposalOf?: (sessionId: string, scopeRoot: string) => string | null;
    commands: Pick<WorktreeSvnCommands, 'lease' | 'verify' | 'accept'> }

  constructor(deps: ReviewCandidates['deps']) { this.deps = deps }

  async create(sessionId: string, message: string, source: WorktreeReviewSnapshot['source']): Promise<{ rows: ReviewRow[]; review: WorktreeReviewSnapshot }> {
    const root = this.deps.records.get(sessionId)?.worktree?.worktreePath
    if (root === undefined) throw new Error('Review requires a worktree')
    return this.deps.commands.lease.within(root, 'finish', async () => {
      await this.deps.commands.verify(root)
      const record = this.deps.records.get(sessionId)
      const state = record?.worktreeLifecycle
      if (state === undefined || record?.worktree?.worktreePath !== root) throw new Error('The review worktree changed')
      const changed = await this.deps.svn.changes(root)
      if (!changed.ok) throw new Error(changed.detail)
      const paths = changed.value.filter((row) => !SvnCommitGate.sidecarPattern.test(row.path)).map((row) => row.path)
      const hashes = await this.deps.svn.commitHashes(root, paths, 'node')
      if (!hashes.ok) throw new Error(hashes.detail)
      const legacyPaths = paths.filter((path) => record.worktree?.setupBaseline?.hashes[path] !== undefined
        && !record.worktree.setupBaseline.hashes[path].startsWith('node:'))
      const legacy = legacyPaths.length === 0 ? { ok: true as const, value: {} as Record<string, string> }
        : await this.deps.svn.commitHashes(root, legacyPaths)
      if (!legacy.ok) throw new Error(legacy.detail)
      const rows: ReviewRow[] = paths.map((path) => {
        const baseline = state.checkBaseline?.[path] ?? record.worktree?.setupBaseline?.hashes[path]
        const setup = baseline !== undefined && baseline === (baseline.startsWith('node:') ? hashes.value[path] : legacy.value[path] ?? hashes.value[path])
        return { path, origin: setup ? 'setup' : 'worker', checked: true }
      })
      const deletions = [...new Set([...await PathPresence.missing(root, paths), ...changed.value.filter((row) => row.deleted).map((row) => row.path)])]
      const roots = await this.deps.svn.reviewRoots(root)
      if (!roots.ok) throw new Error(roots.detail)
      const bounds = await this.deps.svn.lowerBounds(roots.value)
      if (!bounds.ok) throw new Error(bounds.detail)
      const repositories = roots.value.map((candidate) => {
        const repository = bounds.value[candidate.own].repository
        const repositoryName = decodeURIComponent(posix.basename(repository.replace(/\/$/, '')))
        const prior = state.review?.repositories?.find((row) => row.repository === repository && PathCompare.comparable(row.root) === PathCompare.comparable(candidate.path))
        const priorMount = state.review?.repositories?.find((row) => PathCompare.comparable(row.root) === PathCompare.comparable(candidate.path))
        const changedRepository = priorMount !== undefined && priorMount.repository !== repository
        const proposal = changedRepository ? undefined : this.deps.proposalOf?.(sessionId, candidate.path)
        const initial = state.review?.repositories === undefined
        return { root: candidate.path, repository, repositoryName,
          expectedPrefix: `[${ReviewCandidates.ownerOf(candidate.own, bounds.value[candidate.own].base, record.worktree!.repositoryRoot, repositoryName)}]`,
          paths: paths.filter((path) => PathCompare.isInside(candidate.path, resolve(root, path))
            && !roots.value.some((other) => other.path !== candidate.path && PathCompare.isInside(candidate.path, other.path) && PathCompare.isInside(other.path, resolve(root, path)))),
          message: prior !== undefined && (prior.message.trim() || prior.source === 'person-local' || prior.source === 'person-remote') ? prior.message : proposal ?? (initial ? message : ''),
          source: prior !== undefined && (prior.message.trim() || prior.source === 'person-local' || prior.source === 'person-remote') ? prior.source : proposal ? 'agent-proposal' as const : initial ? source : 'unknown' as const, acknowledged: [] }
      }).filter((candidate) => candidate.paths.length > 0)
      const review: WorktreeReviewSnapshot = { version: state.version + 1, selection: rows.filter((row) => row.checked).map((row) => row.path), deletions,
        hashes: hashes.value, repositories, message, source, acknowledged: [], headMovedBy: state.facts.syncedAt?.headMovedBy ?? 0 }
      // Every root, the unchanged ones too, so a label of a lone published repository still names its mount (UA1-J13-5).
      const mounts = roots.value.map((candidate) => ({ own: candidate.own, repository: bounds.value[candidate.own].repository }))
      await this.deps.commands.accept(root)
      if (!await this.deps.records.update(sessionId, (latest) => latest.worktreeLifecycle?.version !== state.version ? null : {
        ...latest, worktreeLifecycle: { ...latest.worktreeLifecycle, phase: 'finishing', step: 'reviewing', wait: undefined, version: review.version, review,
          ...latest.worktreeLifecycle.execution === undefined ? {} : { execution: { ...latest.worktreeLifecycle.execution, mounts } } },
      })) throw new Error('This review is outdated')
      return { rows, review }
    })
  }

  async approve(sessionId: string, press: Pick<WorktreeReviewSnapshot, 'selection' | 'message' | 'source' | 'acknowledged' | 'repositories'> & { reviewVersion: number }): Promise<ReviewApproval> {
    const root = this.deps.records.get(sessionId)?.worktree?.worktreePath
    if (root === undefined) return ReviewCandidates.stale([])
    return this.deps.commands.lease.within(root, 'finish', async () => {
      const state = this.deps.records.get(sessionId)?.worktreeLifecycle
      if (state?.step !== 'reviewing' || state.version !== press.reviewVersion || state.review?.version !== press.reviewVersion)
        return ReviewCandidates.stale([])
      const reviewed = new Map(press.selection.map((path) => [path, ReviewCandidates.reviewedKeyOf(state.review!.hashes, path)]))
      const unknown = press.selection.filter((path) => reviewed.get(path) === undefined || !PathCompare.isInside(root, resolve(root, path)))
      if (unknown.length > 0) return ReviewCandidates.stale(unknown)
      const excluded = Object.keys(state.review.hashes).filter((path) => !press.selection.includes(path))
      if (excluded.length > 0)
        return { ok: false, code: 'review-stale', detail: `Finish publishes the whole tested change set. Include or settle these paths and prepare again: ${excluded.join(', ')}`, changed: excluded }
      const proposed = state.review.repositories?.map((repository) => {
        const supplied = press.repositories?.find((row) => PathCompare.comparable(row.root) === PathCompare.comparable(repository.root))
        return { ...repository, message: supplied?.message ?? press.message, source: supplied?.source ?? press.source,
          acknowledged: supplied?.acknowledged ?? press.acknowledged }
      })
      if (press.repositories !== undefined && (press.repositories.length !== proposed?.length
        || press.repositories.some((row) => !proposed?.some((other) => PathCompare.comparable(other.root) === PathCompare.comparable(row.root)))))
        return ReviewCandidates.stale([])
      // The check reads the text as its author wrote it: a prefix added first hid the chat line above it (UA1-J12-2).
      const selected = (repository: WorktreeRepositoryReview): boolean => press.selection.some((path) => repository.paths.includes(reviewed.get(path)!))
      for (const repository of (proposed ?? []).filter(selected)) {
        const findings = SvnCommitMessageCheck.blocking(repository.message, repository.source, repository.acknowledged)
        if (findings.length > 0)
          return { ok: false, code: 'message-unchecked', detail: `${repository.repositoryName}: ${findings.map(SvnCommitMessageCheck.wordOf).join('; ')}` }
      }
      const repositories = proposed?.map((repository) => repository.source === 'person-local' || repository.source === 'person-remote' ? repository
        : { ...repository, message: SvnCommitMessageCheck.withPrefix(repository.message, repository.expectedPrefix) })
      for (const repository of (repositories ?? []).filter(selected))
        if (repository.source !== 'person-local' && repository.source !== 'person-remote' && !repository.message.startsWith(repository.expectedPrefix))
          return { ok: false, code: 'message-unchecked', detail: `${repository.repositoryName}: message must start with ${repository.expectedPrefix}` }
      await this.deps.commands.verify(root)
      const keys = [...new Set(reviewed.values())] as string[]
      const hashes = await this.deps.svn.commitHashes(root, [...new Set([...press.selection, ...keys])], 'node')
      if (!hashes.ok) throw new Error(hashes.detail)
      const changed = keys.filter((key) => hashes.value[key] !== state.review!.hashes[key])
      const version = state.version + 1
      const { reviewVersion: _reviewVersion, ...approval } = press
      const review = { ...state.review, ...approval, repositories, version, hashes: { ...state.review.hashes, ...hashes.value } }
      if (!await this.deps.records.update(sessionId, (record) => record.worktreeLifecycle?.version !== state.version ? null : {
        ...record, worktreeLifecycle: { ...record.worktreeLifecycle, version, review,
          step: changed.length > 0 ? 'reviewing' : 'awaiting-idle', approvedAt: changed.length > 0 ? undefined : Date.now() },
      })) return ReviewCandidates.stale([])
      return changed.length > 0 ? ReviewCandidates.stale(changed) : { ok: true, review }
    })
  }

  /**
   * The project a mount publishes, as its history and the commit helper name it: an external, a product
   * group (a coordinated commit) and a checkout of a whole repository use the repository name; a project
   * inside a larger repository uses its folder, so a Jamat worktree in `applications` expects [Jamat].
   */
  private static ownerOf(own: string, base: string, ownerDir: string, repositoryName: string): string {
    if (own !== '' || /^\/?(trunk\/?)?$/.test(base)) return repositoryName
    const group = ProductGroup.readAt(ownerDir)
    return group.ok && group.kind === 'product' ? repositoryName : basename(ownerDir)
  }

  /**
   * The reviewed entry a selected path belongs to: its own, or the unversioned directory svn listed
   * whole, whose files the review dialog offers one by one. The directory's hash covers those files.
   */
  private static reviewedKeyOf(hashes: Record<string, string>, path: string): string | undefined {
    if (Object.hasOwn(hashes, path)) return path
    return Object.keys(hashes).filter((key) => key !== '.' && path.startsWith(`${key}/`)).sort((a, b) => b.length - a.length)[0]
  }

  private static stale(changed: string[]): ReviewApproval {
    return { ok: false, code: 'review-stale', detail: `This review is outdated${changed.length > 0 ? `; changed: ${changed.join(', ')}` : ''}`, changed }
  }
}
