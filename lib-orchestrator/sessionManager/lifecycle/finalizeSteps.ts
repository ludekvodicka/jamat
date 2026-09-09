import type { SessionRecord } from '../records/sessionRecord.types'

/**
 * What one press of Finish does next. `already-finalized` is a real answer rather than a refusal:
 * pressing it on a session that has nothing left to do is not a mistake worth an error.
 *
 * `never-started` is the one that is neither: a launch the Host never took has no runtime to stop
 * and nothing to bring home, so Finish is not what that row needs - Remove is, and `admitsOf` says
 * so by not offering Finish at all. It stays a named step rather than a silent `already-finalized`
 * because a caller that is not the row - the CLI, a smoke, remote control - has to be told which of
 * the two it is looking at.
 */
export type FinalizeStep = 'stop' | 'commit-and-merge' | 'already-finalized' | 'never-started'

/**
 * Finish is one action that always does the next step, and this is the whole of what it knows.
 *
 * It plans from the record every time rather than from a stored position, which is what makes the
 * button repeatable: a merge interrupted by a conflict, a failed step or a client that died mid-way
 * leaves the disk in a state the next press reads afresh. That is the same reasoning the merge flow
 * itself is built on, and the reason there is no state machine here to get out of step with it.
 */
export class FinalizeSteps {
  static planOf(record: SessionRecord): FinalizeStep {
    const life = record.life
    if (life === 'live') return 'stop'
    // A `starting` record with no binding names nothing on the Host: its launch is still being
    // refused, or never reached one. `stop()` refuses exactly that shape, and offering Finish for it
    // is how a stuck session ended up with one button that could only fail.
    else if (life === 'starting') return record.binding === null ? 'never-started' : 'stop'
    else if (life === 'ended' || life === 'lost') {
      // A session that ended without a worktree is finished by the stop that ended it. There is no
      // marking a dead session done from here: running it again and finishing that is the way.
      if (record.worktree === undefined) return 'already-finalized'
      // Nor is there anything to bring home from a session whose INSTALL failed. The agent never ran
      // in that worktree, so the only uncommitted thing in it is what the half-finished install left,
      // and committing a partial lockfile into the base branch is not what finishing means. The row
      // hides the button as well, but the rule belongs here: a caller that is not that row - a smoke,
      // a menu item added later - must not be able to ask for it either.
      if (record.pendingSetup !== undefined) return 'already-finalized'
      return 'commit-and-merge'
    }
    else
      throw new Error(`Unknown session life: ${JSON.stringify(life)}`)
  }

  /** Whether Finish has anything to do here, which is what decides if the row offers it at all. */
  static offers(record: SessionRecord): boolean {
    const step = FinalizeSteps.planOf(record)
    if (step === 'stop' || step === 'commit-and-merge') return true
    else if (step === 'already-finalized' || step === 'never-started') return false
    else throw new Error(`Unknown finalize step: ${JSON.stringify(step)}`)
  }
}
