export type ReviewRunEnding = 'committed' | 'cancelled' | 'failed' | 'out-of-date' | 'external' | 'interrupted'

/**
 * How the review run of an SVN action ended, as its exit code: `jamat-v3 sessions worktree-review
 * --wait` writes it and the action reads it back. Shared by the CLI and the library, so both read
 * one table; plain values only, so this file imports nothing.
 */
export class ReviewRunExit {
  static readonly committedConst = 0
  static readonly cancelledConst = 10
  static readonly failedConst = 11
  static readonly outOfDateConst = 12
  static readonly externalConst = 13
  /** The review is unknown or the client went away: nobody can say how it ended. */
  static readonly interruptedConst = 14
  private static readonly outOfDatePatternConst = /out.of.date|E155011|E160028|E170004|newer content/i

  /** Any code outside the table, a missing one included, is an interrupted review. */
  static of(exitCode: number | undefined): ReviewRunEnding {
    if (exitCode === ReviewRunExit.committedConst) return 'committed'
    else if (exitCode === ReviewRunExit.cancelledConst) return 'cancelled'
    else if (exitCode === ReviewRunExit.failedConst) return 'failed'
    else if (exitCode === ReviewRunExit.outOfDateConst) return 'out-of-date'
    else if (exitCode === ReviewRunExit.externalConst) return 'external'
    else return 'interrupted'
  }

  /**
   * The exit code of a settled commit status: committed, cancelled and closed, failed and closed (out
   * of date when its detail says so), or taken to an external client. A status that has not settled
   * is no ending this run can name.
   */
  static codeOf(state: string, closed: boolean, detail: string | null): number {
    if (state === 'committed') return ReviewRunExit.committedConst
    else if (state === 'cancelled' && closed) return ReviewRunExit.cancelledConst
    else if (state === 'failed' && closed)
      return ReviewRunExit.outOfDatePatternConst.test(detail ?? '') ? ReviewRunExit.outOfDateConst : ReviewRunExit.failedConst
    else if (state === 'external-closed') return ReviewRunExit.externalConst
    else return ReviewRunExit.interruptedConst
  }
}
