import type {
  SessionInfo,
  SessionsOpResult,
  SessionsSnapshot,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { ErrorText } from '../../shared/errorText'

export interface SessionRestartChainPorts {
  read(): Promise<IpcResult<SessionsSnapshot>>
  subscribe(onChanged: () => void): () => void
  reopen(sessionId: string): Promise<IpcResult<SessionsOpResult>>
  reportError(message: string): void
  openSessionIds(): Promise<readonly string[]>
  publishSessionRestarted(sessionId: string): Promise<void>
  /** Injected by the tests; the shell leaves it to the clock. */
  now?(): number
}

/**
 * What a restart of the machine cost, put back.
 *
 * After a reboot every session the Host was running is `lost`, and the person's own mark is what
 * separates the ones they had not finished with from the archive. Those come back, one at a time,
 * as soon as anything is known at all - and never before: a reconcile has to have been answered
 * first, or this would race the reconciler's own replay of pending launches.
 *
 * **One at a time is the point.** A burst would launch every agent at once on a machine that has
 * just booted, and each step is a decision the next step re-checks: a session that came back by
 * itself, one closed in the meantime, one just marked finished, all drop out before their turn.
 *
 * It runs at most once per shell, and only inside a window after the shell started. A Host that
 * falls over in the middle of an afternoon must not make the client start things by itself; that is
 * what the Restart button in the panel is for.
 */
export class SessionRestartChain {
  /** No reconcile inside this and the chain disarms: the moment has passed, and a click is honest. */
  private static readonly armedWindowMillisecondsConst = 30_000

  private readonly armedAt: number
  private ran = false

  constructor(private readonly ports: SessionRestartChainPorts) {
    this.armedAt = this.now()
  }

  /**
   * Waits for the first reconcile the Host answered and then drains once. The returned function
   * unsubscribes; it does not stop a drain that has already begun, because every step of one
   * re-checks what it is about to do anyway.
   */
  start(): () => void {
    let stopped = false
    const consider = (): void => {
      if (stopped || this.ran) return
      void this.ports.read().then((answer) => {
        if (stopped || this.ran) return
        if (!answer.ok) return
        if (!answer.value.reconciled) {
          // Nothing has been answered yet. Past the window it never will be worth acting on.
          if (this.now() - this.armedAt > SessionRestartChain.armedWindowMillisecondsConst)
            this.ran = true
          return
        }
        this.ran = true
        void this.drain(answer.value)
          .catch((error: unknown) =>
            this.ports.reportError(`Automatic restart failed: ${ErrorText.of(error)}`))
      })
    }
    const unsubscribe = this.ports.subscribe(consider)
    consider()
    return () => {
      stopped = true
      unsubscribe()
    }
  }

  private async drain(first: SessionsSnapshot): Promise<void> {
    const queue = first.sessions.map((info) => info.sessionId)
    for (const sessionId of queue) {
      // Fresh truth immediately before acting: everything that happened while the queue was being
      // worked through gets its say, and none of it stops the rest.
      const current = await this.infoOf(sessionId)
      if (current === null || !await this.restartable(current)) continue
      const answer = await this.ports.reopen(sessionId)
      if (!answer.ok) {
        this.ports.reportError(`Restarting ${sessionId} failed: ${answer.error}`)
        continue
      }
      if (!answer.value.ok) {
        // Nothing else will succeed either while the Host cannot be reached, and the tabs that are
        // waiting all carry their own button.
        if (answer.value.code === 'host-unreachable') return
        this.ports.reportError(
          `Restarting ${sessionId} was refused: ${answer.value.code}: ${answer.value.detail}`,
        )
        continue
      }
      try {
        await this.ports.publishSessionRestarted(sessionId)
      } catch (error) {
        this.ports.reportError(
          `Publishing restart for ${sessionId} failed: ${ErrorText.of(error)}`,
        )
      }
    }
  }

  /**
   * Two axes and nothing else: what the Host says is gone, and what the person has not finished
   * with. Everything after them is this client's own policy about the moment.
   *
   * Whether the session may be started again at all is NOT asked here: it is `admits`, which the
   * library derives from the record. This used to repeat those rules - a half-done install, a merge
   * in flight, an install session belonging to another - and a copy of somebody else's refusals is
   * a copy that drifts the day one of them changes.
   */
  private async restartable(info: SessionInfo): Promise<boolean> {
    if (info.life !== 'lost' || info.completed === true) return false
    if (!info.admits.includes('restart')) return false
    // A plain tab with no tab is a closed tab, which is an ended tab. Such a record can only be the
    // remains of a crash mid-close, and reviving it would put back what closing meant to end.
    if (info.presentation === 'tab') {
      try {
        return (await this.ports.openSessionIds()).includes(info.sessionId)
      } catch (error) {
        this.ports.reportError(
          `Reading open panels for ${info.sessionId} failed: ${ErrorText.of(error)}`,
        )
        return false
      }
    }
    return true
  }

  private async infoOf(sessionId: string): Promise<SessionInfo | null> {
    const answer = await this.ports.read()
    if (!answer.ok) return null
    return answer.value.sessions.find((info) => info.sessionId === sessionId) ?? null
  }

  private now(): number {
    return this.ports.now?.() ?? Date.now()
  }
}
