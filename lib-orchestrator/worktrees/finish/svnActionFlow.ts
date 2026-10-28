import type { SvnStepRunner } from '../svnStepRunner'

import type { SvnConflictResolutions } from '../../svn/svnConflictResolutions'
import { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { FinishScriptsFlow } from '../../sessionManager/worktreeSessionRuntime'
import { ScriptRunLauncher } from '../../sessionManager/worktreeSessionRuntime'
import type { SessionSteps } from '../../sessionManager/worktreeSessionRuntime'
import type { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import type { ScriptLogStore } from '../../sessionManager/worktreeSessionScripts'
import type {
SessionCreateSpec,
SessionsOpResult
} from '../../sessionManager/sessionManagerApi.types'
import { type SvnResolverPort } from '../conflicts/svnResolverLauncher'
import { SvnWorktreeRemoval } from '../removal/svnWorktreeRemoval'
import { type WorktreeResultsPort } from '../results/worktreeResultsStore'
import type { SessionInternalMarks } from '../worktreeLifecycle.types'
import { SvnRevisionLabels } from './svnRevisionLabels'
import type { MainCopyUpdated, WorktreeEnded } from './worktreeFinish.types'

/** The svn reads an action decides its next stage with, named so a test can hand it a scripted set. */
export type SvnActionPort = Pick<SvnWorktreeManager,
  | 'landingPaths' | 'landingProof' | 'saveLocalPaths' | 'present' | 'updateTargets' | 'assembly'
  | 'ownerCheck' | 'scheduleMissing' | 'headRevisionOf' | 'revisionOf' | 'status' | 'changes' | 'resolveWorking' | 'incoming' | 'locked'
  | 'publicationRows' | 'publicationHashes' | 'advancePublished' | 'logSince' | 'prepareCommit' | 'unprepareCommit' | 'revertSetup' | 'commitHashes' | 'reviewRoots' | 'fingerprint' | 'lowerBounds' | 'conflictSet' | 'logOf' | 'hashes' | 'baseAbove'>

/** What `SessionManager` hands the lifecycle for its SVN actions. */
export interface SvnActionPorts {
  runner: Pick<SvnStepRunner, 'run'>
  logs: Pick<ScriptLogStore, 'writeCommitFiles' | 'read' | 'write'>
  svn: SvnActionPort
  labels: Pick<SvnRevisionLabels, 'ownCommits' | 'afterReview' | 'inferred'>
  removal: Pick<SvnWorktreeRemoval, 'remove'>
  resolver: SvnResolverPort
  /** The option executor that settles a conflicted path at Check again. */
  resolutions: Pick<SvnConflictResolutions, 'apply' | 'recoverLocked'>
  /** Where every ending writes its durable result, and where the saved copies of its conflicts go. */
  results: WorktreeResultsPort
  ended: WorktreeEnded
  /**
   * A committed ending left a landed row, or an UPDATE ended: the main copy is read again at once,
   * whether it holds what its landed rows wait for, and how far behind HEAD it is.
   */
  landedDue: (mainCopy: string) => void
  /** An UPDATE recorded on a landed row; optional: the tests and smokes tell nobody. */
  mainCopyUpdated?: (update: MainCopyUpdated) => void
  /**
   * A committed Finish used the worker's commit message proposals for the roots it reviewed, so they
   * go; Keep, a Finish that committed nothing and Discard leave them.
   */
  proposalsSpent: (sessionId: string, scopeRoots: readonly string[]) => void
  proposalOf?: (sessionId: string, scopeRoot: string) => string | null
  /** Runs a client stage off the caller: it reads svn, and the reconcile loop must not wait for it. */
  detach: (work: Promise<unknown>, what: string) => void
  /** The record moved outside an operation, so the snapshot is composed again. */
  changed: () => void
  /** What this client does for the session now, one step before each client read. */
  steps: Pick<SessionSteps, 'at' | 'clear'>
}

export interface SvnActionFlowDeps extends SvnActionPorts {
  records: SessionRecordsStore
  runs: Pick<ScriptRunLauncher, 'launch'>
  /** The resolver and the merger are agent sessions, created as the merge resolver is: the create writes their record. */
  createResolver: (spec: SessionCreateSpec, marks: SessionInternalMarks) => Promise<SessionsOpResult<{ sessionId: string }>>
  stopRun: (runId: string, manuallyStopped?: boolean) => Promise<boolean>
  /** The Host's words for the last refused stop of a run; optional: tests and smokes may not say. */
  stopRefusal?: (runId: string) => string | undefined
  checks: Pick<FinishScriptsFlow, 'declaredAfter'>
  stop: (sessionId: string) => Promise<SessionsOpResult>
  report: (message: string) => void
  newId: () => string
  now: () => number
}
