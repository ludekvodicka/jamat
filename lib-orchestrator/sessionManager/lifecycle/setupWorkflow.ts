import { basename } from 'node:path'

import type {
  SessionRecord,
  SessionRecordPendingSetup,
  SessionRecordScriptRun,
  SessionRecordScriptStep,
} from '../records/sessionRecord.types'
import { SessionScriptDefinitions } from '../scripts/sessionScriptDefinitions'
import type { SessionWorkflowInfo, SessionWorkflowStep, SessionWorkflowStepState } from '../sessionManagerApi.types'

type RunsOf = (runId: string) => SessionRecord | null

/**
 * The before chain of a session as a workflow: the SVN checkout, the setup and the declared
 * `scripts.before` steps, from `pendingSetup` (steps and cursor) and the before runs in the parent's
 * history. Steps before the cursor are done, the step at the cursor runs while the session starts
 * and failed once it ended, the rest are pending; a setup the create skipped shows as skipped. A
 * chain that finished leaves no `pendingSetup`, so it has no workflow. Nothing reads a clock.
 */
export class SetupWorkflow {
  static of(record: SessionRecord, pending: SessionRecordPendingSetup, runs: RunsOf): SessionWorkflowInfo | null {
    const life = record.life
    let failed: boolean
    if (life === 'starting') failed = false
    else if (life === 'ended' || life === 'lost') failed = true
    // A session the Host runs is past its setup whatever an older record says.
    else if (life === 'live') return null
    else throw new Error(`Unknown session life: ${JSON.stringify(life satisfies never)}`)
    const steps = pending.steps ?? [SetupWorkflow.legacyStepOf()]
    const cursor = pending.cursor ?? 0
    const current = steps[cursor]
    if (current === undefined) throw new Error(`Session ${record.sessionId}: its before chain names step ${cursor} of ${steps.length}`)
    const history = (record.scriptRuns ?? []).filter((run) => run.phase === 'before')
    const planned: SessionWorkflowStep[] = steps.map((step, index) => {
      if (index < cursor) return SetupWorkflow.doneOf(record, step, index, history)
      if (index === cursor) return SetupWorkflow.currentOf(record, step, index, pending.setupSessionId, failed, history, runs)
      return SetupWorkflow.stepOf(record, step, index, 'pending', '', null, null, { kind: 'none' })
    })
    const skipped = SetupWorkflow.skippedOf(record, steps)
    // Where the setup would have run: right after the checkout that leads an SVN chain.
    if (skipped !== null) planned.splice(steps[0]?.scriptId === 'svn' ? 1 : 0, 0, skipped)
    const title = SetupWorkflow.titleOf(record, current)
    const word = SessionScriptDefinitions.wordsOf({ phase: 'before', scriptId: current.scriptId === 'checks' ? 'declared' : current.scriptId,
      name: current.name }).session
    const reason = failed ? SetupWorkflow.lastOf(history, (run) => run.runId === pending.setupSessionId)?.reason ?? record.endedReason : undefined
    return {
      kind: 'before',
      workflowId: `setup:${record.sessionId}`,
      title: `Setup of ${record.title}`,
      badge: failed ? `${word} failed` : `${word} runs`,
      summary: failed ? `${title} failed${reason === undefined ? '' : `: ${reason}`}; press Retry setup` : `Running ${title}`,
      open: !failed,
      rounds: [{ title: 'Setup', steps: planned }],
      actions: failed ? [{ id: 'retry-setup', label: 'Retry setup', primary: true }] : [],
    }
  }

  /** The history is oldest first, so the newest attempt is the last one that matches. */
  private static lastOf(history: readonly SessionRecordScriptRun[], matches: (run: SessionRecordScriptRun) => boolean): SessionRecordScriptRun | undefined {
    return [...history].reverse().find(matches)
  }

  /** A wait written before chains existed is one setup step. */
  private static legacyStepOf(): SessionRecordScriptStep {
    return { key: 'setup', scriptId: 'setup', name: 'setup', commands: [] }
  }

  private static doneOf(record: SessionRecord, step: SessionRecordScriptStep, index: number, history: readonly SessionRecordScriptRun[]): SessionWorkflowStep {
    const run = SetupWorkflow.lastOf(history, (entry) => entry.stepKey === step.key && entry.outcome === 'succeeded')
    return SetupWorkflow.stepOf(record, step, index, 'done', run?.title ?? '', run?.startedAt ?? null, run?.endedAt ?? null,
      run === undefined ? { kind: 'none' } : { kind: 'run', runId: run.runId })
  }

  private static currentOf(
    record: SessionRecord,
    step: SessionRecordScriptStep,
    index: number,
    runId: string,
    failed: boolean,
    history: readonly SessionRecordScriptRun[],
    runs: RunsOf,
  ): SessionWorkflowStep {
    const entry = SetupWorkflow.lastOf(history, (candidate) => candidate.runId === runId)
    const run = runs(runId)
    if (failed)
      return SetupWorkflow.stepOf(record, step, index, 'failed', entry?.reason ?? record.endedReason ?? 'the step failed',
        entry?.startedAt ?? run?.createdAt ?? null, entry?.endedAt ?? run?.endedAt ?? null, { kind: 'run', runId })
    return SetupWorkflow.stepOf(record, step, index, 'running', run?.title ?? '', run?.createdAt ?? null, null, { kind: 'run', runId })
  }

  private static skippedOf(record: SessionRecord, steps: readonly SessionRecordScriptStep[]): SessionWorkflowStep | null {
    if (record.setupSkipped === undefined || steps.some((step) => step.scriptId === 'setup')) return null
    return { key: 'setup', title: 'Setup', detail: record.setupSkipped.reason, state: 'skipped', startedAt: null, endedAt: null, target: { kind: 'none' } }
  }

  private static stepOf(
    record: SessionRecord,
    step: SessionRecordScriptStep,
    index: number,
    state: SessionWorkflowStepState,
    detail: string,
    startedAt: number | null,
    endedAt: number | null,
    target: SessionWorkflowStep['target'],
  ): SessionWorkflowStep {
    return { key: `${index}:${step.key}`, title: SetupWorkflow.titleOf(record, step), detail, state, startedAt, endedAt, target }
  }

  /** "Checkout 014-fix", "Setup", "Script codegen". */
  private static titleOf(record: SessionRecord, step: SessionRecordScriptStep): string {
    const scriptId = step.scriptId
    switch (scriptId) {
      case 'svn': return `Checkout ${basename(record.worktree?.worktreePath ?? '') || step.name}`
      case 'setup': return 'Setup'
      case 'declared': case 'checks': return `Script ${step.name}`
      default: throw new Error(`Unknown before step: ${JSON.stringify(scriptId satisfies never)}`)
    }
  }
}
