import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import { SvnWorktreeSeed } from '../../svn/svnWorktreeSeed'
import type { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import type { SessionRecordScriptStep, SessionRecordWorktree } from '../../sessionManager/worktreeSessionRecords'
import type { SvnStepIntent, SvnStepRunner } from '../svnStepRunner'
import type { LocalBeforeStep } from '../worktreeLifecycle.types'

/**
 * The first step of an SVN worktree's before chain: the working copy of the reserved folder at the
 * reserved revision, as a copy of the owner's seed when one serves and as a plain checkout otherwise
 * (`docs/architecture/svn-worktrees.md`, **Seed copy**). Either way the same proof ends it.
 */
export class SvnCheckoutStep implements LocalBeforeStep {
  private readonly deps: {
    records: SessionRecordsStore
    svn: Pick<SvnWorktreeManager, 'reservedCheck' | 'status' | 'revisionOf' | 'purgeReserved'>
    seed: Pick<SvnWorktreeSeed, 'interrupted' | 'copyInto' | 'proof' | 'adopt' | 'refreshLater'>
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
    // A seed copy that never finished holds files and maybe half a `.svn`, none of it a checkout, so
    // it goes before anything reads it as a working copy.
    if (await this.deps.seed.interrupted(worktree.worktreePath)) await this.purge(worktree, 'a seed copy that never finished')
    const identity = await this.deps.svn.reservedCheck({ worktreePath: worktree.worktreePath, directoryId: worktree.directoryId, url: worktree.branch })
    if (!identity.ok) throw new Error(identity.detail)
    const old = record.worktreeLifecycle?.journal.filter((entry) => entry.endedAt === undefined && (entry.kind === 'checkout' || entry.stepId.startsWith('checkout-'))) ?? []
    const intent = { stepId: `checkout-${step.key}`, attempt: (record.worktreeLifecycle?.journal.filter((entry) => entry.kind === 'checkout').length ?? 0) + 1,
      targetRevision: revision }
    let runId: string
    let adopt = false
    if (recover && identity.value.workingCopy) {
      const cleanup = await this.deps.runner.run(sessionId, 'cleanup', worktree.worktreePath, ['cleanup', '--', '.'], { ...intent, stepId: `${intent.stepId}-cleanup` }, { phase: 'before' })
      if (!cleanup.ok) throw new Error(cleanup.output)
      const update = await this.deps.runner.run(sessionId, 'update', worktree.worktreePath, ['update', '-r', String(revision), '--accept', 'postpone', '--', '.'], intent, { phase: 'before' })
      if (!update.ok) throw new Error(update.output)
      runId = update.runId
    } else {
      const seeded = await this.seeded(sessionId, worktree, intent, revision)
      if (seeded.ok) runId = seeded.runId
      else {
        const started = this.deps.now()
        const checkout = await this.deps.runner.run(sessionId, 'checkout', worktree.worktreePath, [...step.process.args], intent,
          { runId: this.waitRunId(sessionId), preface: `Plain checkout; the seed was not used: ${seeded.reason}\n` })
        if (!checkout.ok) throw new Error(checkout.output)
        runId = checkout.runId
        adopt = this.deps.now() - started >= SvnWorktreeSeed.adoptMillisecondsConst
      }
    }
    const status = await this.deps.svn.status(worktree.worktreePath)
    if (!status.ok) throw new Error(status.detail)
    if (status.value.textConflicts.length > 0 || status.value.otherConflicts.length > 0 || status.value.changed.length > 0)
      throw new Error('The reserved checkout still has conflicts or local changes; setup waits for a clean checkout')
    const base = await this.deps.svn.revisionOf(worktree.worktreePath)
    if (!base.ok) throw new Error(base.detail)
    if (base.value !== revision) throw new Error(`The checkout is at r${base.value}; setup requires reserved r${revision}`)
    // Before setup writes into it: a slow plain checkout becomes the owner's seed. Without a seed the
    // next create checks out again, so a failure here costs time and never this create.
    if (adopt) await this.deps.seed.adopt({ ownerDir: worktree.repositoryRoot, worktreePath: worktree.worktreePath, revision })
    if (!await this.deps.records.update(sessionId, (latest) => {
      const state = latest.worktreeLifecycle
      if (state === undefined) return null
      return { ...latest, worktreeLifecycle: { ...state, version: state.version + 1,
        journal: state.journal.map((entry) => old.some((previous) => previous.runId === entry.runId)
          ? { ...entry, endedAt: this.deps.now(), outcome: 'ok' } : entry) } }
    })) throw new Error('The recovered checkout could not be recorded')
    return runId
  }

  /**
   * The reserved folder as a copy of the owner's seed, updated to the reserved revision by a
   * journaled update and proven like a plain checkout. Any failure empties the folder again and
   * names the reason, so the plain checkout runs in its place.
   */
  private async seeded(sessionId: string, worktree: SessionRecordWorktree, intent: SvnStepIntent, revision: number)
    : Promise<{ ok: true; runId: string } | { ok: false; reason: string }> {
    const copy = await this.deps.seed.copyInto({ ownerDir: worktree.repositoryRoot, worktreePath: worktree.worktreePath, url: worktree.branch })
    if (!copy.ok) {
      if (copy.code !== 'refused') await this.purge(worktree, 'a failed seed copy')
      return { ok: false, reason: copy.detail }
    }
    const { seed, revision: seedRevision, milliseconds } = copy.value
    const update = await this.deps.runner.run(sessionId, 'update', worktree.worktreePath, ['update', '-r', String(revision), '--accept', 'postpone', '--', '.'],
      intent, { phase: 'before', title: 'Checkout from the seed', runId: this.waitRunId(sessionId),
        preface: `Copied the seed ${seed} at r${seedRevision} in ${(milliseconds / 1000).toFixed(1)} s; updating it to r${revision}.\n` })
    const problem = update.ok ? await this.deps.seed.proof(worktree.worktreePath, revision) : `its update failed: ${update.output}`
    if (problem !== null) {
      await this.purge(worktree, 'a seed copy that did not prove clean')
      return { ok: false, reason: `the copy of ${seed} was no clean checkout at r${revision}: ${problem}` }
    }
    this.deps.seed.refreshLater(worktree.repositoryRoot)
    return { ok: true, runId: update.runId }
  }

  /**
   * The wait's id while no run took it yet. A retry re-arms the wait with a fresh id, which the
   * first run takes; recovery after a crash meets the id of the interrupted run, which already names
   * a history row and a journal entry.
   */
  private waitRunId(sessionId: string): string | undefined {
    const record = this.deps.records.get(sessionId)
    const id = record?.pendingSetup?.setupSessionId
    if (record === null || record === undefined || id === undefined) return undefined
    const used = (record.scriptRuns ?? []).some((run) => run.runId === id) || (record.worktreeLifecycle?.journal ?? []).some((entry) => entry.runId === id)
    return used ? undefined : id
  }

  /** Empties the reserved folder by its identity, so a checkout can run there; a folder that is not provably it stays. */
  private async purge(worktree: SessionRecordWorktree, what: string): Promise<void> {
    const purged = await this.deps.svn.purgeReserved({ worktreePath: worktree.worktreePath, directoryId: worktree.directoryId })
    if (!purged.ok) throw new Error(`${worktree.worktreePath} holds ${what} and cannot be emptied: ${purged.detail}`)
  }
}
