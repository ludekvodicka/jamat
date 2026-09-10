import type { FileChangesVcsId } from '../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'

export type VersioningExternalDiffResult = { ok: true } | { ok: false; detail: string }

export class VersioningCommitLimits {
  static readonly messageMaxCharactersConst = 16_384
  static readonly targetsMaxConst = 2_000
}

export type VersioningCommitPhase =
  | { kind: 'editing' }
  | { kind: 'running'; startedAt: number }
  | { kind: 'done'; revision: string; output: string; finishedAt: number }
  | { kind: 'failed'; detail: string; failedAt: number }

export interface VersioningCommitDraftDto {
  draftId: string
  sessionId: string
  vcs: FileChangesVcsId
  scopeRoot: string
  scopeDisplay: string
  source: FileChangesVcsId
  message: string
  editedByPerson: boolean
  proposedByAgent: boolean
  phase: VersioningCommitPhase
  revision: number
}

export type VersioningCommitOpenResult =
  | { ok: true; value: { draftId: string; scopeRoot: string; title: string }; messageApplied: boolean }
  | { ok: false; code: 'unknown-session' | 'no-working-copy' | 'outside-session' | 'store-worktree' | 'remote-session' | 'message-too-long'; detail: string }

export interface VersioningCommitRunRequest {
  draftId: string
  snapshotId: string
  fileIds: readonly string[]
  message: string
}

export type VersioningCommitRunResult =
  | { ok: true; revision: string }
  | { ok: false; code: 'unknown-draft' | 'busy' | 'stale' | 'no-targets' | 'invalid-target' | 'external-target' | 'message-too-long' | 'vcs-failed'; detail: string }

export interface VersioningCommitOpenSessions {
  revision: number
  sessionIds: readonly string[]
}
