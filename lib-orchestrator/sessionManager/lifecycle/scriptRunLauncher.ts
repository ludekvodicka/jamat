import type { RuntimeLaunchSpec, RuntimeResult } from '../../../app-host/app/wire/hostWire.js'
import type { SessionRecord } from '../records/sessionRecord.types'
import type { SessionsOpResult } from '../sessionManagerApi.types'
import { OperationOutcomes } from './operationOutcomes'
import type { SessionHostPort } from './sessionLifecycle'

/** What the lifecycle does for a launched run: the record writes every other launch makes too. */
export interface ScriptRunLaunchPort {
  plannedLaunch(record: SessionRecord, launch: 'create' | 'reopen'): RuntimeLaunchSpec
  /** Why this run cannot be planned on this machine (a direct-process tool that is not there), or null. */
  launchProblem(record: SessionRecord): string | null
  bindLive(record: SessionRecord, result: RuntimeResult): Promise<boolean>
  endRefused(record: SessionRecord, detail: string): Promise<void>
  markLaunchWait(sessionId: string, reason: string): Promise<void>
}

export interface ScriptRunLauncherDeps {
  host: Pick<SessionHostPort, 'runtimeCreate'>
  launch: ScriptRunLaunchPort
}

/** The one launch of a scripted shell run, shared by every flow that starts one. */
export class ScriptRunLauncher {
  private readonly host: Pick<SessionHostPort, 'runtimeCreate'>
  private readonly port: ScriptRunLaunchPort

  constructor(deps: ScriptRunLauncherDeps) {
    this.host = deps.host
    this.port = deps.launch
  }

  /**
   * The run record is already written, `starting` under its pending pair. A refusal the Host DECIDED
   * ends the run carrying its words, and the gate that waits on it is judged by that next pass;
   * anything undecided keeps the pending pair, paced, because the Host may have started the process
   * all the same. The next listing decides: a runtime the Host lists is bound, and one it does not
   * list is replayed under the same id, or lost for a run that is not replayable.
   */
  async launch(run: SessionRecord): Promise<SessionsOpResult> {
    if (run.pendingOperationId === undefined) throw new Error(`Script run ${run.sessionId} names no launch`)
    if (run.scriptOf === undefined) throw new Error(`Session ${run.sessionId} is not a script run`)
    // Decided here, not by the Host: a tool missing now stays missing, so replaying it would be a loop.
    const problem = this.port.launchProblem(run)
    if (problem !== null) {
      await this.port.endRefused(run, problem)
      return { ok: false, code: 'spawn-failed', detail: problem }
    }
    const result = await this.host.runtimeCreate({
      operationId: run.pendingOperationId,
      runtimeSessionId: run.sessionId,
      launch: this.port.plannedLaunch(run, 'create'),
    })
    if (!result.ok) {
      if (OperationOutcomes.decided(result)) await this.port.endRefused(run, result.detail)
      else await this.port.markLaunchWait(run.sessionId, result.detail)
      return OperationOutcomes.failureOf(result)
    }
    await this.port.bindLive(run, result.value)
    return { ok: true, value: undefined }
  }

  /**
   * After a failed `launch`: the run is still `starting` under its pending pair, so the reconciler
   * replays it and the chain it belongs to goes on. A caller answers such a launch as started, never
   * as failed, since a pass may yet run it and act on its verdict.
   */
  static replayArmed(run: SessionRecord | null): boolean {
    return run?.life === 'starting' && run.pendingOperationId !== undefined
  }
}
