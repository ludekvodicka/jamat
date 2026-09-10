import { randomUUID } from 'node:crypto'

import type {
  FileChangeBaseline,
  FileChangeEntry,
  FileChangeGroup,
  FileChangeNodeKind,
  FileChangeStatus,
  FileChangesContext,
  FileChangesHistoryPage,
  FileChangesSnapshot,
  FileChangesWorkingTreeSelection,
  FileChangesWorkingTreeSnapshot,
  FileChangesWorkingTreeExternalRoot,
  FileChangesVcsDetection,
  FileChangesVcsSelection,
} from '../fileChangesManagerApi.types'
import type { FileChangesLogGroup } from '../logs/fileChangesLogSource.types'
import type {
  FileChangesVcs,
  FileChangesVcsBaselineRef,
} from '../vcs/fileChangesVcs.types'

export interface SnapshotFile {
  fileId: string
  currentPath: string
  nodeKind: FileChangeNodeKind
  status: FileChangeStatus
  workingState?: { modifiedAt: number | null; vcsEntry: boolean }
}

export interface SnapshotBaselineFile {
  currentPath: string
  baselinePath: string
  repositoryPath: string | null
  status: FileChangeStatus
}

export type SnapshotBaseline =
  | {
    public: FileChangeBaseline
    kind: 'vcs'
    ref: FileChangesVcsBaselineRef
    files: ReadonlyMap<string, SnapshotBaselineFile>
  }
  | {
    public: FileChangeBaseline
    kind: 'chat'
    groupId: string
    files: ReadonlyMap<string, SnapshotBaselineFile>
  }

export interface FileChangesSnapshotRuntime {
  context: FileChangesContext
  selectedVcs: { adapter: FileChangesVcs; detection: FileChangesVcsDetection } | null
  logGroups: readonly FileChangesLogGroup[]
  files: ReadonlyMap<string, SnapshotFile>
  baselines: ReadonlyMap<string, SnapshotBaseline>
}

export interface FileChangesSnapshotStoreInput extends FileChangesSnapshotRuntime {
  vcs: FileChangesVcsSelection
  defaultBaseline: FileChangeBaseline | null
  entries: readonly FileChangeEntry[]
  groups: readonly FileChangeGroup[]
  warnings: readonly string[]
  pageSize: number
}

export interface FileChangesWorkingTreeSnapshotStoreInput extends FileChangesSnapshotRuntime {
  source: FileChangesWorkingTreeSelection
  defaultBaseline: FileChangeBaseline | null
  entries: readonly FileChangeEntry[]
  externalRoots: readonly FileChangesWorkingTreeExternalRoot[]
  warnings: readonly string[]
}

interface StoredSnapshot extends FileChangesSnapshotRuntime {
  working: FileChangesWorkingTreeSnapshot | null
  snapshotId: string
  createdAt: number
  expiresAt: number
  groups: readonly FileChangeGroup[]
  pageSize: number
  cursors: Map<string, number>
}

export type SnapshotLookup =
  | { ok: true; snapshot: StoredSnapshot }
  | { ok: false; detail: string }

export type SnapshotDiffLookup =
  | {
    ok: true
    snapshot: StoredSnapshot
    file: SnapshotFile
    baseline: SnapshotBaseline
    baselineFile: SnapshotBaselineFile
  }
  | {
    ok: false
    code: 'snapshot-expired' | 'unknown-file' | 'unknown-baseline' | 'invalid-pair'
    detail: string
  }

export type SnapshotFileLookup =
  | { ok: true; snapshot: StoredSnapshot; file: SnapshotFile }
  | { ok: false; code: 'snapshot-expired' | 'unknown-file'; detail: string }

export class FileChangesSnapshotStore {
  private static readonly maxSnapshotsConst = 32
  private static readonly ttlMillisecondsConst = 15 * 60_000

  private readonly snapshots = new Map<string, StoredSnapshot>()

  constructor(private readonly now: () => number = Date.now) {}

  put(input: FileChangesSnapshotStoreInput): FileChangesSnapshot {
    const stored = this.store(input)
    return {
      snapshotId: stored.snapshotId,
      sessionId: input.context.sessionId,
      createdAt: stored.createdAt,
      vcs: input.vcs,
      defaultBaseline: input.defaultBaseline,
      entries: input.entries,
      history: this.page(stored, 0),
      warnings: input.warnings,
    }
  }

  putWorking(input: FileChangesWorkingTreeSnapshotStoreInput): FileChangesWorkingTreeSnapshot {
    const stored = this.store({ ...input, groups: [], pageSize: 1 })
    const snapshot: FileChangesWorkingTreeSnapshot = {
      snapshotId: stored.snapshotId,
      sessionId: input.context.sessionId,
      createdAt: stored.createdAt,
      source: input.source,
      externalRoots: input.externalRoots,
      defaultBaseline: input.defaultBaseline,
      entries: input.entries,
      warnings: input.warnings,
    }
    stored.working = snapshot
    return snapshot
  }

  workingSnapshot(snapshotId: string): FileChangesWorkingTreeSnapshot | null {
    const found = this.lookup(snapshotId)
    return found.ok ? found.snapshot.working : null
  }

  private store(
    input: FileChangesSnapshotRuntime & {
      groups: readonly FileChangeGroup[]
      pageSize: number
    },
  ): StoredSnapshot {
    this.prune()
    while (this.snapshots.size >= FileChangesSnapshotStore.maxSnapshotsConst)
      this.snapshots.delete(this.snapshots.keys().next().value!)
    const snapshotId = randomUUID()
    const createdAt = this.now()
    const stored: StoredSnapshot = {
      working: null,
      snapshotId,
      createdAt,
      expiresAt: createdAt + FileChangesSnapshotStore.ttlMillisecondsConst,
      context: input.context,
      selectedVcs: input.selectedVcs,
      logGroups: input.logGroups,
      files: input.files,
      baselines: input.baselines,
      groups: input.groups,
      pageSize: input.pageSize,
      cursors: new Map(),
    }
    this.snapshots.set(snapshotId, stored)
    return stored
  }

  lookup(snapshotId: string): SnapshotLookup {
    this.prune()
    const snapshot = this.snapshots.get(snapshotId)
    return snapshot
      ? { ok: true, snapshot }
      : { ok: false, detail: 'The file changes snapshot expired or does not exist' }
  }

  lookupDiff(snapshotId: string, fileId: string, baselineId: string): SnapshotDiffLookup {
    const found = this.lookup(snapshotId)
    if (!found.ok) return { ok: false, code: 'snapshot-expired', detail: found.detail }
    const file = found.snapshot.files.get(fileId)
    if (!file) return { ok: false, code: 'unknown-file', detail: 'The file token is unknown' }
    const baseline = found.snapshot.baselines.get(baselineId)
    if (!baseline)
      return { ok: false, code: 'unknown-baseline', detail: 'The baseline token is unknown' }
    const baselineFile = baseline.files.get(fileId)
    if (!baselineFile)
      return { ok: false, code: 'invalid-pair', detail: 'The file does not belong to this baseline' }
    return { ok: true, snapshot: found.snapshot, file, baseline, baselineFile }
  }

  lookupFile(snapshotId: string, fileId: string): SnapshotFileLookup {
    const found = this.lookup(snapshotId)
    if (!found.ok) return { ok: false, code: 'snapshot-expired', detail: found.detail }
    const file = found.snapshot.files.get(fileId)
    return file
      ? { ok: true, snapshot: found.snapshot, file }
      : { ok: false, code: 'unknown-file', detail: 'The file token is unknown' }
  }

  nextPage(snapshotId: string, cursor: string):
    | { ok: true; value: FileChangesHistoryPage }
    | { ok: false; code: 'snapshot-expired' | 'invalid-cursor'; detail: string } {
    const found = this.lookup(snapshotId)
    if (!found.ok) return { ok: false, code: 'snapshot-expired', detail: found.detail }
    const offset = found.snapshot.cursors.get(cursor)
    if (offset === undefined)
      return { ok: false, code: 'invalid-cursor', detail: 'The history cursor is unknown' }
    return { ok: true, value: this.page(found.snapshot, offset) }
  }

  private page(snapshot: StoredSnapshot, offset: number): FileChangesHistoryPage {
    const groups = snapshot.groups.slice(offset, offset + snapshot.pageSize)
    const nextOffset = offset + groups.length
    let nextCursor: string | null = null
    if (nextOffset < snapshot.groups.length) {
      nextCursor = randomUUID()
      snapshot.cursors.set(nextCursor, nextOffset)
    }
    return { groups, nextCursor }
  }

  private prune(): void {
    const now = this.now()
    for (const [id, snapshot] of this.snapshots)
      if (snapshot.expiresAt <= now) this.snapshots.delete(id)
  }
}
