import type { MainFinishChanges, MainFinishPort } from '../mainFinishPort.types'
import type { SessionRecordMainFinish, SessionMainFinishResult } from '../records/sessionRecord.types'
import type { SessionInfo, SessionMainFinishChoice, SessionMainFinishOutcome, SessionsOpResult } from '../sessionManagerApi.types'
import { AgentPresets } from '../launch/agentPresets'
import { MainFinishWorkflow } from './mainFinishWorkflow'
import { OperationOutcomes } from './operationOutcomes'

/** The session manager's side: its snapshot, the record field and the stop of a running session. */
export interface MainFinishSessions {
  info(sessionId: string): SessionInfo | null
  current(sessionId: string): SessionRecordMainFinish | undefined
  committing(): readonly string[]
  /** `change` answers null to write nothing; false is a write that did not happen. */
  write(sessionId: string, change: (current: SessionRecordMainFinish | undefined) => SessionRecordMainFinish | null): Promise<boolean>
  stop(sessionId: string): Promise<SessionsOpResult>
  /** The Remove of a stopped session's row, once its process is gone. */
  remove(sessionId: string): Promise<SessionsOpResult>
  report(message: string): void
  now(): number
}

type MainFinishAnswer = SessionsOpResult<{ outcome: SessionMainFinishOutcome }>

/**
 * Finish of an agent session in a main copy. A session without changes of its own stops as before.
 * One with them waits in Session actions for the person: Commit & close, Commit & continue, Close
 * session or Back to work. A commit types the configured command into the session and commits
 * nothing here, because the agent knows what the changes are for and writes the message.
 *
 * Commit & close then watches the session: once its agent worked on the command and has been idle
 * for `settleMillisecondsConst` with no commit review of it open, the changes are read again. None
 * left stops the session and removes its row, because nothing is left to come back to and the
 * conversation stays in Historic sessions; any left asks the person again. The stop and the Remove
 * are the only automatic acts, and they happen only when nothing of the session is left to commit.
 * **Check again** reads the changes at once, both while a commit waits (without waiting for an idle
 * agent: a commit turn that hangs on a review nobody will finish kept the section waiting with no
 * way on, 058, 2026-11-18) and while choosing (e.g. after another session committed a shared file).
 */
export class MainFinishFlow {
  static readonly tickMillisecondsConst = 3_000
  static readonly settleMillisecondsConst = 5_000
  /** The submit was proven, so a command never seen worked on had its whole turn between two ticks. */
  static readonly unseenTurnMillisecondsConst = 30_000

  private readonly sessions: MainFinishSessions
  private readonly port: MainFinishPort
  private readonly queues = new Map<string, Promise<void>>()
  private readonly idleSince = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(sessions: MainFinishSessions, port: MainFinishPort) {
    this.sessions = sessions
    this.port = port
  }

  /** Whether a Finish of this session asks about its changes rather than stopping it at once. */
  static applies(info: SessionInfo): boolean {
    return info.kind === 'agent' && info.life === 'live' && info.worktree === undefined && info.retiredWorktree === undefined
      && info.script === undefined && info.resolveFor === undefined && info.setupFor === undefined
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => { void this.tick() }, MainFinishFlow.tickMillisecondsConst)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** Without a choice, the Finish press; with one, a press in its Session actions section. */
  press(sessionId: string, choice?: SessionMainFinishChoice): Promise<MainFinishAnswer> {
    return this.serial(sessionId, () => choice === undefined ? this.begin(sessionId) : this.choose(sessionId, choice))
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const sessionId of this.sessions.committing())
        await this.serial(sessionId, () => this.watch(sessionId))
          .catch((error: unknown) => this.sessions.report(`Finish of session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`))
    } finally {
      this.ticking = false
    }
  }

  private async begin(sessionId: string): Promise<MainFinishAnswer> {
    const info = this.sessions.info(sessionId)
    if (info === null) return { ok: false, code: 'not-found', detail: `No session ${sessionId}` }
    const current = this.sessions.current(sessionId)
    if (current !== undefined && current.phase !== 'closed') return { ok: true, value: { outcome: 'choose' } }
    if (!MainFinishFlow.applies(info)) return this.stopped(sessionId)
    const changes = await this.port.changes(sessionId)
    if (changes.ok && (changes.vcs === null || changes.paths.length === 0)) return this.stopped(sessionId)
    const at = this.sessions.now()
    const written = await this.sessions.write(sessionId, () => ({ startedAt: at, phase: 'choosing', ...MainFinishFlow.filesOf(changes),
      ...changes.ok ? {} : { note: `The changes of this session could not be read: ${changes.detail}` } }))
    return written ? { ok: true, value: { outcome: 'choose' } } : OperationOutcomes.latched()
  }

  private async choose(sessionId: string, choice: SessionMainFinishChoice): Promise<MainFinishAnswer> {
    const current = this.sessions.current(sessionId)
    if (current === undefined || current.phase === 'closed')
      return { ok: false, code: 'invalid-spec', detail: 'No Finish of this session waits for a choice' }
    switch (choice) {
      case 'cancel':
        this.idleSince.delete(sessionId)
        return await this.close(sessionId, 'cancelled') ? { ok: true, value: { outcome: 'cancelled' } } : OperationOutcomes.latched()
      case 'close': {
        if (current.phase !== 'choosing') return { ok: false, code: 'invalid-spec', detail: 'The session is committing. Keep the session first.' }
        const stopped = await this.sessions.stop(sessionId)
        if (!stopped.ok) return stopped
        await this.close(sessionId, 'closed')
        return { ok: true, value: { outcome: 'stopped' } }
      }
      case 'commit-close':
      case 'commit-continue':
        return this.commit(sessionId, current, choice)
      case 'check':
        this.idleSince.delete(sessionId)
        if (current.phase === 'committing') return { ok: true, value: { outcome: await this.check(sessionId, 'committing') } }
        else if (current.phase === 'choosing') return { ok: true, value: { outcome: await this.check(sessionId, 'choosing') } }
        else throw new Error(`Unknown main Finish phase: ${JSON.stringify(current.phase satisfies never)}`)
      default: throw new Error(`Unknown main Finish choice: ${JSON.stringify(choice satisfies never)}`)
    }
  }

  private async commit(sessionId: string, current: SessionRecordMainFinish, choice: 'commit-close' | 'commit-continue'): Promise<MainFinishAnswer> {
    if (current.phase !== 'choosing' || current.vcs === null)
      return { ok: false, code: 'invalid-spec', detail: 'This Finish offers no commit now' }
    const info = this.sessions.info(sessionId)
    if (info?.life !== 'live')
      return { ok: false, code: 'live-refused', detail: 'The session is not running, so nothing can commit through it' }
    if (info.agent === undefined)
      return { ok: false, code: 'invalid-spec', detail: 'The session runs no agent that could commit' }
    const { text: command, input } = AgentPresets.commandLine(this.port.command(current.vcs), info.agent.agentId)
    const refusal = await this.port.deliver(sessionId, command, input)
    if (refusal !== null) {
      await this.sessions.write(sessionId, (latest) => latest?.phase === 'choosing'
        ? { ...latest, note: `The commit command was not typed into the session: ${refusal}` } : null)
      return { ok: false, code: 'not-delivered', detail: `The commit command was not typed into the session: ${refusal}` }
    }
    const at = this.sessions.now()
    this.idleSince.delete(sessionId)
    const written = await this.sessions.write(sessionId, (latest) => latest === undefined ? null
      : choice === 'commit-continue'
        ? { ...MainFinishFlow.plain(latest), phase: 'closed', command, sentAt: at, endedAt: at, result: 'sent' }
        : { ...MainFinishFlow.plain(latest), phase: 'committing', command, sentAt: at })
    if (!written) return OperationOutcomes.latched()
    return { ok: true, value: { outcome: choice === 'commit-continue' ? 'sent' : 'committing' } }
  }

  private async watch(sessionId: string): Promise<void> {
    const current = this.sessions.current(sessionId)
    if (current?.phase !== 'committing' || current.sentAt === undefined) {
      this.idleSince.delete(sessionId)
      return
    }
    const info = this.sessions.info(sessionId)
    const now = this.sessions.now()
    if (info === null || (info.life !== 'live' && info.life !== 'starting')) {
      this.idleSince.delete(sessionId)
      await this.close(sessionId, 'ended', 'The session ended before its commit was done.')
      return
    }
    const activity = info.activity
    if (activity === 'working' || activity === 'waiting') {
      this.idleSince.delete(sessionId)
      if (current.workingSeen !== true)
        await this.sessions.write(sessionId, (latest) => latest?.phase === 'committing' ? { ...latest, workingSeen: true } : null)
      return
    }
    if (current.workingSeen !== true && now - current.sentAt < MainFinishFlow.unseenTurnMillisecondsConst) return
    const since = this.idleSince.get(sessionId) ?? now
    this.idleSince.set(sessionId, since)
    if (now - since < MainFinishFlow.settleMillisecondsConst || this.port.reviewPending(sessionId)) return
    this.idleSince.delete(sessionId)
    await this.check(sessionId, 'watch')
  }

  /**
   * Reads the changes and goes on: none left stops the session and removes its row, any left asks
   * the person again. `committing` is Check again during a commit turn, which may come while the
   * agent still works or a review is open; then a remainder keeps the commit waiting with a note,
   * and an open review keeps the session, because stopping it would leave that review pending with
   * no session. `choosing` is Check again from the choice step, e.g. after another session
   * committed a shared file.
   */
  private async check(sessionId: string, mode: 'watch' | 'committing' | 'choosing'): Promise<SessionMainFinishOutcome> {
    const activity = this.sessions.info(sessionId)?.activity
    const busy = mode === 'committing' && (activity === 'working' || activity === 'waiting')
    const changes = await this.port.changes(sessionId)
    if (changes.ok && (changes.vcs === null || changes.paths.length === 0)) {
      if (mode !== 'watch' && this.port.reviewPending(sessionId)) {
        const message = 'Nothing of this session is left to commit, but a commit review of it is still open. Close the review, then check again.'
        if (mode === 'committing') return this.note(sessionId, message)
        else if (mode === 'choosing') { await this.ask(sessionId, message, MainFinishFlow.filesOf(changes)); return 'choose' }
        else throw new Error(`Unknown main Finish check mode: ${JSON.stringify(mode satisfies never)}`)
      }
      const stopped = await this.sessions.stop(sessionId)
      if (!stopped.ok) {
        const prefix = mode === 'choosing' ? 'Nothing of this session is left to commit' : 'The changes are committed'
        await this.ask(sessionId, `${prefix}, but the session did not stop: ${stopped.detail}`, MainFinishFlow.filesOf(changes))
        return 'choose'
      }
      await this.close(sessionId, 'closed')
      const removed = await this.sessions.remove(sessionId)
      if (!removed.ok) this.sessions.report(`Session ${sessionId} committed its changes and stopped, but its row stays: ${removed.detail}`)
      return 'stopped'
    }
    if (!changes.ok) {
      if (busy) return this.note(sessionId, `The changes could not be read: ${changes.detail}`)
      const message = mode === 'choosing'
        ? `The changes of this session could not be read: ${changes.detail}`
        : `The commit turn ended, but the changes could not be read: ${changes.detail}`
      await this.ask(sessionId, message)
      return 'choose'
    }
    const files = MainFinishFlow.filesOf(changes)
    const count = files.paths.length + files.more
    const remain = `${count} ${count === 1 ? 'file' : 'files'} of this session ${count === 1 ? 'is' : 'are'} still changed`
    if (busy) return this.note(sessionId, `${remain[0].toUpperCase()}${remain.slice(1)}; the agent still works on the commit.`)
    let message: string
    switch (mode) {
      case 'choosing':
        message = `${remain[0].toUpperCase()}${remain.slice(1)}. Commit through the session's agent, or close the session.`
        break
      case 'committing':
      case 'watch':
        message = `The commit turn ended and ${remain}. Commit again, or close the session.`
        break
      default: throw new Error(`Unknown main Finish check mode: ${JSON.stringify(mode satisfies never)}`)
    }
    await this.ask(sessionId, message, files)
    return 'choose'
  }

  /** A note on a commit that goes on waiting. */
  private async note(sessionId: string, note: string): Promise<'committing'> {
    await this.sessions.write(sessionId, (latest) => latest?.phase === 'committing' ? { ...latest, note } : null)
    return 'committing'
  }

  /** Back to (or refreshing) the choice, keeping any commit step drawn as done. */
  private async ask(sessionId: string, note: string, files?: Pick<SessionRecordMainFinish, 'vcs' | 'paths' | 'more'>): Promise<void> {
    await this.sessions.write(sessionId, (latest) => latest !== undefined && latest.phase !== 'closed'
      ? { ...MainFinishFlow.plain(latest), ...files, phase: 'choosing', note } : null)
  }

  private async close(sessionId: string, result: SessionMainFinishResult, note?: string): Promise<boolean> {
    const at = this.sessions.now()
    return this.sessions.write(sessionId, (latest) => latest === undefined || latest.phase === 'closed' ? null
      : { ...MainFinishFlow.plain(latest), phase: 'closed', endedAt: at, result, ...note === undefined ? {} : { note } })
  }

  private async stopped(sessionId: string): Promise<MainFinishAnswer> {
    const stopped = await this.sessions.stop(sessionId)
    return stopped.ok ? { ok: true, value: { outcome: 'stopped' } } : stopped
  }

  /** The record without the marks that belong to one phase only. */
  private static plain(finish: SessionRecordMainFinish): SessionRecordMainFinish {
    const { note: _note, workingSeen: _working, ...rest } = finish
    return rest
  }

  private static filesOf(changes: MainFinishChanges): Pick<SessionRecordMainFinish, 'vcs' | 'paths' | 'more'> {
    if (!changes.ok) return { vcs: null, paths: [], more: 0 }
    const limit = MainFinishWorkflow.pathsLimitConst
    return { vcs: changes.vcs, paths: changes.paths.slice(0, limit), more: Math.max(0, changes.paths.length - limit) }
  }

  /** One piece of work per session at a time; a failure is the caller's and does not stop the next. */
  private serial<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const run = previous.then(work)
    const settled = run.then(() => undefined, () => undefined)
    this.queues.set(sessionId, settled)
    void settled.then(() => { if (this.queues.get(sessionId) === settled) this.queues.delete(sessionId) })
    return run
  }
}
