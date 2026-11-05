import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { AttentionQueue } from './attentionQueue'
import type { FinishAttention, FinishAttentionNotice } from '../sessions/finishAttention'
import type { SessionMarksAttention } from './sessionMarksAttention'
import type { TabControlBroker } from '../tabs/tabControlBroker'
import { ErrorText } from '../../../lib-orchestrator/shared/errorText'

export class SessionAttention {
  private readonly snapshot: SessionManager['snapshot']
  private readonly finish: Pick<FinishAttention, 'seen' | 'waits'>
  private readonly marks: Pick<SessionMarksAttention, 'seen'>
  private readonly queue: Pick<AttentionQueue, 'add'>
  private readonly openWorkflow: TabControlBroker['openWorkflow']
  private readonly report: (message: string) => void

  constructor(snapshot: SessionManager['snapshot'], finish: Pick<FinishAttention, 'seen' | 'waits'>,
    marks: Pick<SessionMarksAttention, 'seen'>, queue: Pick<AttentionQueue, 'add'>,
    openWorkflow: TabControlBroker['openWorkflow'], report: (message: string) => void) {
    this.snapshot = snapshot
    this.finish = finish
    this.marks = marks
    this.queue = queue
    this.openWorkflow = openWorkflow
    this.report = report
  }

  seen(seen: readonly string[]): void {
    try { this.marks.seen(this.snapshot().sessions, new Set(seen)) }
    catch (error) { this.report(`The attention queue could not read the sessions: ${ErrorText.of(error)}`) }
  }

  noticeWaits(): void {
    try { this.finish.seen(this.snapshot()) }
    catch (error) { this.report(`A waiting Finish could not be told: ${ErrorText.of(error)}`) }
  }

  queueFinishWait(notice: FinishAttentionNotice): void {
    const title = this.snapshot().sessions.find(session => session.sessionId === notice.sessionId)?.tabTitle ?? notice.title
    this.queue.add({ key: `finish-wait:${notice.sessionId}:${notice.key}`, kind: 'finish-wait', sessionId: notice.sessionId,
      title, automatic: true, holds: true, wanted: () => this.finish.waits(notice.sessionId, notice.key),
      show: async () => {
        const opened = await this.openWorkflow(notice.sessionId, title)
        return opened.ok ? opened.value.panelId : null
      } })
  }
}
