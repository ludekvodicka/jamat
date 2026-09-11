import type { WebContents } from 'electron'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type {
  FileChangesHistoryResult,
  FileChangesContext,
  FileChangesSnapshotResult,
  FileChangesWorkingTreeSnapshotResult,
  FileChangesWorkingTreeSource,
  FileChangesVcsId,
  FileDiffRequest,
  FileDiffResult,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { FileChangesManager } from '../../../lib-orchestrator/fileChangesManager/fileChangesManager'
import type { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import type {
  FileViewerDocumentSource,
  FileViewerOpenResult,
} from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import { PathCompare } from '../../../lib-orchestrator/shared/pathCompare'
import type { FileChangesOpenFileResult } from '../../shared/appClientUiIpc'
import { ServiceIpcBase } from '../shared/serviceIpcBase'
import { FileChangesSettingsSection } from './fileChangesSettingsSection'

interface FileChangesSnapshotOwner {
  ownerIds: Set<string>
  sessionId: string
}

interface FileChangesDiffJob {
  token: object
  snapshotId: string
  ownerIds: Set<string>
  controller: AbortController
  promise: Promise<FileDiffResult>
}

export class ServiceFileChangesIpc extends ServiceIpcBase<
  typeof ServiceFileChangesIpc.channelsConst
> {
  private static readonly maxOwnedSnapshotsConst = 64
  private static readonly diffJobsGlobalMaxConst = 8
  private static readonly diffJobsPerOwnerMaxConst = 2

  static readonly channelsConst = {
    'fileChanges:list': true,
    'fileChanges:working-tree': true,
    'fileChanges:history': true,
    'fileChanges:diff': true,
    'fileChanges:open-file': true,
  } as const

  private readonly snapshotOwners = new Map<string, FileChangesSnapshotOwner>()
  /** The listing each session has in flight, so a second asker joins it instead of starting another. */
  private readonly listing = new Map<string, Promise<FileChangesSnapshotResult>>()
  private readonly workingTrees = new Map<string, Promise<FileChangesWorkingTreeSnapshotResult>>()
  private readonly diffJobs = new Map<string, FileChangesDiffJob>()

  constructor(
    private readonly manager: FileChangesManager,
    private readonly viewer: FileViewer,
    private readonly sessions: SessionManager,
    private readonly configStore: ConfigStore,
    private readonly ownerIdOf: (sender: WebContents) => string | null,
  ) {
    super()
  }

  initialize(): void {
    this.register('fileChanges:list', (event, sessionId, preferredVcs) =>
      this.list(this.ownerId(event.sender), sessionId, preferredVcs))
    this.register('fileChanges:working-tree', (event, sessionId, source) =>
      this.workingTree(this.ownerId(event.sender), sessionId, source))
    this.register('fileChanges:history', (event, snapshotId, cursor) =>
      this.history(this.ownerId(event.sender), snapshotId, cursor))
    this.register('fileChanges:diff', (event, request) =>
      this.diff(this.ownerId(event.sender), request))
    this.register('fileChanges:open-file', (event, snapshotId, fileId) =>
      this.openFile(this.ownerId(event.sender), snapshotId, fileId))
    this.assertComplete(ServiceFileChangesIpc.channelsConst)
  }

  revokeOwner(ownerId: string): void {
    for (const [snapshotId, owner] of this.snapshotOwners)
      if (owner.ownerIds.delete(ownerId) && owner.ownerIds.size === 0)
        this.snapshotOwners.delete(snapshotId)
    for (const [key, job] of this.diffJobs)
      if (job.ownerIds.delete(ownerId) && job.ownerIds.size === 0) {
        this.diffJobs.delete(key)
        job.controller.abort()
      }
  }

  ownedFileAccess(ownerId: string, snapshotId: string, fileId: string): ReturnType<FileChangesManager['fileAccess']> {
    if (!this.owns(ownerId, snapshotId))
      return { ok: false, code: 'snapshot-expired', detail: 'The file changes snapshot expired' }
    return this.manager.fileAccess(snapshotId, fileId)
  }

  ownedWorkingTreeSnapshot(ownerId: string, snapshotId: string): ReturnType<FileChangesManager['workingSnapshot']> {
    return this.owns(ownerId, snapshotId) ? this.manager.workingSnapshot(snapshotId) : null
  }

  /**
   * Restoring one external document from a saved layout. It goes through the same listing as the
   * panel does, and through the same single flight: a window restored with four external documents
   * used to run four complete listings at once, each of them detecting both VCS and reading a
   * hundred commits to find one anchor path - and each of those snapshots pushed a live one out of
   * the store of thirty-two, so a panel that was already open started answering `snapshot-expired`.
   */
  async restoreExternal(
    ownerId: string,
    source: Extract<FileViewerDocumentSource, { kind: 'external' }>,
    supportsDiff: boolean,
  ): Promise<FileViewerOpenResult> {
    const snapshot = await this.list(ownerId, source.sessionId, null)
    if (!snapshot.ok)
      return { ok: false, code: 'invalid-source', detail: snapshot.detail }
    const anchor = snapshot.value.entries.find((entry) =>
      entry.nodeKind === 'file'
      && PathCompare.comparable(entry.path) === PathCompare.comparable(source.anchorPath))
    if (!anchor)
      return {
        ok: false,
        code: 'access-denied',
        detail: 'The external file is no longer present in the session change log',
      }
    const access = this.manager.fileAccess(snapshot.value.snapshotId, anchor.fileId)
    if (!access.ok)
      return { ok: false, code: 'access-denied', detail: access.detail }
    return this.viewer.restoreExternal(ownerId, access.value, source.path, supportsDiff)
  }

  /**
   * One listing per session at a time, whoever asks.
   *
   * A listing is not a cheap read: it detects both VCS, runs a status, reads a hundred commits and
   * parses the session's whole transcript, all in this process. Nothing upstream stopped a second
   * one starting - the renderer's own guard discards the ANSWER, not the work, and four panels
   * mount at once on a restored layout. A caller that arrives while one runs gets that one's answer,
   * which is the answer it would have computed anyway.
   *
   * Keyed by session AND by which VCS was asked for, because those are two different questions.
   */
  private async list(
    ownerId: string,
    sessionId: string,
    preferredVcs: FileChangesVcsId | null,
  ): Promise<FileChangesSnapshotResult> {
    const context = await this.sessions.workingContext(sessionId)
    if (!context.ok)
      return { ok: false, code: 'invalid-context', detail: context.detail }
    const selectedVcs = preferredVcs
      ?? this.configStore.readSection(FileChangesSettingsSection.spec).primaryVcs
    const key = `${sessionId}\u0000${selectedVcs}`
    const running = this.listing.get(key)
    const result = await (running ?? this.startList(key, context.value, selectedVcs))
    if (result.ok) this.track(result.value.snapshotId, ownerId, sessionId)
    return result
  }

  private startList(
    key: string,
    context: FileChangesContext,
    preferredVcs: FileChangesVcsId,
  ): Promise<FileChangesSnapshotResult> {
    const started = this.manager.list(context, { preferredVcs })
      .finally(() => this.listing.delete(key))
    this.listing.set(key, started)
    return started
  }

  async workingTree(
    ownerId: string,
    sessionId: string,
    source: FileChangesWorkingTreeSource | null,
    scopeRoot?: string,
    forCommit = false,
  ): Promise<FileChangesWorkingTreeSnapshotResult> {
    const context = await this.sessions.workingContext(sessionId)
    if (!context.ok)
      return { ok: false, code: 'invalid-context', detail: context.detail }
    if (scopeRoot !== undefined && !PathCompare.isInside(context.value.cwd, scopeRoot))
      return { ok: false, code: 'invalid-context', detail: 'The scope is outside the session working directory' }
    const key = `${sessionId}\u0000${source ?? ''}\u0000${scopeRoot ?? ''}\u0000${forCommit}`
    const running = this.workingTrees.get(key)
    const result = await (running ?? this.startWorkingTree(key, { ...context.value, cwd: scopeRoot ?? context.value.cwd }, source, forCommit))
    if (result.ok) this.track(result.value.snapshotId, ownerId, sessionId)
    return result
  }

  private startWorkingTree(
    key: string,
    context: Parameters<FileChangesManager['workingTree']>[0],
    source: FileChangesWorkingTreeSource | null,
    forCommit: boolean,
  ): Promise<FileChangesWorkingTreeSnapshotResult> {
    const started = this.manager.workingTree(context, source, forCommit)
      .finally(() => this.workingTrees.delete(key))
    this.workingTrees.set(key, started)
    return started
  }

  private history(
    ownerId: string,
    snapshotId: string,
    cursor: string,
  ): FileChangesHistoryResult {
    if (!this.owns(ownerId, snapshotId))
      return { ok: false, code: 'snapshot-expired', detail: 'The file changes snapshot expired' }
    this.touch(snapshotId)
    const result = this.manager.history(snapshotId, cursor)
    if (!result.ok && result.code === 'snapshot-expired') this.expireSnapshot(snapshotId)
    return result
  }

  private async diff(ownerId: string, request: FileDiffRequest): Promise<FileDiffResult> {
    if (!this.owns(ownerId, request.snapshotId))
      return { ok: false, code: 'snapshot-expired', detail: 'The file changes snapshot expired' }
    this.touch(request.snapshotId)
    const key = `${request.snapshotId}\u0000${request.fileId}\u0000${request.baselineId}`
    const running = this.diffJobs.get(key)
    if (running !== undefined) {
      if (!running.ownerIds.has(ownerId)) {
        if (this.ownerDiffJobs(ownerId) >= ServiceFileChangesIpc.diffJobsPerOwnerMaxConst)
          return ServiceFileChangesIpc.diffBusy('This window has too many file diffs in flight')
        running.ownerIds.add(ownerId)
      }
      return running.promise
    }
    if (this.diffJobs.size >= ServiceFileChangesIpc.diffJobsGlobalMaxConst)
      return ServiceFileChangesIpc.diffBusy('The file diff queue is full')
    if (this.ownerDiffJobs(ownerId) >= ServiceFileChangesIpc.diffJobsPerOwnerMaxConst)
      return ServiceFileChangesIpc.diffBusy('This window has too many file diffs in flight')
    const controller = new AbortController()
    const token = {}
    const promise = this.manager.diff(request, {
      ownerId,
      snapshotId: request.snapshotId,
      jobKey: key,
      signal: controller.signal,
    }).finally(() => {
      if (this.diffJobs.get(key)?.token === token) this.diffJobs.delete(key)
    })
    const job: FileChangesDiffJob = {
      token,
      snapshotId: request.snapshotId,
      ownerIds: new Set([ownerId]),
      controller,
      promise,
    }
    this.diffJobs.set(key, job)
    const result = await job.promise
    if (!result.ok && result.code === 'snapshot-expired')
      this.expireSnapshot(request.snapshotId)
    return result
  }

  private async openFile(
    ownerId: string,
    snapshotId: string,
    fileId: string,
  ): Promise<FileChangesOpenFileResult> {
    if (!this.owns(ownerId, snapshotId))
      return { ok: false, code: 'snapshot-expired', detail: 'The file changes snapshot expired' }
    this.touch(snapshotId)
    const access = this.manager.fileAccess(snapshotId, fileId)
    if (!access.ok) {
      if (access.code === 'snapshot-expired') this.expireSnapshot(snapshotId)
      return access
    }
    return this.viewer.openChanged(ownerId, access.value)
  }

  private ownerId(sender: WebContents): string {
    const ownerId = this.ownerIdOf(sender)
    if (ownerId === null) throw new Error('File changes request came from an unknown workspace')
    return ownerId
  }

  /**
   * A question, and only a question. It used to move the entry to the end of the eviction order on
   * the way past, which reads as a question at every one of its three call sites - so a fourth
   * operation that asked twice would have changed which snapshot gets evicted.
   */
  private owns(ownerId: string, snapshotId: string): boolean {
    const found = this.snapshotOwners.get(snapshotId)
    return found !== undefined && found.ownerIds.has(ownerId)
  }

  /** Used, so it is the last to be evicted. Say so, rather than letting `owns` do it quietly. */
  private touch(snapshotId: string): void {
    const found = this.snapshotOwners.get(snapshotId)
    if (found === undefined) return
    this.snapshotOwners.delete(snapshotId)
    this.snapshotOwners.set(snapshotId, found)
  }

  private track(snapshotId: string, ownerId: string, sessionId: string): void {
    const existing = this.snapshotOwners.get(snapshotId)
    if (existing !== undefined) {
      existing.ownerIds.add(ownerId)
      this.touch(snapshotId)
      return
    }
    while (this.snapshotOwners.size >= ServiceFileChangesIpc.maxOwnedSnapshotsConst) {
      const expired = this.snapshotOwners.keys().next().value!
      this.snapshotOwners.delete(expired)
      this.cancelSnapshot(expired)
    }
    this.snapshotOwners.set(snapshotId, { ownerIds: new Set([ownerId]), sessionId })
  }

  private ownerDiffJobs(ownerId: string): number {
    return [...this.diffJobs.values()].filter((job) => job.ownerIds.has(ownerId)).length
  }

  private expireSnapshot(snapshotId: string): void {
    this.snapshotOwners.delete(snapshotId)
    this.cancelSnapshot(snapshotId)
  }

  private cancelSnapshot(snapshotId: string): void {
    for (const [key, job] of this.diffJobs)
      if (job.snapshotId === snapshotId) {
        this.diffJobs.delete(key)
        job.controller.abort()
      }
  }

  private static diffBusy(detail: string): FileDiffResult {
    return { ok: true, kind: 'busy', detail }
  }
}
