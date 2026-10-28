import type { SessionRecord, SessionRecordSvnAction, SvnActionPass } from '../../sessionManager/worktreeSessionRecords'
import type { SvnActionStage } from '../../sessionManager/sessionManagerApi.types'
import type { FinishStep, SvnStepJournalEntry, WorktreeLifecycle } from '../worktreeState'
import { resolve } from 'node:path'
import { PathCompare } from '../../shared/pathCompare'
import { SvnActionStages } from './svnActionStages'

export class FinishProjection {
  static action(record: SessionRecord): SessionRecordSvnAction | undefined {
    if (record.worktreeLifecycle?.unreadable !== undefined) return undefined
    if (record.svnAction?.kind === 'update-main') return record.svnAction
    const state = record.worktreeLifecycle
    if (state?.execution === undefined) return record.svnAction
    if (state.actionId === null || state.phase === 'kept' || state.phase === 'removed' || state.phase === 'active') return undefined
    return { ...state.execution, actionId: state.actionId, kind: state.purpose ?? 'finish',
      commit: state.review === undefined ? state.execution.commit : { selection: state.review.selection.map((path) => resolve(state.execution!.root, path)),
        message: state.review.message, messageSource: state.review.source, acknowledgedFindings: state.review.acknowledged, hashes: state.review.hashes },
      // The driver cursor can be past the last completed check; legacy history requires an index.
      checkCursor: state.execution.checkCursor === state.execution.checks.length
        ? Math.max(0, state.execution.checkCursor - 1) : state.execution.checkCursor,
      rootCursor: Math.min(state.execution.rootCursor, Math.max(0, (state.execution.roots?.length ?? 1) - 1)),
      stage: state.phase === 'landed' ? 'main-update' : state.step === 'worker-resolving' && state.execution.merger !== undefined ? 'merging' : FinishProjection.stage(state.step),
      conflictSet: state.syncConflictSet, rounds: { incoming: 0, lock: 0, outOfDate: state.outOfDate },
      ...(state.wait === undefined ? {} : { needs: { kind: FinishProjection.need(state.wait.kind), reason: state.wait.reason, at: state.wait.at } }) }
  }

  /**
   * What this Finish already did, for Session actions only: its svn steps from the journal, its
   * check runs and the approved review. The driver records no passes, so a finished step vanished
   * from the workflow while the sessions tree still listed its run. Never written back.
   */
  static donePasses(record: SessionRecord): SvnActionPass[] {
    const state = record.worktreeLifecycle
    const execution = state?.execution
    if (state === undefined || execution === undefined || state.actionId === null) return []
    const known = new Set((execution.passes ?? []).map((pass) => pass.runId).filter((runId) => runId !== undefined))
    const journal = FinishProjection.journalPasses(record, state.actionId, known)
    const checks = (record.scriptRuns ?? []).flatMap((run): SvnActionPass[] => run.scriptId !== 'checks' || run.startedAt < execution.startedAt
      || known.has(run.runId) || run.runId === execution.runId ? []
      : [{ stage: 'checks', runId: run.runId, startedAt: run.startedAt, endedAt: run.endedAt, result: run.outcome === 'succeeded' ? 'done' : 'failed' }])
    const approved: SvnActionPass[] = state.approvedAt === undefined ? [] : [{ stage: 'changes', startedAt: state.approvedAt, endedAt: state.approvedAt, result: 'done' }]
    // A verification carries its revision, which tells it from the resolver check of a legacy action.
    const verified = (state.verified ?? []).filter((row) => row.at >= execution.startedAt).map((row): SvnActionPass => {
      const root = FinishProjection.rootFactsOf(execution, row.root)
      const committed = journal.find((pass) => pass.stage === 'committing' && pass.facts?.revision === row.revision
        && pass.facts.mount === root.mount)?.endedAt
      return { stage: 'verifying', startedAt: Math.min(committed ?? row.at, row.at), endedAt: row.at, result: 'done',
        facts: { revision: row.revision, ...root, ...row.repository === undefined ? {} : { repository: row.repository } } }
    })
    const removedAt = record.retiredWorktree?.removedAt
    // The removal began once its permit was granted: a Discard pressed in a prepared review did
    // not remove anything while that preparation ran. A retried one began with its last attempt.
    const removed: SvnActionPass[] = execution.removal === 'removed' && state.step !== 'removing' && removedAt !== undefined && removedAt >= execution.startedAt
      ? [{ stage: 'removing', startedAt: Math.min(removedAt, execution.removalAt ?? Math.max(execution.startedAt, state.approvedAt ?? 0, FinishProjection.permittedAt(state),
        ...verified.map((pass) => pass.endedAt))), endedAt: removedAt, result: 'done' }] : []
    return [...journal, ...FinishProjection.fixingPasses(state, execution.startedAt), ...checks, ...approved, ...verified, ...removed]
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  /**
   * A conflict set this Finish read and that holds nothing open: its check of the conflicts, done, so
   * a rule Jamat applied by itself stays in the history. An open set is the current wait, not history.
   */
  private static fixingPasses(state: WorktreeLifecycle, startedAt: number): SvnActionPass[] {
    const set = state.syncConflictSet
    if (set === undefined || set.entries.length === 0 || set.readAt < startedAt
      || set.more > 0 || set.entries.some((entry) => entry.state !== 'settled')) return []
    const fixed = set.entries.filter((entry) => entry.by === 'jamat').length
    // A later sync reads the settled set again, so `readAt` alone drew 0.0 s after a wait for the person:
    // the check lasts from the update that left the conflicts to the last choice applied to them (UA1-J13-7).
    const choices = state.journal.filter((entry) => entry.stepId.startsWith(`${state.actionId}-conflict-`) && entry.startedAt >= startedAt && entry.endedAt !== undefined)
    if (choices.length === 0)
      return [{ stage: 'fixing', startedAt: set.readAt, endedAt: set.readAt, result: 'done', facts: { conflicts: set.entries.length, fixed, left: 0 } }]
    const first = Math.min(...choices.map((entry) => entry.startedAt))
    const updated = state.journal.filter((entry) => entry.kind === 'update' && entry.startedAt >= startedAt && entry.endedAt !== undefined && entry.endedAt <= first)
      .map((entry) => entry.endedAt!)
    return [{ stage: 'fixing', startedAt: updated.length === 0 ? first : Math.max(...updated), endedAt: Math.max(...choices.map((entry) => entry.endedAt!)),
      result: 'done', facts: { conflicts: set.entries.length, fixed, left: 0 } }]
  }

  /**
   * The publication a lifecycle Finish verifies now, with the revision its receipt names. Null for
   * every other step and for an UPDATE of the main copy, whose `verifying` checks a resolver's work.
   */
  static verifyingOf(record: SessionRecord): { revision: number | null } | null {
    const state = record.worktreeLifecycle
    const execution = state?.execution
    if (state?.step !== 'verifying' || execution === undefined || state.unreadable !== undefined || record.svnAction?.kind === 'update-main') return null
    const root = execution.roots?.[execution.rootCursor]?.path ?? execution.root
    const receipt = [...record.commitReceipts ?? []].reverse()
      .find((row) => row.revision !== null && PathCompare.comparable(row.scopeRoot) === PathCompare.comparable(root))
    return { revision: receipt?.revision ?? null }
  }

  /**
   * The passes Session actions draws, and keeps in the action history: the recorded ones and `donePasses`.
   * An UPDATE draws only the svn steps from its start on: a landed Finish drawn as its waiting UPDATE
   * shares the Finish's action id, and the Finish's own steps stay in the Finish section. The run of
   * the current stage is the current step, so it is never drawn a second time as a pass.
   */
  static shownPasses(record: SessionRecord, action: SessionRecordSvnAction): SvnActionPass[] | undefined {
    if (record.worktreeLifecycle === undefined) return action.passes
    const keyOf = (pass: SvnActionPass): string => `${pass.stage}:${pass.runId ?? ''}:${pass.startedAt}`
    const seen = new Set((action.passes ?? []).map(keyOf))
    const current = action.runId !== undefined && SvnActionStages.isRun(action.stage) ? [action.runId] : []
    const completed = action.kind === 'update-main'
      ? FinishProjection.journalPasses(record, action.actionId, new Set([...current, ...(action.passes ?? []).flatMap((pass) => pass.runId === undefined ? [] : [pass.runId])]))
        .filter((pass) => pass.startedAt >= action.startedAt)
      : FinishProjection.donePasses(record)
    const derived = completed.filter((pass) => !seen.has(keyOf(pass)))
    // A recorded pass starts with its stage, before the runs of earlier roots the same update ran: it
    // sorts by its own run, so the update of a mount follows the update of the root (UA1-J13-7).
    const journal = record.worktreeLifecycle.journal
    const startOf = (pass: SvnActionPass): number => journal.find((entry) => pass.runId !== undefined && entry.runId === pass.runId)?.startedAt ?? pass.startedAt
    return derived.length === 0 ? action.passes : [...action.passes ?? [], ...derived].sort((a, b) => startOf(a) - startOf(b))
  }

  /** The svn step of this Finish that runs now, whose live output Session actions shows. */
  static openRunOf(record: SessionRecord): { runId?: string; startedAt: number } | undefined {
    const state = record.worktreeLifecycle
    const actionId = record.svnAction?.kind === 'update-main' ? record.svnAction.actionId : state?.actionId
    if (state === undefined || actionId === null || actionId === undefined) return undefined
    return [...state.journal].reverse().find((entry) => entry.endedAt === undefined && entry.stepId.startsWith(`${actionId}-`))
  }

  private static journalPasses(record: SessionRecord, actionId: string, known: Set<string>): SvnActionPass[] {
    const journal = record.worktreeLifecycle?.journal ?? []
    // A cleanup that failed and then succeeded on a later try is settled; its failed tries only crowd the list.
    const settled = (entry: SvnStepJournalEntry): boolean => entry.kind === 'cleanup' && entry.outcome !== 'ok'
      && journal.some((other) => other.kind === 'cleanup' && other.stepId === entry.stepId && other.outcome === 'ok' && other.startedAt > entry.startedAt)
    return journal.flatMap((entry): SvnActionPass[] => {
      if (!entry.stepId.startsWith(`${actionId}-`) || entry.endedAt === undefined || known.has(entry.runId) || settled(entry)) return []
      const stage = FinishProjection.journalStage(entry.kind)
      if (stage === null) return []
      const root = entry.kind === 'commit' && entry.cwd !== undefined && record.worktreeLifecycle?.execution !== undefined
        ? FinishProjection.rootFactsOf(record.worktreeLifecycle.execution, entry.cwd) : {}
      const facts = { ...entry.kind === 'commit' && entry.revision !== undefined ? { revision: entry.revision } : {}, ...root }
      return [{ stage, runId: entry.runId, startedAt: entry.startedAt, endedAt: entry.endedAt, result: entry.outcome === 'ok' ? 'done' : 'failed',
        ...Object.keys(facts).length === 0 ? {} : { facts } }]
    })
  }

  /** The mount and the repository of the reviewed root at `path`; nothing for a path no root of the action has. */
  private static rootFactsOf(execution: NonNullable<WorktreeLifecycle['execution']>, path: string): { mount?: string; repository?: string } {
    const root = execution.roots?.find((entry) => PathCompare.comparable(entry.path) === PathCompare.comparable(path))
    if (root === undefined) return {}
    return { mount: root.own, ...root.bounds === undefined ? {} : { repository: root.bounds.repository } }
  }

  /** When the removal of the worktree was permitted, or 0 before any permit. */
  private static permittedAt(state: WorktreeLifecycle): number {
    const permit = state.removalPermit
    if (permit === undefined) return 0
    const kind = permit.kind
    switch (kind) {
      case 'clean': return permit.provedAt
      case 'discard': return permit.at
      default: throw new Error(`Unknown removal permit: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  private static journalStage(kind: SvnStepJournalEntry['kind']): SvnActionStage | null {
    switch (kind) {
      case 'update': return 'updating'
      case 'cleanup': return 'cleaning'
      case 'commit': return 'committing'
      case 'checkout': case 'status': case 'diff': case 'revert': case 'resolve': return null
      default: throw new Error(`Unknown svn step: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  static record(record: SessionRecord): SessionRecord {
    return record.worktreeLifecycle?.execution === undefined ? record : { ...record, svnAction: FinishProjection.action(record) }
  }

  static evidence(action: SessionRecordSvnAction): NonNullable<WorktreeLifecycle['execution']> {
    const { actionId, kind, stage, needs, conflictSet, rounds, ...evidence } = action
    return evidence
  }

  private static stage(step: FinishStep | undefined): SessionRecordSvnAction['stage'] {
    switch (step) {
      case undefined: return 'changes'
      case 'syncing': return 'updating'
      case 'worker-resolving': return 'fixing'
      case 'checking': return 'checks'
      case 'reviewing': return 'changes'
      case 'awaiting-idle': case 'committing': return 'committing'
      case 'verifying': return 'verifying'
      case 'disposing': return 'evidence'
      case 'stopping-worker': return 'stopping'
      case 'removing': return 'removing'
      case 'recording': return 'recording'
      default: throw new Error(`Unknown finish step: ${JSON.stringify(step satisfies never)}`)
    }
  }

  private static need(kind: NonNullable<WorktreeLifecycle['wait']>['kind']): NonNullable<SessionRecordSvnAction['needs']>['kind'] {
    switch (kind) {
      case 'review': case 'waiting-for-review': return 'review-interrupted'
      case 'conflict-person': return 'conflict'
      case 'checks-failed': return 'check-failed'
      case 'repository-busy': return 'out-of-date'
      case 'published-with-differences': case 'partially-landed': return 'partial'
      case 'worker-lost': case 'host-unhealthy': return 'not-stopped'
      case 'changed-outside': case 'auth': case 'never-started': case 'svn-failed': return 'svn-failed'
      case 'worker-busy': return 'worker-busy'
      case 'removal-blocked': case 'locked': case 'pinned-external': return kind
      default: throw new Error(`Unknown worktree wait: ${JSON.stringify(kind satisfies never)}`)
    }
  }
}
