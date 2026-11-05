import { versioningReviewSchema } from '../../../lib-orchestrator/versioning/versioningReviewSchemas'
import { RemoteSessionSchemas } from '../../../lib-orchestrator/remoteControl/remoteSessionSchemas'
import type { SessionViewOpenRequest } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import type { SessionOpen } from '../../../lib-orchestrator/clientApi/sessionViewItems'
import type { SessionViewItemsStore } from './sessionViewItemsStore'
import { TerminalTargetCodec } from '../../../lib-orchestrator/clientApi/terminalTarget'
import { ServiceIpcBase } from '../../../lib-orchestrator/clientApi/serviceIpcBase'
import type { ServiceCaller } from '../../../lib-orchestrator/clientApi/serviceTransport.types'
import type { TabControlBroker } from './tabControlBroker'

type SessionItems = Pick<SessionViewItemsStore, 'page'> & { open(owner: string, sessionId: string, body: SessionViewOpenRequest): Promise<SessionOpen> }

export class ServiceTabRequestsIpc extends ServiceIpcBase<typeof ServiceTabRequestsIpc.channelsConst> {
  static readonly channelsConst = {
    'tabs:open-shared-item': true,
    'tabs:session-items': true,
    'tabs:open-session-task': true,
    'tabs:project-review': true,
    'tabs:projected-review-changed': true,
    'tabs:open-session-actions': true,
  } as const
  private readonly controlBroker: TabControlBroker
  private readonly ownerIdOf: (caller: ServiceCaller) => string | null
  private readonly items: SessionItems | undefined

  constructor(controlBroker: TabControlBroker, ownerIdOf: (caller: ServiceCaller) => string | null, items?: SessionItems) {
    super()
    this.controlBroker = controlBroker
    this.ownerIdOf = ownerIdOf
    this.items = items
  }

  initialize(): void {
    this.register('tabs:open-shared-item', (event, sessionId, body) => {
      const owner = this.requireWindowId(event)
      if (!this.items) throw new Error('Shared items are unavailable')
      return this.items.open(owner, sessionId, RemoteSessionSchemas.sharedOpen.parse(body))
    })
    this.register('tabs:session-items', (event, sessionId, cursor) => {
      this.requireWindowId(event)
      if (!this.items) throw new Error('Shared session items are unavailable')
      return this.items.page(sessionId, cursor)
    })
    this.register('tabs:open-session-task', async (event, target, task, title) => {
      this.requireWindowId(event)
      let decoded
      if (target.kind === 'local') decoded = TerminalTargetCodec.read({ sessionId: target.sessionId })
      else if (target.kind === 'remote') decoded = TerminalTargetCodec.read({ target })
      else throw new Error('Invalid task target')
      if (!decoded || typeof title !== 'string' || title.length > 400) throw new Error('Invalid task target')
      const parsed = RemoteSessionSchemas.sharedOpen.parse({ openId: 'validate-task', item: { kind: 'task', task } })
      if (parsed.item.kind !== 'task') throw new Error('Invalid task reference')
      const result = await this.controlBroker.openSessionTask(decoded.target, parsed.item.task, title)
      if (!result.ok) throw new Error(result.error.detail)
    })
    this.register('tabs:project-review', (event, target, input, itemKey, openId) => {
      this.requireWindowId(event)
      const draft = versioningReviewSchema.parse(input)
      if (target.kind !== 'remote' || target.sessionId !== draft.sessionId || typeof itemKey !== 'string' || itemKey.length > 32768)
        throw new Error('Invalid review projection')
      if (typeof openId !== 'string' || openId.length === 0 || openId.length > 256) throw new Error('Invalid review open identity')
      return this.controlBroker.projectReview(target, draft, itemKey, openId)
    })
    this.register('tabs:projected-review-changed', (event, target, input, closed) => {
      this.requireWindowId(event)
      const draft = versioningReviewSchema.parse(input)
      if (target.kind !== 'remote' || target.sessionId !== draft.sessionId || typeof closed !== 'boolean') throw new Error('Invalid review projection')
      this.controlBroker.updateProjectedReview(target, draft, closed)
    })
    this.register('tabs:open-session-actions', async (event, target) => {
      this.requireWindowId(event)
      const result = await this.controlBroker.openSessionActions(target)
      if (!result.ok) throw new Error(result.error.detail)
    })
    this.assertComplete(ServiceTabRequestsIpc.channelsConst)
  }

  private requireWindowId(caller: ServiceCaller): string {
    const windowId = this.ownerIdOf(caller)
    if (windowId === null) throw new Error('Unknown or closing workspace renderer')
    return windowId
  }
}
