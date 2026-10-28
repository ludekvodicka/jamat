import type { CommitMessageFinding, CommitMessageSource } from '../svn/svnCommitMessageCheck'
import type { SvnFailureClass } from '../svn/svnFailures'
import type { SessionRecordConflictMemory, SvnActionConflictSet, WorkerHandoff } from './worktreeContracts'
import type { WorktreeExecution } from './worktreeExecution'
import type { WorktreeRemovalPermit } from './removal/worktreeRemovalPermit'

export type WorktreePhase = 'active' | 'finishing' | 'waiting' | 'landed' | 'kept' | 'removed'
export type FinishStep = 'syncing' | 'worker-resolving' | 'checking' | 'reviewing' | 'awaiting-idle'
  | 'committing' | 'verifying' | 'disposing' | 'stopping-worker' | 'removing' | 'recording'
export type WorktreeWaitKind = 'review' | 'waiting-for-review' | 'conflict-person' | 'checks-failed'
  | 'repository-busy' | 'published-with-differences' | 'worker-lost' | 'changed-outside' | 'removal-blocked'
  | 'host-unhealthy' | 'svn-failed' | 'locked' | 'auth' | 'pinned-external' | 'partially-landed' | 'never-started'
  | 'worker-busy'
export type WorktreeActor = 'person' | 'remote-person' | 'worker' | 'agent' | 'jamat'
export type SvnStepKind = 'checkout' | 'update' | 'cleanup' | 'status' | 'diff' | 'commit' | 'revert' | 'resolve'

export class WorkerResumePolicy {
  static onDeath(step: FinishStep | undefined): 'resume-and-redeliver' | 'resume-quiet' | 'resume-after-step' | 'none' {
    switch (step) {
      case undefined: case 'syncing': case 'checking': case 'worker-resolving': return 'resume-and-redeliver'
      case 'reviewing': case 'awaiting-idle': return 'resume-quiet'
      case 'committing': case 'verifying': case 'disposing': return 'resume-after-step'
      case 'stopping-worker': case 'removing': case 'recording': return 'none'
      default: throw new Error(`Unknown finish step: ${JSON.stringify(step satisfies never)}`)
    }
  }
}

export interface WorktreeRepositoryReview {
  root: string
  repository: string
  repositoryName: string
  expectedPrefix: string
  paths: string[]
  message: string
  source: CommitMessageSource
  acknowledged: CommitMessageFinding[]
}

export interface WorktreeReviewSnapshot {
  repositories?: WorktreeRepositoryReview[]
  version: number
  selection: string[]
  hashes: Record<string, string>
  message: string
  source: CommitMessageSource
  acknowledged: CommitMessageFinding[]
  headMovedBy: number
  deletions?: string[]
}

export interface SvnStepJournalEntry {
  stepId: string
  kind: SvnStepKind
  attempt: number
  baseRevision?: number
  cwd?: string
  args?: string[]
  targetRevision?: number
  preparedAdds?: string[]
  paths?: string[]
  messageHash?: string
  /** The message a commit was sent with, so the durable result keeps what each repository received. */
  message?: string
  author?: string
  revision?: number
  startedAt: number
  endedAt?: number
  recovered?: 'not-landed'
  /** An interrupted commit that several revisions may hold: none is proven ours, so it stays open for a person to inspect. */
  uncertain?: { repository: string; revisions: number[] }
  output?: string
  logPath?: string
  outcome?: 'ok' | SvnFailureClass
  runId: string
}

export interface WorktreeLifecycle {
  publication?: import('./worktreePublication').WorktreePublicationFacts
  legacyCommit?: true
  unreadable?: string
    preparation?: { format: 1; manifest: string; content: string; metadata: string; commands: string; environment?: string;
    checks: 'pending' | 'passed' | 'none' | 'overridden'; checkedAt?: number; attempt: number }
  preparationIntent?: { root: string; paths: string[]; at: number }
    preparationAdds?: { root: string; paths: string[] }[]
    environment?: { inputs: string; commands?: string; checksPolicy?: string; at: number; source: 'setup' | 'person'; pending?: true; paths: string[]
      inputHashes?: Record<string, string> }
  update?: import('./worktreeContracts').WorktreeUpdateState
  updateFailure?: string
  execution?: WorktreeExecution
  version: number
  actionId: string | null
  phase: WorktreePhase
  step?: FinishStep
  wait?: { kind: WorktreeWaitKind; reason: string; at: number }
  outOfDate: number
  corrective?: true
  stoppedFailure?: string
  retryFrom?: number
  review?: WorktreeReviewSnapshot
  approvedAt?: number
  awaitingIdleAt?: number
  /** Why the worker did not count as idle at the last look before publication. */
  awaitingIdleReason?: string
  /** The `approvedAt` of the approval the person confirmed to publish under a busy worker. */
  busyConfirmedFor?: number
  incoming?: Array<{ revision: number; author: string | null }>
  /** Repository paths a refused publication found changed upstream; Recheck keeps them until an update completes. */
  knownIncoming?: { paths: string[]; at: number }
  handoff?: WorkerHandoff
  workerNotice?: WorkerHandoff
  checks?: { passed: boolean; logPath: string; at: number; overridden: boolean; configured?: boolean }
  checkBaseline?: Record<string, string>
  verified?: Array<{ root: string; revision: number; repository?: string; base?: string; paths: string[]; at: number }>
  differences?: string[]
  conflictProgress?: { generation?: string; owner: 'worker' | 'merger'; settled: number; observedAt: number; idle: boolean; milliseconds: number }
  ownerSince?: number
  journal: SvnStepJournalEntry[]
  owner?: WorktreeActor
  purpose?: 'finish' | 'discard'
  hasWindow?: boolean
  removalPermit?: WorktreeRemovalPermit
  syncConflictSet?: SvnActionConflictSet
  syncJournals?: Record<string, import('../svn/svn.types').SvnConflictJournal>
  conflictMemory?: SessionRecordConflictMemory
  facts: {
    worker: { liveness: 'alive' | 'dead' | 'stopped'; resumeFailures: number; ready?: { at: number; hashes: Record<string, string> };
      diedAt?: number; diedDuring?: FinishStep; deathReason?: string; resumedAt?: number;
      resumeMode?: 'resume-and-redeliver' | 'resume-quiet' | 'resume-after-step' }
    syncedAt?: { revision: number; at: number; headMovedBy?: number }
    fingerprint?: string
  }
}

export type WorktreeEvent =
  | { kind: 'finish'; actionId: string; at: number; ready: boolean; confirmed?: boolean; hasWindow: boolean }
  | { kind: 'ready'; at: number; hashes: Record<string, string> }
  | { kind: 'synced'; at: number; revision: number; conflicts: number }
  | { kind: 'resolved' }
  | { kind: 'checks-passed'; review: WorktreeReviewSnapshot }
  | { kind: 'review-opened' }
  | { kind: 'approve'; reviewVersion: number }
  | { kind: 'correct'; brief: string }
  | { kind: 'idle' }
  | { kind: 'confirm-busy' }
  | { kind: 'committed' }
  | { kind: 'out-of-date'; at: number }
  | { kind: 'verified' }
  | { kind: 'disposed'; permit: WorktreeRemovalPermit }
  | { kind: 'worker-stopped' }
  | { kind: 'removed' }
  | { kind: 'recorded' }
  | { kind: 'keep'; dirty: boolean }
  | { kind: 'discard'; dirty: boolean; permit: WorktreeRemovalPermit }
  | { kind: 'wait'; wait: NonNullable<WorktreeLifecycle['wait']> }
  | { kind: 'retry' }
  | { kind: 'back-to-work' }
  | { kind: 'worker-died'; at: number }
  | { kind: 'worker-resumed'; at: number }
  | { kind: 'resume-failed'; at: number }

export type WorktreeEffect =
  | { kind: 'svn'; step: SvnStepKind }
  | { kind: 'deliver-worker'; brief: string }
  | { kind: 'run-checks' }
  | { kind: 'stop-worker' }
  | { kind: 'resume-worker' }
  | { kind: 'remove'; permit: WorktreeRemovalPermit }
  | { kind: 'notify'; text: string }
  | { kind: 'write-result' }
