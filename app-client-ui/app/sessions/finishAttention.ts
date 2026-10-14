import type { SessionInfo, SessionsSnapshot } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'

/** One Windows notification: whose workflow a click opens, and its two lines. */
export interface FinishAttentionNotice {
  sessionId: string
  title: string
  body: string
}

/** Where a notice goes; AppHub binds it to Electron's `Notification`. */
export interface FinishAttentionPort {
  show(notice: FinishAttentionNotice): void
}

/**
 * Tells the person, once, when a local worktree Finish or Discard starts to wait for them, or its
 * merger waits for an answer at its tab. A transition of the snapshot: one key per session, and a
 * notice when a key appears or changes. The first reconciled snapshot (the records and the Host
 * read) only primes, so a client restart repeats nothing that was already waiting. Only this
 * client's own sessions are read, never a peer's.
 */
export class FinishAttention {
  private readonly told = new Map<string, string>()
  private readonly port: FinishAttentionPort
  private primed: boolean

  constructor(port: FinishAttentionPort) {
    this.port = port
    this.primed = false
  }

  /** Called on every sessions change with the local snapshot. */
  seen(snapshot: Pick<SessionsSnapshot, 'reconciled' | 'sessions'>): void {
    if (!snapshot.reconciled) return
    const sessions = snapshot.sessions
    const present = new Set<string>()
    for (const session of sessions) {
      const key = FinishAttention.keyOf(session, sessions)
      if (key === null) continue
      present.add(session.sessionId)
      if (this.primed && this.told.get(session.sessionId) !== key) this.port.show(FinishAttention.noticeOf(session, key))
      this.told.set(session.sessionId, key)
    }
    for (const sessionId of [...this.told.keys()]) if (!present.has(sessionId)) this.told.delete(sessionId)
    this.primed = true
  }

  /**
   * `needs:<kind>:<wait>` while a worktree action waits for the person, where the wait is the
   * workflow's waiting step, so a settlement in the window that rewrites the reason tells nothing
   * new; `merger:<runId>` while the merger's own activity is `waiting`; else null. UPDATE of a main
   * copy is pressed where it was pressed and tells nothing here.
   */
  static keyOf(session: SessionInfo, sessions: readonly SessionInfo[]): string | null {
    const action = session.svnAction
    if (action === undefined || action.kind === 'update-main') return null
    if (action.needs !== null) {
      const waiting = session.workflow?.rounds.flatMap((round) => round.steps).filter((step) => step.state === 'waits').at(-1)?.key
      return `needs:${action.needsKind ?? 'unknown'}:${session.workflow?.workflowId ?? ''}:${waiting ?? action.needs}`
    }
    const runId = action.stage === 'merging' ? action.mergerRunId ?? null : null
    if (runId === null) return null
    return sessions.find((candidate) => candidate.sessionId === runId)?.activity === 'waiting' ? `merger:${runId}` : null
  }

  private static noticeOf(session: SessionInfo, key: string): FinishAttentionNotice {
    const action = session.svnAction
    if (key.startsWith('merger:'))
      return { sessionId: session.sessionId, title: `The merger of ${session.title} waits for you`, body: 'It asks for an answer in its tab.' }
    return {
      sessionId: session.sessionId,
      title: `${action?.kind === 'discard' ? 'Discard' : 'Finish'} waits: ${session.title}`,
      body: action?.summary ?? session.workflow?.summary ?? action?.needs ?? '',
    }
  }
}
