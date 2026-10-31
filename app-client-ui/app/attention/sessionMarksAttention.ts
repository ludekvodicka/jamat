import type { SessionInfo } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SessionsAttentionModel } from '../../shared/sessionsAttentionModel'
import type { AttentionQueue } from './attentionQueue'

/**
 * The local sessions the tree marks (a turn that settled, a runtime that ended, a failed script,
 * each while the person looked elsewhere) as items a status bar click walks through. They never come
 * forward by themselves: sessions settle every few minutes, and a screen that moved on each one
 * would be the interruption the queue exists to stop. Looking at the session takes its item out.
 */
export class SessionMarksAttention {
  private readonly model = new SessionsAttentionModel()
  private readonly queue: Pick<AttentionQueue, 'add' | 'changed'>
  private readonly show: (sessionId: string, tabTitle: string) => Promise<string | null>
  private marked: ReadonlySet<string> = new Set()

  constructor(queue: Pick<AttentionQueue, 'add' | 'changed'>, show: (sessionId: string, tabTitle: string) => Promise<string | null>) {
    this.queue = queue
    this.show = show
  }

  /** Every sessions change and every change of what the visible windows have in front. */
  seen(sessions: readonly SessionInfo[], lookedAt: ReadonlySet<string>): void {
    this.marked = this.model.apply({ sessions, activeSessionIds: lookedAt })
    for (const session of sessions) {
      const { sessionId, tabTitle } = session
      if (this.marked.has(sessionId))
        this.queue.add({ key: `session-mark:${sessionId}`, kind: 'session-mark', sessionId, title: tabTitle, automatic: false,
          holds: false, wanted: () => this.marked.has(sessionId), show: () => this.show(sessionId, tabTitle) })
    }
    this.queue.changed()
  }
}
