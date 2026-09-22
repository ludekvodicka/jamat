import { randomUUID } from 'node:crypto'
import type { RemoteControlCommitStatusDto, RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

import type { FileChangesFileAccessResult } from '../../../lib-orchestrator/fileChangesManager/fileChangesManager'
import type { FileChangeEntry, FileChangesVcsId, FileChangesWorkingTreeSnapshot } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { VcsStatusView } from '../../../lib-orchestrator/fileChangesManager/vcsStatusView'
import type { GitCheckpointStore } from '../../../lib-orchestrator/git/gitCheckpointStore'
import type { GitCommitManager } from '../../../lib-orchestrator/git/gitCommitManager'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import { ErrorText } from '../../../lib-orchestrator/shared/errorText'
import type { CommitProgress } from '../../../lib-orchestrator/shared/commitProgress.types'
import { PathCompare } from '../../../lib-orchestrator/shared/pathCompare'
import type { TortoiseCommitDialog } from '../../../lib-orchestrator/shared/tortoiseCommitDialog'
import type { SvnCommitManager } from '../../../lib-orchestrator/svn/svnCommitManager'
import { VersioningCommitLimits, VersioningRevert } from '../../shared/versioningCommit'
import type { VersioningRevertRequest, VersioningRevertResult, VersioningTortoiseResult } from '../../shared/versioningCommit'
import type { VersioningCommitDraftDto, VersioningCommitOpenResult, VersioningCommitOpenSessions, VersioningCommitRunRequest, VersioningCommitRunResult } from '../../shared/versioningCommit'
import type { VersioningCommitMessageStore } from './versioningCommitMessageStore'

export interface VersioningCommitManagerDeps {
  messages: Pick<VersioningCommitMessageStore, 'read' | 'save' | 'remove'>
  sessions: Pick<SessionManager, 'workingContext' | 'settleVcs'>
  vcsStatus: Pick<VcsStatusView, 'detect'>
  checkpointStore: Pick<GitCheckpointStore, 'worktreeBelongsToStore'>
  fileAccess(ownerId: string, snapshotId: string, fileId: string): FileChangesFileAccessResult
  snapshotOf(ownerId: string, snapshotId: string): FileChangesWorkingTreeSnapshot | null
  git: Pick<GitCommitManager, 'commit' | 'revertFile'>
  svn: Pick<SvnCommitManager, 'commit' | 'revertFile' | 'update'>
  tortoise: Pick<TortoiseCommitDialog, 'open'>
  onChanged(): void
  now?(): number
  newId?(): string
}

interface Draft {
  dto: VersioningCommitDraftDto
  owners: Set<string>
  cwd: string
  lockRoot: string
  targets?: readonly { path: string; recursive: boolean }[]
  externalReview?: 'running' | 'closed'
  rejectedSnapshotId?: string
}

interface CommitTarget {
  entry: FileChangeEntry
  modifiedAt: number | null
  scopeRoot: string
}

type CancelResult = RemoteControlStepResult<RemoteControlCommitStatusDto>

export class VersioningCommitManager {
  private static readonly retentionMillisecondsConst = 86_400_000
  private static readonly retainedCountConst = 256
  private readonly drafts = new Map<string, Draft>()
  private readonly closed = new Map<string, { draft: Draft; closedAt: number }>()
  private readonly running = new Set<string>()
  private readonly cancellations = new Map<string, {
    result: Promise<CancelResult>; resolve(result: CancelResult): void; timer: ReturnType<typeof setTimeout>
  }>()
  private revision = 0

  private readonly deps: VersioningCommitManagerDeps

  constructor(deps: VersioningCommitManagerDeps) { this.deps = deps }

  async prepare(sessionId: string, vcs: FileChangesVcsId, scope: string | null, proposal: string | null,
    paths?: readonly string[]): Promise<VersioningCommitOpenResult> {
    if (vcs !== 'svn' && vcs !== 'git') throw new Error(`Unknown commit VCS: ${JSON.stringify(vcs)}`)
    if (proposal !== null && proposal.length > VersioningCommitLimits.messageMaxCharactersConst)
      return { ok: false, code: 'message-too-long', detail: `The commit message is limited to ${VersioningCommitLimits.messageMaxCharactersConst} characters` }
    const context = await this.deps.sessions.workingContext(sessionId)
    if (!context.ok) return { ok: false, code: 'unknown-session', detail: context.detail }
    const cwd = context.value.cwd
    const input = paths ?? [scope ?? '.']
    if (!Array.isArray(input) || input.length === 0 || input.length > VersioningCommitLimits.targetsMaxConst
      || input.some((path) => typeof path !== 'string' || !path.trim() || /[\0\r\n]/.test(path)))
      return { ok: false, code: 'no-working-copy', detail: 'Supply a nonempty list of literal commit paths' }
    const selected = [...new Map(input.map((path) => {
      const absolute = resolve(cwd, path)
      return [PathCompare.comparable(absolute), absolute]
    })).values()].sort()
    const retained = [...this.drafts.values()].find((draft) => draft.dto.sessionId === sessionId && draft.dto.vcs === vcs
      && draft.dto.paths !== undefined
      && JSON.stringify(draft.dto.paths.map(PathCompare.comparable)) === JSON.stringify(selected.map(PathCompare.comparable)))
    const targets = retained?.targets ?? await Promise.all(selected.map(async (path) => ({ path,
      recursive: await lstat(path).then((stat) => stat.isDirectory()).catch(() => false) })))
    const directories = targets.map((target) => target.recursive ? target.path : dirname(target.path))
    let requested = retained?.dto.scopeRoot ?? directories[0]
    while (directories.some((directory) => !PathCompare.isInside(requested, directory))) {
      const parent = dirname(requested)
      if (parent === requested) return { ok: false, code: 'no-working-copy', detail: 'Commit paths must share one working-copy directory' }
      requested = parent
    }
    let detection = await this.deps.vcsStatus.detect(requested, vcs)
    while (detection === null && dirname(requested) !== requested) {
      requested = dirname(requested)
      detection = await this.deps.vcsStatus.detect(requested, vcs)
    }
    if (detection === null || detection.id !== vcs || await realpath(requested).catch(() => null) === null)
      return { ok: false, code: 'no-working-copy', detail: `The requested paths are not inside a ${vcs.toUpperCase()} working copy` }
    const restricted = targets.length !== 1 || !targets[0].recursive
      || PathCompare.comparable(targets[0].path) !== PathCompare.comparable(requested)
    const selectedPaths = restricted ? selected : undefined
    if (vcs === 'git' && await this.deps.checkpointStore.worktreeBelongsToStore(detection.root))
      return { ok: false, code: 'store-worktree', detail: 'This worktree belongs to the checkpoint store' }
    const existing = [...this.drafts.values()].find((draft) => draft.dto.sessionId === sessionId && draft.dto.vcs === vcs
      && PathCompare.comparable(draft.dto.scopeRoot) === PathCompare.comparable(requested)
      && JSON.stringify(draft.dto.paths?.map(PathCompare.comparable)) === JSON.stringify(selectedPaths?.map(PathCompare.comparable)))
    const draft: Draft = existing ?? {
      dto: {
        draftId: this.deps.newId?.() ?? randomUUID(), sessionId, vcs, scopeRoot: requested,
        scopeTooltip: VersioningCommitManager.tooltipOf(requested, restricted ? selected : null),
        ...(restricted ? { paths: selected } : {}),
        source: vcs, message: '', editedByPerson: false, proposedByAgent: false,
        ...this.deps.messages.read({ sessionId, vcs, scopeRoot: requested, paths: selectedPaths }),
        phase: { kind: 'editing' }, revision: 0,
      },
      owners: new Set(), cwd, lockRoot: PathCompare.comparable(detection.root), ...(restricted ? { targets } : {}),
    }
    const messageApplied = proposal !== null && !draft.dto.editedByPerson && draft.dto.phase.kind === 'editing'
    if (messageApplied) {
      draft.dto.message = proposal
      draft.dto.proposedByAgent = true
      if (!this.deps.messages.save(draft.dto)) throw new Error('The commit message could not be saved')
    }
    this.drafts.set(draft.dto.draftId, draft)
    this.bump(draft)
    return { ok: true, value: { draftId: draft.dto.draftId, scopeRoot: requested,
      ...(restricted ? { paths: selected } : {}),
      title: `Commit ${vcs.toUpperCase()} · ${selected.length === 1 ? basename(selected[0]) : `${selected.length} paths`}` }, messageApplied }
  }

  /**
   * What the heading says on hover. The heading itself is the working copy, one line, whatever was
   * asked for: a restricted selection used to BE the heading, nine absolute paths joined by a
   * newline that `white-space: nowrap` then folded into one unreadable line. The paths are listed
   * relative to the root because the root is the line directly above them.
   */
  private static tooltipOf(root: string, paths: readonly string[] | null): string {
    if (paths === null) return root
    return [root, ...paths.map((path) => `  ${relative(root, path) || '.'}`)].join('\n')
  }

  files(ownerId: string, draftId: string, snapshot: FileChangesWorkingTreeSnapshot): FileChangesWorkingTreeSnapshot {
    const draft = this.owned(ownerId, draftId)
    if (draft === null) throw new Error('The commit dialog no longer exists')
    const entries = snapshot.entries.filter((entry) => VersioningCommitManager.allows(draft, entry))
    const ids = new Set(entries.map((entry) => entry.fileId))
    return { ...snapshot, entries, externalRoots: snapshot.externalRoots.map((root) => ({ ...root,
      fileIds: root.fileIds.filter((id) => ids.has(id)) })).filter((root) => root.fileIds.length > 0) }
  }

  read(ownerId: string, draftId: string): VersioningCommitDraftDto | null {
    const draft = this.drafts.get(draftId)
    return draft === undefined || !draft.owners.has(ownerId) ? null : structuredClone(draft.dto)
  }

  cancel(draftId: string): Promise<CancelResult> {
    const status = this.status(draftId)
    if (status === null)
      return Promise.resolve({ ok: false, error: { code: 'not-found', detail: 'The commit session is unknown or expired; its outcome is unknown' } })
    if (status.state === 'cancelled' && status.closed) return Promise.resolve({ ok: true, value: status })
    const draft = this.drafts.get(draftId)
    if (draft === undefined || this.running.has(draft.lockRoot) || status.state === 'running'
      || status.state === 'committed' || status.state === 'external-closed')
      return Promise.resolve({ ok: false, error: { code: 'conflict', detail: `Cannot cancel this review while it is ${status.state} or its working copy is busy` } })
    const pending = this.cancellations.get(draftId)
    if (pending !== undefined) return pending.result
    let resolve!: (result: CancelResult) => void
    const result = new Promise<CancelResult>((finish) => { resolve = finish })
    const timer = setTimeout(() => {
      this.cancellations.delete(draftId)
      resolve({ ok: false, error: { code: 'timeout', detail: 'The review was cancelled, but its dialog did not close; check this review before reopening' } })
    }, 5_000)
    this.cancellations.set(draftId, { result, resolve, timer })
    draft.dto.phase = { kind: 'cancelled' }
    this.bump(draft)
    this.releaseUnattached(draftId)
    return result
  }

  status(commitSessionId: string): RemoteControlCommitStatusDto | null {
    this.sweepClosed()
    const draft = this.drafts.get(commitSessionId) ?? this.closed.get(commitSessionId)?.draft
    if (draft === undefined) return null
    const closed = this.closed.has(commitSessionId)
    const { phase, sessionId, vcs, scopeRoot } = draft.dto
    let state: RemoteControlCommitStatusDto['state']
    if (phase.kind === 'done') state = 'committed'
    else if (phase.kind === 'running' || draft.externalReview === 'running') state = 'running'
    else if (draft.externalReview === 'closed') state = 'external-closed'
    else if (phase.kind === 'failed') state = 'failed'
    else if (phase.kind === 'cancelled') state = closed ? 'cancelled' : 'editing'
    else if (phase.kind === 'editing') state = closed ? 'cancelled' : 'editing'
    else throw new Error(`Unknown commit phase: ${JSON.stringify(phase)}`)
    return { kind: 'commit-status', commitSessionId, sessionId, vcs, scopeRoot, state, closed,
      ...(draft.dto.paths === undefined ? {} : { paths: [...draft.dto.paths] }),
      revision: phase.kind === 'done' ? phase.revision : null, detail: state === 'failed' && phase.kind === 'failed' ? phase.detail : null }
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
    const draft = this.drafts.get(draftId)
    if (draft === undefined || !draft.owners.delete(ownerId)) return
    this.releaseUnattached(draftId)
  }

  releaseUnattached(draftId: string): void {
    const draft = this.drafts.get(draftId)
    if (draft === undefined || draft.owners.size !== 0) return
    this.closed.set(draftId, { draft, closedAt: this.now() })
    this.drafts.delete(draftId)
    const pending = this.cancellations.get(draftId)
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      this.cancellations.delete(draftId)
      pending.resolve({ ok: true, value: this.status(draftId)! })
    }
    this.sweepClosed()
    this.changed()
  }

  revokeOwner(ownerId: string): void {
    for (const draft of this.drafts.values()) this.release(draft.dto.draftId, ownerId)
  }

  openSessions(): VersioningCommitOpenSessions {
    return { revision: this.revision, sessionIds: [...new Set([...this.drafts.values()]
      .filter((draft) => draft.dto.phase.kind !== 'done' && draft.dto.phase.kind !== 'cancelled').map((draft) => draft.dto.sessionId))] }
  }

  setMessage(ownerId: string, draftId: string, message: string): boolean {
    const draft = this.owned(ownerId, draftId)
    if (draft === null || typeof message !== 'string' || message.length > VersioningCommitLimits.messageMaxCharactersConst
      || draft.dto.phase.kind === 'running' || draft.dto.phase.kind === 'done') return false
    draft.dto.message = message
    draft.dto.editedByPerson = true
    const saved = this.deps.messages.save(draft.dto)
    this.bump(draft)
    return saved
  }

  async run(ownerId: string, request: VersioningCommitRunRequest): Promise<VersioningCommitRunResult> {
    const draft = this.owned(ownerId, request.draftId)
    if (draft === null) return { ok: false, code: 'unknown-draft', detail: 'The commit dialog no longer exists' }
    if (typeof request.message !== 'string' || request.message.length > VersioningCommitLimits.messageMaxCharactersConst)
      return { ok: false, code: 'message-too-long', detail: `The commit message is limited to ${VersioningCommitLimits.messageMaxCharactersConst} characters` }
    if (this.running.has(draft.lockRoot) || draft.dto.phase.kind === 'running' || draft.dto.phase.kind === 'done')
      return { ok: false, code: 'busy', detail: 'A commit is already running or this dialog has already committed' }
    const snapshot = this.deps.snapshotOf(ownerId, request.snapshotId)
    if (snapshot === null || snapshot.sessionId !== draft.dto.sessionId || snapshot.source.selected !== draft.dto.source)
      return { ok: false, code: 'invalid-target', detail: 'The file list does not belong to this dialog; reload it', reloadRequired: true }
    if (request.includeExternals !== undefined && request.includeExternals !== true)
      return { ok: false, code: 'invalid-target', detail: 'Invalid external selection' }
    if (draft.rejectedSnapshotId === request.snapshotId)
      return { ok: false, code: 'invalid-target', detail: 'This commit attempt changed the working copy; reload the file list', reloadRequired: true }
    const targets = this.resolveTargets(ownerId, draft, snapshot, request.fileIds, request.includeExternals === true)
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
          if (!locks.has(lock) && this.running.has(lock))
            return { ok: false, code: 'busy', detail: `Another change is running in ${scope}` }
          locks.add(lock)
          this.running.add(lock)
        }
        const stale = await this.staleOf(scope, entries, draft.dto.vcs === 'svn')
        if (stale !== null) return { ok: false, code: 'stale', detail: stale }
      }
      if (this.owned(ownerId, request.draftId) !== draft)
        return { ok: false, code: 'unknown-draft', detail: 'The commit dialog closed before the commit started' }
      if (!this.setMessage(ownerId, request.draftId, request.message))
        return fail('The commit message could not be saved')
      draft.dto.phase = { kind: 'running', startedAt }
      delete draft.externalReview
      this.bump(draft)
      temporary = await mkdtemp(join(tmpdir(), 'jamat-v3-commit-'))
      const messageFile = join(temporary, 'message.txt')
      await writeFile(messageFile, request.message.replace(/\n?$/, '\n'), 'utf8')
      for (const [scope, entries] of groups) {
        if (completed.length > 0 && this.owned(ownerId, request.draftId) !== draft)
          return fail('The commit dialog closed before the remaining groups were committed')
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
            const updated = await this.updateOutdated(draft, scope, entries)
            if (!updated.ok) return fail(`${updated.detail}\n\nOriginal commit error:\n${outdated}`, true)
            const stale = await this.staleOf(scope, entries, true)
            if (stale !== null)
              return fail(`${stale}\nThe update changed a file this commit holds. Review it, then click Commit files again.\n\n${updated.output}\n\nOriginal commit error:\n${outdated}`, true)
            updateOutput = updated.output
            onProgress({ stage: 'preparing', completed: 0, total: null })
            result = await this.deps.svn.commit(scope, targets, messageFile, onProgress)
          }
          // An update that happened leaves the shown list behind whatever the retry did.
          if (!result.ok) return fail(result.detail, updateOutput !== null)
          completed.push({ scope, revision: result.value.revision,
            output: updateOutput === null ? result.value.output : `${updateOutput}\n${result.value.output}` })
        }
        else if (draft.dto.vcs === 'git') {
          const paths = entries.flatMap(({ entry }) => entry.status === 'renamed' && entry.previousPath !== null ? [entry.path, entry.previousPath] : [entry.path])
          const result = await this.deps.git.commit(scope, paths, messageFile, onProgress)
          if (!result.ok) return fail(result.detail)
          completed.push({ scope, revision: result.value.hash, output: result.value.output })
        }
        else throw new Error(`Unknown commit VCS: ${JSON.stringify(draft.dto.vcs)}`)
      }
      const revision = completed.map((item) => item.revision).join(', ')
      const output = completed.map((item) => groups.length === 1 ? item.output : `${item.scope}: ${item.revision}\n${item.output}`).join('\n\n')
      draft.dto.phase = { kind: 'done', revision, output, finishedAt: this.now() }
      this.deps.messages.remove(draft.dto)
      this.bump(draft)
      return { ok: true, revision }
    }
    catch (error) { return fail(ErrorText.of(error)) }
    finally {
      for (const lock of locks) this.running.delete(lock)
      if (completed.length > 0)
        for (const scope of new Set([draft.cwd, ...completed.map((item) => item.scope)])) this.deps.sessions.settleVcs(scope)
      if (temporary !== null) await rm(temporary, { recursive: true, force: true })
    }
  }

  async revert(ownerId: string, request: VersioningRevertRequest,
    confirm: (paths: readonly string[], vcs: FileChangesVcsId) => Promise<boolean>): Promise<VersioningRevertResult> {
    const draft = this.owned(ownerId, request.draftId)
    if (draft === null) return { ok: false, code: 'unknown-draft', detail: 'The commit dialog no longer exists' }
    if (this.running.has(draft.lockRoot) || draft.dto.phase.kind === 'running' || draft.dto.phase.kind === 'done')
      return { ok: false, code: 'busy', detail: 'Another change is running or this dialog has already committed' }
    const snapshot = this.deps.snapshotOf(ownerId, request.snapshotId)
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
      for (const target of targets.value) {
        if (this.owned(ownerId, request.draftId) !== draft)
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
      if (attempted) {
        draft.dto.phase = { kind: 'editing' }
        this.bump(draft)
        this.settle(draft, draft.dto.scopeRoot)
      }
    }
  }

  async openTortoise(ownerId: string, draftId: string, message: string): Promise<VersioningTortoiseResult> {
    const draft = this.owned(ownerId, draftId)
    if (draft === null) return { ok: false, code: 'unknown-draft', detail: 'The commit dialog no longer exists' }
    if (this.running.has(draft.lockRoot) || draft.dto.phase.kind === 'running' || draft.dto.phase.kind === 'done')
      return { ok: false, code: 'busy', detail: 'Another change is running or this dialog has already committed' }
    if (typeof message !== 'string' || message.length > VersioningCommitLimits.messageMaxCharactersConst)
      return { ok: false, code: 'message-too-long', detail: `The commit message is limited to ${VersioningCommitLimits.messageMaxCharactersConst} characters` }
    this.running.add(draft.lockRoot)
    let temporary: string | null = null
    try {
      if (!this.setMessage(ownerId, draftId, message))
        return { ok: false, code: 'vcs-failed', detail: 'The commit message could not be saved' }
      temporary = await mkdtemp(join(tmpdir(), 'jamat-v3-commit-'))
      const messageFile = join(temporary, 'message.txt')
      await writeFile(messageFile, message, 'utf8')
      if (this.owned(ownerId, draftId) !== draft)
        return { ok: false, code: 'unknown-draft', detail: 'The commit dialog closed before opening Tortoise' }
      draft.externalReview = 'running'
      this.bump(draft)
      const opened = await this.deps.tortoise.open({ vcs: draft.dto.vcs, scope: draft.dto.scopeRoot, messageFile,
        ...(draft.dto.paths === undefined ? {} : { paths: draft.dto.paths }) })
      if (!opened.ok) {
        delete draft.externalReview
        this.bump(draft)
        return { ok: false, code: 'vcs-failed', detail: opened.detail }
      }
      try { await opened.closed }
      finally { draft.externalReview = 'closed'; this.bump(draft) }
      this.settle(draft, draft.dto.scopeRoot)
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

  private resolveTargets(ownerId: string, draft: Draft, snapshot: FileChangesWorkingTreeSnapshot, ids: readonly string[], includeExternals = false):
    | { ok: true; value: CommitTarget[] }
    | Extract<VersioningCommitRunResult, { ok: false }> {
    if (!Array.isArray(ids) || ids.length > VersioningCommitLimits.targetsMaxConst)
      return { ok: false, code: 'invalid-target', detail: 'Too many commit targets' }
    const selected = new Set(ids)
    for (const entry of snapshot.entries)
      if (entry.nodeKind === 'directory' && (entry.status === 'added' || entry.status === 'untracked')
        && snapshot.entries.some((child) => selected.has(child.fileId) && PathCompare.isInside(entry.path, child.path))) selected.add(entry.fileId)
    const targets: CommitTarget[] = []
    if (selected.size > VersioningCommitLimits.targetsMaxConst)
      return { ok: false, code: 'invalid-target', detail: 'Too many commit targets including required parent directories' }
    for (const id of selected) {
      const entry = snapshot.entries.find((candidate) => candidate.fileId === id)
      const access = this.deps.fileAccess(ownerId, snapshot.snapshotId, id)
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
      targets.push({ entry, modifiedAt: access.value.workingState.modifiedAt, scopeRoot })
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
    const draft = this.drafts.get(draftId)
    return draft?.owners.has(ownerId) && draft.dto.phase.kind !== 'cancelled' ? draft : null
  }

  private static allows(draft: Draft, entry: FileChangeEntry): boolean {
    return draft.targets === undefined || draft.targets.some((target) =>
      PathCompare.comparable(target.path) === PathCompare.comparable(entry.path)
      || (target.recursive && PathCompare.isInside(target.path, entry.path))
      || (entry.nodeKind === 'directory' && (entry.status === 'added' || entry.status === 'untracked')
        && PathCompare.isInside(entry.path, target.path)))
  }

  /** Updating is the only way past an out-of-date scope. Whether a retry follows is the caller's. */
  private async updateOutdated(draft: Draft, scope: string, entries: readonly CommitTarget[]):
    Promise<{ ok: true; output: string } | { ok: false; detail: string }> {
    const startedAt = draft.dto.phase.kind === 'running' ? draft.dto.phase.startedAt : this.now()
    draft.dto.phase = { kind: 'running', startedAt, detail: 'SVN is out of date. Updating this commit scope...' }
    this.bump(draft)
    try {
      const result = draft.targets === undefined ? await this.deps.svn.update(scope)
        : await this.deps.svn.update(scope, entries.map(({ entry }) => entry.path))
      return result.ok ? { ok: true, output: result.value.output }
        : { ok: false, detail: `SVN update failed or left conflicts:\n${result.detail}` }
    }
    catch (error) { return { ok: false, detail: `SVN update failed: ${ErrorText.of(error)}` } }
    finally { this.settle(draft, scope) }
  }

  private failed(draft: Draft, detail: string, reloadRequired = false): Extract<VersioningCommitRunResult, { ok: false }> {
    draft.dto.phase = { kind: 'failed', detail, failedAt: this.now() }
    this.bump(draft)
    return { ok: false, code: 'vcs-failed', detail, ...(reloadRequired ? { reloadRequired: true } : {}) }
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }
  private settle(draft: Draft, scope: string): void {
    for (const cwd of new Set([draft.cwd, scope])) this.deps.sessions.settleVcs(cwd)
  }
  private bump(draft: Draft): void { draft.dto.revision++; this.changed() }
  private changed(): void { this.revision++; this.deps.onChanged() }
}
