import type { RuntimeSessionInfo } from '../../../app-host/app/wire/hostWire.js'
import type { SessionRecord } from '../records/sessionRecord.types'
import type { SessionScriptWords } from './sessionScriptDefinitions'

/** What a run that is no longer running did, in the words its history entry keeps. */
export type ScriptRunEndedOutcome = 'succeeded' | 'failed' | 'stopped' | 'lost'

export type ScriptRunJudgement =
  | { kind: 'running' }
  | { kind: 'succeeded'; outcome: 'succeeded'; exitCode: 0 }
  | { kind: 'failed'; outcome: Exclude<ScriptRunEndedOutcome, 'succeeded'>; reason: string; exitCode?: number }

/**
 * One session that ran FOR another, judged by how it ended. Every script run reads this ladder in the
 * same order for the same reasons: the Host's runtime first, and only where the Host has none, the
 * run's own record.
 *
 * A dead runtime and an ended record are the same fact at two moments, the second being what
 * survives a Host that restarted once the run was over, and both are read the same way: exit 0 is
 * success and nothing else is. A session started in a half-installed worktree, or a merge carried on
 * over a resolution nobody confirmed, is the failure this exists to prevent, so anything less
 * certain than a clean exit is a failure.
 */
export class ScriptRunOutcome {
  private static readonly succeededConst: ScriptRunJudgement = { kind: 'succeeded', outcome: 'succeeded', exitCode: 0 }

  static judge(
    runId: string,
    records: readonly SessionRecord[],
    live: ReadonlyMap<string, RuntimeSessionInfo>,
    words: SessionScriptWords,
  ): ScriptRunJudgement {
    const { session, actor } = words
    const run = records.find((record) => record.sessionId === runId)
    if (!run) return ScriptRunOutcome.failed('lost', `its ${session} session record is gone`)
    // Asked before the exit code, because a stopped run did not finish whatever code the platform
    // reports for a killed process - and on POSIX a signalled process reports 0, which would read
    // here as a clean run.
    if (run.stopRequested) return ScriptRunOutcome.failed('stopped', `its ${actor} was stopped`)
    const runtime = live.get(runId)
    if (runtime) {
      if (runtime.alive) return { kind: 'running' }
      return runtime.exitCode === 0
        ? ScriptRunOutcome.succeededConst
        : ScriptRunOutcome.failed('failed', `the ${actor} exited with ${runtime.exitCode ?? 'no exit code'}`, runtime.exitCode)
    }
    if (run.life === 'starting') {
      // The Host has no runtime for it either, so the run's own replay is what this pass is about:
      // judging it now would end a session over a launch that is being repeated as we speak.
      if (run.pendingOperationId && run.pendingOperationKind) return { kind: 'running' }
      return ScriptRunOutcome.failed('lost', `its ${session} session names no launch to replay`)
    }
    else if (run.life === 'ended') {
      if (run.exitCode === 0) return ScriptRunOutcome.succeededConst
      // A run the Host refused to launch never ran; the Host's own words say why.
      if (run.exitCode === undefined && run.endedReason !== undefined)
        return ScriptRunOutcome.failed('failed', `the ${actor} could not start: ${run.endedReason}`)
      return ScriptRunOutcome.failed('failed', `the ${actor} ended with ${run.exitCode ?? 'no exit code'}`, run.exitCode)
    }
    else if (run.life === 'live')
      return ScriptRunOutcome.failed('lost', `its ${session} session is not on the Host any more`)
    else if (run.life === 'lost')
      return ScriptRunOutcome.failed('lost', `its ${session} session was lost`)
    else
      throw new Error(`Unknown session life: ${JSON.stringify(run.life satisfies never)}`)
  }

  private static failed(
    outcome: Exclude<ScriptRunEndedOutcome, 'succeeded'>,
    reason: string,
    exitCode?: number,
  ): ScriptRunJudgement {
    return { kind: 'failed', outcome, reason, exitCode }
  }
}
