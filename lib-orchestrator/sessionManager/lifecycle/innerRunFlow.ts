import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import { ErrorText } from '../../shared/errorText'
import { PathCompare } from '../../shared/pathCompare'
import type { SessionRecord } from '../records/sessionRecord.types'
import type { SessionRecordsStore } from '../records/sessionRecordsStore'
import { ScriptRunRecords } from '../scripts/scriptRunRecords'
import { SessionScriptDefinitions } from '../scripts/sessionScriptDefinitions'
import { SessionLimits } from '../sessionLimits'
import type { SessionScriptRequest, SessionsOpResult } from '../sessionManagerApi.types'
import { SessionWorkingDirectory } from '../sessionWorkingDirectory'
import { OperationOutcomes } from './operationOutcomes'
import { ScriptRunLauncher } from './scriptRunLauncher'

export interface InnerRunFlowDeps {
  records: SessionRecordsStore
  runs: Pick<ScriptRunLauncher, 'launch'>
  newId: () => string
  now: () => number
}

/**
 * The runs a live session asks for: a shell command judged by its exit code, drawn as the session's
 * child and stopped with it. It adds no capability the control API lacks, since the same caller may
 * create a shell and type into it; what it adds is a run that is visible, bounded and judged.
 *
 * Nothing waits for the verdict, so a run is never replayed: a refusal the Host decided ends it, and
 * a run still starting is bound if the Host lists its runtime and lost if not. Which runs collapse
 * and when is `ScriptRunPlanning`'s.
 */
export class InnerRunFlow {
  static readonly liveRunsPerParentMaxConst = 4
  static readonly titleCharactersMaxConst = 80
  private static readonly controlCharactersConst = /[\0\r\n]/

  private readonly records: SessionRecordsStore
  private readonly runs: Pick<ScriptRunLauncher, 'launch'>
  private readonly newId: () => string
  private readonly now: () => number

  constructor(deps: InnerRunFlowDeps) {
    this.records = deps.records
    this.runs = deps.runs
    this.newId = deps.newId
    this.now = deps.now
  }

  /**
   * Record first, launch second, as every run: a client that dies between them leaves a lost run. A
   * launch the Host did not decide answers the run id, since the Host may run it; its verdict comes
   * through `sessions.scripts` once a listing bound it or found it missing.
   */
  async start(parentId: string, request: SessionScriptRequest): Promise<SessionsOpResult<{ runId: string }>> {
    const parent = this.records.get(parentId)
    if (!parent) return OperationOutcomes.notFound(parentId)
    if (parent.scriptOf !== undefined)
      return InnerRunFlow.refusal(`Session ${parentId} is a script run, and a run has no runs of its own`)
    if (parent.life !== 'live')
      return InnerRunFlow.refusal(`Session ${parentId} is not running; a requested run belongs to a running session`)
    const problem = InnerRunFlow.commandProblem(request.command) ?? InnerRunFlow.titleProblem(request.title)
    if (problem !== null) return InnerRunFlow.refusal(problem)
    const cwd = await InnerRunFlow.cwdOf(SessionWorkingDirectory.ofRecord(parent), request.cwd)
    if (!cwd.ok) return InnerRunFlow.refusal(cwd.problem)
    if (this.liveRuns(parentId) >= InnerRunFlow.liveRunsPerParentMaxConst)
      return InnerRunFlow.refusal(`Session ${parentId} already runs ${InnerRunFlow.liveRunsPerParentMaxConst} `
        + 'requested runs; wait for one to end or stop it')
    if (this.records.latched) return OperationOutcomes.latched()
    const name = InnerRunFlow.nameOf(request)
    const run = ScriptRunRecords.shellRun({
      runId: this.newId(),
      operationId: this.newId(),
      link: SessionScriptDefinitions.linkOf(parentId, 'inner', 'requested', name),
      title: name,
      commands: [{ command: request.command, cwd: cwd.value }],
      now: this.now(),
    })
    if (!await this.records.put(run)) return OperationOutcomes.latched()
    const launched = await this.runs.launch(run)
    return launched.ok || ScriptRunLauncher.replayArmed(this.records.get(run.sessionId))
      ? { ok: true, value: { runId: run.sessionId } }
      : launched
  }

  private liveRuns(parentId: string): number {
    return this.records.list().filter((record) => InnerRunFlow.requestedOf(record, parentId)
      && (record.life === 'live' || record.life === 'starting')).length
  }

  private static requestedOf(record: SessionRecord, parentId: string): boolean {
    const link = record.scriptOf
    return link?.sessionId === parentId && link.phase === 'inner' && link.scriptId === 'requested'
  }

  /** One line: the shell gets it whole, and a line break would end the command the log header shows. */
  private static commandProblem(command: string): string | null {
    if (command.trim() === '') return 'The command is empty'
    if (command.length > SessionLimits.scriptCommandCharacters)
      return `The command has ${command.length} characters; at most ${SessionLimits.scriptCommandCharacters} are allowed`
    if (InnerRunFlow.controlCharactersConst.test(command)) return 'The command must be one line, without NUL, CR or LF'
    return null
  }

  /** The title is the row's name in the tree, so it is one short line. */
  private static titleProblem(title: string | undefined): string | null {
    if (title === undefined) return null
    if (title.trim().length > InnerRunFlow.titleCharactersMaxConst)
      return `The title has ${title.trim().length} characters; at most ${InnerRunFlow.titleCharactersMaxConst} are allowed`
    if (InnerRunFlow.controlCharactersConst.test(title)) return 'The title must be one line, without NUL, CR or LF'
    return null
  }

  /** The title, or the start of the command when there is none. */
  private static nameOf(request: SessionScriptRequest): string {
    const title = request.title?.trim() ?? ''
    return title !== '' ? title : request.command.trim().slice(0, InnerRunFlow.titleCharactersMaxConst)
  }

  /**
   * An existing directory inside the session's own place, its worktree when it has one. A relative
   * `cwd` is read from that place; absent, the run starts there. Both are compared after links are
   * followed: a junction inside the place may lead anywhere.
   */
  private static async cwdOf(
    place: string,
    requested: string | undefined,
  ): Promise<{ ok: true; value: string } | { ok: false; problem: string }> {
    const cwd = requested === undefined || requested === ''
      ? resolve(place)
      : isAbsolute(requested) ? resolve(requested) : resolve(place, requested)
    const outside = { ok: false as const, problem: `The directory ${cwd} is outside the session's directory ${place}` }
    if (!PathCompare.isInside(place, cwd)) return outside
    try {
      const realCwd = await realpath(cwd)
      if (!PathCompare.isInside(await realpath(place), realCwd)) return outside
      if (!(await stat(realCwd)).isDirectory()) return { ok: false, problem: `${cwd} is not a directory` }
    } catch (error) {
      return { ok: false, problem: `The directory ${cwd} cannot be used: ${ErrorText.of(error)}` }
    }
    return { ok: true, value: cwd }
  }

  private static refusal(detail: string): { ok: false; code: 'invalid-spec'; detail: string } {
    return { ok: false, code: 'invalid-spec', detail }
  }
}
