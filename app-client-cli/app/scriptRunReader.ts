import type {
  RemoteControlErrorCode,
  RemoteControlResponse,
  RemoteControlSessionScriptsDto,
  RemoteControlStepResult,
} from '../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { SessionScriptRunInfo } from '../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { ErrorText } from '../../lib-orchestrator/shared/errorText'
import { JsonShape } from '../../lib-orchestrator/shared/jsonShape'
import { AppClientCliError } from './appClientCliError'

export interface ScriptRunReaderDeps {
  /** One `sessions.scripts` read of the run's parent, with the run's id. */
  read(): Promise<RemoteControlResponse>
  now(): number
  pause(milliseconds: number, signal?: AbortSignal): Promise<void>
}

/** What `--wait` answers for a run that succeeded. */
export interface ScriptRunSucceeded {
  sessionId: string
  runId: string
  state: 'succeeded'
  exitCode: number
  logContentUntrusted: true
  log: { text: string; truncated: boolean } | null
  logDetail?: string
}

/**
 * The `--wait` of `sessions scripts run`: the run is read once a second until it is over and its log
 * was saved, because the verdict and the log arrive together in the run's history entry. A run that
 * did not succeed answers as a failure, so a caller tells the two apart by the exit code alone. A read
 * that fails on the way is tried again until the deadline; a refusal that cannot change ends it.
 */
export class ScriptRunReader {
  static readonly timeoutMillisecondsConst = 600_000
  static readonly timeoutMaximumMillisecondsConst = 3_600_000
  private static readonly pollMillisecondsConst = 1_000
  private static readonly retryMillisecondsConst = 250
  private static readonly statesConst: readonly string[] = ['running', 'succeeded', 'failed', 'stopped', 'lost']
  private static readonly logStatesConst: readonly string[] = ['saved', 'unavailable', 'none']

  private readonly deps: ScriptRunReaderDeps

  constructor(deps: ScriptRunReaderDeps) {
    this.deps = deps
  }

  async read(runId: string, timeoutMs: number, signal?: AbortSignal): Promise<RemoteControlStepResult<ScriptRunSucceeded>> {
    const deadline = this.deps.now() + timeoutMs
    let failures = 0
    for (;;) {
      if (signal?.aborted)
        throw new AppClientCliError('operation-failed', `Stopped waiting for script run ${runId}; it may still be running`)
      const answer = await this.deps.read().catch((error: unknown) =>
        new AppClientCliError('operation-failed', `Cannot read script run ${runId}; its outcome is unknown: ${ErrorText.of(error)}`))
      if (answer instanceof AppClientCliError) {
        if (this.deps.now() >= deadline) throw answer
        failures += 1
        await this.pause(runId, ScriptRunReader.backoffOf(failures), deadline, signal)
        continue
      }
      if (!answer.ok) {
        const refusal = { ok: false as const, error: { ...answer.error,
          detail: `Script run ${runId}: ${answer.error.detail}`,
          data: { ...JsonShape.record(answer.error.data), runId } } }
        if (!ScriptRunReader.transient(answer.error.code) || this.deps.now() >= deadline) return refusal
        failures += 1
        await this.pause(runId, ScriptRunReader.backoffOf(failures), deadline, signal)
        continue
      }
      failures = 0
      const reading = ScriptRunReader.readingOf(answer.value)
      const run: unknown = reading?.runs.find((candidate: unknown) => JsonShape.isRecord(candidate) && candidate.runId === runId)
      if (reading === null || !ScriptRunReader.validRun(run))
        throw new AppClientCliError('operation-failed', `Invalid answer for script run ${runId}; its outcome is unknown`)
      if (ScriptRunReader.over(run)) return ScriptRunReader.verdict(reading, run)
      if (this.deps.now() >= deadline)
        throw new AppClientCliError('timeout', `Script run ${runId} is still running; read it with sessions scripts --run-id ${runId}`)
      await this.pause(runId, ScriptRunReader.pollMillisecondsConst, deadline, signal)
    }
  }

  private async pause(runId: string, milliseconds: number, deadline: number, signal?: AbortSignal): Promise<void> {
    await this.deps.pause(Math.min(milliseconds, deadline - this.deps.now()), signal).catch((error: unknown) => {
      throw new AppClientCliError('operation-failed', `Stopped waiting for script run ${runId}; it may still be running: ${ErrorText.of(error)}`)
    })
  }

  /** A busy or restarting AppClientUI answers again; a session or request it refuses does not change. */
  private static transient(code: RemoteControlErrorCode): boolean {
    if (code === 'unavailable' || code === 'timeout' || code === 'conflict' || code === 'operation-failed') return true
    else if (code === 'not-found' || code === 'invalid-request' || code === 'forbidden' || code === 'protocol-mismatch')
      return false
    else throw new Error(`Unknown remote control error code: ${JSON.stringify(code satisfies never)}`)
  }

  private static backoffOf(failures: number): number {
    return Math.min(ScriptRunReader.retryMillisecondsConst * 2 ** (failures - 1), ScriptRunReader.pollMillisecondsConst * 4)
  }

  /** Over and settled: the history entry, and with it the log, exists. */
  private static over(run: SessionScriptRunInfo): boolean {
    if (run.state === 'running') return false
    else if (run.state === 'succeeded' || run.state === 'failed' || run.state === 'stopped' || run.state === 'lost')
      return run.log !== 'none'
    else throw new Error(`Unknown script run state: ${JSON.stringify(run.state)}`)
  }

  private static verdict(
    reading: RemoteControlSessionScriptsDto,
    run: SessionScriptRunInfo,
  ): RemoteControlStepResult<ScriptRunSucceeded> {
    const log = reading.log?.runId === run.runId ? { text: reading.log.text, truncated: reading.log.truncated } : null
    const logDetail = reading.logDetail === undefined ? {} : { logDetail: reading.logDetail }
    if (run.state !== 'succeeded')
      return {
        ok: false,
        error: {
          code: 'operation-failed',
          detail: `Script run ${run.runId} did not succeed: ${run.summary}`,
          data: { run, logContentUntrusted: true, log, ...logDetail },
        },
      }
    return {
      ok: true,
      value: {
        sessionId: reading.sessionId,
        runId: run.runId,
        state: 'succeeded',
        exitCode: run.exitCode ?? 0,
        logContentUntrusted: true,
        log,
        ...logDetail,
      },
    }
  }

  private static readingOf(value: unknown): RemoteControlSessionScriptsDto | null {
    if (!JsonShape.isRecord(value) || typeof value.sessionId !== 'string' || value.logContentUntrusted !== true
      || !Array.isArray(value.runs)) return null
    const log = value.log
    if (log !== null && !(JsonShape.isRecord(log) && typeof log.runId === 'string' && typeof log.text === 'string'
      && typeof log.truncated === 'boolean')) return null
    return value as unknown as RemoteControlSessionScriptsDto
  }

  private static validRun(run: unknown): run is SessionScriptRunInfo {
    return JsonShape.isRecord(run) && typeof run.runId === 'string' && typeof run.summary === 'string'
      && typeof run.state === 'string' && ScriptRunReader.statesConst.includes(run.state)
      && typeof run.log === 'string' && ScriptRunReader.logStatesConst.includes(run.log)
  }
}
