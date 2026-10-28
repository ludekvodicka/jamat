import { relative } from 'node:path'
import { PathCompare } from '../../shared/pathCompare'
import { SvnFailures } from '../../svn/svnFailures'
import { ErrorText } from '../../shared/errorText'
import type { SessionRecordSvnAction } from '../../sessionManager/worktreeSessionRecords'
import { SvnWorktreeRemoval } from '../removal/svnWorktreeRemoval'
import type { SvnStepJournalEntry } from '../worktreeState'
import { WorktreeRecovery } from '../worktreeRecovery'
import type { CommitStep } from './commitStep'
import type { VerifyStep } from './verifyStep'
import { SvnRevisionLabels } from './svnRevisionLabels'
import type { FinishDriverDeps } from './finishDriver.types'
import type { FinishCompletion } from './finishCompletion'
import { FinishState } from './finishState'
import type { PreparationStep } from './preparationStep'

export class PublicationStep {
  private readonly deps: Pick<FinishDriverDeps, 'busyReason' | 'changed' | 'commands' | 'holdInput' | 'landedDue' | 'liveness' | 'logs' | 'now' | 'records' | 'report' | 'steps' | 'svn'>
  private readonly state: Pick<FinishState, 'action' | 'wait' | 'retainAttempt' | 'write'>
  private readonly completion: Pick<FinishCompletion, 'recordResult'>
  private readonly commit: Pick<CommitStep, 'publish' | 'receipt'>
  private readonly verify: Pick<VerifyStep, 'advance' | 'run'>
  private readonly recover: (sessionId: string, entry: SvnStepJournalEntry) => Promise<boolean>
  private readonly preparation: Pick<PreparationStep, 'refuseStale' | 'advanceReceipt'>

  constructor(deps: PublicationStep['deps'], state: PublicationStep['state'], completion: PublicationStep['completion'], commit: PublicationStep['commit'], verify: PublicationStep['verify'], recover: PublicationStep['recover'], preparation: PublicationStep['preparation']) {
    this.deps = deps
    this.state = state
    this.completion = completion
    this.commit = commit
    this.verify = verify
    this.recover = recover
    this.preparation = preparation
  }

  async publish(sessionId: string): Promise<boolean> {
    const action = this.state.action(sessionId)
    const state = this.deps.records.get(sessionId)!.worktreeLifecycle!
    if (action.runId !== undefined && !state.journal.some((entry) => entry.runId === action.runId))
      return this.migratedCommit(sessionId, action)
    const pending = WorktreeRecovery.pending(this.deps.records.get(sessionId)!).find((entry) => entry.kind === 'commit')
    if (pending !== undefined) return this.recover(sessionId, pending)
    if (await this.preparation.refuseStale(sessionId) !== null) return false
    const record = this.deps.records.get(sessionId)!
    const owner = await this.deps.svn.ownerCheck(SvnWorktreeRemoval.locationOf(record.worktree!))
    if (!owner.ok) { await this.state.wait(sessionId, 'svn-failed', owner.detail); return false }
    const publication = await this.commit.publish(sessionId, action, this.deps)
    const attempt = [...this.deps.records.get(sessionId)!.worktreeLifecycle!.journal].reverse().find((entry) => entry.kind === 'commit' && entry.stepId === `${state.actionId}-commit-${action.roots?.[action.rootCursor].own || '.'}`)
    if (attempt !== undefined) await this.state.retainAttempt(sessionId, { runId: attempt.runId, title: 'svn commit' })
    switch (publication.kind) {
      case 'waiting': case 'review': case 'repository-busy': return false
      case 'syncing': return true
      case 'completed': {
        const result = publication.result
        await this.state.write(sessionId, (current) => ({ ...current, execution: { ...current.execution!, runId: result.runId } }))
        if (!result.ok) { await this.state.wait(sessionId, (state.execution?.evidence.length ?? 0) > 0 ? 'partially-landed' : result.failure === 'auth' ? 'auth' : 'svn-failed', result.output); return false }
        const root = action.roots![action.rootCursor]
        let revision = this.deps.records.get(sessionId)?.worktreeLifecycle?.journal.find((entry) => entry.runId === result.runId)?.revision ?? SvnFailures.revisionOf(result.output)
        if (revision === null || revision === undefined) {
          const info = await this.deps.svn.revisionOf(root.selection![0])
          if (!info.ok || info.value <= root.bounds!.since) throw new Error('The commit returned no proven revision')
          revision = info.value
        }
        await this.commit.receipt(sessionId, root.path, revision, root.selection!.map((path) => relative(root.path, path).replace(/\\/g, '/') || '.'))
        await this.state.write(sessionId, (current) => ({ ...current,
          journal: current.journal.map((entry) => entry.runId === result.runId ? { ...entry, revision } : entry),
          execution: { ...current.execution!, evidence: SvnRevisionLabels.merged(current.execution!.evidence,
          [{ repository: root.bounds!.repository, revision, label: 'receipt', paths: attempt?.paths ?? root.selection!.map((path) => FinishState.repositoryPath(root.bounds!.base, relative(root.path, path).replace(/\\/g, '/'))) }]) } }))
        await this.deps.liveness(sessionId, 'committing')
        return true
      }
      default: throw new Error(`Unknown publication: ${JSON.stringify(publication satisfies never)}`)
    }
  }

  async migratedCommit(sessionId: string, action: SessionRecordSvnAction): Promise<boolean> {
    if (action.verdict === undefined) return false
    await this.state.retainAttempt(sessionId, { runId: action.runId!, title: 'Migrated svn commit' })
    const output = (await this.deps.logs.read(sessionId, action.runId!, 1024 * 1024))?.text
    if (output === undefined) { await this.state.wait(sessionId, 'svn-failed', 'The migrated commit log is unavailable; inspect the repository before retrying'); return false }
    if (action.verdict.kind === 'failed') {
      const failure = SvnFailures.classify(output, action.verdict.exitCode ?? null)
      if (failure !== 'out-of-date') { await this.state.wait(sessionId, failure === 'auth' ? 'auth' : 'svn-failed', output); return false }
      const attempts = this.deps.records.get(sessionId)!.worktreeLifecycle!.outOfDate + 1
      await this.state.write(sessionId, (state) => ({ ...state, outOfDate: attempts, phase: 'waiting',
        step: 'syncing', approvedAt: undefined, preparation: undefined, checks: undefined,
        wait: { kind: 'repository-busy', at: this.deps.now(), reason: 'Repository changed; prepare, test and confirm again' },
        execution: { ...state.execution!, runId: undefined, verdict: undefined, commit: undefined, checkCursor: 0, checkBefore: undefined } }))
      return false
    }
    const root = action.roots?.[action.rootCursor]
    const revision = SvnFailures.revisionOf(output)
    if (revision === null || root?.bounds === undefined || root.selection === undefined || action.commit === undefined) {
      await this.state.wait(sessionId, 'published-with-differences', 'The migrated commit has incomplete publication evidence; inspect its retained log and repository before continuing')
      return false
    }
    await this.commit.receipt(sessionId, root.path, revision, root.selection.map((path) => relative(root.path, path).replace(/\\/g, '/') || '.'))
    await this.state.write(sessionId, (state) => ({ ...state, phase: 'finishing', step: 'verifying', wait: undefined,
      execution: { ...state.execution!, verdict: undefined, evidence: SvnRevisionLabels.merged(state.execution!.evidence,
        [{ repository: root.bounds!.repository, revision, label: 'receipt', paths: root.selection!.map((path) => FinishState.repositoryPath(root.bounds!.base, relative(root.path, path).replace(/\\/g, '/'))) }]) } }))
    return true
  }

  async verifyPublication(sessionId: string): Promise<void> {
    const record = this.deps.records.get(sessionId)!
    const state = record.worktreeLifecycle!
    const action = this.state.action(sessionId)
    const root = action.roots?.[action.rootCursor]
    if (root === undefined || state.review === undefined) throw new Error('Verification needs the approved repository and content')
    const receipt = [...record.commitReceipts ?? []].reverse().find((row) => PathCompare.comparable(row.scopeRoot) === PathCompare.comparable(root.path))
    if (receipt === undefined || receipt.revision === null) throw new Error('Verification needs a publication receipt')
    const selection = root.selection!.map((path) => relative(root.path, path).replace(/\\/g, '/') || '.')
    const hashes = Object.fromEntries(root.selection!.map((path, index) => [selection[index], state.review!.hashes[relative(action.root, path).replace(/\\/g, '/') || '.']]))
    const deletions = root.selection!.filter((path) => state.review!.deletions?.includes(relative(action.root, path).replace(/\\/g, '/') || '.'))
      .map((path) => relative(root.path, path).replace(/\\/g, '/') || '.')
    const more = action.rootCursor + 1 < action.roots!.length
    const review = { ...state.review, selection, hashes, deletions }
    this.deps.steps.at(sessionId, { kind: 'publication', revision: receipt.revision })
    let verified: Awaited<ReturnType<VerifyStep['run']>>
    // A root stays in `verifying` until the cursor moves past it, so a failure before that verifies it again.
    try {
      // Verification proves the selected nodes itself, so what a killed commit left on them does not stop it.
      await this.deps.commands.acceptInterrupted(root.path, root.selection!)
      await this.verify.advance(root.path, receipt.revision, review)
      verified = await this.verify.run(sessionId, root.path, receipt.revision, review, more ? 'verifying' : 'disposing')
    }
    finally { if (this.deps.steps.clear(sessionId)) this.deps.changed() }
    if (!verified.verified) return
    if (more && await this.preparation.advanceReceipt(sessionId, root.path, selection))
      await this.state.write(sessionId, (current) => ({ ...current, step: 'awaiting-idle', execution: { ...current.execution!, rootCursor: action.rootCursor + 1, runId: undefined } }))
    this.deps.landedDue(record.worktree!.repositoryRoot)
    try { await this.completion.recordResult(sessionId, undefined, true) }
    catch (error) { this.deps.report(`The interim worktree result was not saved: ${ErrorText.of(error)}`) }
  }

  async verifyCurrent(sessionId: string): Promise<boolean> {
    const pending = WorktreeRecovery.pending(this.deps.records.get(sessionId)!).find((entry) => entry.kind === 'commit')
    if (pending !== undefined && !await this.recover(sessionId, pending)) return false
    await this.verifyPublication(sessionId)
    await this.deps.liveness(sessionId, 'verifying')
    return true
  }
}
