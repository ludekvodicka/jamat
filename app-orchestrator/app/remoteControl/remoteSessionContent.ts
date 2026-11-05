import type { RemoteSessionInteraction } from './remoteSessionViews'
import type { RemoteSessionReadRequest, RemoteSessionViewResponse } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import type { RemoteSidebarAccess } from './remoteSidebarAccess'
import type { RemoteReviewAccess } from './remoteReviewAccess'
import type { SessionTaskAccess } from '../sessionTasks/sessionTaskAccess'
import type { RemoteContentPages } from './remoteContentPages'
import type { SessionViewItemsStore } from '../tabs/sessionViewItemsStore'
import type { SessionSharedItems } from '../tabs/sessionSharedItems'
import type { RemoteContentAccess } from './remoteContentAccess'
import type { RemoteChangesAccess } from './remoteChangesAccess'

export class RemoteSessionContent {
  private readonly sidebarAccess: Pick<RemoteSidebarAccess, 'request' | 'page' | 'release'>

  private readonly reviewAccess: Pick<RemoteReviewAccess, 'request' | 'page' | 'release'>

  private readonly taskAccess: Pick<SessionTaskAccess, 'request' | 'page' | 'release'>

  private readonly itemPages: Pick<RemoteContentPages, 'put' | 'read' | 'release'>

  private readonly sessionViewItems: Pick<SessionViewItemsStore, 'page'>

  private readonly sharedItems: Pick<SessionSharedItems, 'open'>

  private readonly remoteContentAccess: Pick<RemoteContentAccess, 'admitSource' | 'request' | 'page' | 'release'>

  private readonly remoteChangesAccess: Pick<RemoteChangesAccess, 'request' | 'page' | 'release'>

  private readonly ownerOf: (view: RemoteSessionInteraction) => string

  constructor(sidebarAccess: Pick<RemoteSidebarAccess, 'request' | 'page' | 'release'>, reviewAccess: Pick<RemoteReviewAccess, 'request' | 'page' | 'release'>, taskAccess: Pick<SessionTaskAccess, 'request' | 'page' | 'release'>, itemPages: Pick<RemoteContentPages, 'put' | 'read' | 'release'>, sessionViewItems: Pick<SessionViewItemsStore, 'page'>, sharedItems: Pick<SessionSharedItems, 'open'>, remoteContentAccess: Pick<RemoteContentAccess, 'admitSource' | 'request' | 'page' | 'release'>, remoteChangesAccess: Pick<RemoteChangesAccess, 'request' | 'page' | 'release'>, ownerOf: (view: RemoteSessionInteraction) => string) {
    this.sidebarAccess = sidebarAccess
    this.reviewAccess = reviewAccess
    this.taskAccess = taskAccess
    this.itemPages = itemPages
    this.sessionViewItems = sessionViewItems
    this.sharedItems = sharedItems
    this.remoteContentAccess = remoteContentAccess
    this.remoteChangesAccess = remoteChangesAccess
    this.ownerOf = ownerOf
  }

  async read(view: RemoteSessionInteraction, request: RemoteSessionReadRequest): Promise<RemoteSessionViewResponse['result']> {
    if (request.operation === 'sidebar.request') return this.sidebarAccess.request(view, request.body)
    else if (request.operation === 'sidebar.page') return this.sidebarAccess.page(view, request.body)
    else if (request.operation === 'reviews.request') return this.reviewAccess.request(view, request.body)
    else if (request.operation === 'reviews.page') return Promise.resolve(this.reviewAccess.page(view, request.body))
    else if (request.operation === 'items.open') {
      const item = await this.sharedItems.open(this.ownerOf(view), view.sessionId, request.body)
      return this.itemPages.put(this.ownerOf(view), item)
    }
    else if (request.operation === 'items.request') {
      const page = this.sessionViewItems.page(view.sessionId, request.body)
      for (const entry of page.items) if (entry.item.kind === 'file') this.remoteContentAccess.admitSource(view, entry.item.source)
      return Promise.resolve(this.itemPages.put(this.ownerOf(view), page))
    }
    else if (request.operation === 'items.page') return Promise.resolve(this.itemPages.read(this.ownerOf(view), request.body))
    else if (request.operation === 'tasks.request') return this.taskAccess.request(view, request.body)
    else if (request.operation === 'tasks.page') return this.taskAccess.page(view, request.body.task, request.body.cursor)
    else if (request.operation === 'files.request') return this.remoteContentAccess.request(view, request.body)
    else if (request.operation === 'files.page') return Promise.resolve(this.remoteContentAccess.page(view, request.body))
    else if (request.operation === 'changes.request') return this.remoteChangesAccess.request(view, request.body)
    else if (request.operation === 'changes.page') return Promise.resolve(this.remoteChangesAccess.page(view, request.body))
    else throw new Error(`Unknown content operation: ${JSON.stringify(request)}`)
  }

  release(view: RemoteSessionInteraction): void { this.sidebarAccess.release(view); this.reviewAccess.release(view); this.taskAccess.release(view); this.itemPages.release(this.ownerOf(view)); this.remoteChangesAccess.release(view); this.remoteContentAccess.release(view) }
}
