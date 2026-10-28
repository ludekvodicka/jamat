import { FinishProjection } from '../../worktrees/worktreeFinish'
import type { HostClient } from '../../hostClient/hostClient'
import { ErrorText } from '../../shared/errorText'
import { LaunchBackoff } from '../lifecycle/launchBackoff'
import { OperationOutcomes } from '../lifecycle/operationOutcomes'
import { SessionWorkflows } from '../lifecycle/sessionWorkflows'
import type {
  SessionRecord,
  SessionRecordLaunchWait,
  SessionRecordScriptLog,
  SessionRecordScriptRun,
} from '../records/sessionRecord.types'
import type { SessionRecordsStore } from '../records/sessionRecordsStore'
import type {
  SessionInfo,
  SessionScriptOutput,
  SessionScriptPhase,
  SessionScriptId,
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

export interface LocalScriptOptions {
  phase?: SessionScriptPhase
  scriptId?: SessionScriptId
  commands?: string[]
  durable?: boolean
  recordStart?: (record: SessionRecord, startedAt: number) => SessionRecord
}

type CollapseOutcome =
  | { kind: 'collapsed' }
  | { kind: 'host-refused'; detail: string }
  | { kind: 'not-collapsed' }

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
  private readonly localRuns = new Map<string, { parentId: string; info: SessionScriptRunInfo; text: string }>()
  private static readonly commandsMaxConst = 8
  private static readonly commandCharactersMaxConst = 300
  /** The install's whole output fits in a thousand rows far more often than the cap of the log does. */
  private static readonly scrollbackRowsConst = 1000
  private static readonly hostRestartedConst = 'the Host restarted before the output was saved'
  private static readonly olderBuildConst = 'ended before this build kept logs'
  private static readonly noReferenceConst = 'Jamat could not capture the output of this command'
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

  async runLocal<T extends { ok: boolean; exitCode?: number }>(parentId: string, runId: string, title: string,
    work: (output: (text: string) => void) => Promise<T>, changed: () => void, options: LocalScriptOptions = {}): Promise<T> {
    const startedAt = this.now()
    const phase = options.phase ?? 'after'
    const scriptId = options.scriptId ?? 'declared'
    const local = { parentId, text: '', info: { runId, phase, scriptId,
      name: title, title, state: 'running' as const, summary: title, startedAt, commands: options.commands ?? [], row: false, log: 'none' as const } }
    let truncated = false
    let pendingSave: Promise<void> | null = null
    let needsSave = false
    const save = (): void => {
      needsSave = true
      if (pendingSave !== null) return
      pendingSave = (async () => {
        while (needsSave) {
          needsSave = false
          await this.logs.write(parentId, runId, local.text)
        }
      })().catch((error: unknown) => { this.report(`Local script log: ${ErrorText.of(error)}`) })
        .finally(() => { pendingSave = null })
    }
    const initial = await this.logs.write(parentId, runId, '')
    if (!initial.ok && options.durable) throw new Error(`The local command log could not be started: ${initial.detail}`)
    const entry: SessionRecordScriptRun = { runId, phase, scriptId, name: title, title,
      commands: options.commands ?? [], startedAt, endedAt: startedAt, outcome: 'lost', reason: 'The client stopped before the command finished',
      log: initial.ok ? { state: 'saved', bytes: 0, truncated: false } : { state: 'unavailable', reason: initial.detail } }
    if (!await this.records.update(parentId, (current) => ({ ...options.recordStart?.(current, startedAt) ?? current,
      scriptRuns: [...current.scriptRuns ?? [], entry] }))) {
      await this.logs.removeRun(parentId, runId)
      throw new Error('The local command could not record its start')
    }
    this.localRuns.set(runId, local)
    changed()
    let succeeded = false
    let exitCode: number | undefined
    try {
      const result = await work((text) => {
        const bytes = Buffer.from(local.text + text, 'utf8')
        truncated ||= bytes.length > ScriptLogText.maxBytesConst
        let start = Math.max(0, bytes.length - ScriptLogText.maxBytesConst)
        while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1
        local.text = bytes.subarray(start).toString('utf8')
        save()
        changed()
      })
      succeeded = result.ok
      exitCode = result.exitCode
      return result
    } finally {
      try {
        await pendingSave
        const endedAt = this.now()
        const saved = await this.logs.write(parentId, runId, local.text)
        if (!saved.ok && options.durable) throw new Error(`The local command log could not be saved: ${saved.detail}`)
        const completed: SessionRecordScriptRun = { ...entry, endedAt, exitCode,
          outcome: succeeded ? 'succeeded' : 'failed', reason: undefined,
          log: saved.ok ? { state: 'saved', bytes: saved.bytes, truncated }
            : { state: 'unavailable', reason: saved.detail } }
        const written = await this.records.update(parentId, (current) => ({ ...current,
          scriptRuns: (current.scriptRuns ?? []).map((run) => run.runId === runId ? completed : run) }))
        if (!written && options.durable) throw new Error('The local command result could not be saved')
      } finally {
        this.localRuns.delete(runId)
        const parent = this.records.get(parentId)
        if (parent === null || SessionWorkflows.endedHistoryOf(this.records.list()).has(parent.sessionId)) await this.parentRemoved(parentId)
        else if (!SessionScriptsManager.entryOf(parent, runId)) await this.logs.removeRun(parentId, runId)
        changed()
      }
    }
  }

  /**
   * Captures the log while the Host still holds the dead runtime and appends the history entry.
   * Idempotent: a run its parent's history already names is not settled twice. False also when the
   * Host could not be asked, so the next pass asks again.
   */
  async settle(runId: string): Promise<boolean> {
    const run = this.records.get(runId)
    const link = run?.scriptOf
    if (!run || !link || link.historyExpired === true || (run.life !== 'ended' && run.life !== 'lost')) return false
    const parent = this.records.get(link.sessionId)
    if (!parent || SessionWorkflows.endedHistoryOf(this.records.list()).has(parent.sessionId) || SessionScriptsManager.entryOf(parent, runId)) return false
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
    const landed = await this.records.update(link.sessionId, (current) => SessionScriptsManager.entryOf(current, runId)
      || this.records.get(runId)?.scriptOf?.historyExpired === true || this.records.get(runId) === null ? null
      : { ...current, scriptRuns: [...current.scriptRuns ?? [], entry] })
    if (!landed) {
      if (this.records.get(link.sessionId) === null) await this.parentRemoved(link.sessionId)
      else if (this.records.get(runId)?.scriptOf?.historyExpired === true || this.records.get(runId) === null)
        await this.logs.removeRun(link.sessionId, runId)
      return false
    }
    if (log.state === 'unavailable') this.unlogged += 1
    return true
  }

  /** `runtimeRemove`, then the record goes without a recovery point; emits `onCollapsed`. */
  async collapse(runId: string): Promise<boolean> {
    return (await this.collapseRun(runId)).kind === 'collapsed'
  }

  private async collapseRun(runId: string): Promise<CollapseOutcome> {
    const run = this.records.get(runId)
    const link = run?.scriptOf
    if (!run || !link || ScriptRunPlanning.liveOrBound(run)) return { kind: 'not-collapsed' }
    const target = OperationOutcomes.targetOf(run)
    if (target) {
      const removed = await this.host.runtimeRemove(target)
      if (!removed.ok) return { kind: 'host-refused', detail: `${removed.code}: ${removed.detail}` }
    }
    if (!await this.records.remove(runId, { recoveryPoint: false })) return { kind: 'not-collapsed' }
    this.stopRefusals.delete(runId)
    this.stopsConfirmed.delete(runId)
    const parent = this.records.get(link.sessionId)
    // A parent that is gone has no tab to hand over to.
    const handoff = parent === null ? 'close' : SessionScriptDefinitions.of(link).handoff
    // A chain step that collapses while the parent waits on the next step hands its tab to that step.
    const next = parent?.life === 'starting' ? parent.pendingSetup?.setupSessionId : undefined
    const handoffTo = next !== undefined && next !== runId && this.records.get(next) !== null ? next : link.sessionId
    this.onCollapsed({ runId, parentId: link.sessionId, handoff, handoffTo })
    return { kind: 'collapsed' }
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
    return this.stopBoundRun(runId)
  }

  /** What the Host answered to the last refused stop of a run, while that refusal stands. */
  stopRefusalOf(runId: string): string | undefined {
    return this.stopRefusals.get(runId)?.reason
  }

  /** A gate needs confirmation, including retained descendants of an already ended root. */
  async confirmStopped(runId: string, manuallyStopped = false): Promise<boolean> {
    if (this.stopsConfirmed.has(runId)) return true
    const run = this.records.get(runId)
    if (run === null) return !this.stopRefusals.has(runId)
    if (run.manuallyStoppedAt !== undefined) return true
    if (manuallyStopped) {
      if (run.life !== 'ended' && run.life !== 'lost') return false
      const target = OperationOutcomes.targetOf(run)
      if (target !== null) {
        const stopped = await this.host.runtimeStop(target, true)
        // A reachable Host still owns known descendants; a person cannot waive a failed kill.
        if (!stopped.ok && run.life !== 'lost' && stopped.code !== 'host-unreachable') return false
      }
      const saved = await this.records.update(runId, (current) => current.life !== run.life
        || current.binding?.hostInstanceId !== run.binding?.hostInstanceId || current.binding?.generation !== run.binding?.generation ? null
        : { ...current, life: 'ended', binding: null, pendingOperationId: undefined, pendingOperationKind: undefined,
          launchWait: undefined, stopRequested: true, manuallyStoppedAt: this.now(), endedAt: current.endedAt ?? this.now() })
      if (!saved) return false
      this.stopRefusals.delete(runId)
      this.stopsConfirmed.add(runId)
      return true
    }
    if (OperationOutcomes.targetOf(run) === null) return run.life === 'ended'
    return this.stopBoundRun(runId)
  }

  private async stopBoundRun(runId: string): Promise<boolean> {
    const run = this.records.get(runId)!
    const target = OperationOutcomes.targetOf(run)!
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
        if (target && !(await this.host.runtimeRemove(target)).ok) continue
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
    if (parent !== null && link.historyExpired !== true && !SessionWorkflows.endedHistoryOf(this.records.list()).has(parent.sessionId) && (run.life === 'ended' || run.life === 'lost')) {
      await this.settle(runId)
      if (!SessionScriptsManager.entryOf(this.records.get(link.sessionId) ?? parent, runId))
        return { ok: false, code: 'live-refused', detail: `The output of script run ${runId} is not saved yet, `
          + 'because the Host could not be asked or the history could not be written; try again in a moment' }
    }
    const collapsed = await this.collapseRun(runId)
    if (collapsed.kind === 'collapsed') return { ok: true, value: undefined }
    if (collapsed.kind === 'host-refused')
      return { ok: false, code: 'live-refused', detail: `The Host did not remove the runtime of script run ${runId} `
        + `(${collapsed.detail}); stop its processes, then remove the row` }
    if (collapsed.kind === 'not-collapsed') return OperationOutcomes.latched()
    throw new Error(`Unknown collapse outcome ${JSON.stringify(collapsed)}`)
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

  async outputOf(parentId: string, runId: string): Promise<SessionsOpResult<SessionScriptOutput>> {
    const parent = this.records.get(parentId)
    if (!parent) return OperationOutcomes.notFound(parentId)
    const local = this.localRuns.get(runId)
    if (local?.parentId === parentId)
      return { ok: true, value: { state: 'running', source: 'live', lines: local.text === '' ? [] : local.text.split('\n'), terminal: null } }
    const run = this.records.get(runId)
    if (run?.scriptOf?.sessionId !== parentId) {
      const entry = SessionScriptsManager.entryOf(parent, runId)
      if (entry === undefined)
        return { ok: false, code: 'not-found', detail: `Session ${parentId} has no script run ${runId}` }
      return this.logOutputOf(parentId, entry)
    }
    const info = SessionScriptsManager.rowInfoOf(run)
    let settled: SessionRecordScriptRun | undefined
    let missingRuntimeReason: string
    switch (info.state) {
      case 'running': missingRuntimeReason = 'the Host has not started it yet'; break
      case 'succeeded':
      case 'failed':
      case 'stopped':
      case 'lost':
        settled = SessionScriptsManager.entryOf(parent, runId)
        missingRuntimeReason = SessionScriptsManager.noReferenceConst
        break
      default: throw new Error(`Unknown script run state: ${JSON.stringify(info.state satisfies never)}`)
    }
    const target = OperationOutcomes.targetOf(run)
    const judged = info.state === 'running' ? null : ScriptRunOutcome.judge(runId, [run], new Map(), SessionScriptDefinitions.wordsOf(run.scriptOf))
    const output: SessionScriptOutput = {
      state: info.state,
      source: 'live',
      lines: [],
      terminal: target,
      ...(judged?.kind === 'failed' ? { failureReason: judged.reason } : {}),
      ...(info.endedAt === undefined ? {} : { endedAt: info.endedAt }),
    }
    if (target === null) {
      if (settled !== undefined) return this.logOutputOf(parentId, settled)
      output.logReason = missingRuntimeReason
      return { ok: true, value: output }
    }
    const inspected = await this.host.runtimeInspect(target, {
      rawTailChars: 0,
      screenScrollbackRows: SessionScriptsManager.scrollbackRowsConst,
    })
    // Collapse can remove the Host runtime while this read is in flight; its saved log takes over.
    if (this.records.get(runId) === null) return this.outputOf(parentId, runId)
    if (!inspected.ok) {
      // Failed gated records outlive their Host runtime; their settled history still owns the output.
      if (settled !== undefined) return this.logOutputOf(parentId, settled)
      return OperationOutcomes.failureOf(inspected)
    }
    const rows = inspected.value.projection?.screenLines
    if (rows === undefined) {
      if (settled !== undefined) return this.logOutputOf(parentId, settled)
      output.logReason = 'the Host answered without the rows of its output'
    }
    else output.lines = SessionScriptsManager.outputLinesOf(rows)
    return { ok: true, value: output }
  }

  private async logOutputOf(parentId: string, entry: SessionRecordScriptRun): Promise<SessionsOpResult<SessionScriptOutput>> {
    const reading = await this.logTextOf(parentId, SessionScriptsManager.settledInfoOf(entry, false))
    return { ok: true, value: {
      state: entry.outcome,
      source: 'log',
      ...(entry.reason === undefined ? {} : { failureReason: entry.reason }),
      lines: reading.log?.text ? reading.log.text.split('\n') : [],
      ...(reading.logDetail === undefined ? {} : { logReason: reading.logDetail }),
      terminal: null,
      endedAt: entry.endedAt,
    } }
  }

  private static outputLinesOf(rows: readonly string[]): readonly string[] {
    const clean = rows.map(ScriptLogText.withoutDimMarkers)
    let used = 0
    let first = clean.length
    while (first > 0) {
      const bytes = Buffer.byteLength(clean[first - 1], 'utf8') + 1
      if (used + bytes > ScriptLogText.maxBytesConst) break
      used += bytes
      first -= 1
    }
    return clean.slice(first)
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
    const actionRun = FinishProjection.action(record)?.runId
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
    const rows = this.records.list().filter((run) => run.scriptOf?.sessionId === parent.sessionId && run.scriptOf.historyExpired !== true)
    const rowIds = new Set(rows.map((run) => run.sessionId))
    const settledIds = new Set(history.map((entry) => entry.runId))
    const runs = [
      ...[...this.localRuns.values()].filter((run) => run.parentId === parent.sessionId).map((run) => run.info),
      ...history.filter((entry) => !this.localRuns.has(entry.runId)).map((entry) => SessionScriptsManager.settledInfoOf(entry, rowIds.has(entry.runId))),
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
      return { ok: false, reason: run.life === 'lost' ? this.goneReasonOf(run) : SessionScriptsManager.noReferenceConst }
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

}
