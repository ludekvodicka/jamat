import { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { SessionRecord } from '../records/sessionRecord.types'
import type { SessionStepInfo, SessionStepProgress } from '../sessionManagerApi.types'
import { SvnActionFlow } from './svnActionFlow'
import { SvnActionStages } from './svnActionStages'
import { type SessionStepFacts, SessionStepWords } from './sessionStepWords'

export interface SessionStepsDeps {
  /** The snapshot is composed again: at once for a new text, at most once a second for a moved count. */
  changed: () => void
  now: () => number
}

interface LiveStep {
  facts: SessionStepFacts
  text: string
  progress: SessionStepProgress | null
  startedAt: number
  pushedAt: number
}

/**
 * What this client does for each session now, in memory only: a step exists while its work runs,
 * so an idle snapshot never moves for it, and no record or history entry is written for one.
 *
 * Producers call `at` before each piece of client work and `clear` where it ends. While no
 * producer holds a step, the record still says enough for a resting one: a session the action
 * waits to stop, a relaunch after an svn lock, or a client stage written and not driven yet.
 */
export class SessionSteps {
  static readonly progressPushMillisecondsConst = 1_000
  private readonly changed: () => void
  private readonly now: () => number
  private readonly steps = new Map<string, LiveStep>()

  constructor(deps: SessionStepsDeps) {
    this.changed = deps.changed
    this.now = deps.now
  }

  at(sessionId: string, facts: SessionStepFacts, progress: SessionStepProgress | null = null): void {
    const now = this.now()
    const text = SessionStepWords.textOf(facts)
    const current = this.steps.get(sessionId)
    if (current !== undefined && current.text === text) {
      current.facts = facts
      current.progress = progress
      // No trailing timer: every reconcile pass composes the snapshot again and takes the latest count.
      if (now - current.pushedAt < SessionSteps.progressPushMillisecondsConst) return
      current.pushedAt = now
      this.changed()
      return
    }
    this.steps.set(sessionId, { facts, text, progress, startedAt: now, pushedAt: now })
    this.changed()
  }

  /** Whether a step was there. The caller pushes, so a run row and the step's end land in one snapshot. */
  clear(sessionId: string): boolean {
    return this.steps.delete(sessionId)
  }

  /** No I/O and no clock: composed on every recompose. Memory first, then what the record says. */
  infoOf(record: SessionRecord): SessionStepInfo | null {
    const live = this.steps.get(record.sessionId)
    if (live !== undefined)
      return { ...SessionStepWords.of(live.facts, live.progress), progress: live.progress, startedAt: live.startedAt }
    const resting = SessionSteps.restingOf(record)
    return resting === null ? null : { ...SessionStepWords.of(resting.facts, null), progress: null, startedAt: resting.startedAt }
  }

  private static restingOf(record: SessionRecord): { facts: SessionStepFacts; startedAt: number | null } | null {
    const action = record.svnAction
    // A need speaks through its own mark.
    if (action === undefined || action.needs !== undefined) return null
    if (SvnActionStages.isRun(action.stage))
      // Without a relaunch pending the run's own row speaks.
      return action.retryAt === undefined ? null : {
        facts: { kind: 'lock-wait', relaunch: action.rounds.lock, relaunches: SvnWorktreeManager.lockRetryDelaysConst.length },
        startedAt: null,
      }
    if (action.stage === 'stopping' && (record.life === 'live' || record.life === 'starting'))
      return {
        facts: { kind: 'stopping', limitSeconds: SvnActionFlow.stopLimitMillisecondsConst / 1_000 },
        startedAt: action.startedAt,
      }
    return { facts: { kind: 'pending', stage: action.stage }, startedAt: null }
  }
}
