import type { HostClient } from '../../hostClient/hostClient'
import { ErrorText } from '../../shared/errorText'
import { LaunchBackoff } from '../lifecycle/launchBackoff'
import { OperationOutcomes } from '../lifecycle/operationOutcomes'
import type {
  SessionRecord,
  SessionRecordLaunchWait,
  SessionRecordScriptLog,
  SessionRecordScriptRun,
} from '../records/sessionRecord.types'
import type { SessionRecordsStore } from '../records/sessionRecordsStore'
import type {
  SessionInfo,
  SessionScriptPhase,
  SessionScriptRunInfo,
  SessionScriptsInfo,
  SessionScriptsReading,
  SessionsOpResult,
} from '../sessionManagerApi.types'
import { ScriptBadges } from './scriptBadges'
import { ScriptDuration } from './scriptDuration'
import type { ScriptLogStore } from './scriptLogStore'
import { ScriptLogText } from './scriptLogText'
import { ScriptRunOutcome, type ScriptRunJudgement } from './scriptRunOutcome'
import { ScriptRunPlanning } from './scriptRunPlanning'
import { ScriptRunRecords } from './scriptRunRecords'
import { SessionScriptDefinitions, type SessionScriptHandoff } from './sessionScriptDefinitions'

export type ScriptsHostPort = Pick<HostClient, 'runtimeInspect' | 'runtimeStop' | 'runtimeRemove'>

export interface ScriptCollapsed {
  runId: string
  parentId: string
  handoff: SessionScriptHandoff
  /** The session whose tab takes a `parent-tab` run's place: the next step the parent waits on, else the parent. */
  handoffTo: string
}

export interface SessionScriptsManagerDeps {
  records: SessionRecordsStore
  host: ScriptsHostPort
  logs: ScriptLogStore
  onCollapsed: (event: ScriptCollapsed) => void
  report: (message: string) => void
  now: () => number
}

type ScriptRows =
  | { ok: true; rows: readonly string[] }
  | { ok: false; reason: string }

/**
 * Every script run from its end to its history: the log saved off the Host's dead runtime, the entry
 * written on the parent, and the record removed once nothing names the run any more. What decides
 * WHEN is `ScriptRunPlanning`, read by the reconciler; this class carries each decision out.
 *
 * A collapse spends no recovery point. The history entry and the log hold what went, and a wave of
 * worktree sessions would otherwise push every real recovery point out of the ring of ten.
 */
export class SessionScriptsManager {
  static readonly historyMaxConst = 10
  private static readonly commandsMaxConst = 8
  private static readonly commandCharactersMaxConst = 300
  /** The install's whole output fits in a thousand rows far more often than the cap of the log does. */
  private static readonly scrollbackRowsConst = 1000
  private static readonly hostRestartedConst = 'the Host restarted before the output was saved'
  private static readonly olderBuildConst = 'ended before this build kept logs'
  private static readonly neverRanConst = 'the Host never ran it'
  private static readonly sweepAgeConst = 24 * 60 * 60 * 1000

  private readonly records: SessionRecordsStore
  private readonly host: ScriptsHostPort
  private readonly logs: ScriptLogStore
  private readonly onCollapsed: (event: ScriptCollapsed) => void
  private readonly report: (message: string) => void
  private readonly now: () => number
  /** This client process's start: a run that ended before it ended under whatever build ran then. */
  private readonly startedAt: number
  /** Runs settled without a saved log since the last report of them. */
  private unlogged = 0
  /** The stops the Host refused, per run: when to ask again, and that the refusal was said once. */
  private readonly stopRefusals = new Map<string, SessionRecordLaunchWait>()
  /** Runs whose stop the Host confirmed; the exit it reports next is what moves them on. */
  private readonly stopsConfirmed = new Set<string>()

  constructor(deps: SessionScriptsManagerDeps) {
    this.records = deps.records
    this.host = deps.host
    this.logs = deps.logs
    this.onCollapsed = deps.onCollapsed
    this.report = deps.report
    this.now = deps.now
    this.startedAt = this.now()
  }

  /**
   * Captures the log while the Host still holds the dead runtime and appends the history entry.
   * Idempotent: a run its parent's history already names is not settled twice. False also when the
   * Host could not be asked, so the next pass asks again.
   */
  async settle(runId: string): Promise<boolean> {
    const run = this.records.get(runId)
    const link = run?.scriptOf
    if (!run || !link || (run.life !== 'ended' && run.life !== 'lost')) return false
    const parent = this.records.get(link.sessionId)
    if (!parent || SessionScriptsManager.entryOf(parent, runId)) return false
    // The record is all there is to judge by: an ended run carries the exit code the Host reported.
    const judged = ScriptRunOutcome.judge(runId, [run], new Map(), SessionScriptDefinitions.wordsOf(link))
    if (judged.kind === 'running') return false
    const rows = await this.rowsOf(run)
    if (rows === null) return false
    const endedAt = run.endedAt ?? this.now()
    const log = rows.ok
      ? await this.saved(parent, run, judged, endedAt, rows.rows)
      : { state: 'unavailable' as const, reason: rows.reason }
    const entry: SessionRecordScriptRun = {
      runId,
      phase: link.phase,
      scriptId: link.scriptId,
      name: link.name,
      title: run.title,
      commands: SessionScriptsManager.displayCommandsOf(run),
      startedAt: run.createdAt,
      endedAt,
      outcome: judged.outcome,
      log,
    }
    if (link.stepKey !== undefined) entry.stepKey = link.stepKey
    if (judged.exitCode !== undefined) entry.exitCode = judged.exitCode
    if (judged.kind === 'failed') entry.reason = judged.reason
    let dropped: SessionRecordScriptRun[] = []
    const landed = await this.records.update(link.sessionId, (current) => {
      if (SessionScriptsManager.entryOf(current, runId)) return null
      const history = [...(current.scriptRuns ?? []), entry]
      dropped = this.evictedOf(history)
      return { ...current, scriptRuns: history.filter((old) => !dropped.includes(old)) }
    })
    if (!landed) return false
    for (const old of dropped) await this.removeLog(link.sessionId, old.runId)
    if (log.state === 'unavailable') this.unlogged += 1
    return true
  }

  /**
   * The oldest entries over the cap, skipping every entry whose run record still exists: that entry
   * is what keeps its run settled, and losing it would settle the run again and evict another.
   */
  private evictedOf(history: readonly SessionRecordScriptRun[]): SessionRecordScriptRun[] {
    let excess = history.length - SessionScriptsManager.historyMaxConst
    const evicted: SessionRecordScriptRun[] = []
    for (const entry of history) {
      if (excess <= 0) break
      if (this.records.get(entry.runId) !== null) continue
      evicted.push(entry)
      excess -= 1
    }
    return evicted
  }

  /** Best-effort `runtimeRemove`, then the record goes without a recovery point; emits `onCollapsed`. */
  async collapse(runId: string): Promise<boolean> {
    const run = this.records.get(runId)
    const link = run?.scriptOf
    if (!run || !link || ScriptRunPlanning.liveOrBound(run)) return false
    const target = OperationOutcomes.targetOf(run)
    // The dead entry is only a diagnostic once the record is gone, and the Host's next start drops it.
    if (run.life === 'ended' && target) await this.host.runtimeRemove(target)
    if (!await this.records.remove(runId, { recoveryPoint: false })) return false
    this.stopRefusals.delete(runId)
    this.stopsConfirmed.delete(runId)
    const parent = this.records.get(link.sessionId)
    // A parent that is gone has no tab to hand over to.
    const handoff = parent === null ? 'close' : SessionScriptDefinitions.of(link).handoff
    // A chain step that collapses while the parent waits on the next step hands its tab to that step.
    const next = parent?.life === 'starting' ? parent.pendingSetup?.setupSessionId : undefined
    const handoffTo = next !== undefined && next !== runId && this.records.get(next) !== null ? next : link.sessionId
    this.onCollapsed({ runId, parentId: link.sessionId, handoff, handoffTo })
    return true
  }

  /**
   * A stop with `stopRequested`, written after the Host confirmed it, the way `SessionLifecycle.stop`
   * writes it. A refused stop is said once per run and asked again on the `LaunchBackoff` pace; one
   * the Host confirmed is not asked again. A run no gate waits on is marked on a refusal too, because
   * the Host's "did not confirm its death" is usually a process that dies a second later, and on
   * POSIX a killed process reports 0.
   */
  async stopRun(runId: string): Promise<boolean> {
    const run = this.records.get(runId)
    const target = run === null ? null : OperationOutcomes.targetOf(run)
    if (!run || !target || !ScriptRunPlanning.liveOrBound(run) || this.stopsConfirmed.has(runId)) return false
    const refused = this.stopRefusals.get(runId)
    if (!LaunchBackoff.due(refused, this.now())) return false
    const stopped = await this.host.runtimeStop(target)
    if (!stopped.ok) {
      this.stopRefusals.set(runId, LaunchBackoff.after(refused, stopped.detail, this.now()))
      if (refused === undefined)
        this.report(`The script run ${runId} could not be stopped (${stopped.code}: ${stopped.detail}); `
          + `it may still be running for ${run.scriptOf?.sessionId ?? 'nobody'}`)
      if (run.scriptOf !== undefined && SessionScriptDefinitions.of(run.scriptOf).gate === null)
        await this.markStopRequested(runId)
      return false
    }
    this.stopRefusals.delete(runId)
    this.stopsConfirmed.add(runId)
    await this.markStopRequested(runId)
    return true
  }

  private async markStopRequested(runId: string): Promise<void> {
    await this.records.update(runId, (current) => current.stopRequested ? null : { ...current, stopRequested: true })
  }

  /**
   * A parent the Host confirmed stopped: its runs that stop with it are stopped now. A restart brings
   * the parent back to live before any planning pass sees it ended, so the planning rule alone would
   * leave them running. A gated run is not one of them: its gate's own rules judge it.
   */
  async stopWithParent(parentId: string): Promise<void> {
    for (const run of this.records.list())
      if (run.scriptOf?.sessionId === parentId && SessionScriptDefinitions.of(run.scriptOf).stopsWithParent
        && ScriptRunPlanning.liveOrBound(run) && !run.stopRequested) await this.stopRun(run.sessionId)
  }

  /**
   * A parent removal: live runs are stopped, and the planning removes each once it ended; every other
   * run joins the parent's one destructive write, its dead runtime asked away first.
   */
  async cascadeOf(parent: SessionRecord): Promise<{ removeWith: readonly string[] }> {
    const removeWith: string[] = []
    for (const run of this.records.list().filter((record) => record.scriptOf?.sessionId === parent.sessionId)) {
      const target = OperationOutcomes.targetOf(run)
      if (ScriptRunPlanning.liveOrBound(run)) await this.stopRun(run.sessionId)
      else {
        if (run.life === 'ended' && target) await this.host.runtimeRemove(target)
        removeWith.push(run.sessionId)
      }
    }
    return { removeWith }
  }

  /**
   * Chain evidence for a before gate an older build wrote without its steps: the step keys a run of
   * this parent succeeded at, started at or after `since`. Read off the history, so a step counts
   * once its run settled.
   */
  succeededKeys(parent: SessionRecord, phase: SessionScriptPhase, since: number): ReadonlySet<string> {
    const keys = new Set<string>()
    for (const entry of parent.scriptRuns ?? [])
      if (entry.phase === phase && entry.outcome === 'succeeded' && entry.stepKey !== undefined
        && entry.startedAt >= since) keys.add(entry.stepKey)
    return keys
  }

  /** After the parent's removal landed: its logs go with its history. */
  async parentRemoved(parentId: string): Promise<void> {
    try {
      await this.logs.removeParent(parentId)
    } catch (error) {
      this.report(`The script logs of session ${parentId} could not be removed: ${ErrorText.of(error)}`)
    }
  }

  /**
   * Remove on a run row: settle, then collapse. Refused while the run is live, while its gate still
   * waits for its verdict, and while its history entry could not be written: removed then, the gate
   * would read the gone record as a failure, and the person would lose what the run did.
   */
  async dismiss(runId: string): Promise<SessionsOpResult> {
    const run = this.records.get(runId)
    const link = run?.scriptOf
    if (!run || !link) return OperationOutcomes.notFound(runId)
    if (ScriptRunPlanning.liveOrBound(run))
      return { ok: false, code: 'live-refused', detail: `The script run ${runId} is ${run.life}; stop it before removing it` }
    const parent = this.records.get(link.sessionId)
    if (parent !== null && SessionScriptDefinitions.awaitsVerdictOf(runId, link, parent))
      return { ok: false, code: 'live-refused', detail: `The script run ${runId} is still being judged for `
        + `session ${link.sessionId}; remove it once its verdict is written` }
    if (parent !== null && (run.life === 'ended' || run.life === 'lost')) {
      await this.settle(runId)
      if (!SessionScriptsManager.entryOf(this.records.get(link.sessionId) ?? parent, runId))
        return { ok: false, code: 'live-refused', detail: `The output of script run ${runId} is not saved yet, `
          + 'because the Host could not be asked or the history could not be written; try again in a moment' }
    }
    if (!await this.collapse(runId)) return OperationOutcomes.latched()
    return { ok: true, value: undefined }
  }

  /**
   * The main-side proof a log needs before anything opens it: the parent's history names the run with
   * a saved log, and the file is there. The caller's own idea of the path is never asked.
   */
  async scriptLogOf(parentId: string, runId: string): Promise<SessionsOpResult<{ path: string }>> {
    const parent = this.records.get(parentId)
    if (!parent) return OperationOutcomes.notFound(parentId)
    const entry = SessionScriptsManager.entryOf(parent, runId)
    if (entry === undefined)
      return { ok: false, code: 'not-found', detail: `Session ${parentId} has no script run ${runId} in its history` }
    if (entry.log.state !== 'saved')
      return { ok: false, code: 'not-found', detail: `The script run ${runId} has no saved log` }
    try {
      const path = await this.logs.existingPathOf(parentId, runId)
      if (path === null) return { ok: false, code: 'not-found', detail: `The log of script run ${runId} is gone` }
      return { ok: true, value: { path } }
    } catch (error) {
      return { ok: false, code: 'not-found', detail: `The log of script run ${runId} could not be read: ${ErrorText.of(error)}` }
    }
  }

  /**
   * The runs of a parent as the `Scripts` menu lists them, and with `runId` that run's saved log text.
   * A run the parent never had is `not-found`; a run without a log answers why in `logDetail`.
   */
  async scriptsOf(parentId: string, runId?: string): Promise<SessionsOpResult<SessionScriptsReading>> {
    const parent = this.records.get(parentId)
    if (!parent) return OperationOutcomes.notFound(parentId)
    const runs = this.runsOf(parent, true)
    if (runId === undefined) return { ok: true, value: { sessionId: parentId, runs, log: null } }
    const run = runs.find((candidate) => candidate.runId === runId)
    if (run === undefined)
      return { ok: false, code: 'not-found', detail: `Session ${parentId} has no script run ${runId}` }
    const log = await this.logTextOf(parentId, run)
    return { ok: true, value: { sessionId: parentId, runs, ...log } }
  }

  /**
   * At load: the log folders of parents that no record names any more and that nothing wrote to for
   * a day. Old runs settle by the planning. A records file that could not be read, or is not there,
   * names no session at all, so nothing is swept then; `parentRemoved` already takes the logs of a
   * parent removed here, so this only catches what a crash between the two left.
   */
  async sweep(): Promise<void> {
    if (this.records.latched || !this.records.loadedFromFile) return
    try {
      await this.logs.sweep(new Set(this.records.list().map((record) => record.sessionId)),
        this.now() - SessionScriptsManager.sweepAgeConst)
    } catch (error) {
      this.report(`The script logs could not be swept: ${ErrorText.of(error)}`)
    }
  }

  /** One line for every run settled without a log since the last one, so an upgrade says it once. */
  reportUnlogged(): void {
    if (this.unlogged === 0) return
    this.report(`${this.unlogged} script run${this.unlogged === 1 ? ' was' : 's were'} settled without a saved log; `
      + 'each history entry says why')
    this.unlogged = 0
  }

  /**
   * The snapshot's view of the runs: the link on a run, and on a parent its runs, its badge and the
   * run its launch waits for. No I/O and no clock, because it is composed on every recompose and the
   * whole composition is compared to decide whether anything changed.
   */
  infoOf(record: SessionRecord): Pick<SessionInfo, 'script' | 'scripts'> {
    const info: Pick<SessionInfo, 'script' | 'scripts'> = {}
    if (record.scriptOf !== undefined)
      info.script = { parentId: record.scriptOf.sessionId, phase: record.scriptOf.phase, scriptId: record.scriptOf.scriptId }
    const runs = this.runsOf(record, false)
    const pending = record.pendingSetup
    const checks = record.finishChecks
    // The after chain is the newer fact while it is on the record: a Finish press comes after the
    // before chain, and a reopen, which runs the session again, clears it.
    const actionRun = record.svnAction?.runId
    const badge = ScriptBadges.actionOf(record, actionRun === undefined ? null : this.records.get(actionRun))
      ?? ScriptBadges.afterOf(record, checks === undefined ? null : this.records.get(checks.runId))
      ?? ScriptBadges.beforeOf(record, pending === undefined ? null : this.records.get(pending.setupSessionId))
    const waitingOn = record.life === 'starting' ? pending?.setupSessionId : undefined
    if (runs.length === 0 && badge === null && waitingOn === undefined) return info
    const scripts: SessionScriptsInfo = { runs }
    if (badge !== null) scripts.badge = ScriptBadges.of(badge)
    if (waitingOn !== undefined) scripts.waitingOn = waitingOn
    info.scripts = scripts
    return info
  }

  /**
   * Rows and history together, newest first: a settled run that is still a row is one entry.
   *
   * `requestedCommands` false leaves out the commands of a requested run. The snapshot reaches every
   * paired peer through `sessions.list`, and a command an agent typed may carry a token; the
   * local-only `sessions.scripts` and the log header keep them.
   */
  private runsOf(parent: SessionRecord, requestedCommands: boolean): SessionScriptRunInfo[] {
    const history = parent.scriptRuns ?? []
    const rows = this.records.list().filter((run) => run.scriptOf?.sessionId === parent.sessionId)
    const rowIds = new Set(rows.map((run) => run.sessionId))
    const settledIds = new Set(history.map((entry) => entry.runId))
    const runs = [
      ...history.map((entry) => SessionScriptsManager.settledInfoOf(entry, rowIds.has(entry.runId))),
      ...rows.filter((run) => !settledIds.has(run.sessionId)).map((run) => SessionScriptsManager.rowInfoOf(run)),
    ]
    if (!requestedCommands)
      for (const run of runs) if (run.phase === 'inner' && run.scriptId === 'requested') run.commands = []
    return runs.sort((left, right) => right.startedAt - left.startedAt)
  }

  private static settledInfoOf(entry: SessionRecordScriptRun, row: boolean): SessionScriptRunInfo {
    const durationText = ScriptDuration.text(entry.endedAt - entry.startedAt)
    const info: SessionScriptRunInfo = {
      runId: entry.runId,
      phase: entry.phase,
      scriptId: entry.scriptId,
      name: entry.name,
      title: entry.title,
      state: entry.outcome,
      summary: ScriptBadges.summaryOf({ title: entry.title, state: entry.outcome, exitCode: entry.exitCode, durationText }),
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      durationText,
      commands: entry.commands,
      row,
      log: entry.log.state,
    }
    if (entry.exitCode !== undefined) info.exitCode = entry.exitCode
    if (entry.log.state === 'unavailable') info.logDetail = entry.log.reason
    return info
  }

  /**
   * A run not settled yet, judged off its own record by the ladder its history entry will be written
   * from. A `live` record is running whatever the Host's last listing said: the reconciler moves the
   * record, and a listing missed while the Host was unreachable must not flip the row to lost and back.
   */
  private static rowInfoOf(run: SessionRecord): SessionScriptRunInfo {
    const link = run.scriptOf
    if (link === undefined) throw new Error(`Session ${run.sessionId} is not a script run`)
    const judged = run.life === 'live'
      ? { kind: 'running' as const }
      : ScriptRunOutcome.judge(run.sessionId, [run], new Map(), SessionScriptDefinitions.wordsOf(link))
    const state = judged.kind === 'running' ? 'running' : judged.outcome
    const info: SessionScriptRunInfo = {
      runId: run.sessionId,
      phase: link.phase,
      scriptId: link.scriptId,
      name: link.name,
      title: run.title,
      state,
      summary: '',
      startedAt: run.createdAt,
      commands: SessionScriptsManager.displayCommandsOf(run),
      row: true,
      log: 'none',
    }
    if (judged.kind !== 'running') {
      if (run.endedAt !== undefined) {
        info.endedAt = run.endedAt
        info.durationText = ScriptDuration.text(run.endedAt - run.createdAt)
      }
      if (judged.exitCode !== undefined) info.exitCode = judged.exitCode
    }
    info.summary = ScriptBadges.summaryOf(info)
    return info
  }

  /** A display copy: the log header keeps every command in full. */
  private static displayCommandsOf(run: SessionRecord): string[] {
    return ScriptRunRecords.commandsOf(run).slice(0, SessionScriptsManager.commandsMaxConst)
      .map((step) => step.command.slice(0, SessionScriptsManager.commandCharactersMaxConst))
  }

  private async logTextOf(
    parentId: string,
    run: SessionScriptRunInfo,
  ): Promise<Pick<SessionScriptsReading, 'log' | 'logDetail'>> {
    if (run.state === 'running') return { log: null, logDetail: 'running; read it with terminal peek' }
    if (run.log === 'none') return { log: null, logDetail: 'ended and not saved yet; read it again in a moment' }
    else if (run.log === 'unavailable') return { log: null, logDetail: run.logDetail ?? 'no log was saved' }
    else if (run.log !== 'saved') throw new Error(`Unknown script log state: ${JSON.stringify(run.log)}`)
    try {
      const read = await this.logs.read(parentId, run.runId, ScriptLogText.maxBytesConst)
      if (read === null) return { log: null, logDetail: 'the saved log is gone' }
      return { log: { runId: run.runId, ...read } }
    } catch (error) {
      return { log: null, logDetail: `the saved log could not be read: ${ErrorText.of(error)}` }
    }
  }

  private static entryOf(parent: SessionRecord, runId: string): SessionRecordScriptRun | undefined {
    return parent.scriptRuns?.find((entry) => entry.runId === runId)
  }

  /** The rows the Host still holds for the dead runtime, why there are none, or null to ask again later. */
  private async rowsOf(run: SessionRecord): Promise<ScriptRows | null> {
    const target = OperationOutcomes.targetOf(run)
    if (target === null)
      return { ok: false, reason: run.life === 'lost' ? this.goneReasonOf(run) : SessionScriptsManager.neverRanConst }
    const inspected = await this.host.runtimeInspect(target, {
      rawTailChars: 0,
      screenScrollbackRows: SessionScriptsManager.scrollbackRowsConst,
    })
    if (!inspected.ok) {
      if (inspected.code !== 'op-rejected') return null
      return {
        ok: false,
        reason: inspected.status === 404 ? this.goneReasonOf(run) : `the Host could not read its output (${inspected.detail})`,
      }
    }
    const rows = inspected.value.projection?.screenLines
    if (rows === undefined) return { ok: false, reason: 'the Host answered without the rows of its output' }
    return { ok: true, rows }
  }

  private goneReasonOf(run: SessionRecord): string {
    return run.endedAt !== undefined && run.endedAt < this.startedAt
      ? SessionScriptsManager.olderBuildConst
      : SessionScriptsManager.hostRestartedConst
  }

  private async saved(
    parent: SessionRecord,
    run: SessionRecord,
    judged: Exclude<ScriptRunJudgement, { kind: 'running' }>,
    endedAt: number,
    rows: readonly string[],
  ): Promise<SessionRecordScriptLog> {
    const link = run.scriptOf
    if (link === undefined) throw new Error(`Session ${run.sessionId} is not a script run`)
    const { text, truncated } = ScriptLogText.of({
      phase: link.phase,
      scriptId: link.scriptId,
      name: link.name,
      parentId: parent.sessionId,
      parentTitle: parent.title,
      runId: run.sessionId,
      startedAt: run.createdAt,
      endedAt,
      exitCode: judged.exitCode,
      reason: judged.kind === 'failed' ? judged.reason : undefined,
      commands: ScriptRunRecords.commandsOf(run),
    }, rows)
    const written = await this.logs.write(parent.sessionId, run.sessionId, text)
    return written.ok
      ? { state: 'saved', bytes: written.bytes, truncated }
      : { state: 'unavailable', reason: `the log could not be written (${written.detail})` }
  }

  private async removeLog(parentId: string, runId: string): Promise<void> {
    try {
      await this.logs.removeRun(parentId, runId)
    } catch (error) {
      this.report(`The log of script run ${runId} could not be removed: ${ErrorText.of(error)}`)
    }
  }
}
