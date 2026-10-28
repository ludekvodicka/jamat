import { FinishProjection, SvnActionStages } from '../../worktrees/worktreeFinish'
import type { SessionRecord, SessionRecordScriptLink, SessionRecordScriptRun } from '../records/sessionRecord.types'
import type {
  SessionScriptRunState,
  SessionScriptsBadge,
  SessionScriptsInfo,
  SessionSetupInfo,
} from '../sessionManagerApi.types'
import { ScriptDuration } from './scriptDuration'
import { ScriptRunRecords } from './scriptRunRecords'

/** Which step of a chain a badge speaks of: the SVN checkout, the dependency install, or a step the project named. */
export type ScriptBadgeStep = { kind: 'checkout' } | { kind: 'setup' } | { kind: 'declared'; name: string }

/** What a badge says, before it is put into words. */
export type ScriptBadgeFacts =
  | {
    phase: SessionScriptsBadge['phase']
    state: 'running'
    step: ScriptBadgeStep
    runId: string
    commands: readonly string[]
  }
  /** `reason` is a whole sentence the title shows as it stands. */
  | { phase: SessionScriptsBadge['phase']; state: 'failed'; step: ScriptBadgeStep; runId: string; reason: string | null }
  | { phase: 'before'; state: 'skipped'; reason: string }
  | { phase: SessionScriptsBadge['phase']; state: 'succeeded'; runId: string; durationMs: number }

/**
 * The words a parent row and the `Scripts` menu show about the runs of a session. They are composed
 * here, never by a surface, so the window, a peer's window and the CLI say one thing.
 *
 * Nothing here reads a clock: a running badge has no elapsed time, because a field that moves on
 * every poll mints a snapshot revision on every poll.
 */
export class ScriptBadges {
  private static readonly setupStepConst: ScriptBadgeStep = { kind: 'setup' }
  private static readonly checkoutStepConst: ScriptBadgeStep = { kind: 'checkout' }

  static of(facts: ScriptBadgeFacts): SessionScriptsBadge {
    if (facts.state === 'running') {
      const text = ScriptBadges.runningTextOf(facts.phase, facts.step)
      const title = facts.commands.length === 0 ? text : `${text}:\n${facts.commands.join('\n')}`
      return { phase: facts.phase, state: 'running', text, title: ScriptBadges.capitalized(title), runId: facts.runId }
    }
    else if (facts.state === 'failed') {
      const text = ScriptBadges.failedTextOf(facts.phase, facts.step)
      return { phase: facts.phase, state: 'failed', text, title: ScriptBadges.capitalized(facts.reason ?? text), runId: facts.runId }
    }
    else if (facts.state === 'skipped')
      return { phase: facts.phase, state: 'skipped', text: 'setup skipped', title: `Setup skipped: ${facts.reason}` }
    else if (facts.state === 'succeeded') {
      const duration = ScriptDuration.text(facts.durationMs)
      const phase = facts.phase
      if (phase === 'before')
        return { phase, state: 'succeeded', text: `setup ✓ ${duration}`, title: `Setup succeeded in ${duration}`, runId: facts.runId }
      else if (phase === 'after')
        return { phase, state: 'succeeded', text: `checks ✓ ${duration}`, title: `Checks passed in ${duration}`, runId: facts.runId }
      else throw new Error(`Unknown script phase: ${JSON.stringify(phase satisfies never)}`)
    }
    else throw new Error(`Unknown badge state: ${JSON.stringify(facts satisfies never)}`)
  }

  /**
   * The before chain, read off the parent: its gate while it waits, otherwise the last chain that
   * succeeded, otherwise the reason nothing ran. `current` is the record of the run the gate names.
   *
   * A `live` parent still carrying the gate is a record an older build wrote or a hand edited, and a
   * session the Host runs is past its setup whatever it says, so it has no running or failed badge.
   */
  static beforeOf(parent: SessionRecord, current: SessionRecord | null): ScriptBadgeFacts | null {
    const pending = parent.pendingSetup
    if (pending !== undefined) {
      const runId = pending.setupSessionId
      const planned = pending.steps?.[pending.cursor ?? 0]
      const link = current?.scriptOf ?? (planned === undefined ? undefined
        : { sessionId: parent.sessionId, phase: 'before' as const, scriptId: planned.scriptId, name: planned.name })
      const step = link?.phase === 'before' ? ScriptBadges.stepOf(link) : ScriptBadges.setupStepConst
      if (parent.life === 'starting')
        return { phase: 'before', state: 'running', step, runId, commands: (current === null ? [] : ScriptRunRecords.commandsOf(current)).map((command) => command.command) }
      else if (parent.life === 'ended' || parent.life === 'lost') {
        const entry = parent.scriptRuns?.find((candidate) => candidate.runId === runId)
        return { phase: 'before', state: 'failed', step, runId, reason: entry?.reason ?? parent.endedReason ?? null }
      }
      else if (parent.life === 'live') return null
      else throw new Error(`Unknown session life: ${JSON.stringify(parent.life satisfies never)}`)
    }
    const succeeded = ScriptBadges.succeededChainOf(parent.scriptRuns ?? [], 'before')
    if (succeeded !== null) return succeeded
    if (parent.setupSkipped !== undefined) return { phase: 'before', state: 'skipped', reason: parent.setupSkipped.reason }
    return null
  }

  /**
   * The after chain of the last Finish press, read off the parent: running, failed at its cursor, or
   * passed, timed from the history of this chain alone. Null without a chain, and for a chain that
   * passed before its runs settled; the before badge speaks meanwhile. `current` is the record of the
   * run the chain names.
   */
  static afterOf(parent: SessionRecord, current: SessionRecord | null): ScriptBadgeFacts | null {
    const checks = parent.finishChecks
    if (checks === undefined) return null
    const step: ScriptBadgeStep = { kind: 'declared', name: checks.steps[checks.cursor].name }
    const result = checks.result
    if (result === undefined)
      return {
        phase: 'after',
        state: 'running',
        step,
        runId: checks.runId,
        commands: (current?.commands ?? checks.steps[checks.cursor].commands).map((command) => command.command),
      }
    else if (result.kind === 'failed')
      return { phase: 'after', state: 'failed', step, runId: checks.runId, reason: result.reason }
    else if (result.kind === 'passed')
      return ScriptBadges.succeededChainOf(
        (parent.scriptRuns ?? []).filter((entry) => entry.startedAt >= checks.startedAt),
        'after',
      )
    else throw new Error(`Unknown Finish checks result: ${JSON.stringify(result satisfies never)}`)
  }

  /**
   * The checks of an SVN action, read off the parent while they run or after one failed: the same
   * words as a Git Finish's checks. Every other stage speaks through the row's finish mark.
   */
  static actionOf(parent: SessionRecord, current: SessionRecord | null): ScriptBadgeFacts | null {
    const action = FinishProjection.action(parent)
    if (action === undefined || action.stage !== 'checks' || action.runId === undefined) return null
    const install = SvnActionStages.installOf(action)
    const check = install ?? action.checks[action.checkCursor]
    const step: ScriptBadgeStep = install === null ? { kind: 'declared', name: check.name } : ScriptBadges.setupStepConst
    if (action.needs === undefined)
      return {
        phase: 'after',
        state: 'running',
        step,
        runId: action.runId,
        commands: (current?.commands ?? check.commands).map((command) => command.command),
      }
    return action.needs.kind === 'check-failed'
      ? { phase: 'after', state: 'failed', step, runId: action.runId, reason: action.needs.reason }
      : null
  }

  /** The menu line of one run: "Setup i12-x · failed · exit 1 · 24 s". */
  static summaryOf(run: { title: string; state: SessionScriptRunState; exitCode?: number; durationText?: string }): string {
    const parts = [run.title, run.state]
    // A stopped run's code is whatever its platform reports for a kill, which says nothing.
    if (run.state === 'failed' && run.exitCode !== undefined) parts.push(`exit ${run.exitCode}`)
    if (run.durationText !== undefined) parts.push(run.durationText)
    return parts.join(' · ')
  }

  /**
   * An older peer sends the legacy `setup` alone. It says enough for the badge and for the click on a
   * waiting parent; the runs it never sent stay unknown.
   */
  static legacyOf(setup: SessionSetupInfo): SessionScriptsInfo {
    const step = ScriptBadges.setupStepConst
    if (setup.state === 'running')
      return {
        runs: [],
        badge: ScriptBadges.of({ phase: 'before', state: 'running', step, runId: setup.setupSessionId, commands: setup.commands }),
        waitingOn: setup.setupSessionId,
      }
    else if (setup.state === 'failed')
      return {
        runs: [],
        badge: ScriptBadges.of({ phase: 'before', state: 'failed', step, runId: setup.setupSessionId, reason: null }),
      }
    else if (setup.state === 'skipped')
      return { runs: [], badge: ScriptBadges.of({ phase: 'before', state: 'skipped', reason: setup.reason }) }
    else throw new Error(`Unknown setup state: ${JSON.stringify(setup satisfies never)}`)
  }

  /**
   * The chain whose last run succeeded, timed as the sum of each step's last success: a retry resumes
   * at the first step without one, so the steps of one chain can come from several attempts.
   */
  private static succeededChainOf(
    history: readonly SessionRecordScriptRun[],
    phase: SessionScriptsBadge['phase'],
  ): ScriptBadgeFacts | null {
    const entries = history.filter((entry) => entry.phase === phase)
    const newest = entries.at(-1)
    if (newest === undefined || newest.outcome !== 'succeeded') return null
    const perStep = new Map<string, SessionRecordScriptRun>()
    for (const entry of entries)
      if (entry.outcome === 'succeeded') perStep.set(entry.stepKey ?? `${entry.scriptId}/${entry.name}`, entry)
    let durationMs = 0
    for (const entry of perStep.values()) durationMs += Math.max(0, entry.endedAt - entry.startedAt)
    return { phase, state: 'succeeded', runId: newest.runId, durationMs }
  }

  private static stepOf(link: SessionRecordScriptLink): ScriptBadgeStep {
    if (link.scriptId === 'setup') return ScriptBadges.setupStepConst
    else if (link.scriptId === 'declared') return { kind: 'declared', name: link.name }
    else if (link.scriptId === 'merge-resolve') throw new Error('The merge resolver carries no badge')
    else if (link.scriptId === 'requested') throw new Error('A requested run carries no badge')
    else if (link.scriptId === 'checks') return { kind: 'declared', name: link.name }
    else if (link.scriptId === 'svn' && link.phase === 'before') return ScriptBadges.checkoutStepConst
    else if (link.scriptId === 'svn' || link.scriptId === 'svn-resolve' || link.scriptId === 'svn-merge' || link.scriptId === 'review')
      throw new Error('An svn, resolver, merger or review run of an SVN action carries no badge')
    else throw new Error(`Unknown script: ${JSON.stringify(link.scriptId satisfies never)}`)
  }

  private static runningTextOf(phase: SessionScriptsBadge['phase'], step: ScriptBadgeStep): string {
    if (phase === 'before') return ScriptBadges.beforeTextOf(step, 'checking out', 'installing dependencies', 'setup')
    else if (phase === 'after') return step.kind === 'setup' ? 'installing dependencies' : `checks: ${ScriptBadges.declaredNameOf(step)}`
    else throw new Error(`Unknown script phase: ${JSON.stringify(phase satisfies never)}`)
  }

  private static failedTextOf(phase: SessionScriptsBadge['phase'], step: ScriptBadgeStep): string {
    if (phase === 'before') return ScriptBadges.beforeTextOf(step, 'checkout failed', 'setup failed', 'setup failed')
    else if (phase === 'after') return step.kind === 'setup' ? 'setup failed' : `checks failed: ${ScriptBadges.declaredNameOf(step)}`
    else throw new Error(`Unknown script phase: ${JSON.stringify(phase satisfies never)}`)
  }

  private static beforeTextOf(step: ScriptBadgeStep, checkout: string, setup: string, declared: string): string {
    if (step.kind === 'checkout') return checkout
    else if (step.kind === 'setup') return setup
    else if (step.kind === 'declared') return `${declared}: ${step.name}`
    else throw new Error(`Unknown chain step: ${JSON.stringify(step satisfies never)}`)
  }

  /** The after chain is the project's own steps only; the dependency install never runs after. */
  private static declaredNameOf(step: ScriptBadgeStep): string {
    if (step.kind === 'declared') return step.name
    else if (step.kind === 'setup') throw new Error('The setup step never runs after the work')
    else if (step.kind === 'checkout') throw new Error('The checkout never runs after the work')
    else throw new Error(`Unknown chain step: ${JSON.stringify(step satisfies never)}`)
  }

  private static capitalized(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1)
  }
}
