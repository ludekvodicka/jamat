import { SvnCommitMessageCheck, type CommitMessageSource } from '../../../lib-orchestrator/svn/svnCommitMessageCheck'
import { FileChangesFingerprint } from '../../../lib-orchestrator/fileChangesManager/fileChangesFingerprint'
import type { RemoteWorkflowReview } from '../../../lib-orchestrator/remoteControl/remoteReviewApi.types'
import type { VersioningWorkflowPort } from '../../shared/versioningCommit'
import { CommitTargets } from '../../shared/commitTargets'
import { randomUUID } from 'node:crypto'
import type { RemoteControlCommitStatusDto, RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

import type { FileChangesFileAccessResult } from '../../../lib-orchestrator/fileChangesManager/fileChangesManager'
import type { FileChangeEntry, FileChangesVcsDetection, FileChangesVcsId, FileChangesWorkingTreeSnapshot } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { VcsStatusView } from '../../../lib-orchestrator/fileChangesManager/vcsStatusView'
import type { GitCommitManager } from '../../../lib-orchestrator/git/gitCommitManager'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { SessionCommitReceipt } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { ErrorText } from '../../../lib-orchestrator/shared/errorText'
import type { CommitProgress } from '../../../lib-orchestrator/shared/commitProgress.types'
import { PathCompare } from '../../../lib-orchestrator/shared/pathCompare'
import type { TortoiseCommitDialog } from '../../../lib-orchestrator/shared/tortoiseCommitDialog'
import type { SvnCommitManager } from '../../../lib-orchestrator/svn/svnCommitManager'
import { VersioningCommitLimits, VersioningCommitMessage, VersioningCommitPaths, VersioningCommitReceipts, VersioningRevert } from '../../shared/versioningCommit'
import type { ReviewInteraction, ReviewInteractionAccess } from './reviewInteractionAccess'
import type { VersioningReviewDecision, VersioningReviewEdit, VersioningReviewEditResult, VersioningCommitPath, VersioningRevertRequest, VersioningRevertResult, VersioningTortoiseResult } from '../../shared/versioningCommit'
import type { VersioningCommitDraftDto, VersioningCommitOpenResult, VersioningCommitOpenSessions, VersioningCommitRunRequest, VersioningCommitRunResult } from '../../shared/versioningCommit'
import type { VersioningReviewStore, VersioningReviewRecord, VersioningReviewWake } from './versioningReviewStore'
import type { NotifySource, PendingNotify } from '../../../lib-orchestrator/sessionManager/sessionManager'
import { SessionLimits } from '../../../lib-orchestrator/sessionManager/sessionLimits'
import type { VersioningCommitMessageStore } from './versioningCommitMessageStore'

export interface VersioningCommitManagerDeps {
  workflow?: VersioningWorkflowPort
  splitReview?(sessionId: string, vcs: 'svn' | 'git', scopeRoot: string, intentId: string): Promise<string>
  externalDiffAvailable?(): boolean
  externalDiff?: import('./externalDiffLauncher').ExternalDiffLauncher['launch']
  interactions?: Pick<ReviewInteractionAccess, 'isActive'>
  reviews?: Pick<VersioningReviewStore, 'read' | 'save'>
  messages: Pick<VersioningCommitMessageStore, 'read' | 'save' | 'remove'>
  sessions: Pick<SessionManager, 'workingContext' | 'worktreeAt'> & Partial<Pick<SessionManager, 'proposeWorktreeReady'>>
  vcsStatus: Pick<VcsStatusView, 'detect'>
  fileAccess(ownerId: string, snapshotId: string, fileId: string): FileChangesFileAccessResult
  snapshotOf(ownerId: string, snapshotId: string): FileChangesWorkingTreeSnapshot | null
  git: Pick<GitCommitManager, 'commit' | 'revertFile'>
  svn: Pick<SvnCommitManager, 'commit' | 'revertFile' | 'updateOutOfDate'>
  tortoise: Pick<TortoiseCommitDialog, 'open'>
  onChanged(): void
  /**
   * An SVN review committed one or more scopes, or went to TortoiseSVN and closed (revision null:
   * TortoiseSVN does not say whether it committed). A worktree session there may go once it ended.
   */
  committed?(receipt: SessionCommitReceipt): void
  now?(): number
  newId?(): string
}

interface Draft {
  decisions?: VersioningReviewRecord['decisions']
  dto: VersioningCommitDraftDto
  committedPaths?: readonly string[]
  owners: Set<string>
  fileReviews: Map<string, {
    snapshot: FileChangesWorkingTreeSnapshot
    files: ReadonlyMap<string, FileChangesFileAccessResult>
  }>
  cwd: string
  lockRoot: string
  /** What the request named; a directory that is not `recursive` names its own node only. */
  targets?: readonly { path: string; directory: boolean; recursive: boolean }[]
  externalReview?: 'running' | 'closed'
  rejectedSnapshotId?: string
  wake?: VersioningReviewWake
  /** The paths the last listing showed, so a later listing can tell which rows are new. */
  listed?: ReadonlySet<string>
}

interface CommitTarget {
  entry: FileChangeEntry
  modifiedAt: number | null
  fingerprint?: string
  scopeRoot: string
}

type CancelResult = RemoteControlStepResult<RemoteControlCommitStatusDto>

export type VersioningCommitProposeResult =
  | { ok: true; scopeRoot: string }
  | { ok: false; code: 'message-empty' | 'message-too-long' | 'no-working-copy' | 'message-edited' | 'message-prefix' | 'busy'; detail: string }

export class VersioningCommitManager {
  private static readonly retentionMillisecondsConst = 86_400_000
  private static readonly retainedCountConst = 256
  private readonly drafts = new Map<string, Draft>()
  private readonly closed = new Map<string, { draft: Draft; closedAt: number }>()
  private readonly running = new Set<string>()
  private readonly pendingDecisions = new Map<string, { payload: string; result: Promise<VersioningCommitRunResult> }>()
  private readonly saved = new Map<string, VersioningReviewRecord>()
  private readonly epoch = randomUUID()
  private revision = 0
  /** What a window last read; a change from it is published, and nothing is before the first read. */
  private lastOpenSessions: string | null = null

  private readonly deps: VersioningCommitManagerDeps

  constructor(deps: VersioningCommitManagerDeps) {
    this.deps = deps
    for (const record of deps.reviews?.read() ?? []) {
      const dto = { ...record.dto, epoch: this.epoch, externalReview: record.externalReview === 'running' ? 'closed' as const : record.externalReview }
      if (dto.phase.kind === 'running' && dto.workflow === undefined || record.externalReview === 'running')
        dto.phase = { kind: 'failed', detail: 'The source restarted during publication. Its outcome is uncertain; verify the repository before continuing.', failedAt: this.now() }
      const draft: Draft = { ...record, dto, owners: new Set(), fileReviews: new Map(),
        ...(record.externalReview === 'running' ? { externalReview: 'closed' as const } : {}) }
      if (record.closedAt !== undefined) this.closed.set(dto.draftId, { draft, closedAt: record.closedAt })
      else this.drafts.set(dto.draftId, draft)
      this.saved.set(dto.draftId, structuredClone(record))
    }
  }

  /**
   * `fresh` is for a caller that waits for the outcome of the review it opens: a draft of the same
   * scope that already ended, still shown in a pane, would answer its old outcome at once.
   */
  private async isWorktree(path: string): Promise<boolean> {
    return path.replace(/\\/g, '/').split('/').some((part) => part.toLowerCase() === '.worktrees')
      || (await this.deps.sessions.worktreeAt(path))?.kind === 'svn'
  }

  async prepare(sessionId: string, vcs: FileChangesVcsId, scope: string | null, proposal: string | null,
    paths?: readonly VersioningCommitPath[], options: { fresh?: true; reviewOnly?: true; wakeOnClose?: true } = {}): Promise<VersioningCommitOpenResult> {
    if (vcs !== 'svn' && vcs !== 'git') throw new Error(`Unknown commit VCS: ${JSON.stringify(vcs)}`)
    const proposed = proposal === null ? null : VersioningCommitMessage.normalize(proposal)
    if (proposed !== null && proposed.length > VersioningCommitLimits.messageMaxCharactersConst)
      return { ok: false, code: 'message-too-long', detail: `The commit message is limited to ${VersioningCommitLimits.messageMaxCharactersConst} characters` }
    const context = await this.deps.sessions.workingContext(sessionId)
    if (!context.ok) return { ok: false, code: 'unknown-session', detail: context.detail }
    const cwd = context.value.cwd
    const input: readonly unknown[] = paths ?? [scope ?? '.']
    if (!Array.isArray(input) || input.length === 0 || input.length > VersioningCommitLimits.targetsMaxConst
      || !input.every(VersioningCommitPaths.valid))
      return { ok: false, code: 'no-working-copy', detail: 'Supply a nonempty list of literal commit paths' }
    const requests = new Map<string, { path: string; nodeOnly: boolean }>()
    for (const request of input) {
      const path = resolve(cwd, VersioningCommitPaths.pathOf(request))
      const key = PathCompare.comparable(path)
      // The same directory named twice keeps the wider selection.
      requests.set(key, { path, nodeOnly: VersioningCommitPaths.nodeOnly(request) && (requests.get(key)?.nodeOnly ?? true) })
    }
    if (vcs === 'svn' && options.reviewOnly !== true)
      for (const path of requests.values())
        if (await this.isWorktree(path.path))
          return { ok: false, code: 'use-finish', detail: 'use-finish: press Finish in Session actions' }
    const selected = [...requests.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    const requestedKey = VersioningCommitManager.keyOf(selected.map(({ path, nodeOnly }) => nodeOnly ? { path, depth: 'empty' } : path))
    const retained = [...this.drafts.values()].find((draft) => draft.dto.sessionId === sessionId && draft.dto.vcs === vcs
      && draft.dto.paths !== undefined && VersioningCommitManager.keyOf(draft.dto.paths) === requestedKey)
    const targets = retained?.targets ?? await Promise.all(selected.map(async ({ path, nodeOnly }) => {
      const directory = await lstat(path).then((stat) => stat.isDirectory()).catch(() => false)
      return { path, directory, recursive: directory && !nodeOnly }
    }))
    const normalized: readonly VersioningCommitPath[] = targets.map((target) =>
      target.directory && !target.recursive ? { path: target.path, depth: 'empty' } : target.path)
    const directories = targets.map((target) => target.directory ? target.path : dirname(target.path))
    let requested = retained?.dto.scopeRoot ?? directories[0]
    while (directories.some((directory) => !PathCompare.isInside(requested, directory))) {
      const parent = dirname(requested)
      if (parent === requested) return { ok: false, code: 'no-working-copy', detail: 'Commit paths must share one working-copy directory' }
      requested = parent
    }
    const workingCopy = await this.workingCopyOf(requested, vcs)
    if (workingCopy === null)
      return { ok: false, code: 'no-working-copy', detail: `The requested paths are not inside a ${vcs.toUpperCase()} working copy` }
    requested = workingCopy.scopeRoot
    const detection = workingCopy.detection
    const restricted = targets.length !== 1 || !targets[0].recursive
      || PathCompare.comparable(targets[0].path) !== PathCompare.comparable(requested)
    const selectedPaths = restricted ? normalized : undefined
    const matching = [...this.drafts.values()].find((draft) => draft.dto.sessionId === sessionId && draft.dto.vcs === vcs
      && PathCompare.comparable(draft.dto.scopeRoot) === PathCompare.comparable(requested)
      && (draft.dto.paths === undefined ? null : VersioningCommitManager.keyOf(draft.dto.paths))
        === (selectedPaths === undefined ? null : VersioningCommitManager.keyOf(selectedPaths)))
    const existing = matching !== undefined && (matching.dto.phase.kind === 'cancelled' || (options.fresh === true && VersioningCommitManager.ended(matching))) ? undefined : matching
    // Its pane finds the draft gone and opens this scope again, which reaches the fresh draft.
    if (matching !== undefined && existing === undefined) this.close(matching)
    const draft: Draft = existing ?? {
      dto: {
        draftId: this.deps.newId?.() ?? randomUUID(), epoch: this.epoch, sessionId, vcs, scopeRoot: requested,
        scopeTooltip: VersioningCommitManager.tooltipOf(requested, selectedPaths ?? null),
        ...(selectedPaths === undefined ? {} : { paths: selectedPaths }),
        source: vcs, message: '', messageSource: 'unknown', messageAt: this.now(), editedByPerson: false, proposedByAgent: false,
        ...this.deps.messages.read({ sessionId, vcs, scopeRoot: requested, paths: selectedPaths }),
        phase: { kind: 'editing' }, revision: 0,
      },
      owners: new Set(), fileReviews: new Map(), cwd, lockRoot: PathCompare.comparable(detection.root), ...(restricted ? { targets } : {}),
    }
    if (options.wakeOnClose === true) draft.wake ??= { state: 'watching' }
    const messageApplied = proposed !== null && !VersioningCommitManager.personEdited(draft.dto) && draft.dto.phase.kind === 'editing'
    if (messageApplied) {
      draft.dto.message = proposed
      draft.dto.editedByPerson = false
      draft.dto.proposedByAgent = true
      draft.dto.messageSource = 'agent-proposal'
      draft.dto.messageAt = this.now()
      if (!this.deps.messages.save(draft.dto)) throw new Error('The commit message could not be saved')
    }
    const source = this.deps.workflow?.messageSource?.(draft.dto)
    if (source !== undefined && source !== draft.dto.messageSource) {
      draft.dto.messageSource = source
      draft.dto.messageAt = this.now()
      if (!this.deps.messages.save(draft.dto)) throw new Error('The commit message could not be saved')
    }
    this.drafts.set(draft.dto.draftId, draft)
    this.bump(draft)
    return { ok: true, value: { draftId: draft.dto.draftId, scopeRoot: requested,
      ...(selectedPaths === undefined ? {} : { paths: selectedPaths }),
      title: `Commit ${vcs.toUpperCase()} · ${selected.length === 1 ? basename(selected[0].path) : `${selected.length} paths`}` }, messageApplied }
  }

  /** One comparable spelling of a selection, so a reopened review finds the draft it left. */
  private static keyOf(paths: readonly VersioningCommitPath[]): string {
    return JSON.stringify(paths.map((path) => VersioningCommitPaths.nodeOnly(path)
      ? [PathCompare.comparable(VersioningCommitPaths.pathOf(path)), 'empty'] : PathCompare.comparable(VersioningCommitPaths.pathOf(path))))
  }

  /**
   * A worker's message for the SVN working copy at or above `directory`, kept under its session the
   * way the split keeps a proposal, and nothing opens. An open split of that scope shows it at once.
   * A message a person wrote there wins, as it wins over every proposal.
   */
  async propose(sessionId: string, directory: string, message: string): Promise<VersioningCommitProposeResult> {
    const proposed = VersioningCommitMessage.normalize(message)
    if (!proposed.trim()) return { ok: false, code: 'message-empty', detail: 'The proposed commit message is empty' }
    if (proposed.length > VersioningCommitLimits.messageMaxCharactersConst)
      return { ok: false, code: 'message-too-long', detail: `The commit message is limited to ${VersioningCommitLimits.messageMaxCharactersConst} characters` }
    const workingCopy = await this.workingCopyOf(directory, 'svn')
    if (workingCopy === null) return { ok: false, code: 'no-working-copy', detail: `${directory} is not inside an SVN working copy` }
    const scopeRoot = workingCopy.scopeRoot
    const scope = { sessionId, vcs: 'svn' as const, scopeRoot }
    const open = [...this.drafts.values()].find((draft) => draft.dto.sessionId === sessionId && draft.dto.vcs === 'svn'
      && draft.dto.paths === undefined && PathCompare.comparable(draft.dto.scopeRoot) === PathCompare.comparable(scopeRoot)
      && !VersioningCommitManager.ended(draft))
    // A Finish review keeps one message per repository: the row of this root says who wrote it there (UA1-J12-5).
    const finish = [...this.drafts.values()].find((draft) => draft.dto.sessionId === sessionId && draft.dto.vcs === 'svn'
      && draft.dto.paths === undefined && !VersioningCommitManager.ended(draft)
      && this.repositoriesOf(draft)?.some((row) => PathCompare.comparable(row.root) === PathCompare.comparable(scopeRoot)))
    const row = finish === undefined ? undefined : this.repositoriesOf(finish)!.find((candidate) => PathCompare.comparable(candidate.root) === PathCompare.comparable(scopeRoot))
    // With a field per repository the draft's own message is hidden, and its flag also recorded an
    // edit that left a field empty: Mirabia 113 refused a proposal into an empty row (2026-10-30).
    const field = row !== undefined && this.deps.workflow?.separateMessages?.(finish!.dto) === true ? row : undefined
    const kept = field === undefined ? open?.dto ?? this.deps.messages.read(scope) : undefined
    if (field !== undefined ? SvnCommitMessageCheck.personMessage(field.message, field.source) : kept !== undefined && VersioningCommitManager.personEdited(kept))
      return { ok: false, code: 'message-edited', detail: `A person already wrote the commit message for ${scopeRoot}; the proposal was not stored` }
    if (open?.dto.phase.kind === 'running' || finish?.dto.phase.kind === 'running')
      return { ok: false, code: 'busy', detail: `A commit of ${scopeRoot} is running; propose again after it` }
    // The same rule Publish applies, answered while the worker can still correct it.
    if (row !== undefined && !SvnCommitMessageCheck.prefixed(proposed, row.expectedPrefix))
      return { ok: false, code: 'message-prefix', detail: `${row.repositoryName}: message must start with ${row.expectedPrefix}; the proposal was not stored` }
    if (open === undefined) {
      if (!this.deps.messages.save({ ...scope, message: proposed, editedByPerson: false, proposedByAgent: true, messageSource: 'agent-proposal', messageAt: this.now() }))
        throw new Error('The commit message could not be saved')
    }
    else {
      open.dto.message = proposed
      open.dto.editedByPerson = false
      open.dto.proposedByAgent = true
      open.dto.messageSource = 'agent-proposal'
      open.dto.messageAt = this.now()
      if (!this.deps.messages.save(open.dto)) throw new Error('The commit message could not be saved')
    }
    // The field shows the proposal the Finish publishes, not an older one the review was prepared with.
    if (finish !== undefined) finish.dto.repositories = this.repositoryMessagesOf(finish, scopeRoot, proposed, 'agent-proposal')
    if (open !== undefined) this.bump(open)
    if (finish !== undefined && finish !== open) this.bump(finish)
    await this.deps.sessions.proposeWorktreeReady?.(sessionId)
    return { ok: true, scopeRoot }
  }

  /** The message kept for the session's whole working copy at `scopeRoot`, or null when there is none to use. */
  proposalOf(sessionId: string, scopeRoot: string): string | null {
    const saved = this.deps.messages.read({ sessionId, vcs: 'svn', scopeRoot })
    return saved === undefined || !saved.message.trim() ? null : saved.message
  }

  /** A Finish committed the worktree at `scopeRoot`, so the message kept for it there has served. */
  forgetProposal(sessionId: string, scopeRoot: string): void {
    if (!this.deps.messages.remove({ sessionId, vcs: 'svn', scopeRoot }))
      throw new Error('The commit message could not be removed')
  }

  /**
   * The directory a review of `start` stands on, and what detected it there. A directory SVN does not
   * know yet answers to the project's own Git instead, so a file inside a new SVN directory has to
   * climb past that answer to the working copy that will version it.
   */
  private async workingCopyOf(start: string, vcs: FileChangesVcsId): Promise<{ scopeRoot: string; detection: FileChangesVcsDetection } | null> {
    let scopeRoot = start
    let detection = await this.deps.vcsStatus.detect(scopeRoot, vcs)
    while (detection?.id !== vcs && dirname(scopeRoot) !== scopeRoot) {
      scopeRoot = dirname(scopeRoot)
      detection = await this.deps.vcsStatus.detect(scopeRoot, vcs)
    }
    if (detection === null || detection.id !== vcs || await realpath(scopeRoot).catch(() => null) === null) return null
    return { scopeRoot, detection }
  }

  /** A person's message is one they wrote: a field they emptied, or left at its prefix, protects nothing (2026-10-30). */
  private static personEdited(message: Pick<VersioningCommitDraftDto, 'message' | 'editedByPerson'>): boolean {
    return message.editedByPerson && !SvnCommitMessageCheck.empty(message.message)
  }

  /** Whether a draft can no longer settle any other way than it already did. */
  private static ended(draft: Draft): boolean {
    const phase = draft.dto.phase
    if (phase.kind === 'done' || phase.kind === 'cancelled') return true
    else if (phase.kind === 'editing' || phase.kind === 'failed') return draft.externalReview === 'closed'
    else if (phase.kind === 'running') return false
    else throw new Error(`Unknown commit phase: ${JSON.stringify(phase satisfies never)}`)
  }

  /**
   * What the heading says on hover. The heading itself is the working copy, one line, whatever was
   * asked for: a restricted selection used to BE the heading, nine absolute paths joined by a
   * newline that `white-space: nowrap` then folded into one unreadable line. The paths are listed
   * relative to the root because the root is the line directly above them.
   */
  private static tooltipOf(root: string, paths: readonly VersioningCommitPath[] | null): string {
    if (paths === null) return root
    return [root, ...paths.map((path) => `  ${relative(root, VersioningCommitPaths.pathOf(path)) || '.'}${
      VersioningCommitPaths.nodeOnly(path) ? ' (this folder only)' : ''}`)].join('\n')
  }

  /**
   * The rows the review shows, which are also the only rows a write accepts: a plain scope shows
   * all of it, a selection only what its targets reach (`allows`). Which of them start checked is
   * `checkedPaths`.
   */
  files(ownerId: string, draftId: string, snapshot: FileChangesWorkingTreeSnapshot): FileChangesWorkingTreeSnapshot {
    const draft = this.owned(ownerId, draftId)
    if (draft === null) throw new Error('The commit dialog no longer exists')
    const entries = snapshot.entries.filter((entry) => VersioningCommitManager.allows(draft, entry))
    const ids = new Set(entries.map((entry) => entry.fileId))
    const filtered = { ...snapshot, entries, externalRoots: snapshot.externalRoots.map((root) => ({ ...root,
      fileIds: root.fileIds.filter((id) => ids.has(id)) })).filter((root) => root.fileIds.length > 0) }
    // A visible review must outlive the shared browsing cache's TTL and capacity evictions.
    // Keep its original timestamps; commit and revert still check the files on disk.
    draft.fileReviews.set(ownerId, structuredClone({ snapshot: filtered,
      files: new Map(entries.map((entry) => [entry.fileId, this.deps.fileAccess(ownerId, snapshot.snapshotId, entry.fileId)])) }))
    const listed = draft.listed
    draft.listed = new Set(entries.map((entry) => PathCompare.comparable(entry.path)))
    if (draft.dto.phase.kind !== 'editing' && draft.dto.phase.kind !== 'failed') return filtered
    const defaults = this.checkedPaths(ownerId, draftId, filtered)
    const checked = CommitTargets.eligible(filtered)
      .filter((entry) => entry.origin !== 'setup' && (defaults === null || defaults.includes(entry.path))).map((entry) => entry.path)
    if (draft.dto.selection === undefined) {
      draft.dto.selection = { snapshotId: snapshot.snapshotId, paths: checked }
      this.bump(draft)
    }
    // A Finish publishes only its whole verified set, so a path that appeared since the person chose
    // starts checked; a plain dialog keeps what the person chose.
    else if (listed !== undefined && this.deps.workflow?.owns?.(draft.dto.sessionId) === true) {
      const added = checked.filter((path) => !listed.has(PathCompare.comparable(path)))
      if (added.length === 0) return filtered
      draft.dto.selection = { snapshotId: snapshot.snapshotId, paths: [...draft.dto.selection.paths, ...added] }
      this.bump(draft)
    }
    return filtered
  }

  /**
   * The rows a review that named its targets starts with checked: a named file, a named directory
   * with every row below it, a node-only directory alone. Null for a plain scope, whose eligible rows
   * all start checked. r345 committed 123 paths of other sessions' unfinished work because a
   * review of one directory's property change started with the whole scope below it checked.
   */
  checkedPaths(ownerId: string, draftId: string, snapshot: FileChangesWorkingTreeSnapshot): readonly string[] | null {
    const draft = this.owned(ownerId, draftId)
    if (draft === null) throw new Error('The commit dialog no longer exists')
    const targets = draft.targets
    if (targets === undefined) return null
    return snapshot.entries.filter((entry) => targets.some((target) =>
      PathCompare.comparable(target.path) === PathCompare.comparable(entry.path)
      || (target.recursive && PathCompare.isInside(target.path, entry.path)))).map((entry) => entry.path)
  }

  discovery(): { revision: number; pending: readonly string[]; results: readonly string[] } {
    this.sweepClosed()
    const all = [...this.drafts.values(), ...[...this.closed.values()].map(({ draft }) => draft)]
    return { revision: this.revision, pending: [...new Set(all.filter((draft) => !VersioningCommitManager.ended(draft)).map((draft) => draft.dto.sessionId))],
      results: [...new Set(all.filter(VersioningCommitManager.ended).map((draft) => draft.dto.sessionId))] }
  }

  catalog(sessionId?: string): readonly VersioningCommitDraftDto[] {
    this.sweepClosed()
    return [...this.drafts.values(), ...[...this.closed.values()].map(({ draft }) => draft)]
      .filter((draft) => sessionId === undefined || draft.dto.sessionId === sessionId).map((draft) => this.dtoOf(draft))
  }

  openReview(sessionId: string, reviewId: string, ownerId: string): VersioningCommitOpenResult {
    const draft = this.drafts.get(reviewId) ?? this.closed.get(reviewId)?.draft
    if (!draft || draft.dto.sessionId !== sessionId)
      return { ok: false, code: 'unknown-session', detail: 'The review does not belong to this source session or has expired' }
    draft.owners.add(ownerId)
    return { ok: true, value: { draftId: reviewId, scopeRoot: draft.dto.scopeRoot, paths: draft.dto.paths,
      title: `Commit ${draft.dto.vcs.toUpperCase()}` }, messageApplied: false }
  }

  externalScope(ownerId: string, draftId: string, snapshotId: string, scopeRoot: string): boolean {
    const draft = this.owned(ownerId, draftId)
    const snapshot = draft ? this.snapshotOf(ownerId, draft, snapshotId) : null
    return snapshot?.externalRoots.some((root) => PathCompare.comparable(root.path) === PathCompare.comparable(scopeRoot)
      && root.fileIds.length > 0) === true
  }

  read(ownerId: string, draftId: string): VersioningCommitDraftDto | null {
    const draft = this.drafts.get(draftId) ?? this.closed.get(draftId)?.draft
    return draft === undefined || !draft.owners.has(ownerId) ? null : this.dtoOf(draft)
  }

  async openWorkflow(sessionId: string, vcs: 'svn' | 'git', scopeRoot: string, ownerId: string): Promise<VersioningCommitOpenResult> {
    if (!this.deps.workflow?.offers(sessionId, vcs, scopeRoot))
      return { ok: false, code: 'outside-session', detail: 'This scope is not offered by the source session Finish' }
    const result = await this.prepare(sessionId, vcs, scopeRoot, null, undefined, { reviewOnly: true })
    if (result.ok) this.attach(result.value.draftId, ownerId)
    return result
  }

  cancel(draftId: string): Promise<CancelResult> {
    const status = this.status(draftId)
    if (status === null)
      return Promise.resolve({ ok: false, error: { code: 'not-found', detail: 'The commit review is unknown' } })
    if (status.state === 'cancelled') return Promise.resolve({ ok: true, value: status })
    const draft = this.drafts.get(draftId)
    if (draft === undefined || this.busy(draft.lockRoot) || status.state === 'running'
      || status.state === 'committed' || status.state === 'external-closed')
      return Promise.resolve({ ok: false, error: { code: 'conflict', detail: `Cannot cancel this review while it is ${status.state} or its working copy is busy` } })
    draft.dto.phase = { kind: 'cancelled' }
    // Only `commit cancel` reaches here, the agent's own command, and its answer already says
    // cancelled: a close line after it started a needless turn (Codex i83, 2026-10-30). A person
    // cancels through `decide`, which keeps the line.
    if (draft.wake?.state === 'watching') delete draft.wake
    this.bump(draft)
    this.releaseUnattached(draftId)
    return Promise.resolve({ ok: true, value: this.status(draftId)! })
  }

  status(commitSessionId: string): RemoteControlCommitStatusDto | null {
    this.sweepClosed()
    const draft = this.drafts.get(commitSessionId) ?? this.closed.get(commitSessionId)?.draft
    if (draft === undefined) return null
    this.refreshWorkflow(draft)
    const closed = draft.owners.size === 0 || this.closed.has(commitSessionId)
    const { phase, sessionId, vcs, scopeRoot } = draft.dto
    let state: RemoteControlCommitStatusDto['state']
    if (phase.kind === 'done') state = 'committed'
    else if (phase.kind === 'running' || draft.externalReview === 'running') state = 'running'
    else if (draft.externalReview === 'closed') state = 'external-closed'
    else if (phase.kind === 'failed') state = 'failed'
    else if (phase.kind === 'cancelled') state = 'cancelled'
    else if (phase.kind === 'editing') state = 'editing'
    else throw new Error(`Unknown commit phase: ${JSON.stringify(phase)}`)
    const omittedPaths = [...new Set(VersioningCommitReceipts.unresolved(draft.dto).flatMap((receipt) => receipt.omittedPaths ?? []))]
    return { kind: 'commit-status', commitSessionId, sessionId, vcs, scopeRoot, state, closed,
      ...(draft.dto.paths === undefined ? {} : { paths: draft.dto.paths.map(VersioningCommitPaths.pathOf) }),
      ...(draft.committedPaths === undefined ? {} : { committedPaths: [...draft.committedPaths] }),
      ...(omittedPaths.length === 0 ? {} : { omittedPaths }),
      revision: phase.kind === 'done' ? phase.revision : null, detail: state === 'failed' && phase.kind === 'failed' ? phase.detail
        : omittedPaths.length > 0 ? `SVN published revisions, but did not report these selected paths: ${omittedPaths.join(', ')}` : null }
  }

  /** The close lines of the reviews the CLI opened, typed into each review's session by the session notifier. */
  notifySource(): NotifySource {
    return { pending: () => this.pendingWakes(), note: (ids, state) => Promise.resolve(this.noteWakes(ids, state)) }
  }

  /**
   * A watched review gets its line once it ended the way a CLI waiter ends on it. The line is saved
   * with the review, so a restart neither loses nor repeats it; a review that settled just before a
   * restart gets it at the first pass after it.
   */
  private pendingWakes(): PendingNotify[] {
    const reviews = () => [...this.drafts.values(), ...[...this.closed.values()].map(({ draft }) => draft)]
    const settled = reviews().filter((draft) => draft.wake?.state === 'watching').flatMap((draft) => {
      const status = this.status(draft.dto.draftId)
      return status !== null && VersioningCommitManager.settles(status) ? [{ draft, status }] : []
    })
    if (settled.length > 0) {
      const at = this.now()
      for (const { draft, status } of settled) draft.wake = { state: 'pending', text: VersioningCommitManager.wakeLineOf(status), at, attempts: 0 }
      // The store already reported a failed write; the reviews stay watched and the next pass tries again.
      try { this.persist() }
      catch { for (const { draft } of settled) draft.wake = { state: 'watching' } }
    }
    return reviews().flatMap((draft) => draft.wake?.state === 'pending'
      ? [{ id: draft.dto.draftId, sessionId: draft.dto.sessionId, text: draft.wake.text, at: draft.wake.at, attempts: draft.wake.attempts }]
      : [])
  }

  /** `attempted` counts a refused try; the other two end the line. */
  private noteWakes(ids: readonly string[], state: 'delivered' | 'attempted' | 'expired'): void {
    for (const id of ids) {
      const draft = this.drafts.get(id) ?? this.closed.get(id)?.draft
      const wake = draft?.wake
      if (draft === undefined || wake?.state !== 'pending') continue
      if (state === 'attempted') draft.wake = { ...wake, attempts: wake.attempts + 1 }
      else if (state === 'delivered' || state === 'expired') draft.wake = { ...wake, state }
      else throw new Error(`Unknown notify state: ${JSON.stringify(state satisfies never)}`)
    }
    // Memory keeps the settled line, so this client never types it twice; the store reported a failed write.
    try { this.persist() } catch { /* reported by the store */ }
  }

  /** The same end as `CommitStatusReader`: a failure or cancellation counts once its review closed. */
  private static settles(status: RemoteControlCommitStatusDto): boolean {
    const state = status.state
    if (state === 'committed' || state === 'external-closed') return true
    else if (state === 'failed' || state === 'cancelled') return status.closed
    else if (state === 'editing' || state === 'running') return false
    else throw new Error(`Unknown commit state: ${JSON.stringify(state satisfies never)}`)
  }

  /** One line without control characters, inside the notifier's limit; only a failure detail is shortened. */
  private static wakeLineOf(status: RemoteControlCommitStatusDto): string {
    const flat = (text: string) => text.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim()
    const review = `Jamat: commit review ${status.commitSessionId}`
    const scope = flat(status.scopeRoot)
    const end = ' Verify the result and finish your reply.'
    const state = status.state
    let outcome: string
    if (state === 'committed') outcome = `${review} committed revision ${status.revision} in ${scope}.`
    else if (state === 'cancelled') outcome = `${review} in ${scope} was cancelled; nothing was committed.`
    else if (state === 'external-closed') outcome = `${review} in ${scope} closed in Tortoise, which does not say whether it committed.`
    else if (state === 'failed') {
      const head = `${review} in ${scope} failed: `
      const room = SessionLimits.worktreeNotifyCharacters - head.length - end.length - 1
      const detail = flat(status.detail ?? 'no detail').replace(/[. ]+$/, '')
      outcome = `${head}${detail.length <= room ? detail : `${detail.slice(0, room - 1)}…`}.`
    } else if (state === 'editing' || state === 'running') throw new Error(`A ${state} review has no close line`)
    else throw new Error(`Unknown commit state: ${JSON.stringify(state satisfies never)}`)
    const line = `${outcome}${end}`
    const limit = SessionLimits.worktreeNotifyCharacters
    return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`
  }

  private sweepClosed(): void {
    for (const [id, entry] of this.closed)
      if (entry.draft.dto.phase.kind !== 'running' && entry.draft.externalReview !== 'running'
        && (this.now() - entry.closedAt >= VersioningCommitManager.retentionMillisecondsConst
          || this.closed.size > VersioningCommitManager.retainedCountConst))
        this.closed.delete(id)
  }

  reviews(sessionId: string, ownerId: string): readonly RemoteControlCommitStatusDto[] {
    return [...this.drafts.values()].filter((draft) => draft.dto.sessionId === sessionId && draft.owners.has(ownerId))
      .map((draft) => this.status(draft.dto.draftId)!)
  }

  attach(draftId: string, ownerId: string): void {
    this.drafts.get(draftId)?.owners.add(ownerId)
  }

  release(draftId: string, ownerId: string): void {
    const draft = this.drafts.get(draftId) ?? this.closed.get(draftId)?.draft
    if (draft === undefined || !draft.owners.delete(ownerId)) return
    draft.fileReviews.delete(ownerId)
    this.releaseUnattached(draftId)
  }

  releaseUnattached(draftId: string): void {
    const draft = this.drafts.get(draftId)
    if (draft === undefined || draft.owners.size !== 0 || !VersioningCommitManager.ended(draft)) return
    this.close(draft)
  }

  /** The review leaves the open drafts; its status stays readable until it expires. */
  private close(draft: Draft): void {
    const draftId = draft.dto.draftId
    draft.owners.clear()
    draft.fileReviews.clear()
    this.closed.set(draftId, { draft, closedAt: this.now() })
    this.drafts.delete(draftId)
    this.sweepClosed()
    this.persist()
    this.changed()
  }

  revokeOwner(ownerId: string): void {
    for (const draft of [...this.drafts.values(), ...[...this.closed.values()].map(({ draft }) => draft)]) this.release(draft.dto.draftId, ownerId)
  }

  openSessions(): VersioningCommitOpenSessions {
    const sessionIds = this.openSessionIds()
    this.lastOpenSessions = JSON.stringify(sessionIds)
    return { revision: this.revision, sessionIds, reviews: this.pendingDrafts().map(({ dto }) => ({
      draftId: dto.draftId, sessionId: dto.sessionId, vcs: dto.vcs, scopeRoot: dto.scopeRoot,
      ...(dto.paths === undefined ? {} : { paths: structuredClone(dto.paths) }),
      workflow: this.deps.workflow?.owns?.(dto.sessionId) === true,
    })) }
  }

  /**
   * A Finish review commits through its Finish, so its draft is never marked done; once the Finish
   * left the review it no longer asks for one, and 051 kept its red mark over a landed row.
   */
  workflowChanged(): void {
    this.settleWorkflows()
    if (this.lastOpenSessions === null) return
    const open = JSON.stringify(this.openSessionIds())
    if (open === this.lastOpenSessions) return
    this.lastOpenSessions = open
    this.changed()
  }

  /**
   * A Finish review is refreshed only when it is read, so a Finish that ended while nobody showed its
   * review stayed `running` with an empty receipt for good: 13 drafts back to 14 Oct (2026-10-30).
   * Once nobody holds it, a draft whose Finish ended, or whose session is gone, leaves the open drafts;
   * a restart keeps such a draft running until the first read of the sessions settles it here.
   * A shown draft follows its Finish here too: the approval answers before the Finish publishes.
   */
  private settleWorkflows(): void {
    for (const draft of [...this.drafts.values()]) {
      if (draft.dto.workflow === undefined || this.running.has(draft.lockRoot)) continue
      this.refreshWorkflow(draft)
      if (draft.owners.size !== 0) continue
      if (draft.dto.phase.kind === 'done' || draft.dto.workflow !== undefined && this.deps.workflow?.abandoned?.(draft.dto) === true) this.close(draft)
    }
  }

  private openSessionIds(): string[] {
    return [...new Set(this.pendingDrafts().map((draft) => draft.dto.sessionId))]
  }

  private pendingDrafts(): Draft[] {
    return [...this.drafts.values()]
      .filter((draft) => draft.dto.phase.kind !== 'done' && draft.dto.phase.kind !== 'cancelled' && !this.finishLeft(draft))
  }

  private finishLeft(draft: Draft): boolean {
    const workflow = this.deps.workflow
    return workflow?.owns?.(draft.dto.sessionId) === true && draft.dto.phase.kind !== 'running'
      && (draft.dto.vcs !== 'svn' && draft.dto.vcs !== 'git' || !workflow.offers(draft.dto.sessionId, draft.dto.vcs, draft.dto.scopeRoot))
  }

  setMessage(ownerId: string, draftId: string, message: string): boolean {
    const draft = this.owned(ownerId, draftId)
    if (draft === null || typeof message !== 'string' || message.length > VersioningCommitLimits.messageMaxCharactersConst
      || draft.dto.phase.kind === 'running' || draft.dto.phase.kind === 'done' || draft.dto.phase.kind === 'cancelled') return false
    const previous = structuredClone(draft.dto)
    draft.dto.message = VersioningCommitMessage.normalize(message)
    draft.dto.editedByPerson = !SvnCommitMessageCheck.empty(draft.dto.message)
    draft.dto.proposedByAgent = false
    draft.dto.messageSource = 'person-local'
    draft.dto.messageAt = this.now()
    if (!this.deps.messages.save(draft.dto)) { draft.dto = previous; return false }
    try { this.bump(draft) }
    catch (error) { draft.dto = previous; this.deps.messages.save(previous); throw error }
    return true
  }

  edit(ownerId: string, request: VersioningReviewEdit, source: CommitMessageSource = request.messageSource ?? 'person-remote'): VersioningReviewEditResult {
    const draft = this.owned(ownerId, request.draftId)
    if (!draft) return { ok: false, code: 'unknown-draft', detail: 'The review is no longer available' }
    if (request.epoch !== this.epoch || request.expectedRevision !== draft.dto.revision)
      return { ok: false, code: 'stale', detail: 'This review changed in another viewer. Compare or reload its edits.', current: this.dtoOf(draft) }
    if (this.busy(draft.lockRoot) || draft.dto.phase.kind === 'running' || draft.dto.phase.kind === 'done' || draft.dto.phase.kind === 'cancelled')
      return { ok: false, code: 'busy', detail: 'The review is running or settled' }
    if (request.message !== undefined && (typeof request.message !== 'string' || request.message.length > VersioningCommitLimits.messageMaxCharactersConst))
      return { ok: false, code: 'invalid-target', detail: 'Invalid commit message' }
    let selection = draft.dto.selection
    if (request.selection !== undefined) {
      const snapshot = this.snapshotOf(ownerId, draft, request.selection.snapshotId)
      const ids = request.selection.fileIds
      if (!snapshot || snapshot.sessionId !== draft.dto.sessionId || snapshot.source.selected !== draft.dto.source
        || !Array.isArray(ids) || ids.length > VersioningCommitLimits.targetsMaxConst
        || ids.some((id) => !snapshot.entries.some((entry) => entry.fileId === id && VersioningCommitManager.allows(draft, entry))))
        return { ok: false, code: 'invalid-target', detail: 'The selection contains files outside the displayed source snapshot' }
      selection = { snapshotId: snapshot.snapshotId, paths: snapshot.entries.filter((entry) => ids.includes(entry.fileId)).map((entry) => entry.path) }
    }
    const repositories = this.repositoriesOf(draft)
    if (request.repositoryMessage !== undefined && !repositories?.some((row) => PathCompare.comparable(row.root) === PathCompare.comparable(request.repositoryMessage!.root)))
      return { ok: false, code: 'invalid-target', detail: 'The repository is outside the current Finish review' }
    const previous = structuredClone(draft.dto)
    draft.dto = { ...draft.dto, ...(request.repositoryMessage === undefined ? {}
      : { repositories: this.repositoryMessagesOf(draft, request.repositoryMessage.root, request.repositoryMessage.message, source) }), ...(selection === undefined ? {} : { selection }),
      ...(request.message === undefined ? {} : { message: VersioningCommitMessage.normalize(request.message),
        editedByPerson: !SvnCommitMessageCheck.empty(request.message), proposedByAgent: false, messageSource: source, messageAt: this.now() }) }
    try {
      if (request.message !== undefined && !this.deps.messages.save(draft.dto)) throw new Error('The commit message could not be saved')
      this.bump(draft)
    } catch (error) { draft.dto = previous; this.deps.messages.save(previous); throw error }
    return { ok: true, value: this.dtoOf(draft) }
  }

  decide(interaction: ReviewInteraction, request: VersioningReviewDecision): Promise<VersioningCommitRunResult> {
    const refused = (code: 'forbidden' | 'conflict' | 'uncertain' | 'unknown-draft', detail: string): Promise<VersioningCommitRunResult> => Promise.resolve({ ok: false, code, detail })
    if (!this.deps.interactions?.isActive(interaction)) return refused('forbidden', 'A live human workspace interaction is required')
    const draft = this.drafts.get(request.draftId) ?? this.closed.get(request.draftId)?.draft
    if (!draft || draft.dto.sessionId !== interaction.sessionId) return refused('unknown-draft', 'This review belongs to another source session')
    this.refreshWorkflow(draft)
    const payload = JSON.stringify(request)
    const key = JSON.stringify([interaction.actorId, interaction.sessionId, request.draftId, request.operationId])
    const pending = this.pendingDecisions.get(key)
    if (pending) return pending.payload === payload ? pending.result : refused('conflict', 'Operation ID was already used with another decision')
    const prior = draft.decisions?.find((decision) => decision.operationId === request.operationId && decision.actorId === interaction.actorId)
    if (prior) {
      if (prior.payload !== payload) return refused('conflict', 'Operation ID was already used with another decision')
      return prior.result ? Promise.resolve(structuredClone(prior.result)) : refused('uncertain', 'The source restarted after accepting this operation; verify its original outcome')
    }
    if (!draft.owners.has(interaction.ownerId)) return refused('unknown-draft', 'This source view does not own the review')
    if (this.busy(draft.lockRoot) || draft.dto.phase.kind === 'done' || draft.dto.phase.kind === 'cancelled')
      return Promise.resolve({ ok: false, code: 'busy', detail: 'The review is running or already settled' })
    if (draft.decisions?.some((decision) => decision.result === undefined || !decision.result.ok && decision.result.code === 'uncertain')) return refused('uncertain', 'An accepted source operation has no proved outcome; verify it before another decision')
    const claim = (): VersioningCommitRunResult | null => {
      if (!this.deps.interactions?.isActive(interaction)) return { ok: false, code: 'forbidden', detail: 'The human view was revoked before acceptance' }
      if (request.epoch !== this.epoch || request.expectedRevision !== draft.dto.revision)
        return { ok: false, code: 'stale', detail: 'The review changed before the decision was accepted' }
      draft.decisions ??= []
      draft.decisions.push({ operationId: request.operationId, actorId: interaction.actorId, payload, acceptedAt: this.now() })
      try { this.persist() }
      catch (error) { draft.decisions.pop(); throw error }
      return null
    }
    let operation: Promise<VersioningCommitRunResult>
    if (request.kind === 'approve') operation = this.run(interaction.ownerId, request, claim)
    else if (request.kind === 'finish') operation = this.run(interaction.ownerId, request, claim, request.workflow)
    else if (request.kind === 'revert') operation = this.revert(interaction.ownerId, request, async () => request.confirmed, claim).then((result) => result.ok ? { ok: true, revision: '' } : result)
    else if (request.kind === 'external-review') operation = this.openTortoise(interaction.ownerId, request.draftId, request.message, request, claim).then((result) => result.ok ? { ok: true, revision: '' } : result)
    else if (request.kind === 'external-diff') operation = this.externalDiff(interaction.ownerId, request, claim)
    else if (request.kind === 'split') {
      if (!this.externalScope(interaction.ownerId, request.draftId, request.snapshotId, request.scopeRoot) || !this.deps.splitReview)
        return Promise.resolve({ ok: false, code: 'invalid-target', detail: 'A separate review must name an external root in the held source snapshot' })
      this.running.add(draft.lockRoot)
      operation = (async (): Promise<VersioningCommitRunResult> => {
        try {
          const refusal = claim()
          if (refusal) return refusal
          const reviewId = await this.deps.splitReview!(draft.dto.sessionId, draft.dto.vcs, request.scopeRoot, key)
          return { ok: true, revision: '', reviewId }
        } finally { this.running.delete(draft.lockRoot) }
      })()
    }
    else if (request.kind === 'cancel') {
      if (this.busy(draft.lockRoot) || VersioningCommitManager.ended(draft))
        return Promise.resolve({ ok: false, code: 'busy', detail: 'The review is running or already settled' })
      this.running.add(draft.lockRoot)
      try {
        const refusal = claim()
        if (refusal) operation = Promise.resolve(refusal)
        else { draft.dto.phase = { kind: 'cancelled' }; this.bump(draft); operation = Promise.resolve({ ok: true, revision: '' }) }
      } finally { this.running.delete(draft.lockRoot) }
    } else throw new Error(`Unknown review decision: ${JSON.stringify(request satisfies never)}`)
    const result = operation.then((result) => {
      const receipt = draft.decisions?.find((decision) => decision.operationId === request.operationId && decision.actorId === interaction.actorId)
      if (receipt) { receipt.result = structuredClone(result); this.persist() }
      return result
    }).finally(() => this.pendingDecisions.delete(key))
    this.pendingDecisions.set(key, { payload, result })
    return result
  }

  private async worktreeDraft(draft: Draft): Promise<boolean> {
    const paths = [draft.dto.scopeRoot, ...draft.targets?.map((target) => target.path) ?? [], ...draft.dto.selection?.paths ?? []]
    for (const path of paths)
      if (await this.isWorktree(path)) return true
    return false
  }

  async run(ownerId: string, request: VersioningCommitRunRequest, claim?: () => VersioningCommitRunResult | null, workflow?: RemoteWorkflowReview): Promise<VersioningCommitRunResult> {
    const draft = this.owned(ownerId, request.draftId)
    if (draft === null) return { ok: false, code: 'unknown-draft', detail: 'The commit dialog no longer exists' }
    if (workflow === undefined && draft.dto.vcs === 'svn') {
      if (this.busy(draft.lockRoot)) return { ok: false, code: 'busy', detail: 'Another change is running in this scope' }
      this.running.add(draft.lockRoot)
      try {
        if (await this.worktreeDraft(draft)) return { ok: false, code: 'use-finish', detail: 'use-finish: press Finish in Session actions' }
      } finally { this.running.delete(draft.lockRoot) }
    }
    if (workflow && (!claim || !this.deps.workflow)) return { ok: false, code: 'forbidden', detail: 'Finish requires an admitted source review' }
    if (typeof request.message !== 'string' || request.message.length > VersioningCommitLimits.messageMaxCharactersConst)
      return { ok: false, code: 'message-too-long', detail: `The commit message is limited to ${VersioningCommitLimits.messageMaxCharactersConst} characters` }
    const message = VersioningCommitMessage.normalize(request.message)
    if (request.expectedRevision !== undefined && (request.expectedRevision !== draft.dto.revision || request.epoch !== this.epoch))
      return { ok: false, code: 'stale', detail: 'The review changed; reload or compare before approving' }
    if (request.expectedRevision !== undefined && draft.dto.selection !== undefined
      && (draft.dto.selection.snapshotId !== request.snapshotId || draft.dto.message !== message))
      return { ok: false, code: 'stale', detail: 'The reviewed selection or message changed' }
    if (this.busy(draft.lockRoot) || draft.dto.phase.kind === 'running' || draft.dto.phase.kind === 'done' || draft.dto.phase.kind === 'cancelled')
      return { ok: false, code: 'busy', detail: 'A commit is already running or this dialog has already committed' }
    const snapshot = this.snapshotOf(ownerId, draft, request.snapshotId)
    if (snapshot === null || snapshot.sessionId !== draft.dto.sessionId || snapshot.source.selected !== draft.dto.source)
      return { ok: false, code: 'invalid-target', detail: 'The file list does not belong to this dialog; reload it', reloadRequired: true }
    if (request.includeExternals !== undefined && request.includeExternals !== true)
      return { ok: false, code: 'invalid-target', detail: 'Invalid external selection' }
    if (draft.rejectedSnapshotId === request.snapshotId)
      return { ok: false, code: 'invalid-target', detail: 'This commit attempt changed the working copy; reload the file list', reloadRequired: true }
    if (claim && (!draft.dto.selection || JSON.stringify([...draft.dto.selection.paths].sort()) !== JSON.stringify(snapshot.entries.filter((entry) => request.fileIds.includes(entry.fileId)).map((entry) => entry.path).sort())))
      return { ok: false, code: 'stale', detail: 'Save and review the selected source files before approving' }
    const targets = workflow && request.fileIds.length === 0 && snapshot.entries.length === 0 && snapshot.warnings.length === 0
      ? { ok: true as const, value: [] as CommitTarget[] }
      : this.resolveTargets(ownerId, draft, snapshot, request.fileIds, request.includeExternals === true || workflow !== undefined)
    if (!targets.ok) return targets
    const grouped = new Map<string, CommitTarget[]>()
    for (const target of targets.value) {
      const group = grouped.get(target.scopeRoot) ?? []
      group.push(target)
      grouped.set(target.scopeRoot, group)
    }
    const groups = [...grouped].sort(([left], [right]) =>
      Number(left === draft.dto.scopeRoot) - Number(right === draft.dto.scopeRoot) || left.localeCompare(right))
    const completed: { scope: string; revision: string; output: string }[] = []
    const fail = (detail: string, reloadRequired = false): VersioningCommitRunResult => {
      if (groups.length > 1) {
        draft.rejectedSnapshotId = snapshot.snapshotId
        const committed = completed.map((item) => `${item.scope}: ${item.revision}`).join('\n') || 'None'
        const remaining = groups.slice(completed.length).map(([scope]) => scope).join('\n')
        detail = `Committed:\n${committed}\n\nRemaining or unconfirmed:\n${remaining}\n\n${detail}\n\nReview the refreshed files before trying again.`
      }
      // The scopes committed before the failure are in the repository all the same.
      if (completed.length > 0) this.svnSettled(draft, completed)
      return this.failed(draft, detail, reloadRequired || groups.length > 1)
    }
    // Lock before the async preflight so sibling scopes cannot both pass it and start staging.
    this.running.add(draft.lockRoot)
    const locks = new Set([draft.lockRoot])
    let temporary: string | null = null
    const startedAt = this.now()
    try {
      const actualScope = await realpath(draft.dto.scopeRoot)
      for (const [scope, entries] of groups) {
        if (scope !== draft.dto.scopeRoot) {
          const actual = await realpath(scope).catch(() => null)
          const detection = await this.deps.vcsStatus.detect(scope, draft.dto.vcs)
          if (actual === null || !PathCompare.isInside(actualScope, actual) || detection?.id !== 'svn'
            || PathCompare.comparable(detection.root) !== PathCompare.comparable(scope)
            || !(await lstat(scope)).isDirectory())
            return { ok: false, code: 'external-target', detail: `The external working copy changed: ${scope}; reload the list`, reloadRequired: true }
          const lock = PathCompare.comparable(detection.root)
          if (!locks.has(lock) && this.busy(lock))
            return { ok: false, code: 'busy', detail: `Another change is running in ${scope}` }
          locks.add(lock)
          this.running.add(lock)
        }
        if (workflow) continue
        const stale = await this.staleOf(scope, entries, draft.dto.vcs === 'svn')
        if (stale !== null) return { ok: false, code: 'stale', detail: stale }
      }
      if (workflow) {
        const changed: string[] = []
        for (const [scope, entries] of groups)
          for (const target of entries)
            if (await this.staleOf(scope, [target], draft.dto.vcs === 'svn') !== null) changed.push(target.entry.displayPath)
        if (changed.length > 0) return { ok: false, code: 'stale', detail: this.deps.workflow!.changed(changed) }
      }
      if (this.owned(ownerId, request.draftId) !== draft)
        return { ok: false, code: 'unknown-draft', detail: 'The commit dialog closed before the commit started' }
      if (workflow) {
        const refusal = this.deps.workflow!.check(draft.dto, workflow)
        if (refusal) return { ok: false, code: 'stale', detail: refusal }
        if (targets.value.some((target) => target.fingerprint === undefined))
          return { ok: false, code: 'stale', detail: 'Reload the source files before approving Finish' }
      }
      const refused = claim?.()
      if (refused) return refused
      if (message !== draft.dto.message && !this.setMessage(ownerId, request.draftId, message))
        return fail('The commit message could not be saved')
      draft.dto.phase = { kind: 'running', startedAt }
      if (draft.dto.vcs === 'svn') draft.committedPaths ??= []
      delete draft.externalReview
      this.bump(draft)
      if (workflow) {
        const reviewed: Record<string, string> = {}
        for (const { entry, fingerprint } of targets.value) {
          reviewed[entry.path] = fingerprint!
          if (entry.previousPath !== null) reviewed[entry.previousPath] = 'missing'
        }
        draft.dto.workflow = { workflowId: workflow.workflowId, acceptedAt: startedAt, lockRoots: [...locks] }
        this.bump(draft)
        const result = await this.deps.workflow!.start(draft.dto, workflow, Object.keys(reviewed), reviewed)
        // The refusal answers the press and stays in the Finish until its next preparation; a failed
        // phase would stay on the shared review beside the next passed checks.
        if (!result.ok) {
          delete draft.dto.workflow
          draft.dto.phase = { kind: 'editing' }
          this.bump(draft)
        } else this.refreshWorkflow(draft)
        return result
      }
      temporary = await mkdtemp(join(tmpdir(), 'jamat-v3-commit-'))
      const messageFile = join(temporary, 'message.txt')
      await writeFile(messageFile, message.replace(/\n?$/, '\n'), 'utf8')
      for (const [scope, entries] of groups) {
        if (!PathCompare.isInside(actualScope, await realpath(scope)))
          return fail(`${scope} points outside the commit scope; reload the list`, true)
        const stale = await this.staleOf(scope, entries, draft.dto.vcs === 'svn')
        if (stale !== null) return fail(stale, true)
        let publishedAt = 0
        const onProgress = (progress: CommitProgress): void => {
          const now = this.now()
          const previous = draft.dto.phase.kind === 'running' ? draft.dto.phase.progress : undefined
          const changedStage = previous?.stage !== progress.stage || previous.groupIndex !== completed.length + 1
          draft.dto.phase = { kind: 'running', startedAt,
            ...(groups.length > 1 ? { detail: `Committing ${completed.length + 1} of ${groups.length}: ${scope}` } : {}),
            progress: { ...progress, stageStartedAt: changedStage ? now : previous.stageStartedAt,
              updatedAt: now, groupIndex: completed.length + 1, groupCount: groups.length } }
          if (changedStage || now - publishedAt >= 100 || progress.completed === progress.total) {
            publishedAt = now
            this.bump(draft)
          }
        }
        onProgress({ stage: 'preparing', completed: 0, total: null })
        if (draft.dto.vcs === 'svn') {
          const targets = entries.map(({ entry }) => ({ absolutePath: entry.path, nodeKind: entry.nodeKind, status: entry.status }))
          let result = await this.deps.svn.commit(scope, targets, messageFile, onProgress)
          let updateOutput: string | null = null
          if (!result.ok && result.code === 'out-of-date') {
            // An out-of-date scope usually holds somebody else's unrelated files, and then the
            // update brings nothing this commit is about: retrying the same reviewed selection sends
            // exactly what the person approved. `staleOf` is what draws that line - the moment the
            // update writes into a selected file, the review is about something else and stops here.
            const outdated = result.detail
            const updated = await this.updateOutdated(draft, scope, entries, outdated)
            if (!updated.ok) return fail(`${updated.detail}\n\nOriginal commit error:\n${outdated}`, updated.wrote)
            const stale = await this.staleOf(scope, entries, true)
            if (stale !== null)
              return fail(`${stale}\nThe update changed a file this commit holds. Review it, then click Commit files again.\n\n${updated.output}\n\nOriginal commit error:\n${outdated}`, true)
            updateOutput = updated.output
            onProgress({ stage: 'preparing', completed: 0, total: null })
            result = await this.deps.svn.commit(scope, targets, messageFile, onProgress)
          }
          // An update that happened leaves the shown list behind whatever the retry did.
          if (!result.ok) return fail(result.detail, updateOutput !== null)
          draft.committedPaths = [...new Set([...(draft.committedPaths ?? []), ...result.value.committedPaths])]
          const published = new Set(result.value.committedPaths.map(PathCompare.normalized))
          const omittedPaths = targets.map((target) => target.absolutePath).filter((path) => !published.has(PathCompare.normalized(path)))
          draft.dto.published = [...(draft.dto.published ?? []), { scopeRoot: scope, revision: result.value.revision, paths: [...result.value.committedPaths],
            ...(omittedPaths.length === 0 ? {} : { omittedPaths }) }]
          this.bump(draft)
          completed.push({ scope, revision: result.value.revision,
            output: updateOutput === null ? result.value.output : `${updateOutput}\n${result.value.output}` })
        }
        else if (draft.dto.vcs === 'git') {
          const paths = entries.flatMap(({ entry }) => entry.status === 'renamed' && entry.previousPath !== null ? [entry.path, entry.previousPath] : [entry.path])
          const result = await this.deps.git.commit(scope, paths, messageFile, onProgress)
          if (!result.ok) return fail(result.detail)
          draft.dto.published = [...(draft.dto.published ?? []), { scopeRoot: scope, revision: result.value.hash }]
          this.bump(draft)
          completed.push({ scope, revision: result.value.hash, output: result.value.output })
        }
        else throw new Error(`Unknown commit VCS: ${JSON.stringify(draft.dto.vcs)}`)
      }
      const revision = completed.map((item) => item.revision).join(', ')
      const output = completed.map((item) => groups.length === 1 ? item.output : `${item.scope}: ${item.revision}\n${item.output}`).join('\n\n')
      draft.dto.phase = { kind: 'done', revision, output, finishedAt: this.now() }
      this.deps.messages.remove(draft.dto)
      this.bump(draft)
      this.svnSettled(draft, completed)
      return { ok: true, revision }
    }
    catch (error) {
      if (workflow && draft.dto.workflow) {
        this.failed(draft, `Finish acknowledgement was lost: ${ErrorText.of(error)}. Read its original source outcome before retrying.`)
        return { ok: false, code: 'uncertain', detail: `The source may have accepted Finish (${ErrorText.of(error)}). Verify its original outcome before another approval.` }
      }
      return fail(ErrorText.of(error))
    }
    finally {
      for (const lock of locks) this.running.delete(lock)
      if (temporary !== null) await rm(temporary, { recursive: true, force: true })
      this.releaseUnattached(draft.dto.draftId)
    }
  }

  async revert(ownerId: string, request: VersioningRevertRequest,
    confirm: (paths: readonly string[], vcs: FileChangesVcsId) => Promise<boolean>, claim?: () => VersioningCommitRunResult | null): Promise<VersioningRevertResult> {
    const draft = this.owned(ownerId, request.draftId)
    if (draft === null) return { ok: false, code: 'unknown-draft', detail: 'The commit dialog no longer exists' }
    if (this.busy(draft.lockRoot) || draft.dto.phase.kind === 'running' || draft.dto.phase.kind === 'done' || draft.dto.phase.kind === 'cancelled')
      return { ok: false, code: 'busy', detail: 'Another change is running or this dialog has already committed' }
    const snapshot = this.snapshotOf(ownerId, draft, request.snapshotId)
    if (snapshot === null || snapshot.sessionId !== draft.dto.sessionId || snapshot.source.selected !== draft.dto.source)
      return { ok: false, code: 'invalid-target', detail: 'The file list does not belong to this dialog; reload it' }
    if (request.fileIds !== undefined && request.fileId !== undefined)
      return { ok: false, code: 'invalid-target', detail: 'Specify either one file or a list of files' }
    const ids = request.fileIds !== undefined ? request.fileIds : [request.fileId]
    const targets = this.resolveTargets(ownerId, draft, snapshot, ids)
    if (!targets.ok) return targets
    if (targets.value.length !== new Set(ids).size || targets.value.some(({ entry }) => !VersioningRevert.allows(entry)))
      return { ok: false, code: 'invalid-target', detail: 'Revert supports modified, missing or deleted versioned files; handle additions, moves and directories in your VCS client' }
    this.running.add(draft.lockRoot)
    let attempted = false
    let reverted = 0
    const progress = (detail: string): string => `Reverted ${reverted} of ${targets.value.length} files. ${detail}`
    try {
      const stale = await this.staleOf(draft.dto.scopeRoot, targets.value, false)
      if (stale !== null) return { ok: false, code: 'stale', detail: stale }
      if (!await confirm(targets.value.map(({ entry }) => entry.path), draft.dto.vcs)) return { ok: true, reverted: false }
      if (this.owned(ownerId, request.draftId) !== draft)
        return { ok: false, code: 'unknown-draft', detail: 'The commit dialog closed before reverting' }
      const changed = await this.staleOf(draft.dto.scopeRoot, targets.value, false)
      if (changed !== null) return { ok: false, code: 'stale', detail: changed }
      for (const { entry } of targets.value) {
        const current = await lstat(entry.path).catch(() => null)
        if (current !== null && !current.isFile())
          return { ok: false, code: 'invalid-target', detail: 'Only regular files can be reverted here' }
      }
      const refusal = claim?.()
      if (refusal && !refusal.ok) return refusal
      if (claim) { draft.dto.phase = { kind: 'running', startedAt: this.now(), detail: 'Reverting reviewed files...' }; this.bump(draft) }
      for (const target of targets.value) {
        if (!claim && this.owned(ownerId, request.draftId) !== draft)
          return { ok: false, code: 'unknown-draft', detail: progress('The commit dialog closed while reverting') }
        const changed = await this.staleOf(draft.dto.scopeRoot, [target], false)
        if (changed !== null) return { ok: false, code: 'stale', detail: progress(changed) }
        attempted = true
        let result: Awaited<ReturnType<SvnCommitManager['revertFile']>> | Awaited<ReturnType<GitCommitManager['revertFile']>>
        if (draft.dto.vcs === 'svn') result = await this.deps.svn.revertFile(draft.dto.scopeRoot, target.entry.path)
        else if (draft.dto.vcs === 'git') result = await this.deps.git.revertFile(draft.dto.scopeRoot, target.entry.path)
        else throw new Error(`Unknown revert VCS: ${JSON.stringify(draft.dto.vcs)}`)
        if (!result.ok) return { ok: false, code: 'vcs-failed', detail: progress(`${target.entry.displayPath}: ${result.detail}`) }
        reverted++
      }
      return { ok: true, reverted: true }
    } catch (error) { return { ok: false, code: 'vcs-failed', detail: progress(ErrorText.of(error)) } }
    finally {
      this.running.delete(draft.lockRoot)
      if (attempted || claim && draft.dto.phase.kind === 'running') {
        draft.dto.phase = { kind: 'editing' }
        this.bump(draft)
      }
    }
  }

  async openTortoise(ownerId: string, draftId: string, message: string, binding?: { snapshotId: string; fileIds: readonly string[] },
    claim?: () => VersioningCommitRunResult | null): Promise<VersioningTortoiseResult> {
    const draft = this.owned(ownerId, draftId)
    if (draft === null) return { ok: false, code: 'unknown-draft', detail: 'The commit dialog no longer exists' }
    if (draft.dto.vcs === 'svn') {
      if (this.busy(draft.lockRoot)) return { ok: false, code: 'busy', detail: 'Another change is running in this scope' }
      this.running.add(draft.lockRoot)
      try {
        if (await this.worktreeDraft(draft)) return { ok: false, code: 'use-finish', detail: 'use-finish: press Finish in Session actions' }
      } finally { this.running.delete(draft.lockRoot) }
    }
    if (this.busy(draft.lockRoot) || draft.dto.phase.kind === 'running' || draft.dto.phase.kind === 'done' || draft.dto.phase.kind === 'cancelled')
      return { ok: false, code: 'busy', detail: 'Another change is running or this dialog has already committed' }
    if (typeof message !== 'string' || message.length > VersioningCommitLimits.messageMaxCharactersConst)
      return { ok: false, code: 'message-too-long', detail: `The commit message is limited to ${VersioningCommitLimits.messageMaxCharactersConst} characters` }
    // Tortoise has no depth per target: it would list the work below the folder and check it.
    if (draft.targets?.some((target) => target.directory && !target.recursive))
      return { ok: false, code: 'invalid-target', detail: 'Tortoise cannot keep a folder to its own node; it would show and check the work below it. Commit this review here.' }
    let selected: CommitTarget[] | undefined
    if (binding) {
      const snapshot = this.snapshotOf(ownerId, draft, binding.snapshotId)
      if (!snapshot || snapshot.sessionId !== draft.dto.sessionId || snapshot.source.selected !== draft.dto.source)
        return { ok: false, code: 'invalid-target', detail: 'The external review file list is no longer owned' }
      if (draft.dto.selection?.snapshotId !== binding.snapshotId || draft.dto.message !== message)
        return { ok: false, code: 'stale', detail: 'The shared message or selection changed' }
      const targets = this.resolveTargets(ownerId, draft, snapshot, binding.fileIds)
      if (!targets.ok) return targets
      for (const { entry } of targets.value) {
        if (entry.nodeKind !== 'directory') continue
        const recursive = draft.targets === undefined ? PathCompare.isInside(draft.dto.scopeRoot, entry.path)
          : draft.targets.some((target) => target.directory && target.recursive && PathCompare.isInside(target.path, entry.path))
        if (!recursive || snapshot.entries.some((child) => PathCompare.isInside(entry.path, child.path) && !binding.fileIds.includes(child.fileId)))
          return { ok: false, code: 'invalid-target', detail: 'Tortoise checks a directory recursively. Use an explicit recursive directory with every displayed descendant selected, or commit this exact selection here.' }
      }
      const selectedPaths = targets.value.map(({ entry }) => entry.path).sort()
      if (JSON.stringify(selectedPaths) !== JSON.stringify([...draft.dto.selection.paths].sort()))
        return { ok: false, code: 'stale', detail: 'The selected external review targets changed' }
      selected = targets.value
    }
    this.running.add(draft.lockRoot)
    let temporary: string | null = null
    try {
      if (selected) {
        const stale = await this.staleOf(draft.dto.scopeRoot, selected, false)
        if (stale !== null) return { ok: false, code: 'stale', detail: stale }
      }
      const refusal = claim?.()
      if (refusal && !refusal.ok) return refusal
      if (!this.setMessage(ownerId, draftId, message))
        return { ok: false, code: 'vcs-failed', detail: 'The commit message could not be saved' }
      temporary = await mkdtemp(join(tmpdir(), 'jamat-v3-commit-'))
      const messageFile = join(temporary, 'message.txt')
      await writeFile(messageFile, VersioningCommitMessage.normalize(message), 'utf8')
      if (!claim && this.owned(ownerId, draftId) !== draft)
        return { ok: false, code: 'unknown-draft', detail: 'The commit dialog closed before opening Tortoise' }
      draft.externalReview = 'running'
      this.bump(draft)
      const opened = await this.deps.tortoise.open({ vcs: draft.dto.vcs, scope: draft.dto.scopeRoot, messageFile,
        ...(selected ? { paths: selected.filter(({ entry }) => !selected!.some((parent) => parent.entry !== entry && parent.entry.nodeKind === 'directory' && PathCompare.isInside(parent.entry.path, entry.path)))
          .flatMap(({ entry }) => entry.previousPath ? [entry.path, entry.previousPath] : [entry.path]) }
          : draft.dto.paths === undefined ? {} : { paths: draft.dto.paths.map(VersioningCommitPaths.pathOf) }) })
      if (!opened.ok) {
        delete draft.externalReview
        this.bump(draft)
        return { ok: false, code: 'vcs-failed', detail: opened.detail }
      }
      try { await opened.closed }
      finally { draft.externalReview = 'closed'; this.bump(draft) }
      // TortoiseSVN does not say whether it committed; the cleanup reads the worktree before it removes anything.
      if (draft.dto.vcs === 'svn')
        this.deps.committed?.({ sessionId: draft.dto.sessionId, scopes: [{ scopeRoot: draft.dto.scopeRoot, revision: null }], paths: [] })
      return { ok: true }
    } catch (error) {
      if (draft.externalReview === 'running') { draft.externalReview = 'closed'; this.bump(draft) }
      return { ok: false, code: 'vcs-failed', detail: ErrorText.of(error) }
    }
    finally {
      this.running.delete(draft.lockRoot)
      if (temporary !== null) await rm(temporary, { recursive: true, force: true })
    }
  }

  private async externalDiff(ownerId: string, request: Extract<VersioningReviewDecision, { kind: 'external-diff' }>,
    claim: () => VersioningCommitRunResult | null): Promise<VersioningCommitRunResult> {
    const draft = this.owned(ownerId, request.draftId)
    if (!draft) return { ok: false, code: 'unknown-draft', detail: 'The review is no longer attached' }
    if (this.busy(draft.lockRoot) || VersioningCommitManager.ended(draft)) return { ok: false, code: 'busy', detail: 'The review is running or settled' }
    const snapshot = this.snapshotOf(ownerId, draft, request.snapshotId)
    const entry = snapshot?.entries.find((entry) => entry.fileId === request.fileId)
    if (!snapshot || snapshot.sessionId !== draft.dto.sessionId || snapshot.source.selected !== draft.dto.source
      || snapshot.defaultBaseline?.baselineId !== request.baselineId || !entry || entry.nodeKind !== 'file'
      || !VersioningCommitManager.allows(draft, entry) || !PathCompare.isInside(draft.dto.scopeRoot, entry.path))
      return { ok: false, code: 'invalid-target', detail: 'The diff target or baseline does not belong to this review' }
    if (!this.deps.externalDiff) return { ok: false, code: 'vcs-failed', detail: 'External diff is unavailable on the source' }
    this.running.add(draft.lockRoot)
    try {
      const refusal = claim()
      if (refusal) return refusal
      const result = await this.deps.externalDiff(ownerId, { snapshotId: request.snapshotId, fileId: request.fileId, baselineId: request.baselineId })
      return result.ok ? { ok: true, revision: '' } : { ok: false, code: 'vcs-failed', detail: result.detail }
    } finally { this.running.delete(draft.lockRoot) }
  }

  private snapshotOf(ownerId: string, draft: Draft, snapshotId: string): FileChangesWorkingTreeSnapshot | null {
    const review = draft.fileReviews.get(ownerId)
    return review?.snapshot.snapshotId === snapshotId ? review.snapshot : this.deps.snapshotOf(ownerId, snapshotId)
  }

  private resolveTargets(ownerId: string, draft: Draft, snapshot: FileChangesWorkingTreeSnapshot, ids: readonly string[], includeExternals = false):
    | { ok: true; value: CommitTarget[] }
    | Extract<VersioningCommitRunResult, { ok: false }> {
    if (!Array.isArray(ids) || ids.length > VersioningCommitLimits.targetsMaxConst)
      return { ok: false, code: 'invalid-target', detail: 'Too many commit targets' }
    const selected = new Set(ids)
    for (const entry of snapshot.entries)
      if (entry.nodeKind === 'directory' && (entry.status === 'added' || entry.status === 'untracked')
        && snapshot.entries.some((child) => selected.has(child.fileId) && PathCompare.isInside(entry.path, child.path))) selected.add(entry.fileId)
    // What a copied directory carries is never a target of its own: the copy publishes the whole
    // subtree from its copyfrom source, and `svn commit --depth empty` on such a child fails,
    // because its parent add has not been published yet. The loop above already put that parent in,
    // so dropping the child here keeps the copy whole rather than narrowing it.
    for (const entry of snapshot.entries)
      if (entry.status === 'copied' && snapshot.entries.some((parent) => parent.nodeKind === 'directory'
        && parent.status === 'added' && selected.has(parent.fileId) && PathCompare.isInside(parent.path, entry.path)))
        selected.delete(entry.fileId)
    // What `svn delete --keep-local` leaves on disk comes back as an untracked row inside a
    // `deleted` directory, and adding one REPLACES that directory instead of deleting it. The pane
    // leaves those rows unchecked and disabled, so a selection that still carries one is stale
    // rather than a decision, and publishing a subtree the dialog says it removes is not a recovery.
    for (const entry of snapshot.entries)
      if (entry.status === 'untracked' && selected.has(entry.fileId)
        && snapshot.entries.some((parent) => parent.nodeKind === 'directory' && parent.status === 'deleted'
          && PathCompare.isInside(parent.path, entry.path)))
        return { ok: false, code: 'invalid-target', detail: 'A selected path sits inside a directory this commit deletes; reload the list' }
    const targets: CommitTarget[] = []
    if (selected.size > VersioningCommitLimits.targetsMaxConst)
      return { ok: false, code: 'invalid-target', detail: 'Too many commit targets including required parent directories' }
    const review = draft.fileReviews.get(ownerId)
    for (const id of selected) {
      const entry = snapshot.entries.find((candidate) => candidate.fileId === id)
      const access = (review?.snapshot.snapshotId === snapshot.snapshotId ? review.files.get(id) : undefined)
        ?? this.deps.fileAccess(ownerId, snapshot.snapshotId, id)
      if (entry === undefined || !access.ok || access.value.workingState === undefined
        || !VersioningCommitManager.allows(draft, entry)
        || access.value.sessionId !== draft.dto.sessionId || access.value.path !== entry.path
        || !PathCompare.isInside(draft.dto.scopeRoot, entry.path)
        || (entry.previousPath !== null && !PathCompare.isInside(draft.dto.scopeRoot, entry.previousPath))
        || entry.status === 'conflicted' || entry.status === 'obstructed')
        return { ok: false, code: 'invalid-target', detail: 'A selected target is invalid or conflicted; reload the list' }
      const external = snapshot.externalRoots.filter((root) => PathCompare.comparable(root.path) !== PathCompare.comparable(draft.dto.scopeRoot)
        && PathCompare.isInside(draft.dto.scopeRoot, root.path) && PathCompare.isInside(root.path, entry.path))
        .sort((left, right) => right.path.length - left.path.length)[0]
      if (external !== undefined && (!includeExternals || draft.dto.vcs !== 'svn'))
        return { ok: false, code: 'external-target', detail: 'Commit this external separately' }
      const scopeRoot = external?.path ?? draft.dto.scopeRoot
      if (external !== undefined && (!external.fileIds.includes(id)
        || (entry.previousPath !== null && !PathCompare.isInside(scopeRoot, entry.previousPath))))
        return { ok: false, code: 'external-target', detail: 'A selected path crosses an external boundary; reload the list' }
      if (!access.value.workingState.vcsEntry) continue
      if (draft.dto.vcs === 'git' && entry.nodeKind === 'directory') continue
      targets.push({ entry, modifiedAt: access.value.workingState.modifiedAt, fingerprint: access.value.workingState.fingerprint, scopeRoot })
    }
    return targets.length === 0 ? { ok: false, code: 'no-targets', detail: 'Select at least one changed file' } : { ok: true, value: targets }
  }

  /**
   * `keptLocalDeletions` belongs to an operation that ignores what the file holds: an SVN commit
   * sends the removal alone. Revert writes the file back, so it passes false and keeps refusing.
   */
  private async staleOf(scope: string, targets: readonly CommitTarget[], keptLocalDeletions: boolean): Promise<string | null> {
    const actualScope = await realpath(scope)
    for (const target of targets) {
      const path = target.entry.path
      if (target.entry.status === 'renamed' && target.entry.previousPath !== null
        && await lstat(target.entry.previousPath).catch(() => null) !== null)
        return `${target.entry.previousDisplayPath ?? target.entry.previousPath} exists at the rename source; review the rename before committing`
      // An SVN deletion commits the removal and nothing of the file: `svn delete --keep-local`
      // leaves it on disk on purpose, and a regenerated one (next-env.d.ts) moves its mtime under a
      // list that is still correct. The commit leaves that file in place, unversioned. Git is the
      // opposite: its staging adds a present file back, so a deletion there still needs it gone.
      if (target.entry.status !== 'deleted' || !keptLocalDeletions) {
        if (target.fingerprint !== undefined && await FileChangesFingerprint.of(path) !== target.fingerprint)
          return `${target.entry.displayPath} changed since you looked; reload the list`
        const current = await lstat(path).catch(() => null)
        if ((current === null ? null : Math.round(current.mtimeMs)) !== target.modifiedAt
          || (current === null && target.entry.status !== 'missing' && target.entry.status !== 'deleted')
          || (current !== null && (target.entry.status === 'missing' || target.entry.status === 'deleted')))
          return `${target.entry.displayPath} changed since you looked; reload the list`
      }
      let parent = dirname(path)
      while (PathCompare.isInside(scope, parent)) {
        const actual = await realpath(parent).catch(() => null)
        if (actual !== null) {
          if (!PathCompare.isInside(actualScope, actual)) return `${target.entry.displayPath} points outside the commit scope; reload the list`
          break
        }
        const next = dirname(parent)
        if (next === parent) break
        parent = next
      }
    }
    return null
  }

  private owned(ownerId: string, draftId: string): Draft | null {
    const draft = this.drafts.get(draftId) ?? this.closed.get(draftId)?.draft
    return draft?.owners.has(ownerId) && draft.dto.phase.kind !== 'cancelled' ? draft : null
  }

  /**
   * Whether a selection reaches the row: a named path, the subtree of a named directory, or a new
   * parent a named path needs. Below a node-only directory the other work is shown unchecked, so
   * the person sees what stays local; nothing outside the named targets is read into the review,
   * which keeps a list across projects from showing their whole common directory.
   */
  private static allows(draft: Draft, entry: FileChangeEntry): boolean {
    return draft.targets === undefined || draft.targets.some((target) =>
      PathCompare.comparable(target.path) === PathCompare.comparable(entry.path)
      || (target.directory && PathCompare.isInside(target.path, entry.path))
      || (entry.nodeKind === 'directory' && (entry.status === 'added' || entry.status === 'untracked')
        && PathCompare.isInside(entry.path, target.path)))
  }

  /**
   * Updating is the only way past an out-of-date scope. Whether a retry follows is the caller's.
   * Only the paths SVN named in `failure` move, each at depth empty, and never a moved node
   * (`SvnCommitManager.updateOutOfDate`). `wrote` is false when it refused before any write, so the
   * shown list still describes the disk.
   */
  private async updateOutdated(draft: Draft, scope: string, entries: readonly CommitTarget[], failure: string):
    Promise<{ ok: true; output: string } | { ok: false; detail: string; wrote: boolean }> {
    const startedAt = draft.dto.phase.kind === 'running' ? draft.dto.phase.startedAt : this.now()
    draft.dto.phase = { kind: 'running', startedAt, detail: 'SVN is out of date. Updating what SVN named...' }
    this.bump(draft)
    try {
      const result = await this.deps.svn.updateOutOfDate(scope, failure, entries.map(({ entry }) => entry.path))
      if (result.ok) return { ok: true, output: result.value.output }
      return result.code === 'refused' ? { ok: false, detail: `SVN is out of date and Jamat did not update it:\n${result.detail}`, wrote: false }
        : { ok: false, detail: `SVN update failed or left conflicts:\n${result.detail}`, wrote: true }
    }
    catch (error) { return { ok: false, detail: `SVN update failed: ${ErrorText.of(error)}`, wrote: true } }
  }

  private failed(draft: Draft, detail: string, reloadRequired = false): Extract<VersioningCommitRunResult, { ok: false }> {
    draft.dto.phase = { kind: 'failed', detail, failedAt: this.now() }
    this.bump(draft)
    return { ok: false, code: 'vcs-failed', detail, ...(reloadRequired ? { reloadRequired: true } : {}) }
  }

  private svnSettled(draft: Draft, completed: readonly { scope: string; revision: string }[]): void {
    if (draft.dto.vcs !== 'svn') return
    this.deps.committed?.({
      sessionId: draft.dto.sessionId,
      scopes: completed.map((item) => ({ scopeRoot: item.scope, revision: /^[1-9]\d*$/.test(item.revision) ? Number(item.revision) : null })),
      paths: [...(draft.committedPaths ?? [])],
    })
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }
  private persist(): void {
    const reviews: VersioningReviewRecord[] = [...this.drafts.values(), ...[...this.closed.values()].map(({ draft }) => draft)]
      .map(({ dto, cwd, lockRoot, targets, committedPaths, externalReview, rejectedSnapshotId, decisions, wake }) => ({
        dto, cwd, lockRoot, targets, committedPaths, externalReview, rejectedSnapshotId, decisions, wake,
        ...(this.closed.has(dto.draftId) ? { closedAt: this.closed.get(dto.draftId)!.closedAt } : {}),
      }))
    if (this.deps.reviews?.save(reviews) === false) throw new Error('The commit review could not be saved')
    this.saved.clear()
    for (const review of reviews) this.saved.set(review.dto.draftId, structuredClone(review))
  }
  private dtoOf(draft: Draft): VersioningCommitDraftDto {
    this.refreshWorkflow(draft)
    return { ...structuredClone(draft.dto), repositories: this.repositoriesOf(draft)?.map((row) => ({ ...row, findings: SvnCommitMessageCheck.info(row.message, row.source) })), messageFindings: SvnCommitMessageCheck.info(draft.dto.message, draft.dto.messageSource ?? 'unknown'), ...(this.deps.externalDiffAvailable ? { externalDiffAvailable: this.deps.externalDiffAvailable() } : {}) }
  }

  /** The review's rows with the message of `root` replaced. A repository this review leaves out keeps its saved text for the review that shows it again. */
  private repositoryMessagesOf(draft: Draft, root: string, message: string, source: CommitMessageSource): NonNullable<VersioningCommitDraftDto['repositories']> {
    const repositories = this.repositoriesOf(draft) ?? []
    const retained = (draft.dto.repositories ?? []).filter((saved) => !repositories.some((row) => row.repository === saved.repository
      && PathCompare.comparable(row.root) === PathCompare.comparable(saved.root)))
    return [...repositories.map((row) => PathCompare.comparable(row.root) !== PathCompare.comparable(root) ? row
      : { ...row, message: VersioningCommitMessage.normalize(message), source, acknowledged: [] }), ...retained]
  }

  private repositoriesOf(draft: Draft): VersioningCommitDraftDto['repositories'] {
    const current = this.deps.workflow?.repositories?.(draft.dto)
    if (current === undefined) return draft.dto.repositories
    return current.map((row) => {
      const saved = draft.dto.repositories?.find((prior) => PathCompare.comparable(prior.root) === PathCompare.comparable(row.root)
        && prior.repository === row.repository)
      return saved === undefined ? row : { ...row, message: saved.message, source: saved.source, acknowledged: [] }
    })
  }

  private refreshWorkflow(draft: Draft): void {
    if (!draft.dto.workflow || !this.deps.workflow || this.running.has(draft.lockRoot)) return
    const current = draft.dto.phase
    const state = current.kind === 'done'
      ? { kind: 'done' as const, revision: current.revision, output: current.output }
      : this.deps.workflow.state(draft.dto)
    let receiptChanged = false
    for (const decision of draft.decisions ?? []) {
      const request: unknown = JSON.parse(decision.payload)
      if (!request || typeof request !== 'object' || !('kind' in request) || request.kind !== 'finish'
        || !('workflow' in request) || !request.workflow || typeof request.workflow !== 'object'
        || !('workflowId' in request.workflow) || request.workflow.workflowId !== draft.dto.workflow.workflowId) continue
      const result: VersioningCommitRunResult | undefined = state.kind === 'done' ? { ok: true, revision: state.revision }
        : state.kind === 'waiting' || state.kind === 'replaced' ? { ok: false, code: 'vcs-failed', detail: state.detail }
        : state.kind === 'running' ? { ok: true, revision: '' } : undefined
      if (result && JSON.stringify(result) !== JSON.stringify(decision.result)) {
        decision.result = result
        receiptChanged = true
      }
    }
    if (receiptChanged) this.persist()
    if (state.kind === 'running') {
      if (current.kind === 'running') return
      draft.dto.phase = { kind: 'running', startedAt: draft.dto.workflow.acceptedAt, detail: 'Finish continues on the source computer' }
    } else if (state.kind === 'waiting' || state.kind === 'uncertain') {
      if (current.kind === 'failed' && current.detail === state.detail) return
      draft.dto.phase = { kind: 'failed', detail: state.detail, failedAt: this.now() }
    } else if (state.kind === 'replaced') {
      // The draft serves the later Finish's review of the same scope, with the person's text kept;
      // only its next approval binds it again.
      delete draft.dto.workflow
      draft.dto.phase = { kind: 'editing' }
    } else if (state.kind === 'done') {
      if (current.kind === 'done' && current.revision === state.revision && current.output === state.output) return
      draft.dto.phase = { kind: 'done', revision: state.revision, output: state.output, finishedAt: this.now() }
    } else throw new Error(`Unknown workflow state: ${JSON.stringify(state satisfies never)}`)
    this.bump(draft)
  }

  private busy(root: string): boolean {
    if (this.running.has(root)) return true
    for (const draft of this.drafts.values()) {
      if (!draft.dto.workflow || !this.deps.workflow || draft.lockRoot !== root && !draft.dto.workflow.lockRoots?.includes(root)) continue
      this.refreshWorkflow(draft)
      if (!draft.dto.workflow || draft.dto.phase.kind === 'done') continue
      const state = this.deps.workflow.state(draft.dto)
      if (state.kind === 'running' || state.kind === 'uncertain') return true
    }
    return false
  }

  private bump(draft: Draft): void {
    if (draft.externalReview === undefined) delete draft.dto.externalReview
    else draft.dto.externalReview = draft.externalReview
    draft.dto.revision++
    try { this.persist() }
    catch (error) {
      const previous = this.saved.get(draft.dto.draftId)
      if (previous) Object.assign(draft, structuredClone(previous))
      else this.drafts.delete(draft.dto.draftId)
      throw error
    }
    this.changed()
  }
  private changed(): void { this.revision++; this.deps.onChanged() }
}
