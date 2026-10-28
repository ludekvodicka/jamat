export interface RemoteReviewEdit {
  repositoryMessage?: { root: string; message: string }
  messageSource?: 'restored-draft'
  draftId: string
  epoch: string
  expectedRevision: number
  message?: string
  selection?: { snapshotId: string; fileIds: readonly string[] }
}

export type RemoteReviewDecision = {
  draftId: string
  epoch: string
  expectedRevision: number
  operationId: string
} & ({ kind: 'approve'; snapshotId: string; fileIds: readonly string[]; message: string; includeExternals?: true }
  | { kind: 'finish'; snapshotId: string; fileIds: readonly string[]; message: string; workflow: RemoteWorkflowReview }
  | { kind: 'cancel' }
  | { kind: 'revert'; snapshotId: string; fileIds: readonly string[]; confirmed: true }
  | { kind: 'external-review'; snapshotId: string; fileIds: readonly string[]; message: string }
  | { kind: 'external-diff'; snapshotId: string; fileId: string; baselineId: string }
  | { kind: 'split'; snapshotId: string; scopeRoot: string })

export type RemoteReviewRequest =
  | { kind: 'create'; vcs: 'svn' | 'git'; openId: string; scopeRoot?: string }
  | { kind: 'workflow'; vcs: 'svn' | 'git'; scopeRoot: string }
  | { [K in 'open' | 'read' | 'files' | 'release']: { kind: K; reviewId: string } }['open' | 'read' | 'files' | 'release']
  | { kind: 'edit'; edit: RemoteReviewEdit }
  | { kind: 'decide'; decision: RemoteReviewDecision }
  | { kind: 'list' }
export interface RemoteWorkflowReview {
  reviewVersion?: number
  repositories?: import('../worktrees/worktreeState').WorktreeRepositoryReview[]
  acknowledgedFindings?: import('../svn/svnCommitMessageCheck').CommitMessageFinding[]
  workflowId: string
  revision: number
  actionId: 'finish-again'
  agreement: { acknowledgeSetup?: string; confirmWorking?: true; overrideChecks?: true }
}

