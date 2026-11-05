import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { FileViewer } from '../../../lib-orchestrator/fileViewer/fileViewer'
import type { SessionViewOpenRequest } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import type { SessionTasksOperations } from '../sessionTasks/sessionTasksOperations'
import type { SessionViewItemsStore } from './sessionViewItemsStore'

export class SessionSharedItems {
  private readonly sessions: Pick<SessionManager, 'snapshot'>

  private readonly fileViewer: Pick<FileViewer, 'document'>

  private readonly tasks: Pick<SessionTasksOperations, 'itemOf'>

  private readonly items: Pick<SessionViewItemsStore, 'record'>

  constructor(sessions: Pick<SessionManager, 'snapshot'>, fileViewer: Pick<FileViewer, 'document'>, tasks: Pick<SessionTasksOperations, 'itemOf'>, items: Pick<SessionViewItemsStore, 'record'>) {
    this.sessions = sessions
    this.fileViewer = fileViewer
    this.tasks = tasks
    this.items = items
  }

  async open(owner: string, sessionId: string, body: SessionViewOpenRequest) {
    if (!this.sessions.snapshot().sessions.some((session) => session.sessionId === sessionId)) throw new Error('Source session no longer exists')
    if (body.item.kind === 'file') {
      const answer = await this.fileViewer.document(owner, body.item.documentId)
      if (!answer.ok) throw new Error(answer.detail)
      if (answer.value.source.sessionId !== sessionId) throw new Error('Shared file belongs to another session')
      return this.items.record({ openId: body.openId, sessionId, key: answer.value.documentKey, title: answer.value.name,
        item: { kind: 'file', source: answer.value.source } })
    } else if (body.item.kind === 'workflow') return this.items.record({ openId: body.openId, sessionId, key: `workflow:${sessionId}`, title: 'Session actions', item: body.item })
    else if (body.item.kind === 'task') {
      const item = await this.tasks.itemOf(sessionId, body.item.task)
      return this.items.record({ openId: body.openId, sessionId, key: item.key, title: item.title, item: body.item })
    } else throw new Error('Unknown shared item request')
  }
}
