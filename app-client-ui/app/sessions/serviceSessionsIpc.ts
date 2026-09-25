import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import { ServiceIpcBase } from '../shared/serviceIpcBase'

/**
 * The SessionManager's share of the named allowlist, and the third service to take one. Every
 * handler is one delegation: what a session is, when it may be removed and what the Host is asked
 * for all live in the library, where the smoke run and the unit tests can reach them without an
 * Electron process.
 */
export class ServiceSessionsIpc extends ServiceIpcBase<typeof ServiceSessionsIpc.channelsConst> {
  static readonly channelsConst = {
    'sessions:snapshot': true,
    'sessions:create': true,
    'sessions:history-references': true,
    'sessions:open-history': true,
    'sessions:reopen': true,
    'sessions:finalize': true,
    'sessions:remove': true,
    'sessions:fork': true,
    'sessions:restart': true,
    'sessions:set-color': true,
    'sessions:set-details': true,
    'sessions:adopt-orphan': true,
    'sessions:discard-worktree': true,
    'sessions:retry-setup': true,
    'sessions:next-number': true,
    'sessions:allocate-number': true,
    'sessions:start-host': true,
    'sessions:reference': true,
  } as const

  constructor(
    private readonly sessions: SessionManager,
    /**
     * Told after a fork has landed, with the session it was cut from first. It is what carries the
     * group the parent was put in by hand over to the fork, and it lives outside this service
     * because a group assignment is the client's own state rather than anything the library keeps.
     */
    private readonly onForked: (parentSessionId: string, sessionId: string) => void,
  ) {
    super()
  }

  initialize(): void {
    this.register('sessions:snapshot', () => this.sessions.snapshot())
    this.register('sessions:create', (_event, spec) => this.sessions.createSession(spec))
    this.register('sessions:history-references', (_event, directory) =>
      this.sessions.historyReferences(directory))
    this.register('sessions:open-history', (_event, spec) =>
      this.sessions.openHistorySession(spec))
    this.register('sessions:reopen', (_event, sessionId) => this.sessions.reopenSession(sessionId))
    this.register('sessions:finalize', (_event, sessionId) =>
      this.sessions.finalizeSession(sessionId))
    this.register('sessions:remove', (_event, sessionId) => this.sessions.removeSession(sessionId))
    this.register('sessions:fork', (_event, sessionId, options) => this.fork(sessionId, options))
    this.register('sessions:restart', (_event, sessionId) =>
      this.sessions.restartSession(sessionId))
    this.register('sessions:set-color', (_event, sessionId, color) =>
      this.sessions.setSessionColor(sessionId, color))
    this.register('sessions:set-details', (_event, sessionId, update) =>
      this.sessions.setSessionDetails(sessionId, update))
    this.register('sessions:adopt-orphan', (_event, runtimeSessionId) =>
      this.sessions.adoptOrphan(runtimeSessionId))
    this.register('sessions:discard-worktree', (_event, sessionId) =>
      this.sessions.discardWorktree(sessionId))
    this.register('sessions:retry-setup', (_event, sessionId, acknowledgeSetup) =>
      this.sessions.retrySetup(sessionId, acknowledgeSetup))
    this.register('sessions:next-number', (_event, projectPath) =>
      this.sessions.nextSessionNumber(projectPath))
    this.register('sessions:allocate-number', (_event, projectPath) =>
      this.sessions.allocateSessionNumber(projectPath))
    this.register('sessions:start-host', () => this.sessions.startHost())
    this.register('sessions:reference', (_event, sessionId) =>
      this.sessions.sessionReference(sessionId))
    this.assertComplete(ServiceSessionsIpc.channelsConst)
  }

  /**
   * The one handler that is not a bare delegation. A fork is where a session BEGINS, and where it
   * begins is the only moment anything can be inherited: the answer names the session that was
   * created, and this call is the only place that holds both it and the one it came from.
   *
   * A refused fork inherits nothing, because nothing was created.
   */
  private async fork(
    sessionId: string,
    options: Parameters<SessionManager['forkSession']>[1],
  ): Promise<Awaited<ReturnType<SessionManager['forkSession']>>> {
    const forked = await this.sessions.forkSession(sessionId, options)
    if (forked.ok) this.onForked(sessionId, forked.value.sessionId)
    return forked
  }
}
