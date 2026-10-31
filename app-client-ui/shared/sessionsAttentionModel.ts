import type {
  SessionActivity,
  SessionInfo,
  SessionScriptsBadge,
} from '../../lib-orchestrator/sessionManager/sessionManagerApi.types'

export interface AttentionInput {
  sessions: readonly SessionInfo[]
  /** What the user can see right now; none raises attention for itself. */
  activeSessionIds: ReadonlySet<string>
}

/**
 * Which sessions want the person: a turn that settled while they were elsewhere, or a runtime that
 * exited. One fact, and it is a CHANGE OF STATE rather than an arrival of output.
 *
 * It used to be two. The second was `unread` - "output arrived you have not looked at", measured as
 * the Host's `outputSeq` moving past the last value the user was shown. Over a plain terminal that
 * is exactly right; over an agent TUI it is meaningless, and it was measured to be so on
 * 2026-08-20: six working sessions moved their sequence EVERY SECOND, by hundreds of bytes each,
 * and a session sitting at an idle prompt still repainted every few minutes. The sequence answers
 * "did any cell change", and an agent redrawing a spinner changes cells for ever. So every session
 * the person was not looking at went unread within a second of them looking away, and the mark
 * stopped meaning anything. Removed rather than tuned: a threshold over repaint traffic would be a
 * guess about somebody else's TUI, and the fact worth drawing was always the other one.
 *
 * **A LIVE shell therefore raises nothing.** Nothing classifies a plain terminal, so it has no
 * activity to transition, and `unread` was the only signal it could ever produce. Its exit still
 * raises, because `exited` below reads `life` alone. So what a shell can no longer say is
 * "something happened in here while it ran", and that loss was taken knowingly: the alternative was
 * a tree where every agent row is lit permanently, which is the same as a tree where no row is.
 *
 * A session's FIRST sighting raises nothing either, and needs no guard of its own to say so: both
 * rules below read a PREVIOUS value, and a session this model has never seen has none. That covers
 * the first snapshot after a start, where every session is first seen at once - a tree that lights
 * up completely on every start trains the user to ignore the one row that meant something.
 *
 * **A script run raises nothing; its parent does.** An install, a check or a resolver runs FOR a
 * session, and the news it carries is that session's: its badge turning `failed` raises the parent.
 * A run that ends is how every successful run goes away, so raising it would light a row on every
 * install that worked.
 *
 * Nothing is stored, so attention is measured from the first snapshot this model saw rather than
 * from the last one the user actually read.
 */
export class SessionsAttentionModel {
  private readonly previousActivity = new Map<string, SessionActivity | null>()
  private readonly previousLife = new Map<string, SessionInfo['life']>()
  private readonly previousBadge = new Map<string, SessionScriptsBadge['state'] | null>()
  private attention: ReadonlySet<string> = new Set()

  apply(input: AttentionInput): ReadonlySet<string> {
    const attention = new Set(this.attention)
    const alive = new Set<string>()
    const lookedAt = SessionsAttentionModel.lookedAt(input)

    for (const session of input.sessions) {
      alive.add(session.sessionId)
      if (this.raises(session) && !lookedAt.has(session.sessionId))
        attention.add(session.sessionId)
      this.previousActivity.set(session.sessionId, session.activity)
      this.previousLife.set(session.sessionId, session.life)
      this.previousBadge.set(session.sessionId, session.scripts?.badge?.state ?? null)
      // Looked at is read: the mark goes out on the session in front, whatever raised it.
      if (lookedAt.has(session.sessionId))
        attention.delete(session.sessionId)
    }

    // A session removed from the records keeps nothing: the row it belonged to is gone, and a
    // recycled id would inherit somebody else's mark.
    this.forget(alive, attention)
    this.attention = attention
    return attention
  }

  /**
   * The sessions in front, and the parent of every run in front: a click on a starting session opens
   * its install, so a failure of that install is already on screen when the parent's badge turns.
   */
  private static lookedAt(input: AttentionInput): ReadonlySet<string> {
    const lookedAt = new Set(input.activeSessionIds)
    for (const session of input.sessions)
      if (session.script !== undefined && input.activeSessionIds.has(session.sessionId))
        lookedAt.add(session.script.parentId)
    return lookedAt
  }

  private raises(session: SessionInfo): boolean {
    if (session.script !== undefined) return false
    return SessionsAttentionModel.badgeFailed(this.previousLife.has(session.sessionId),
      this.previousBadge.get(session.sessionId), session.scripts?.badge?.state)
      || SessionsAttentionModel.settled(
      this.previousActivity.get(session.sessionId),
      session.activity,
    ) || SessionsAttentionModel.exited(this.previousLife.get(session.sessionId), session.life)
  }

  /**
   * A turn that finished. It needs no output to be true, which is the whole reason this is the fact
   * worth drawing: a turn ends by going QUIET, and the classifier settles it fifteen seconds after
   * the last byte. Nothing measured on arriving output can see that moment.
   *
   * `unknown` is not a settle: a classifier that lost the thread would otherwise raise attention on
   * every session whose screen went quiet.
   */
  private static settled(
    before: SessionActivity | null | undefined,
    after: SessionActivity | null,
  ): boolean {
    if (before !== 'working')
      return false
    if (after === 'waiting' || after === 'idle') return true
    else if (after === 'working' || after === 'unknown' || after === null) return false
    else
      throw new Error(`Unknown session activity: ${JSON.stringify(after)}`)
  }

  /**
   * A runtime that stopped. A session waiting on an install goes `starting` to `ended` when the
   * install fails, which is the same news by a different road and is raised the same way.
   */
  private static exited(
    before: SessionInfo['life'] | undefined,
    after: SessionInfo['life'],
  ): boolean {
    if (before === undefined)
      return false
    if (after === 'ended' || after === 'lost') return before === 'live' || before === 'starting'
    else if (after === 'live' || after === 'starting') return false
    else
      throw new Error(`Unknown session life: ${JSON.stringify(after)}`)
  }

  /**
   * A run of this session failed: the before chain that holds its start, or the checks that hold its
   * Finish. Only a change raises, so a badge that was already `failed` when first seen does not.
   */
  private static badgeFailed(
    seen: boolean,
    before: SessionScriptsBadge['state'] | null | undefined,
    after: SessionScriptsBadge['state'] | undefined,
  ): boolean {
    if (!seen || after === undefined || before === 'failed') return false
    if (after === 'failed') return true
    else if (after === 'running' || after === 'skipped' || after === 'succeeded') return false
    else
      throw new Error(`Unknown scripts badge state: ${JSON.stringify(after satisfies never)}`)
  }

  private forget(alive: ReadonlySet<string>, attention: Set<string>): void {
    for (const sessionId of [...this.previousLife.keys()])
      if (!alive.has(sessionId)) {
        this.previousLife.delete(sessionId)
        this.previousActivity.delete(sessionId)
        this.previousBadge.delete(sessionId)
      }
    for (const sessionId of [...attention])
      if (!alive.has(sessionId))
        attention.delete(sessionId)
  }
}
