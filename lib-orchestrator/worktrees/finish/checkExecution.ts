import { ScriptRunRecords } from '../../sessionManager/worktreeSessionScripts'
import { SessionScriptDefinitions } from '../../sessionManager/worktreeSessionScripts'
import type { ChecksStep } from './checksStep'
import type { FinishDriverDeps } from './finishDriver.types'
import type { FinishState } from './finishState'
import type { PreparationStep } from './preparationStep'

export class CheckExecution {
  static readonly timeoutMillisecondsConst = 20 * 60_000
  private readonly deps: Pick<FinishDriverDeps, 'commands' | 'newId' | 'now' | 'records' | 'runs' | 'stopRun' | 'awaitExit'>
  private readonly state: Pick<FinishState, 'changedHashes' | 'write' | 'writeWithRun' | 'retainAttempt' | 'keepAttempt'>
  private readonly checks: Pick<ChecksStep, 'recordChanges' | 'complete'>
  private readonly preparation: Pick<PreparationStep, 'begin' | 'checked' | 'refreshed' | 'refreshFailed'>

  constructor(deps: CheckExecution['deps'], state: CheckExecution['state'], checks: CheckExecution['checks'], preparation: CheckExecution['preparation']) {
    this.deps = deps
    this.state = state
    this.checks = checks
    this.preparation = preparation
  }

  async runChecks(sessionId: string): Promise<boolean> {
    const state = this.deps.records.get(sessionId)!.worktreeLifecycle!
    const execution = state.execution!
    const root = execution.root
    if (execution.runId !== undefined && execution.verdict === undefined) {
      const started = execution.checkStartedAt ?? this.deps.records.get(execution.runId)?.createdAt ?? execution.startedAt
      if (this.deps.now() - started < CheckExecution.timeoutMillisecondsConst) return false
      if (!await this.deps.stopRun(execution.runId) || !await this.deps.awaitExit(execution.runId)) return false
      await this.state.write(sessionId, (current) => ({ ...current, execution: { ...current.execution!,
        verdict: { kind: 'failed', reason: 'The declared check exceeded twenty minutes and was stopped' } } }))
      return true
    }
    if (execution.refresh !== undefined && execution.refresh.endedAt === undefined) return this.refresh(sessionId)
    if (state.preparation === undefined) {
      if (execution.runId !== undefined && execution.verdict !== undefined) {
        await this.state.retainAttempt(sessionId, { runId: execution.runId, title: execution.checks[execution.checkCursor]?.name ?? 'Checks before preparation upgrade' })
        await this.state.write(sessionId, (current) => ({ ...current,
          execution: { ...current.execution!, runId: undefined, verdict: undefined, checkBefore: undefined, checkCursor: 0 } }))
      }
      return this.preparation.begin(sessionId)
    }
    if (execution.checkBefore === undefined) {
      await this.deps.commands.verify(root)
      const before = await this.state.changedHashes(root)
      await this.state.write(sessionId, (current) => ({ ...current, execution: { ...current.execution!, checkBefore: before } }))
    }
    if (execution.verdict !== undefined && execution.runId !== undefined) {
      const logPath = await this.state.keepAttempt(sessionId, { runId: execution.runId, title: execution.checks[execution.checkCursor].name })
      // A check whose record and log are gone leaves no evidence to judge, so it runs again.
      if (logPath === null) {
        await this.state.write(sessionId, (latest) => ({ ...latest, execution: { ...latest.execution!, runId: undefined, verdict: undefined, checkBefore: undefined } }))
        return true
      }
      const current = this.deps.records.get(sessionId)!.worktreeLifecycle!
      await this.checks.recordChanges(sessionId, current.execution!.checkBefore!, await this.state.changedHashes(root))
      await this.deps.commands.accept(root)
      if (execution.verdict.kind === 'failed') {
        await this.checks.complete(sessionId, { passed: false, logPath, at: this.deps.now() })
        await this.state.write(sessionId, (latest) => ({ ...latest, execution: { ...latest.execution!, runId: undefined, verdict: undefined, checkBefore: undefined, checkCursor: 0 } }))
        return false
      }
      await this.state.write(sessionId, (latest) => ({ ...latest, execution: { ...latest.execution!, checkCursor: execution.checkCursor + 1, runId: undefined, verdict: undefined, checkLogPath: logPath } }))
      return true
    }
    const current = this.deps.records.get(sessionId)!.worktreeLifecycle!
    if (current.execution!.checkCursor >= current.execution!.checks.length) {
      await this.checks.recordChanges(sessionId, current.execution!.checkBefore!, await this.state.changedHashes(root))
      await this.deps.commands.accept(root)
      if (!await this.preparation.checked(sessionId)) return this.deps.records.get(sessionId)!.worktreeLifecycle!.phase === 'finishing'
      await this.checks.complete(sessionId, { passed: true, logPath: current.execution!.checkLogPath ?? '', at: this.deps.now() })
      return true
    }
    const step = current.execution!.checks[current.execution!.checkCursor]
    const runId = this.deps.newId()
    const run = ScriptRunRecords.shellRun({ runId, operationId: this.deps.newId(), now: this.deps.now(),
      link: SessionScriptDefinitions.linkOf(sessionId, 'after', 'checks', step.name, step.key), title: ScriptRunRecords.titleOf(step, root), commands: step.commands })
    await this.state.writeWithRun(sessionId, run, (latest) => ({ ...latest, execution: { ...latest.execution!, runId, checkStartedAt: this.deps.now() } }))
    await this.deps.runs.launch(run)
    return false
  }

  /** The install a preparation asked for, one run per step, before the checks; its failure waits for the person. */
  private async refresh(sessionId: string): Promise<boolean> {
    const execution = this.deps.records.get(sessionId)!.worktreeLifecycle!.execution!
    const refresh = execution.refresh!
    const root = execution.root
    if (execution.runId !== undefined && execution.verdict !== undefined) {
      const verdict = execution.verdict
      const logPath = await this.state.keepAttempt(sessionId, { runId: execution.runId, title: refresh.steps[refresh.cursor].name })
      await this.deps.commands.accept(root)
      await this.state.write(sessionId, (latest) => ({ ...latest, execution: { ...latest.execution!, runId: undefined, verdict: undefined,
        refresh: { ...refresh, cursor: refresh.cursor + 1 } } }))
      if (verdict.kind === 'succeeded') return true
      else if (verdict.kind === 'failed') { await this.preparation.refreshFailed(sessionId, verdict.reason, logPath); return false }
      else throw new Error(`Unknown run verdict: ${JSON.stringify(verdict satisfies never)}`)
    }
    if (refresh.cursor >= refresh.steps.length) { await this.preparation.refreshed(sessionId); return true }
    if (refresh.cursor === 0) await this.deps.commands.verify(root)
    const step = refresh.steps[refresh.cursor]
    const runId = this.deps.newId()
    const run = ScriptRunRecords.shellRun({ runId, operationId: this.deps.newId(), now: this.deps.now(),
      link: SessionScriptDefinitions.linkOf(sessionId, 'after', 'setup', step.name, step.key), title: ScriptRunRecords.titleOf(step, root), commands: step.commands })
    await this.state.writeWithRun(sessionId, run, (latest) => ({ ...latest, execution: { ...latest.execution!, runId, checkStartedAt: this.deps.now() } }))
    await this.deps.runs.launch(run)
    return false
  }
}
