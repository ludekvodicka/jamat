import type { FileChangeEntry, FileChangesVcsId } from '../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { CommitProgress } from '../../lib-orchestrator/shared/commitProgress.types'

export type VersioningExternalDiffResult = { ok: true } | { ok: false; detail: string }

export class VersioningRevert {
  static allows(entry: FileChangeEntry): boolean {
    return entry.nodeKind === 'file' && entry.previousPath === null
      && (entry.status === 'modified' || entry.status === 'missing' || entry.status === 'deleted')
  }
}

export type VersioningRevertRequest = {
  draftId: string
  snapshotId: string
} & ({ fileIds: readonly string[]; fileId?: never } | { fileId: string; fileIds?: never })

export type VersioningRevertResult = { ok: true; reverted: boolean } | Extract<VersioningCommitRunResult, { ok: false }>
export type VersioningTortoiseResult = { ok: true } | Extract<VersioningCommitRunResult, { ok: false }>

export class VersioningCommitLimits {
  static readonly messageMaxCharactersConst = 16_384
  static readonly targetsMaxConst = 2_000
}

export type VersioningCommitPhase =
  | { kind: 'editing' }
  | { kind: 'cancelled' }
  | { kind: 'running'; startedAt: number; detail?: string; progress?: CommitProgress & {
    stageStartedAt: number; updatedAt: number; groupIndex: number; groupCount: number
  } }
  | { kind: 'done'; revision: string; output: string; finishedAt: number }
  | { kind: 'failed'; detail: string; failedAt: number }

export interface VersioningCommitDraftDto {
  draftId: string
  sessionId: string
  vcs: FileChangesVcsId
  scopeRoot: string
  paths?: readonly string[]
  /**
   * What the pane says on hover. The heading itself is the working copy and one line long, so a
   * restricted selection lists its paths here rather than reprinting nine absolute paths across a
   * heading `white-space: nowrap` then folds into one.
   */
  scopeTooltip: string
  source: FileChangesVcsId
  message: string
  editedByPerson: boolean
  proposedByAgent: boolean
  phase: VersioningCommitPhase
  revision: number
}

export type VersioningCommitOpenResult =
  | { ok: true; value: { draftId: string; scopeRoot: string; title: string; paths?: readonly string[] }; messageApplied: boolean }
  | { ok: false; code: 'unknown-session' | 'no-working-copy' | 'outside-session' | 'store-worktree' | 'remote-session' | 'message-too-long'; detail: string }

export interface VersioningCommitRunRequest {
  draftId: string
  snapshotId: string
  fileIds: readonly string[]
  message: string
  includeExternals?: true
}

export type VersioningCommitRunResult =
  | { ok: true; revision: string }
  | { ok: false; code: 'unknown-draft' | 'busy' | 'stale' | 'no-targets' | 'invalid-target' | 'external-target' | 'message-too-long' | 'vcs-failed'; detail: string; reloadRequired?: true }

export interface VersioningCommitOpenSessions {
  revision: number
  sessionIds: readonly string[]
}
