import { randomUUID } from 'node:crypto'
import type { RemoteControlCommitStatusDto } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import type { FileChangesFileAccessResult } from '../../../lib-orchestrator/fileChangesManager/fileChangesManager'
import type { FileChangeEntry, FileChangesVcsId, FileChangesWorkingTreeSnapshot } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { VcsStatusView } from '../../../lib-orchestrator/fileChangesManager/vcsStatusView'
import type { GitCheckpointStore } from '../../../lib-orchestrator/git/gitCheckpointStore'
import type { GitCommitManager } from '../../../lib-orchestrator/git/gitCommitManager'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import { ErrorText } from '../../../lib-orchestrator/shared/errorText'
import { PathCompare } from '../../../lib-orchestrator/shared/pathCompare'
import type { TortoiseCommitDialog } from '../../../lib-orchestrator/shared/tortoiseCommitDialog'
import type { SvnCommitManager } from '../../../lib-orchestrator/svn/svnCommitManager'
import { VersioningCommitLimits, VersioningRevert } from '../../shared/versioningCommit'
import type { VersioningRevertRequest, VersioningRevertResult, VersioningTortoiseResult } from '../../shared/versioningCommit'
import type { VersioningCommitDraftDto, VersioningCommitOpenResult, VersioningCommitOpenSessions, VersioningCommitRunRequest, VersioningCommitRunResult } from '../../shared/versioningCommit'

export interface VersioningCommitManagerDeps {
  sessions: Pick<SessionManager, 'workingContext' | 'settleVcs'>
  vcsStatus: Pick<VcsStatusView, 'detect'>
  checkpointStore: Pick<GitCheckpointStore, 'worktreeBelongsToStore'>
  fileAccess(ownerId: string, snapshotId: string, fileId: string): FileChangesFileAccessResult
  snapshotOf(ownerId: string, snapshotId: string): FileChangesWorkingTreeSnapshot | null
  git: Pick<GitCommitManager, 'commit' | 'revertFile'>
  svn: Pick<SvnCommitManager, 'commit' | 'revertFile'>
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
  externalReview?: 'running' | 'closed'
}

interface CommitTarget {
  entry: FileChangeEntry
  modifiedAt: number | null
}

export class VersioningCommitManager {
  private static readonly retentionMillisecondsConst = 86_400_000
  private static readonly retainedCountConst = 256
  private readonly drafts = new Map<string, Draft>()
  private readonly closed = new Map<string, { draft: Draft; closedAt: number }>()
  private readonly running = new Set<string>()
  private revision = 0

  constructor(private readonly deps: VersioningCommitManagerDeps) {}

  async prepare(sessionId: string, vcs: FileChangesVcsId, scope: string | null, proposal: string | null): Promise<VersioningCommitOpenResult> {
    if (vcs !== 'svn' && vcs !== 'git') throw new Error(`Unknown commit VCS: ${JSON.stringify(vcs)}`)
    if (proposal !== null && proposal.length > VersioningCommitLimits.messageMaxCharactersConst)
      return { ok: false, code: 'message-too-long', detail: `The commit message is limited to ${VersioningCommitLimits.messageMaxCharactersConst} characters` }
    const context = await this.deps.sessions.workingContext(sessionId)
    if (!context.ok) return { ok: false, code: 'unknown-session', detail: context.detail }
    const cwd = context.value.cwd
    const requested = resolve(cwd, scope ?? '.')
    const [realCwd, realScope] = await Promise.all([realpath(cwd).catch(() => null), realpath(requested).catch(() => null)])
    if (!PathCompare.isInside(cwd, requested) || (realCwd !== null && realScope !== null && !PathCompare.isInside(realCwd, realScope)))
      return { ok: false, code: 'outside-session', detail: 'The commit scope must be inside the session working directory' }
    const detection = await this.deps.vcsStatus.detect(requested, vcs)
    if (realScope === null || detection === null || detection.id !== vcs)
      return { ok: false, code: 'no-working-copy', detail: `${requested} is not inside a ${vcs.toUpperCase()} working copy` }
    if (vcs === 'git' && await this.deps.checkpointStore.worktreeBelongsToStore(detection.root))
      return { ok: false, code: 'store-worktree', detail: 'This worktree belongs to the checkpoint store' }
    const existing = [...this.drafts.values()].find((draft) => draft.dto.sessionId === sessionId && draft.dto.vcs === vcs
      && PathCompare.comparable(draft.dto.scopeRoot) === PathCompare.comparable(requested))
    const draft: Draft = existing ?? {
      dto: {
        draftId: this.deps.newId?.() ?? randomUUID(), sessionId, vcs, scopeRoot: requested, scopeDisplay: requested,
        source: vcs, message: '', editedByPerson: false, proposedByAgent: false, phase: { kind: 'editing' }, revision: 0,
      },
      owners: new Set(), cwd, lockRoot: PathCompare.comparable(detection.root),
    }
    this.drafts.set(draft.dto.draftId, draft)
    const messageApplied = proposal !== null && !draft.dto.editedByPerson && draft.dto.phase.kind === 'editing'
    if (messageApplied) {
      draft.dto.message = proposal
      draft.dto.proposedByAgent = true
    }
    this.bump(draft)
    return { ok: true, value: { draftId: draft.dto.draftId, scopeRoot: requested, title: `Commit ${vcs.toUpperCase()} · ${basename(requested)}` }, messageApplied }
  }

  read(ownerId: string, draftId: string): VersioningCommitDraftDto | null {
    const draft = this.owned(ownerId, draftId)
    return draft === null ? null : structuredClone(draft.dto)
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
    else if (phase.kind === 'editing') state = closed ? 'cancelled' : 'editing'
    else throw new Error(`Unknown commit phase: ${JSON.stringify(phase)}`)
    return { kind: 'commit-status', commitSessionId, sessionId, vcs, scopeRoot, state, closed,
      revision: phase.kind === 'done' ? phase.revision : null, detail: state === 'failed' && phase.kind === 'failed' ? phase.detail : null }
  }

  private sweepClosed(): void {
    for (const [id, entry] of this.closed)
      if (entry.draft.dto.phase.kind !== 'running' && entry.draft.externalReview !== 'running'
        && (this.now() - entry.closedAt >= VersioningCommitManager.retentionMillisecondsConst
          || this.closed.size > VersioningCommitManager.retainedCountConst))
        this.closed.delete(id)
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
    this.sweepClosed()
    this.changed()
  }

  revokeOwner(ownerId: string): void {
    for (const draft of this.drafts.values()) this.release(draft.dto.draftId, ownerId)
  }

  openSessions(): VersioningCommitOpenSessions {
    return { revision: this.revision, sessionIds: [...new Set([...this.drafts.values()]
      .filter((draft) => draft.dto.phase.kind !== 'done').map((draft) => draft.dto.sessionId))] }
  }

  setMessage(ownerId: string, draftId: string, message: string): boolean {
    const draft = this.owned(ownerId, draftId)
    if (draft === null || typeof message !== 'string' || message.length > VersioningCommitLimits.messageMaxCharactersConst
      || draft.dto.phase.kind === 'running' || draft.dto.phase.kind === 'done') return false
    draft.dto.message = message
    draft.dto.editedByPerson = true
    this.bump(draft)
    return true
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
      return { ok: false, code: 'invalid-target', detail: 'The file list does not belong to this dialog; reload it' }
    const targets = this.resolveTargets(ownerId, draft, snapshot, request.fileIds)
    if (!targets.ok) return targets
    // Lock before the async preflight so sibling scopes cannot both pass it and start staging.
    this.running.add(draft.lockRoot)
    let temporary: string | null = null
    try {
      const stale = await this.staleOf(draft.dto.scopeRoot, targets.value)
      if (stale !== null) return { ok: false, code: 'stale', detail: stale }
      if (this.owned(ownerId, request.draftId) !== draft)
        return { ok: false, code: 'unknown-draft', detail: 'The commit dialog closed before the commit started' }
      draft.dto.message = request.message
      draft.dto.editedByPerson = true
      draft.dto.phase = { kind: 'running', startedAt: this.now() }
      delete draft.externalReview
      this.bump(draft)
      temporary = await mkdtemp(join(tmpdir(), 'jamat-v3-commit-'))
      const messageFile = join(temporary, 'message.txt')
      await writeFile(messageFile, request.message.replace(/\n?$/, '\n'), 'utf8')
      let revision: string
      let output: string
      if (draft.dto.vcs === 'svn') {
        const result = await this.deps.svn.commit(draft.dto.scopeRoot, targets.value.map(({ entry }) => ({ absolutePath: entry.path, nodeKind: entry.nodeKind, status: entry.status })), messageFile)
        if (!result.ok) return this.failed(draft, result.detail)
        revision = result.value.revision
        output = result.value.output
      }
      else if (draft.dto.vcs === 'git') {
        const paths = targets.value.flatMap(({ entry }) => entry.status === 'renamed' && entry.previousPath !== null ? [entry.path, entry.previousPath] : [entry.path])
        const result = await this.deps.git.commit(draft.dto.scopeRoot, paths, messageFile)
        if (!result.ok) return this.failed(draft, result.detail)
        revision = result.value.hash
        output = result.value.output
      }
      else throw new Error(`Unknown commit VCS: ${JSON.stringify(draft.dto.vcs)}`)
      draft.dto.phase = { kind: 'done', revision, output, finishedAt: this.now() }
      this.bump(draft)
      this.deps.sessions.settleVcs(draft.cwd)
      return { ok: true, revision }
    }
    catch (error) { return this.failed(draft, ErrorText.of(error)) }
    finally {
      this.running.delete(draft.lockRoot)
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
      const stale = await this.staleOf(draft.dto.scopeRoot, targets.value)
      if (stale !== null) return { ok: false, code: 'stale', detail: stale }
      if (!await confirm(targets.value.map(({ entry }) => entry.path), draft.dto.vcs)) return { ok: true, reverted: false }
      if (this.owned(ownerId, request.draftId) !== draft)
        return { ok: false, code: 'unknown-draft', detail: 'The commit dialog closed before reverting' }
      const changed = await this.staleOf(draft.dto.scopeRoot, targets.value)
      if (changed !== null) return { ok: false, code: 'stale', detail: changed }
      for (const { entry } of targets.value) {
        const current = await lstat(entry.path).catch(() => null)
        if (current !== null && !current.isFile())
          return { ok: false, code: 'invalid-target', detail: 'Only regular files can be reverted here' }
      }
      for (const target of targets.value) {
        if (this.owned(ownerId, request.draftId) !== draft)
          return { ok: false, code: 'unknown-draft', detail: progress('The commit dialog closed while reverting') }
        const changed = await this.staleOf(draft.dto.scopeRoot, [target])
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
        this.deps.sessions.settleVcs(draft.cwd)
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
      temporary = await mkdtemp(join(tmpdir(), 'jamat-v3-commit-'))
      const messageFile = join(temporary, 'message.txt')
      await writeFile(messageFile, message, 'utf8')
      if (this.owned(ownerId, draftId) !== draft)
        return { ok: false, code: 'unknown-draft', detail: 'The commit dialog closed before opening Tortoise' }
      draft.externalReview = 'running'
      this.bump(draft)
      const opened = await this.deps.tortoise.open({ vcs: draft.dto.vcs, scope: draft.dto.scopeRoot, messageFile })
      if (!opened.ok) {
        delete draft.externalReview
        this.bump(draft)
        return { ok: false, code: 'vcs-failed', detail: opened.detail }
      }
      try { await opened.closed }
      finally { draft.externalReview = 'closed'; this.bump(draft) }
      this.deps.sessions.settleVcs(draft.cwd)
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

  private resolveTargets(ownerId: string, draft: Draft, snapshot: FileChangesWorkingTreeSnapshot, ids: readonly string[]):
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
        || access.value.sessionId !== draft.dto.sessionId || access.value.path !== entry.path
        || !PathCompare.isInside(draft.dto.scopeRoot, entry.path)
        || (entry.previousPath !== null && !PathCompare.isInside(draft.dto.scopeRoot, entry.previousPath))
        || entry.status === 'conflicted' || entry.status === 'obstructed')
        return { ok: false, code: 'invalid-target', detail: 'A selected target is invalid or conflicted; reload the list' }
      if (snapshot.externalRoots.some((root) => PathCompare.comparable(root.path) !== PathCompare.comparable(draft.dto.scopeRoot)
        && PathCompare.isInside(draft.dto.scopeRoot, root.path) && PathCompare.isInside(root.path, entry.path)))
        return { ok: false, code: 'external-target', detail: 'Commit this external separately' }
      if (!access.value.workingState.vcsEntry) continue
      if (draft.dto.vcs === 'git' && entry.nodeKind === 'directory') continue
      targets.push({ entry, modifiedAt: access.value.workingState.modifiedAt })
    }
    return targets.length === 0 ? { ok: false, code: 'no-targets', detail: 'Select at least one changed file' } : { ok: true, value: targets }
  }

  private async staleOf(scope: string, targets: readonly CommitTarget[]): Promise<string | null> {
    const actualScope = await realpath(scope)
    for (const target of targets) {
      const path = target.entry.path
      if (target.entry.status === 'renamed' && target.entry.previousPath !== null
        && await lstat(target.entry.previousPath).catch(() => null) !== null)
        return `${target.entry.previousDisplayPath ?? target.entry.previousPath} exists at the rename source; review the rename before committing`
      const current = await lstat(path).catch(() => null)
      if ((current === null ? null : Math.round(current.mtimeMs)) !== target.modifiedAt
        || (current === null && target.entry.status !== 'missing' && target.entry.status !== 'deleted')
        || (current !== null && (target.entry.status === 'missing' || target.entry.status === 'deleted')))
        return `${target.entry.displayPath} changed since you looked; reload the list`
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
    return draft?.owners.has(ownerId) ? draft : null
  }

  private failed(draft: Draft, detail: string): Extract<VersioningCommitRunResult, { ok: false }> {
    draft.dto.phase = { kind: 'failed', detail, failedAt: this.now() }
    this.bump(draft)
    return { ok: false, code: 'vcs-failed', detail }
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }
  private bump(draft: Draft): void { draft.dto.revision++; this.changed() }
  private changed(): void { this.revision++; this.deps.onChanged() }
}
