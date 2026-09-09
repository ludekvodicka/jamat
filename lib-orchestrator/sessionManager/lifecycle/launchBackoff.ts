import type { SessionRecordLaunchWait } from '../records/sessionRecord.types'

/**
 * How often a launch the Host refused without deciding is sent again, and when that waiting is worth
 * saying out loud.
 *
 * `OperationOutcomes.decided` splits the Host's refusals into the ones a retry cannot change and the
 * ones it can, and the second half is replayed by the reconciler under the same operation id. That
 * classification is right and stays: a 429 really does lift when a runtime exits, and ending the
 * record instead would kill a session for good with its worktree and its branch still on disk.
 *
 * What was missing is a clock and a voice. Every replay went out on the reconcile pass's own cadence,
 * so four records the Host was refusing produced four calls every two seconds for as long as the
 * refusal stood - measured on 2026-09-05 at 885 rejected creates in nine minutes, none of which the
 * person waiting for those four sessions could see. Pure, and shared by the two classes that need
 * the two halves: the lifecycle writes the wait, the reconciler reads whether it is due.
 */
export class LaunchBackoff {
  /**
   * Indexed by how many refusals stand behind the record, so `delaysConst[1]` is the wait after the
   * first. The first two are zero because the first refusals really are the transient ones - a Host
   * restarting publishes a new descriptor and answers 401 until the watcher has it - and the last is
   * the steady state of a ceiling that lifts when a person finishes something, which is minutes away
   * rather than seconds.
   */
  private static readonly delaysConst = [0, 0, 2_000, 5_000, 15_000, 30_000, 60_000] as const

  /**
   * How many refusals make a wait worth drawing. Below it the row says `starting`, which is what a
   * launch still going through looks like and is; above it that would be a lie, because nothing is
   * starting until the Host stops refusing.
   */
  private static readonly visibleAfterConst = 3

  /** The wait a fresh refusal leaves behind, counted on from whatever the record already carried. */
  static after(
    previous: SessionRecordLaunchWait | undefined,
    reason: string,
    now: number,
  ): SessionRecordLaunchWait {
    return { attempts: (previous?.attempts ?? 0) + 1, lastAttemptAt: now, reason }
  }

  /**
   * Whether the next replay may go out. A record with no wait has never been refused, so it is due:
   * absence is not a delay.
   */
  static due(wait: SessionRecordLaunchWait | undefined, now: number): boolean {
    if (wait === undefined) return true
    // A clock that went backwards - a machine that resumed, an NTP step - would otherwise park the
    // record until wall time caught up again. The wait is a delay, so it is measured forwards only.
    const since = now - wait.lastAttemptAt
    if (since < 0) return true
    return since >= LaunchBackoff.delayOf(wait.attempts)
  }

  static visible(wait: SessionRecordLaunchWait | undefined): boolean {
    return wait !== undefined && wait.attempts >= LaunchBackoff.visibleAfterConst
  }

  private static delayOf(attempts: number): number {
    const delays = LaunchBackoff.delaysConst
    if (attempts < 1) return 0
    return attempts >= delays.length ? delays[delays.length - 1] : delays[attempts]
  }
}
