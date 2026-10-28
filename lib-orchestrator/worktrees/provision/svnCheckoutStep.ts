import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import type { SessionRecordScriptStep } from '../../sessionManager/worktreeSessionRecords'
import type { SvnStepRunner } from '../svnStepRunner'
import type { LocalBeforeStep } from '../worktreeLifecycle.types'

export class SvnCheckoutStep implements LocalBeforeStep {
  private readonly deps: {
    records: SessionRecordsStore
    svn: Pick<SvnWorktreeManager, 'reservedCheck' | 'status' | 'revisionOf'>
    runner: Pick<SvnStepRunner, 'run'>
    now: () => number
  }

  constructor(deps: SvnCheckoutStep['deps']) {
    this.deps = deps
  }

  accepts(step: SessionRecordScriptStep): boolean { return step.scriptId === 'svn' }

  async run(sessionId: string, recover: boolean): Promise<string> {
    const record = this.deps.records.get(sessionId)
    const gate = record?.pendingSetup
    const worktree = record?.worktree
    const step = gate?.steps?.[gate.cursor ?? 0]
    if (record === null || gate === undefined || worktree === undefined || step?.scriptId !== 'svn' || step.process === undefined)
      throw new Error('Checkout recovery needs its recorded reservation and step')
    const revision = Number(/^r(\d+)$/.exec(worktree.baseCommit)?.[1])
    if (!Number.isSafeInteger(revision)) throw new Error('Checkout has no reserved revision')
    const identity = await this.deps.svn.reservedCheck({ worktreePath: worktree.worktreePath, directoryId: worktree.directoryId, url: worktree.branch })
    if (!identity.ok) throw new Error(identity.detail)
    const old = record.worktreeLifecycle?.journal.filter((entry) => entry.endedAt === undefined && (entry.kind === 'checkout' || entry.stepId.startsWith('checkout-'))) ?? []
    const intent = { stepId: `checkout-${step.key}`, attempt: (record.worktreeLifecycle?.journal.filter((entry) => entry.kind === 'checkout').length ?? 0) + 1,
      targetRevision: revision }
    let runId: string
    if (recover && identity.value.workingCopy) {
      const cleanup = await this.deps.runner.run(sessionId, 'cleanup', worktree.worktreePath, ['cleanup', '--', '.'], { ...intent, stepId: `${intent.stepId}-cleanup` }, { phase: 'before' })
      if (!cleanup.ok) throw new Error(cleanup.output)
      const update = await this.deps.runner.run(sessionId, 'update', worktree.worktreePath, ['update', '-r', String(revision), '--accept', 'postpone', '--', '.'], intent, { phase: 'before' })
      if (!update.ok) throw new Error(update.output)
      runId = update.runId
    } else {
      // A retry re-arms the wait with a fresh id, which the checkout takes; recovery after a crash
      // meets the id of the interrupted run, which already names a history row and a journal entry.
      const used = (record.scriptRuns ?? []).some((run) => run.runId === gate.setupSessionId)
        || (record.worktreeLifecycle?.journal ?? []).some((entry) => entry.runId === gate.setupSessionId)
      const checkout = await this.deps.runner.run(sessionId, 'checkout', worktree.worktreePath, [...step.process.args], intent,
        { runId: used ? undefined : gate.setupSessionId })
      if (!checkout.ok) throw new Error(checkout.output)
      runId = checkout.runId
    }
    const status = await this.deps.svn.status(worktree.worktreePath)
    if (!status.ok) throw new Error(status.detail)
    if (status.value.textConflicts.length > 0 || status.value.otherConflicts.length > 0 || status.value.changed.length > 0)
      throw new Error('The reserved checkout still has conflicts or local changes; setup waits for a clean checkout')
    const base = await this.deps.svn.revisionOf(worktree.worktreePath)
    if (!base.ok) throw new Error(base.detail)
    if (base.value !== revision) throw new Error(`The checkout is at r${base.value}; setup requires reserved r${revision}`)
    if (!await this.deps.records.update(sessionId, (latest) => {
      const state = latest.worktreeLifecycle
      if (state === undefined) return null
      return { ...latest, worktreeLifecycle: { ...state, version: state.version + 1,
        journal: state.journal.map((entry) => old.some((previous) => previous.runId === entry.runId)
          ? { ...entry, endedAt: this.deps.now(), outcome: 'ok' } : entry) } }
    })) throw new Error('The recovered checkout could not be recorded')
    return runId
  }
}
