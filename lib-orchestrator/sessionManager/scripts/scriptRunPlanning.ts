import type { SessionRecord } from '../records/sessionRecord.types'
import { SessionWorkflows } from '../lifecycle/sessionWorkflows'
import { SessionScriptDefinitions, type SessionScriptDefinition } from './sessionScriptDefinitions'

/**
 * What the manager does to a run. `stop` ends one whose parent no longer runs while it still does;
 * `settle` captures the log of one that is over and writes its history entry on the parent;
 * `collapse` removes its record once nothing names it any more.
 */
export type ScriptRunChange =
  | { kind: 'stop-script-run'; runId: string }
  | { kind: 'settle-script-run'; runId: string }
  | { kind: 'collapse-script-run'; runId: string }

/** The pure half of the scripts manager: records and the Host's runtimes in, the changes they call for out. */
export class ScriptRunPlanning {
  /** Each settle is one `runtime.inspect`; an upgrade with many old runs spreads them over passes. */
  static readonly settlesPerPassConst = 4

  /** `runtimes`: the ids the Host's listing names, alive or dead. */
  static changes(records: readonly SessionRecord[], runtimes: ReadonlySet<string>): ScriptRunChange[] {
    const endedHistory = SessionWorkflows.endedHistoryOf(records)
    const byId = new Map(records.map((record) => [record.sessionId, record]))
    const out: ScriptRunChange[] = []
    let settles = 0
    for (const run of records) {
      if (run.scriptOf === undefined) continue
      const definition = SessionScriptDefinitions.of(run.scriptOf)
      const parent = byId.get(run.scriptOf.sessionId)
      // Asked on every pass while a process may stand behind it: the manager paces a stop the Host
      // refused and skips one it confirmed, and the Host's report of the exit moves the run on.
      if (ScriptRunPlanning.liveOrBound(run)
        && (parent === undefined || run.scriptOf.historyExpired === true || (definition.stopsWithParent && !ScriptRunPlanning.running(parent))
          || (definition.gate === 'action' && definition.pointerOf(parent) !== run.sessionId))) {
        out.push({ kind: 'stop-script-run', runId: run.sessionId })
        continue
      }
      if (ScriptRunPlanning.neverLaunched(run, parent, definition, runtimes)) {
        out.push({ kind: 'collapse-script-run', runId: run.sessionId })
        continue
      }
      if (run.life !== 'ended' && run.life !== 'lost') continue
      // Nobody is left to keep a history for, so the run simply goes. One still starting is first
      // marked lost by the orphan rule, and one still running is stopped by the rule above.
      if (parent === undefined || run.scriptOf.historyExpired === true || endedHistory.has(parent.sessionId)) {
        out.push({ kind: 'collapse-script-run', runId: run.sessionId })
        continue
      }
      if (!ScriptRunPlanning.settled(parent, run.sessionId)) {
        if (settles < ScriptRunPlanning.settlesPerPassConst)
          out.push({ kind: 'settle-script-run', runId: run.sessionId })
        settles += 1
        continue
      }
      if (ScriptRunPlanning.collapses(run, parent, definition, records))
        out.push({ kind: 'collapse-script-run', runId: run.sessionId })
    }
    return out
  }

  /** A runtime may stand behind it: live, or starting over a binding the Host answered. */
  static liveOrBound(run: SessionRecord): boolean {
    return run.life === 'live' || (run.life === 'starting' && run.binding !== null)
  }

  /**
   * A gated run still starting that its gate never named, with no answer from the Host and no
   * runtime there: its record was written and the pointer write after it did not land. Nothing was
   * ever launched for it, so it goes without a history entry that would show an attempt that never
   * existed. The orphan rule marks it lost in the same pass; this removes it.
   */
  private static neverLaunched(
    run: SessionRecord,
    parent: SessionRecord | undefined,
    definition: SessionScriptDefinition,
    runtimes: ReadonlySet<string>,
  ): boolean {
    if (run.life !== 'starting' || run.binding !== null || runtimes.has(run.sessionId)) return false
    if (parent === undefined || definition.gate === null) return false
    return definition.pointerOf(parent) !== run.sessionId
      && !ScriptRunPlanning.settled(parent, run.sessionId)
  }

  private static settled(parent: SessionRecord, runId: string): boolean {
    return parent.scriptRuns?.some((entry) => entry.runId === runId) ?? false
  }

  /** Only a live parent runs: `starting`, `ended` and `lost` all stop a run that stops with its parent. */
  private static running(parent: SessionRecord): boolean {
    return parent.life === 'live'
  }

  /**
   * A run its gate no longer names is history: superseded by a retry, or past a gate that moved on.
   * A named run stays while its gate still judges, and after that only a success goes: a failed run
   * its gate names is what the parent is blocked on, and its row is where a person reads why.
   *
   * A run no gate waits for goes at once after a success. A failure stays a row for whoever asked
   * for it, until that parent asks for another run of the same kind or no longer runs.
   */
  private static collapses(
    run: SessionRecord,
    parent: SessionRecord,
    definition: SessionScriptDefinition,
    records: readonly SessionRecord[],
  ): boolean {
    const entry = parent.scriptRuns?.find((candidate) => candidate.runId === run.sessionId)
    if (definition.gate === null)
      return entry?.outcome === 'succeeded' || !ScriptRunPlanning.running(parent)
        || ScriptRunPlanning.superseded(run, parent, records)
    if (definition.pointerOf(parent) !== run.sessionId) return true
    return entry?.outcome === 'succeeded' && !SessionScriptDefinitions.judging(definition.gate, parent)
  }

  /**
   * The parent asked for a run of the same kind after this one, read off its records and its history
   * both, so a newer run that already succeeded and collapsed still counts.
   */
  private static superseded(run: SessionRecord, parent: SessionRecord, records: readonly SessionRecord[]): boolean {
    const link = run.scriptOf
    if (link === undefined) return false
    const same = (other: { phase: string; scriptId: string }): boolean =>
      other.phase === link.phase && other.scriptId === link.scriptId
    return records.some((other) => other.scriptOf?.sessionId === parent.sessionId && same(other.scriptOf)
      && other.createdAt > run.createdAt)
      || (parent.scriptRuns ?? []).some((entry) => same(entry) && entry.startedAt > run.createdAt)
  }
}
