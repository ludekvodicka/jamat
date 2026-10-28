import { ConflictJournals } from '../conflicts/conflictJournals'
import type { SessionRecord, SessionRecordSvnAction } from '../../sessionManager/worktreeSessionRecords'
import { SvnConflictFlow } from '../conflicts/svnConflictFlow'
import { SvnMergerLauncher } from '../conflicts/svnMergerLauncher'
import type { WorktreeLifecycle } from '../worktreeState'
import type { WorktreeStopPress } from '../worktreeExecution'
import { FinishProjection } from './finishProjection'
import type { FinishDriverDeps } from './finishDriver.types'
import type { FinishState } from './finishState'

export class ConflictStep {
  /** The person's press that records a stop Jamat cannot prove; every text asking for it names it. */
  static readonly confirmStoppedConst = 'I stopped the processes manually'
  private readonly deps: Pick<FinishDriverDeps, 'commands' | 'createResolver' | 'idle' | 'newId' | 'now' | 'records' | 'resolver' | 'stopRun' | 'stopRefusal' | 'awaitExit'>
  private readonly state: Pick<FinishState, 'action' | 'keepAttempt' | 'wait' | 'write'>
  private readonly conflicts: Pick<SvnConflictFlow, 'recheck' | 'fix' | 'brief' | 'handOver' | 'remember'>

  constructor(deps: ConflictStep['deps'], state: ConflictStep['state'], conflicts: Pick<SvnConflictFlow, 'recheck' | 'fix' | 'brief' | 'handOver' | 'remember'>) {
    this.deps = deps
    this.state = state
    this.conflicts = conflicts
  }

  async run(sessionId: string, state: WorktreeLifecycle): Promise<boolean> {
    if (state.execution?.verdict !== undefined && state.execution.runId !== undefined) {
      // A merger lost with its Host saved no log; it ended all the same, and the check goes on.
      await this.state.keepAttempt(sessionId, { runId: state.execution.runId, title: 'Conflict merger' })
      await this.checkConflicts(sessionId, false, true)
      return this.deps.records.get(sessionId)?.worktreeLifecycle?.step !== 'worker-resolving'
    }
    await this.fallback(sessionId)
    return false
  }

  async checkConflicts(sessionId: string, agent = false, confirmed = false): Promise<void> {
    let action = this.state.action(sessionId)
    await this.deps.commands.verify(action.root)
    if (action.merger !== undefined && action.merger.endedAt === undefined) {
      const runId = action.merger.runId
      const run = this.deps.records.get(runId)
      const captured = this.deps.records.get(sessionId)?.scriptRuns?.find((entry) => entry.runId === runId && entry.endedAt !== undefined)
      if (run?.life !== 'live' && run?.life !== 'starting' && captured !== undefined) {
        await this.state.keepAttempt(sessionId, { runId, title: 'Conflict merger' })
        action = { ...action, merger: { ...action.merger, endedAt: captured.endedAt } }
      }
    }
    if (action.merger !== undefined && action.merger.endedAt === undefined) {
      const checked = await this.conflicts.recheck(action, () => {})
      if (!checked.ok) {
        await this.state.wait(sessionId, 'svn-failed', checked.detail)
        if (checked.set !== undefined)
          await this.state.write(sessionId, (current) => ({ ...current, syncConflictSet: checked.set, syncJournals: ConflictStep.conflictJournals(current, checked.set) }))
        return
      }
      await this.state.write(sessionId, (current) => ({ ...current, syncConflictSet: checked.value, syncJournals: ConflictStep.conflictJournals(current, checked.value) }))
      return
    }
    const checked = await this.conflicts.fix({ ...action, conflictSet: action.conflictSet === undefined ? undefined : { ...action.conflictSet, waited: true } },
      () => {}, (path, journal, kind) => this.state.write(sessionId, (current) => ConflictJournals.record(current, path, journal, kind)), agent)
    // A crash must retain the guard's wait before it records that the one-time guard was consumed.
    if (checked.kind === 'needs') await this.state.wait(sessionId, checked.need === 'conflict' ? 'conflict-person' : 'svn-failed', checked.reason)
    await this.state.write(sessionId, (current) => ({ ...current, syncConflictSet: checked.action.conflictSet, syncJournals: ConflictStep.conflictJournals(current, checked.action.conflictSet),
      ...(checked.kind === 'settled' ? { phase: 'finishing', step: 'syncing', wait: undefined } : {}),
      execution: { ...current.execution!, merger: checked.action.merger, runId: undefined, verdict: undefined,
        ...(checked.kind === 'settled' ? { checkCursor: 0, checkBefore: undefined, confirmBusy: confirmed } : {}) } }))
    switch (checked.kind) {
      case 'settled': return
      case 'merge': await this.startMerger(sessionId); return
      case 'needs': return
      case 'applied': throw new Error('A checked conflict set cannot apply a fresh rule')
      default: throw new Error(`Unknown conflict check: ${JSON.stringify(checked satisfies never)}`)
    }
  }

  static conflictJournals(state: WorktreeLifecycle, set: SessionRecordSvnAction['conflictSet']): WorktreeLifecycle['syncJournals'] {
    const journals = { ...state.syncJournals }
    for (const entry of set?.entries ?? []) delete journals[entry.occurrenceId === undefined ? entry.path : `${entry.occurrenceId}:${entry.path}`]
    return Object.keys(journals).length === 0 ? undefined : journals
  }

  async fallback(sessionId: string): Promise<void> {
    const state = this.deps.records.get(sessionId)!.worktreeLifecycle!
    const fallback = SvnMergerLauncher.fallback(state, this.deps.idle(sessionId), this.deps.now())
    await this.state.write(sessionId, (current) => ({ ...current, conflictProgress: fallback.progress }))
    if (fallback.action === 'merger') await this.startMerger(sessionId)
    else if (fallback.action === 'person') { await this.stopHelper(this.deps.records.get(sessionId)!); await this.state.wait(sessionId, 'conflict-person', 'The merger made no settlement for twenty minutes') }
    else if (fallback.action !== 'wait') throw new Error(`Unknown fallback: ${JSON.stringify(fallback.action satisfies never)}`)
  }

  async startMerger(sessionId: string): Promise<void> {
    const record = this.deps.records.get(sessionId)!
    const action = this.state.action(sessionId)
    if (action.merger !== undefined && action.merger.endedAt === undefined) return
    const unavailable = this.deps.resolver.unavailable()
    if (unavailable !== null) {
      await this.state.write(sessionId, (current) => ({ ...current, syncConflictSet: current.syncConflictSet === undefined ? undefined : SvnConflictFlow.toPerson(current.syncConflictSet) }))
      await this.state.wait(sessionId, 'conflict-person', `Conflicts need your choice (no merger runs here: ${unavailable})`)
      return
    }
    const brief = await this.conflicts.brief(record, action)
    if (!brief.ok || brief.value.mergeBrief === undefined) { await this.state.wait(sessionId, 'conflict-person', brief.ok ? 'No merger brief was written' : brief.detail); return }
    const handed = await this.conflicts.handOver(brief.value)
    if (!handed.ok) { await this.state.wait(sessionId, 'conflict-person', handed.detail); return }
    const runId = this.deps.newId()
    await this.state.write(sessionId, (current) => ({ ...current, phase: 'finishing', wait: undefined,
      conflictProgress: { ...SvnMergerLauncher.fallback(current, this.deps.idle(sessionId), this.deps.now()).progress,
        owner: 'merger', milliseconds: 0, observedAt: this.deps.now() },
      execution: { ...current.execution!, ...FinishProjection.evidence(brief.value), runId,
        merger: { runId, setAt: action.conflictSet!.readAt, startedAt: this.deps.now() } } }))
    const created = await this.deps.createResolver(SvnMergerLauncher.specOf(record, { root: action.root, briefFile: brief.value.mergeBrief }), SvnMergerLauncher.marksOf(sessionId, runId))
    if (!created.ok) {
      await this.state.write(sessionId, (current) => ({ ...current, execution: { ...current.execution!, runId: undefined, merger: undefined } }))
      await this.state.wait(sessionId, 'conflict-person', created.detail)
    }
  }

  /**
   * Stops the run of the current step before `press` goes on. A run that still runs only refuses: its
   * root stays alive and readable, so the person repeats the press. A run that ended or was lost without
   * a proven stop is marked for the person's manual confirmation, which then goes on with `press`.
   */
  async stopHelper(record: SessionRecord, manuallyStopped = false, press: WorktreeStopPress = 'back-to-work'): Promise<void> {
    const runId = record.worktreeLifecycle?.execution?.runId
    if (runId === undefined || await this.deps.stopRun(runId, manuallyStopped) && await this.deps.awaitExit(runId)) return
    const run = this.deps.records.get(runId)
    const refusal = ConflictStep.hostWordsOf(this.deps.stopRefusal?.(runId))
    if ((run?.life === 'live' || run?.life === 'starting') && manuallyStopped)
      throw new Error(`The Finish run ${runId} still runs, so its stop cannot be confirmed by hand. Press Stop again.`)
    if (run?.life === 'live' || run?.life === 'starting')
      throw new Error(`The Host did not stop the Finish run ${runId}${refusal === undefined ? '' : `: ${refusal}`}. Press Stop again.`)
    await this.state.write(record.sessionId, (current) => current.execution?.runId !== runId ? current
      : { ...current, execution: { ...current.execution, stopRefusedRunId: runId, stopRefusedPress: press } })
    throw new Error(`${ConflictStep.unprovenOf(run?.life ?? 'lost', `The Finish run ${runId}`, refusal)} Stop them, then press ${ConflictStep.confirmStoppedConst}.`)
  }

  /** Why Jamat cannot prove that the run named `what` stopped, ended with a full stop. */
  static unprovenOf(life: SessionRecord['life'], what: string, refusal: string | undefined): string {
    switch (life) {
      case 'lost': return `${what} was lost when its Host stopped; its processes may still run, and Jamat cannot prove that they ended.`
      case 'ended': return `${what} ended, but Jamat cannot prove that its child processes stopped${refusal === undefined ? '' : `: ${refusal}`}; they may still run.`
      case 'live': case 'starting': return `${what} still runs${refusal === undefined ? '' : `: ${refusal}`}.`
      default: throw new Error(`Unknown session life: ${JSON.stringify(life satisfies never)}`)
    }
  }

  /** The Host's own words, without the transport's prefix. */
  static hostWordsOf(detail: string | undefined): string | undefined {
    return detail?.replace(/^runtime\.stop answered \d+: /, '')
  }

  async preserveRecoveryConflicts(sessionId: string): Promise<void> {
    const record = this.deps.records.get(sessionId)!
    const read = await this.conflicts.remember(this.state.action(sessionId), record.worktreeLifecycle?.conflictMemory ?? record.worktree?.conflictMemory)
    if (!read.ok) throw new Error(read.detail)
    if (!await this.deps.records.update(sessionId, (latest) => latest.worktree === undefined ? null : { ...latest,
      worktree: { ...latest.worktree, conflictMemory: undefined },
      worktreeLifecycle: { ...latest.worktreeLifecycle!, version: latest.worktreeLifecycle!.version + 1,
        syncConflictSet: read.value.set, conflictMemory: read.value.memory } })) throw new Error('Recovery conflict evidence could not be saved')
  }
}
