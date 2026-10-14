import type { SessionRecord } from '../records/sessionRecord.types'
import type { SessionWorkflowInfo } from '../sessionManagerApi.types'
import { GitFinishWorkflow } from './gitFinishWorkflow'
import { SetupWorkflow } from './setupWorkflow'
import { SvnActionWorkflow } from './svnActionWorkflow'

/**
 * The one workflow of a session, by the chain it holds: an SVN action running or waiting, else a Git
 * Finish (its checks and its merge), else the before chain while it runs or failed, else the ended
 * view of its last SVN action until the next press, else none. One composer per kind; this class
 * only picks it.
 */
export class SessionWorkflows {
  static of(record: SessionRecord, runs: (runId: string) => SessionRecord | null): SessionWorkflowInfo | null {
    if (record.svnAction !== undefined) return SvnActionWorkflow.of(record, record.svnAction, runs)
    const git = record.finishChecks === undefined && record.worktreeMerge === undefined ? null : GitFinishWorkflow.of(record, runs)
    if (git !== null) return git
    const before = record.pendingSetup === undefined ? null : SetupWorkflow.of(record, record.pendingSetup, runs)
    if (before !== null) return before
    return record.worktreeOutcome === undefined ? null : SvnActionWorkflow.endedOf(record, record.worktreeOutcome)
  }
}
