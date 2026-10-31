import type { CommitMessageSource, CommitMessageFindingInfo } from '../../lib-orchestrator/svn/svnCommitMessageCheck'
import type { FileChangeEntry, FileChangesVcsId, FileChangesWorkingTreeSnapshot, FileChangesWorkingTreeSnapshotResult } from '../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { RemoteControlCommitPath } from '../../lib-orchestrator/remoteControl/remoteControlApi.types'
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

/** A requested review target: a literal path, or a directory with the depth of its selection. */
export type VersioningCommitPath = RemoteControlCommitPath

export class VersioningCommitPaths {
  /** Exact keys, so a misspelled `depth` never falls back to a whole subtree. */
  static valid(value: unknown): value is VersioningCommitPath {
    if (typeof value === 'string') return VersioningCommitPaths.literal(value)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const keys = Object.keys(value).sort()
    const target = value as Record<string, unknown>
    return keys.length === 2 && keys[0] === 'depth' && keys[1] === 'path'
      && (target.depth === 'empty' || target.depth === 'infinity')
      && typeof target.path === 'string' && VersioningCommitPaths.literal(target.path)
  }

  static pathOf(value: VersioningCommitPath): string {
    return typeof value === 'string' ? value : value.path
  }

  /** Whether the target names a directory's own node and nothing below it. */
  static nodeOnly(value: VersioningCommitPath): boolean {
    if (typeof value === 'string') return false
    else if (value.depth === 'empty') return true
    else if (value.depth === 'infinity') return false
    else throw new Error(`Unknown commit path depth: ${JSON.stringify(value.depth satisfies never)}`)
  }

  private static literal(path: string): boolean {
    return path.trim().length > 0 && !/[\0\r\n]/.test(path)
  }
}

/**
 * The commit pane's file list. `checkedPaths` is set when the review names its targets: only those
 * rows start checked, and the other work below a node-only folder is shown unchecked. Without it
 * every eligible row starts checked, as in a plain directory review.
 */
export type VersioningCommitFilesResult =
  | { ok: true; value: FileChangesWorkingTreeSnapshot; checkedPaths?: readonly string[] }
  | Extract<FileChangesWorkingTreeSnapshotResult, { ok: false }>

/**
 * SVN normalizes a log message to LF and REFUSES one that mixes styles: `E135000: Inconsistent line
 * ending style`, raised after the person has already approved the review and the files are staged.
 * A message an agent wrote into a `--message-file` on Windows arrives with CRLF, and the newline
 * the commit appends when the text lacks one is a bare LF, which is all it takes to mix them. The
 * message therefore becomes LF wherever it enters, not only in the file write that happens to break.
 */
export class VersioningCommitMessage {
  static normalize(message: string): string { return message.replace(/\r\n?/g, '\n') }
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
  workflow?: { workflowId: string; acceptedAt: number; lockRoots?: readonly string[] }
  draftId: string
  epoch?: string
  externalReview?: 'running' | 'closed'
  externalDiffAvailable?: boolean
  published?: { scopeRoot: string; revision: string; paths?: readonly string[]; omittedPaths?: readonly string[] }[]
  selection?: { paths: readonly string[]; snapshotId: string }
  sessionId: string
  vcs: FileChangesVcsId
  scopeRoot: string
  paths?: readonly VersioningCommitPath[]
  /**
   * What the pane says on hover. The heading itself is the working copy and one line long, so a
   * restricted selection lists its paths here rather than reprinting nine absolute paths across a
   * heading `white-space: nowrap` then folds into one.
   */
  scopeTooltip: string
  source: FileChangesVcsId
  message: string
  messageSource?: CommitMessageSource
  messageAt?: number
  messageFindings?: CommitMessageFindingInfo[]
  repositories?: Array<import('../../lib-orchestrator/worktrees/worktreeState').WorktreeRepositoryReview & { findings?: CommitMessageFindingInfo[] }>
  editedByPerson: boolean
  proposedByAgent: boolean
  phase: VersioningCommitPhase
  revision: number
}

export class VersioningCommitReceipts {
  static unresolved(draft: Pick<VersioningCommitDraftDto, 'published'> | null): NonNullable<VersioningCommitDraftDto['published']> {
    const receipts = draft?.published ?? []
    return receipts.flatMap((receipt, index) => {
      const later = new Set(receipts.slice(index + 1).flatMap((next) => next.paths ?? []).map((path) => path.replaceAll('\\', '/')))
      const omittedPaths = receipt.omittedPaths?.filter((path) => !later.has(path.replaceAll('\\', '/'))) ?? []
      return omittedPaths.length > 0 ? [{ ...receipt, omittedPaths }] : []
    })
  }

  /** Old peers reject new receipt keys and auto-close a done phase, hiding a partial result. */
  static forLegacyPeer(draft: VersioningCommitDraftDto): VersioningCommitDraftDto {
    if (!draft.published?.some((receipt) => receipt.omittedPaths !== undefined)) return draft
    const unresolved = VersioningCommitReceipts.unresolved(draft)
    const phase = draft.phase.kind === 'done' && unresolved.length > 0
      ? { kind: 'failed' as const, failedAt: draft.phase.finishedAt,
        detail: `Published ${draft.phase.revision}. SVN did not report these selected paths:\n${unresolved.flatMap((receipt) => receipt.omittedPaths ?? []).join('\n')}\nInspect the revision and remaining changes. Do not repeat the published commit.` }
      : draft.phase
    return { ...draft, phase, published: draft.published.map(({ omittedPaths: _omitted, ...receipt }) => receipt) }
  }
}

export type VersioningCommitOpenResult =
  | { ok: true; value: { draftId: string; scopeRoot: string; title: string; paths?: readonly VersioningCommitPath[] }; messageApplied: boolean }
  | { ok: false; code: 'use-finish' | 'unknown-session' | 'no-working-copy' | 'outside-session' | 'remote-session' | 'message-too-long'; detail: string }

export interface VersioningCommitRunRequest {
  draftId: string
  snapshotId: string
  fileIds: readonly string[]
  message: string
  includeExternals?: true
  expectedRevision?: number
  epoch?: string
}

export type { RemoteReviewEdit as VersioningReviewEdit, RemoteReviewDecision as VersioningReviewDecision } from '../../lib-orchestrator/remoteControl/remoteReviewApi.types'

export type VersioningReviewEditResult =
  | { ok: true; value: VersioningCommitDraftDto }
  | { ok: false; code: 'stale' | 'busy' | 'invalid-target' | 'unknown-draft'; detail: string; current?: VersioningCommitDraftDto }

export type VersioningCommitRunResult =
  | { ok: true; revision: string; reviewId?: string }
  | { ok: false; code: 'use-finish' | 'unknown-draft' | 'busy' | 'stale' | 'no-targets' | 'invalid-target' | 'external-target' | 'message-too-long' | 'vcs-failed' | 'forbidden' | 'conflict' | 'uncertain'; detail: string; reloadRequired?: true;
      setup?: import('../../lib-orchestrator/sessionManager/sessionManagerApi.types').SessionSetupAgreement; working?: true }

export interface VersioningCommitOpenSessions {
  revision: number
  sessionIds: readonly string[]
  reviews?: readonly (Pick<VersioningCommitDraftDto, 'draftId' | 'sessionId' | 'vcs' | 'scopeRoot' | 'paths'> & { workflow: boolean })[]
}
import type { RemoteWorkflowReview } from '../../lib-orchestrator/remoteControl/remoteReviewApi.types'

export type VersioningWorkflowState =
  | { kind: 'running' }
  | { kind: 'waiting'; detail: string }
  | { kind: 'uncertain'; detail: string }
  /** A later Finish of the same worktree took over; the approval holds no publication of its own any more. */
  | { kind: 'replaced'; detail: string }
  | { kind: 'done'; revision: string; output: string }

export interface VersioningWorkflowPort {
  repositories?(draft: VersioningCommitDraftDto): VersioningCommitDraftDto['repositories']
  /** Each repository row is its own field, and the draft's own message is hidden and publishes nothing. */
  separateMessages?(draft: VersioningCommitDraftDto): boolean
  /**
   * The Finish the draft is bound to (`draft.workflow`) is gone from the sessions this client has read:
   * neither its session nor that action is there any more, so its review can never settle further.
   */
  abandoned?(draft: VersioningCommitDraftDto): boolean
  messageSource?(draft: VersioningCommitDraftDto): CommitMessageSource | undefined
  offers(sessionId: string, vcs: 'svn' | 'git', scope: string): boolean
  /** The session commits only through its Finish: an SVN worktree, or its landed row. */
  owns?(sessionId: string): boolean
  check(draft: VersioningCommitDraftDto, request: RemoteWorkflowReview): string | null
  start(draft: VersioningCommitDraftDto, request: RemoteWorkflowReview, selection: string[], reviewed: Record<string, string>): Promise<VersioningCommitRunResult>
  state(draft: VersioningCommitDraftDto): VersioningWorkflowState
  /** The refusal of an approval whose files changed after the person read them, naming those files. */
  changed(paths: readonly string[]): string
}
