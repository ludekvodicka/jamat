import type {
  SessionActivity,
  SessionInfo,
  SessionOperation,
  SessionSetupInfo,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'

/**
 * What a row is drawn as. Nine shapes, one per state a person reads differently: `starting` is not
 * an early `idle`, and `lost` is not `ended` - a runtime nobody can find again and a runtime that
 * exited look the same in a list and mean opposite things to whoever decides what to do next.
 */
export type SessionGlyph =
  | 'starting'
  | 'working'
  | 'background'
  | 'waiting'
  | 'idle'
  | 'unknown'
  | 'shell'
  | 'ended'
  | 'lost'

export type SessionAction =
  | 'finalize'
  | 'reopen'
  | 'remove'
  | 'retrySetup'

/** What a merge is doing, as the one word the row shows for it. */
export type SessionMergeBadge = 'merging' | 'conflict' | 'merge-failed'

/**
 * The install a session had to wait for, as the one thing a row draws about it. It is a fact BESIDE
 * the glyph and never folded into it: a session waiting for its dependencies is still `starting`,
 * and a failed install is still an `ended` session - what the install did is a second sentence.
 */
export type SessionSetupBadge = 'installing' | 'install-failed' | 'install-skipped'

/**
 * A launch the Host keeps refusing, as the one word a row says about it. Beside the glyph and never
 * folded into it, for the reason the install badge is: the session is still `starting` in the sense
 * that nothing has ended, and what is holding it up is a second sentence.
 */
export type SessionLaunchBadge = 'waiting'

/**
 * What colour a state character is drawn in, as a MEANING rather than a colour. Deliberately the
 * same words a tab signal uses, so a tab can take one of these straight as its tone and the
 * two surfaces cannot drift; `sessionsTree.css` and `tabs.css` are the only places these become
 * something to look at.
 */
export type SessionPaint = 'ok' | 'attention' | 'danger' | 'accent' | 'idle' | 'muted'

/**
 * The one derivation of a session's visible state and available tree operations. Every surface that
 * draws a session asks here, so two of them cannot end up disagreeing about the same session - which
 * is exactly how V2's rail and its inspector drifted apart.
 */
export class SessionNodeState {
  static glyphOf(
    life: SessionInfo['life'],
    kind: SessionInfo['kind'],
    activity: SessionActivity | null,
    activityDetail?: SessionInfo['activityDetail'],
  ): SessionGlyph {
    if (life === 'starting') return 'starting'
    else if (life === 'ended') return 'ended'
    else if (life === 'lost') return 'lost'
    else if (life === 'live') return SessionNodeState.liveGlyphOf(kind, activity, activityDetail)
    else
      throw new Error(`Unknown session life: ${JSON.stringify(life)}`)
  }

  /**
   * What the tree offers for a session, which is what it can actually be asked for right now.
   * Finish may be drawn on the row; the secondary operations are drawn in its context menu.
   *
   * A running row still reads the library's `admits`: Finish means stopping a live runtime. Once the
   * runtime has ended, the finalize catalog decides whether Finish has anything to ask. That keeps
   * the row label and the dialog on one decision, including failed installs whose only executable
   * ending is Discard inside the dialog.
   */
  static actionsOf(session: {
    life: SessionInfo['life']
    admits: SessionInfo['admits']
  }, finalizeOffered: boolean): readonly SessionAction[] {
    const life = session.life
    if (life !== 'live' && life !== 'starting' && life !== 'ended' && life !== 'lost')
      throw new Error(`Unknown session life: ${JSON.stringify(life)}`)
    const running = life === 'live' || life === 'starting'
    // `remove` is in BOTH orders and gated by `admits` alone, which is what the library already
    // decides: a live session is never removable, and a `starting` one is exactly when its launch
    // named no runtime on the Host. Leaving it out of the running order is how a session whose
    // launch the Host kept refusing ended up with Finish as its only button - and Finish on that
    // shape is the one operation that cannot work, because there is nothing to stop.
    const order: readonly SessionAction[] = running
      ? ['finalize', 'remove']
      : ['finalize', 'retrySetup', 'reopen', 'remove']
    return order.filter((action) => action === 'finalize' && !running
      ? finalizeOffered
      : session.admits.includes(SessionNodeState.operationOf(action)))
  }

  /**
   * The tree's word for an action against the library's. They differ in exactly one place: the tree
   * says Rerun and the library says `restart`, because a rerun of an ended session and a restart of
   * a live one are the same operation asked at two moments.
   */
  private static operationOf(action: SessionAction): SessionOperation {
    if (action === 'reopen') return 'restart'
    else if (action === 'finalize' || action === 'remove' || action === 'retrySetup')
      return action
    else
      throw new Error(`Unknown session action: ${JSON.stringify(action)}`)
  }

  static actionLabelOf(action: SessionAction): string {
    if (action === 'finalize') return 'Finish'
    else if (action === 'reopen') return 'Rerun'
    else if (action === 'remove') return 'Remove'
    else if (action === 'retrySetup') return 'Retry setup'
    else
      throw new Error(`Unknown session action: ${JSON.stringify(action)}`)
  }

  /** A running Finish stops; an ended Finish opens a dialog, which the ellipsis promises. */
  static finalizeLabelOf(life: SessionInfo['life']): string {
    if (life === 'live' || life === 'starting') return 'Finish'
    else if (life === 'ended' || life === 'lost') return 'Finish…'
    else
      throw new Error(`Unknown session life: ${JSON.stringify(life)}`)
  }

  /**
   * A failure outranks the phase: a merge that stopped is what the row has to say, whatever it was
   * doing when it stopped. The three words mirror the install badge beside them.
   */
  static mergeBadgeOf(merge: SessionInfo['merge']): SessionMergeBadge | null {
    if (merge === undefined) return null
    if (merge.failure !== undefined) return 'merge-failed'
    if (merge.phase === 'resolving') return 'conflict'
    else if (merge.phase === 'base-merging' || merge.phase === 'main-merging'
      || merge.phase === 'tearing-down')
      return 'merging'
    else
      throw new Error(`Unknown merge phase: ${JSON.stringify(merge.phase)}`)
  }

  /**
   * What the merge word says when it is pointed at. A failure carries the reason the library
   * already put on the wire; the other two say what is happening to the worktree, which the one
   * word beside them cannot.
   */
  static mergeTitleOf(merge: SessionInfo['merge']): string | null {
    const badge = SessionNodeState.mergeBadgeOf(merge)
    if (badge === null) return null
    if (badge === 'merge-failed') return merge?.failure ?? 'The merge failed'
    else if (badge === 'conflict') return 'Stopped on conflicts; a resolve session is settling them'
    else if (badge === 'merging') return 'Merging the worktree back to its base'
    else
      throw new Error(`Unknown session merge badge: ${JSON.stringify(badge)}`)
  }

  /** Counted by the project rows, so `starting` counts: it is a session on its way, not an absence. */
  static isLive(life: SessionInfo['life']): boolean {
    if (life === 'live' || life === 'starting') return true
    else if (life === 'ended' || life === 'lost') return false
    else
      throw new Error(`Unknown session life: ${JSON.stringify(life)}`)
  }

  /**
   * The one character each state is drawn as. It lives here rather than in the tree that first drew
   * it because a session tab shows the same mark: two surfaces spelling the same state with two
   * characters is the drift this class exists to prevent.
   *
   * Idle uses a square so it stays distinct from running even when colours are hard to distinguish.
   * Filling it preserves the unseen-result signal without adding another mark to the row.
   */
  static characterOf(glyph: SessionGlyph, marked: boolean): string {
    if (glyph === 'starting') return '◐'
    else if (glyph === 'working') return '●'
    else if (glyph === 'background') return '◉'
    else if (glyph === 'waiting') return '◆'
    else if (glyph === 'idle') return marked ? '■' : '□'
    else if (glyph === 'unknown') return '?'
    else if (glyph === 'shell') return '❯'
    else if (glyph === 'ended') return '×'
    else if (glyph === 'lost') return '!'
    else
      throw new Error(`Unknown session glyph: ${JSON.stringify(glyph)}`)
  }

  /**
   * What the character is coloured, as one ladder read top down: the most urgent thing true of a
   * session is what its colour says. `marked` is "this session wants you" - a turn that settled
   * while you were away, or a runtime that died. It is not "output arrived": that was measured on
   * 2026-08-20 to be true of every agent session nobody is looking at, because a TUI repaints its
   * own status row, and the mark that fired on it meant nothing.
   *
   * The order is the whole design. A runtime that is gone outranks everything, because nothing
   * else about that row matters as much. A session WAITING for input outranks the unseen mark,
   * because it wants something now rather than merely having something to read. And `working`
   * keeps its own colour even when marked: a session that settled and started working again is
   * working, whatever nobody has read yet, and letting the mark win would erase the
   * green from the tree and leave the colour saying nothing about what anything is doing.
   *
   */
  static paintOf(glyph: SessionGlyph, marked: boolean): SessionPaint {
    if (glyph === 'lost') return 'danger'
    else if (glyph === 'waiting') return 'attention'
    else if (glyph === 'idle') return 'idle'
    else if (glyph === 'ended') return marked ? 'accent' : 'muted'
    else if (glyph === 'working' || glyph === 'background') return 'ok'
    else if (glyph === 'starting') return 'accent'
    else if (glyph === 'shell' || glyph === 'unknown') return 'muted'
    else
      throw new Error(`Unknown session glyph: ${JSON.stringify(glyph)}`)
  }

  /**
   * What the character says when it is pointed at. One wording for both surfaces, and the place the
   * unseen half is spelled out: `working` keeps its colour when marked, so the tooltip is where
   * that session admits nobody has looked since it last stopped.
   */
  static glyphTitleOf(glyph: SessionGlyph, marked: boolean): string {
    if (!marked) {
      if (glyph === 'background') return 'background work'
      else if (glyph === 'starting' || glyph === 'working' || glyph === 'waiting'
        || glyph === 'idle' || glyph === 'unknown' || glyph === 'shell'
        || glyph === 'ended' || glyph === 'lost') return glyph
      else throw new Error(`Unknown session glyph: ${JSON.stringify(glyph)}`)
    }
    if (glyph === 'ended') return 'ended - not seen since it ended'
    else if (glyph === 'lost') return 'lost - not seen since it was lost'
    else if (glyph === 'background') return 'background work - previous result not seen'
    else if (glyph === 'starting' || glyph === 'working' || glyph === 'waiting'
      || glyph === 'idle' || glyph === 'unknown' || glyph === 'shell')
      return `${glyph} - not seen since the turn finished`
    else
      throw new Error(`Unknown session glyph: ${JSON.stringify(glyph)}`)
  }

  /**
   * The library decides WHEN a stuck launch is worth a word - it owns the attempt threshold - so this
   * says only that there is one. A row that re-derived the threshold from `attempts` would drift
   * from the pacing that produced it.
   */
  static launchBadgeOf(launchWait: SessionInfo['launchWait']): SessionLaunchBadge | null {
    return launchWait === undefined ? null : 'waiting'
  }

  /** What that badge says when it is pointed at: the Host's own words, and how long this has run. */
  static launchTitleOf(launchWait: SessionInfo['launchWait']): string | null {
    if (launchWait === undefined) return null
    return `The launch has not been accepted yet after ${launchWait.attempts} attempts: ${
      launchWait.reason}`
  }

  static setupBadgeOf(setup: SessionSetupInfo | undefined): SessionSetupBadge | null {
    if (setup === undefined) return null
    if (setup.state === 'running') return 'installing'
    else if (setup.state === 'failed') return 'install-failed'
    else if (setup.state === 'skipped') return 'install-skipped'
    else
      throw new Error(`Unknown session setup state: ${JSON.stringify(setup)}`)
  }

  /**
   * What the badge says when it is pointed at. An install runs with echo off, so the commands are not
   * readable anywhere else until a terminal exists: a repository-authored setup is agreed to before it
   * starts, and this is where it can be read afterwards.
   */
  static setupTitleOf(setup: SessionSetupInfo | undefined): string | null {
    if (setup === undefined) return null
    if (setup.state === 'running' || setup.state === 'failed')
      return setup.commands.length === 0 ? null : setup.commands.join('\n')
    // The skipped badge is one character, so this is the only place that says what happened; the
    // reason alone named a cause for an effect the reader could no longer see.
    else if (setup.state === 'skipped') return `Nothing was installed: ${setup.reason}`
    else
      throw new Error(`Unknown session setup state: ${JSON.stringify(setup)}`)
  }

  private static liveGlyphOf(
    kind: SessionInfo['kind'],
    activity: SessionActivity | null,
    activityDetail: SessionInfo['activityDetail'],
  ): SessionGlyph {
    if (kind === 'shell') return 'shell'
    else if (kind === 'agent') return SessionNodeState.activityGlyphOf(activity, activityDetail)
    else
      throw new Error(`Unknown session kind: ${JSON.stringify(kind)}`)
  }

  private static activityGlyphOf(
    activity: SessionActivity | null,
    activityDetail: SessionInfo['activityDetail'],
  ): SessionGlyph {
    if (activityDetail === 'background') {
      if (activity === 'working') return 'background'
      throw new Error(`Background activity detail requires working activity: ${JSON.stringify(activity)}`)
    }
    else if (activityDetail !== undefined)
      throw new Error(`Unknown session activity detail: ${JSON.stringify(activityDetail)}`)
    if (activity === 'working') return 'working'
    else if (activity === 'waiting') return 'waiting'
    else if (activity === 'idle') return 'idle'
    // `null` is the wire's "nothing classifies this", which for a shell is the truth and for a live
    // agent means the record carries no agent to classify. Both are "we do not know", and drawing an
    // agent as idle on that evidence is how a waiting agent goes unnoticed.
    else if (activity === 'unknown' || activity === null) return 'unknown'
    else
      throw new Error(`Unknown session activity: ${JSON.stringify(activity)}`)
  }
}
