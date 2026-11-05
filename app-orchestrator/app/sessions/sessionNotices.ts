import { randomUUID } from 'node:crypto'
import type { ShellPort } from '../../../lib-orchestrator/shared/shellPort.types'
import type { TabControlBroker } from '../tabs/tabControlBroker'
import type { FinishAttentionNotice } from './finishAttention'
import type { MainCopyUpdateNoticeView } from './mainCopyUpdateNotice'
import { ErrorText } from '../../../lib-orchestrator/shared/errorText'

export class SessionNotices {
  private readonly shell: Pick<ShellPort, 'notify' | 'onNotice' | 'openPath'>
  private readonly titleOf: (sessionId: string) => string | null
  private readonly openWorkflow: TabControlBroker['openWorkflow']
  private readonly report: (message: string) => void
  private readonly actions: Map<string, () => Promise<void>>
  private readonly unsubscribe: () => void
  private disposed: boolean

  constructor(shell: Pick<ShellPort, 'notify' | 'onNotice' | 'openPath'>, titleOf: (sessionId: string) => string | null,
    openWorkflow: TabControlBroker['openWorkflow'], report: (message: string) => void) {
    this.shell = shell
    this.titleOf = titleOf
    this.openWorkflow = openWorkflow
    this.report = report
    this.actions = new Map()
    this.disposed = false
    this.unsubscribe = shell.onNotice((id, event) => {
      if (this.disposed) return
      const action = this.actions.get(id)
      this.actions.delete(id)
      if (event === 'clicked') {
        if (action) void action().catch(error => this.report(ErrorText.of(error)))
      } else if (event !== 'closed') throw new Error(`Unknown notice event: ${event satisfies never}`)
    })
  }

  show(notice: Pick<FinishAttentionNotice, 'sessionId' | 'title' | 'body'>, click?: () => Promise<void>): void {
    if (this.disposed) return
    const id = randomUUID()
    this.actions.set(id, click ?? (async () => {
      const opened = await this.openWorkflow(notice.sessionId, this.titleOf(notice.sessionId) ?? notice.title)
      if (!opened.ok) this.report(`The workflow of session ${notice.sessionId} could not be opened: ${opened.error.detail}`)
    }))
    this.shell.notify({ id, title: notice.title, body: notice.body })
  }

  update(notice: MainCopyUpdateNoticeView): void {
    const log = notice.log
    this.show(notice, log === null ? undefined : async () => {
      try { await this.shell.openPath(log) }
      catch (error) { this.report(`The update log ${log} could not be opened: ${ErrorText.of(error)}`) }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.actions.clear()
  }
}
