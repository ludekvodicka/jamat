import type { FileViewerResourceResult } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { RemoteSessionView } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import { randomUUID } from 'node:crypto'

import type { WebContents } from 'electron'

import type {
  RemoteControlRequestUnion,
} from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import type { SessionCreateSpec } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type {
  RemoteConnectionsHoldReason,
} from '../../shared/remoteConnectionsHold'
import type { RemoteControlInboundRegistry } from './remoteControlInboundRegistry'
import type { RemoteConnectionsManager } from './remoteConnectionsManager'
import { RemoteClipboardPaste } from './remoteClipboardPaste'
import { RemoteSessionCommandsContract } from '../../shared/remoteSessionCommand'
import { ServiceIpcBase } from '../shared/serviceIpcBase'

interface RemoteRendererAttach {
  sender: WebContents
  remoteEndpointId: string
  attachId: string
}

export interface ServiceRemoteControlIpcDeps {
  startImageDrag?(sender: WebContents, endpointId: string, view: RemoteSessionView, documentId: string): Promise<boolean>
  exportFile?(sender: WebContents, endpointId: string, view: RemoteSessionView, documentId: string, name: string): Promise<boolean>
  mediaResource?(endpointId: string, view: RemoteSessionView, documentId: string, reference: string | null): Promise<FileViewerResourceResult>
  releaseMedia?(endpointId: string, viewId: string, documentId?: string): void
  revision(): number
  acceptsRenderer(sender: WebContents): boolean
  requestId?(): string
  operationId?(): string
}

export class ServiceRemoteControlIpc
  extends ServiceIpcBase<typeof ServiceRemoteControlIpc.channelsConst> {
  static readonly channelsConst = {
    'remote:session-command': true,
    'remote:start-image-drag': true,
    'remote:export-file': true,
    'remote:media-resource': true,
    'remote:changes-request': true,
    'remote:changes-page': true,
    'remote:reviews-request': true,
    'remote:reviews-page': true,
    'remote:sidebar-request': true,
    'remote:sidebar-page': true,
    'remote:tasks-request': true,
    'remote:tasks-page': true,
    'remote:items-open': true,
    'remote:items-request': true,
    'remote:items-page': true,
    'remote:files-request': true,
    'remote:files-page': true,
    'remote:view-detail': true,
    'remote:view-open': true,
    'remote:view-close': true,
    'remote:view-press': true,
    'remote:snapshot': true,
    'remote:connect': true,
    'remote:select-session': true,
    'remote:disconnect': true,
    'remote:release': true,
    'remote:agents-describe': true,
    'remote:accounts-list': true,
    'remote:projects-list': true,
    'remote:sessions-create': true,
    'remote:sessions-reopen': true,
    'remote:sessions-finalize': true,
    'remote:sessions-reference': true,
    'remote:terminal-attach': true,
    'remote:terminal-input': true,
    'remote:terminal-resize': true,
    'remote:terminal-active': true,
    'remote:terminal-detach': true,
    'remote:terminal-clipboard-paste': true,
  } as const

  private readonly viewers = new Map<WebContents, string>()
  private readonly views = new Map<string, { sender: WebContents; endpointId: string; view: RemoteSessionView }>()
  private readonly owned = new Map<WebContents, Set<string>>()
  private readonly attaches = new Map<string, RemoteRendererAttach>()
  /** Window ownership releases an explicitly connected endpoint when its dialog closes. */
  private readonly holds = new Map<WebContents, Set<RemoteConnectionsHoldReason>>()
  private readonly wired = new WeakSet<WebContents>()
  private readonly requestId: () => string
  private readonly operationId: () => string
  private readonly clipboardPaste: RemoteClipboardPaste

  constructor(
    private readonly outbound: RemoteConnectionsManager,
    private readonly inbound: RemoteControlInboundRegistry,
    private readonly deps: ServiceRemoteControlIpcDeps,
  ) {
    super()
    this.requestId = deps.requestId ?? randomUUID
    this.operationId = deps.operationId ?? randomUUID
    this.clipboardPaste = new RemoteClipboardPaste(outbound)
  }

  initialize(): void {
    this.register('remote:session-command', (event, endpointId, command) => {
      if (!this.deps.acceptsRenderer(event.sender)) throw new Error('The workspace window is closing')
      if (!RemoteSessionCommandsContract.operations.some((operation) => operation === command.operation))
        throw new Error('This session command is not admitted')
      return this.outbound.execute(endpointId, { ...command, protocol: RemoteControlConst.protocol, requestId: this.requestId() })
    })
    this.register('remote:start-image-drag', (event, endpointId, viewId, documentId) => {
      const held = this.ownedView(event.sender, endpointId, viewId)
      return this.deps.startImageDrag?.(event.sender, endpointId, held.view, documentId) ?? false
    })
    this.register('remote:export-file', (event, endpointId, viewId, documentId, name) => {
      const held = this.ownedView(event.sender, endpointId, viewId)
      return this.deps.exportFile?.(event.sender, endpointId, held.view, documentId, name) ?? false
    })
    this.register('remote:media-resource', (event, endpointId, viewId, documentId, reference) => {
      const held = this.ownedView(event.sender, endpointId, viewId)
      return this.deps.mediaResource?.(endpointId, held.view, documentId, reference)
        ?? { ok: false, code: 'not-found', detail: 'Remote media is unavailable' }
    })
    this.register('remote:changes-request', async (event, endpointId, viewId, body) => {
      const held = this.ownedView(event.sender, endpointId, viewId)
      const answer = await this.outbound.sessionView(endpointId, { ...held.view, requestId: this.requestId(), operation: 'changes.request', body })
      if (!answer.ok) return answer
      if (!answer.value || !('transferId' in answer.value)) throw new Error('Invalid remote content response')
      return { ok: true, value: answer.value }
    })
    this.register('remote:changes-page', async (event, endpointId, viewId, body) => {
      const held = this.ownedView(event.sender, endpointId, viewId)
      const answer = await this.outbound.sessionView(endpointId, { ...held.view, requestId: this.requestId(), operation: 'changes.page', body })
      if (!answer.ok) return answer
      if (!answer.value || !('transferId' in answer.value)) throw new Error('Invalid remote content page')
      return { ok: true, value: answer.value }
    })
    this.register('remote:reviews-request', async (event, endpointId, viewId, body) => {
      const held = this.ownedView(event.sender, endpointId, viewId)
      const answer = await this.outbound.sessionView(endpointId, { ...held.view, requestId: this.requestId(), operation: 'reviews.request', body })
      if (!answer.ok) return answer
      if (!answer.value || !('transferId' in answer.value)) throw new Error('Invalid task content page')
      return { ok: true, value: answer.value }
    })
    this.register('remote:reviews-page', async (event, endpointId, viewId, body) => {
      const held = this.ownedView(event.sender, endpointId, viewId)
      const answer = await this.outbound.sessionView(endpointId, { ...held.view, requestId: this.requestId(), operation: 'reviews.page', body })
      if (!answer.ok) return answer
      if (!answer.value || !('transferId' in answer.value)) throw new Error('Invalid task content page')
      return { ok: true, value: answer.value }
    })
    this.register('remote:sidebar-request', async (event, endpointId, viewId, body) => {
      const held = this.ownedView(event.sender, endpointId, viewId)
      const answer = await this.outbound.sessionView(endpointId, { ...held.view, requestId: this.requestId(), operation: 'sidebar.request', body })
      if (!answer.ok) return answer
      if (!answer.value || !('transferId' in answer.value)) throw new Error('Invalid task content page')
      return { ok: true, value: answer.value }
    })
    this.register('remote:sidebar-page', async (event, endpointId, viewId, body) => {
      const held = this.ownedView(event.sender, endpointId, viewId)
      const answer = await this.outbound.sessionView(endpointId, { ...held.view, requestId: this.requestId(), operation: 'sidebar.page', body })
      if (!answer.ok) return answer
      if (!answer.value || !('transferId' in answer.value)) throw new Error('Invalid task content page')
      return { ok: true, value: answer.value }
    })
    this.register('remote:tasks-request', async (event, endpointId, viewId, body) => {
      const held = this.ownedView(event.sender, endpointId, viewId)
      const answer = await this.outbound.sessionView(endpointId, { ...held.view, requestId: this.requestId(), operation: 'tasks.request', body })
      if (!answer.ok) return answer
      if (!answer.value || !('transferId' in answer.value)) throw new Error('Invalid task content page')
      return { ok: true, value: answer.value }
    })
    this.register('remote:tasks-page', async (event, endpointId, viewId, body) => {
      const held = this.ownedView(event.sender, endpointId, viewId)
      const answer = await this.outbound.sessionView(endpointId, { ...held.view, requestId: this.requestId(), operation: 'tasks.page', body })
      if (!answer.ok) return answer
      if (!answer.value || !('transferId' in answer.value)) throw new Error('Invalid task content page')
      return { ok: true, value: answer.value }
    })
    this.register('remote:items-open', async (event, endpointId, viewId, body) => {
      const held = this.ownedView(event.sender, endpointId, viewId)
      const answer = await this.outbound.sessionView(endpointId, { ...held.view, requestId: this.requestId(), operation: 'items.open', body })
      if (!answer.ok) return answer
      if (!answer.value || !('transferId' in answer.value)) throw new Error('Invalid shared open response')
      return { ok: true, value: answer.value }
    })
    this.register('remote:items-request', async (event, endpointId, viewId, body) => {
      const held = this.ownedView(event.sender, endpointId, viewId)
      const answer = await this.outbound.sessionView(endpointId, { ...held.view, requestId: this.requestId(), operation: 'items.request', body })
      if (!answer.ok) return answer
      if (!answer.value || !('transferId' in answer.value)) throw new Error('Invalid shared items response')
      return { ok: true, value: answer.value }
    })
    this.register('remote:items-page', async (event, endpointId, viewId, body) => {
      const held = this.ownedView(event.sender, endpointId, viewId)
      const answer = await this.outbound.sessionView(endpointId, { ...held.view, requestId: this.requestId(), operation: 'items.page', body })
      if (!answer.ok) return answer
      if (!answer.value || !('transferId' in answer.value)) throw new Error('Invalid shared items page')
      return { ok: true, value: answer.value }
    })
    this.register('remote:files-request', async (event, endpointId, viewId, body) => {
      const held = this.ownedView(event.sender, endpointId, viewId)
      if (body.kind === 'release') this.deps.releaseMedia?.(endpointId, viewId, body.documentId)
      const answer = await this.outbound.sessionView(endpointId, { ...held.view, requestId: this.requestId(), operation: 'files.request', body })
      if (!answer.ok) return answer
      if (!answer.value || !('transferId' in answer.value)) throw new Error('Invalid remote content response')
      return { ok: true, value: answer.value }
    })
    this.register('remote:files-page', async (event, endpointId, viewId, body) => {
      const held = this.ownedView(event.sender, endpointId, viewId)
      const answer = await this.outbound.sessionView(endpointId, { ...held.view, requestId: this.requestId(), operation: 'files.page', body })
      if (!answer.ok) return answer
      if (!answer.value || !('transferId' in answer.value)) throw new Error('Invalid remote content page')
      return { ok: true, value: answer.value }
    })
    this.register('remote:view-open', async (event, endpointId, sessionId) => {
      if (!this.deps.acceptsRenderer(event.sender)) throw new Error('The workspace window is closing')
      const epoch = this.outbound.viewEpoch(endpointId)
      if (!epoch) return { ok: false, error: { code: 'unavailable', detail: 'Remote session is offline' } }
      let ownerGeneration = this.viewers.get(event.sender)
      if (!ownerGeneration) {
        ownerGeneration = randomUUID()
        this.viewers.set(event.sender, ownerGeneration)
      }
      const viewerId = randomUUID()
      this.wire(event.sender)
      const answer = await this.outbound.sessionView(endpointId, {
        requestId: this.requestId(), epoch, operation: 'views.open', body: { sessionId, viewerId },
      })
      if (!answer.ok) return answer
      if (!answer.value || !('viewId' in answer.value)) throw new Error('The peer returned no session view')
      if (!this.deps.acceptsRenderer(event.sender) || this.viewers.get(event.sender) !== ownerGeneration) {
        void this.outbound.sessionView(endpointId, { ...answer.value, requestId: this.requestId(), operation: 'views.close', body: {} })
        return { ok: false, error: { code: 'unavailable', detail: 'The workspace window closed' } }
      }
      this.views.set(JSON.stringify([endpointId, answer.value.viewId]), { sender: event.sender, endpointId, view: answer.value })
      return { ok: true, value: answer.value }
    })
    this.register('remote:view-detail', (event, endpointId, viewId) =>
      this.outbound.sessionDetail(endpointId, this.ownedView(event.sender, endpointId, viewId).view))
    this.register('remote:view-close', async (event, endpointId, viewId) => {
      const held = this.ownedView(event.sender, endpointId, viewId)
      this.views.delete(JSON.stringify([endpointId, viewId]))
      this.deps.releaseMedia?.(endpointId, viewId)
      const answer = await this.outbound.sessionView(endpointId, { ...held.view, requestId: this.requestId(), operation: 'views.close', body: {} })
      return answer.ok ? { ok: true, value: null } : answer
    })
    this.register('remote:view-press', async (event, endpointId, viewId, body, operationId) => {
      const held = this.ownedView(event.sender, endpointId, viewId)
      if (!this.deps.acceptsRenderer(event.sender)) throw new Error('The workspace window is closing')
      const answer = await this.outbound.sessionView(endpointId, { ...held.view, requestId: this.requestId(), operationId, operation: 'actions.press', body })
      return answer.ok ? { ok: true, value: null } : answer
    })
    this.register('remote:snapshot', () => ({
      revision: this.deps.revision(),
      outbound: this.outbound.snapshot().outbound,
      inbound: this.inbound.snapshot(),
    }))
    this.register('remote:connect', (event, reason, endpointId) => {
      if (!this.deps.acceptsRenderer(event.sender)) throw new Error('The workspace window is closing')
      const held = this.holds.get(event.sender)
      if (held) held.add(reason)
      else this.holds.set(event.sender, new Set([reason]))
      this.wire(event.sender)
      return this.outbound.connectComputer(ServiceRemoteControlIpc.holdKey(event.sender, reason), endpointId)
    })
    this.register('remote:release', (event, reason) => {
      this.holds.get(event.sender)?.delete(reason)
      this.outbound.releaseConnections(ServiceRemoteControlIpc.holdKey(event.sender, reason))
    })
    this.register('remote:select-session', (_event, endpointId, sessionId) =>
      this.outbound.selectSession(endpointId, sessionId))
    this.register('remote:disconnect', (_event, endpointId, sessionIds) =>
      this.outbound.disconnectSessions(endpointId, sessionIds))
    this.register('remote:agents-describe', (_event, endpointId) =>
      this.outbound.execute(endpointId, this.describeRequest()))
    this.register('remote:accounts-list', (_event, endpointId) =>
      this.outbound.execute(endpointId, { protocol: RemoteControlConst.protocol,
        requestId: this.requestId(), operation: 'accounts.list', body: {} }))
    this.register('remote:projects-list', (_event, endpointId, request) =>
      this.outbound.execute(endpointId, this.projectsRequest(request)))
    this.register('remote:sessions-create', (event, endpointId, spec, operationId) => {
      if (!this.deps.acceptsRenderer(event.sender)) throw new Error('The workspace window is closing')
      const request = this.createRequest(spec, operationId)
      if (spec.worktree !== undefined) {
        const capabilities = this.outbound.snapshot().outbound.find((entry) => entry.remoteEndpointId === endpointId)?.workspaceCapabilities
        if (!capabilities?.includes('session-workspace.views') || !capabilities.includes('session-workspace.actions'))
          return { protocol: request.protocol, requestId: request.requestId, operation: request.operation, operationId,
            ok: false, error: { code: 'unavailable', detail: 'This peer cannot display worktree setup approval. Update it before creating a worktree here.' } }
      }
      return this.outbound.execute(endpointId, request)
    })
    this.register('remote:sessions-reopen', (_event, endpointId, sessionId) =>
      this.outbound.execute(endpointId, this.sessionRequest('sessions.reopen', sessionId)))
    this.register('remote:sessions-finalize', (_event, endpointId, sessionId, acknowledgeSetup) =>
      this.outbound.execute(endpointId, this.sessionRequest('sessions.finalize', sessionId, acknowledgeSetup)))
    // The one remote channel that sends nothing over the wire: what it answers is composed from the
    // snapshot that computer already pushed.
    this.register('remote:sessions-reference', (_event, endpointId, sessionId) =>
      this.outbound.sessionReference(endpointId, sessionId))
    this.register('remote:terminal-attach', async (event, endpointId, attachId, spec) => {
      if (!this.deps.acceptsRenderer(event.sender))
        throw new Error('The workspace window is closing')
      const key = ServiceRemoteControlIpc.attachKey(endpointId, attachId)
      if (this.attaches.has(key))
        throw new Error(`Remote terminal attach already exists: ${attachId}`)
      this.claim(event.sender, endpointId, attachId)
      const answer = await this.outbound.attachTerminal(
        endpointId,
        attachId,
        spec,
        (frame) => {
          if (!event.sender.isDestroyed())
            event.sender.send('remote:terminal-frame', endpointId, attachId, frame)
        },
      )
      if (!answer.ok && answer.error.code !== 'unavailable')
        this.release(event.sender, endpointId, attachId)
      return answer
    })
    this.register('remote:terminal-input', (event, endpointId, attachId, data) => {
      this.assertOwner(event.sender, endpointId, attachId)
      return this.outbound.terminalInput(endpointId, attachId, data)
    })
    this.register('remote:terminal-resize', (event, endpointId, attachId, cols, rows) => {
      this.assertOwner(event.sender, endpointId, attachId)
      return this.outbound.terminalResize(endpointId, attachId, cols, rows)
    })
    this.register('remote:terminal-active', (event, endpointId, attachId, active) => {
      this.assertOwner(event.sender, endpointId, attachId)
      return this.outbound.terminalActive(endpointId, attachId, active)
    })
    this.register('remote:terminal-detach', async (event, endpointId, attachId) => {
      this.assertOwner(event.sender, endpointId, attachId)
      try { return await this.outbound.detachTerminal(endpointId, attachId) }
      finally { this.release(event.sender, endpointId, attachId) }
    })
    this.register('remote:terminal-clipboard-paste', (event, endpointId, attachId) => {
      this.assertOwner(event.sender, endpointId, attachId)
      return this.clipboardPaste.paste(endpointId, attachId)
    })
    this.assertComplete(ServiceRemoteControlIpc.channelsConst)
  }

  /**
   * A READ carries no operationId, and the far side is strict about it: an id on an operation that
   * does not mutate is refused as `invalid-request`, the whole request. Nothing replays a read, so
   * there is nothing for an id to key.
   */
  private projectsRequest(
    request: { categoryId?: string; sort?: 'alpha' | 'recent' },
  ): RemoteControlRequestUnion {
    return {
      protocol: RemoteControlConst.protocol,
      requestId: this.requestId(),
      operation: 'projects.list',
      body: structuredClone(request),
    }
  }

  /** The same read rule, with an empty body. */
  private describeRequest(): RemoteControlRequestUnion {
    return {
      protocol: RemoteControlConst.protocol,
      requestId: this.requestId(),
      operation: 'agents.describe',
      body: {},
    }
  }

  /**
   * The supplied `operationId` rather than a fresh one: a create the caller could not hear the
   * answer to is retried with the same id, and the far side's replay store is what turns that into
   * the stored result instead of a second session.
   */
  private createRequest(spec: SessionCreateSpec, operationId: string): RemoteControlRequestUnion {
    return {
      protocol: RemoteControlConst.protocol,
      requestId: this.requestId(),
      operationId,
      operation: 'sessions.create',
      body: { spec: structuredClone(spec) },
    }
  }

  private sessionRequest(
    operation: 'sessions.reopen' | 'sessions.finalize',
    sessionId: string,
    acknowledgeSetup?: string,
  ): RemoteControlRequestUnion {
    const common = {
      protocol: RemoteControlConst.protocol,
      requestId: this.requestId(),
      operationId: this.operationId(),
      body: { session: { kind: 'sessionId' as const, sessionId } },
    }
    if (operation === 'sessions.reopen')
      return { ...common, operation }
    else if (operation === 'sessions.finalize')
      return {
        ...common,
        operation,
        body: { ...common.body, ...(acknowledgeSetup === undefined ? {} : { acknowledgeSetup }) },
      }
    else
      throw new Error(`Unknown remote session operation: ${JSON.stringify(operation)}`)
  }

  private claim(sender: WebContents, remoteEndpointId: string, attachId: string): void {
    const key = ServiceRemoteControlIpc.attachKey(remoteEndpointId, attachId)
    this.attaches.set(key, { sender, remoteEndpointId, attachId })
    const held = this.owned.get(sender)
    if (held) held.add(key)
    else this.owned.set(sender, new Set([key]))
    this.wire(sender)
  }

  /**
   * A window that dies or navigates away releases everything it was holding. Without this a closed
   * window would keep every paired computer dialled for as long as the app ran, which is the state
   * this whole mechanism exists to end.
   */
  private wire(sender: WebContents): void {
    if (this.wired.has(sender)) return
    this.wired.add(sender)
    sender.on('destroyed', () => this.releaseAll(sender))
    sender.on('did-start-navigation', () => this.releaseAll(sender))
  }

  private release(sender: WebContents, remoteEndpointId: string, attachId: string): void {
    const key = ServiceRemoteControlIpc.attachKey(remoteEndpointId, attachId)
    if (this.attaches.get(key)?.sender !== sender) return
    this.attaches.delete(key)
    const held = this.owned.get(sender)
    if (!held) return
    held.delete(key)
    if (held.size === 0) this.owned.delete(sender)
  }

  private ownedView(sender: WebContents, endpointId: string, viewId: string) {
    const held = this.views.get(JSON.stringify([endpointId, viewId]))
    if (!held || held.sender !== sender || held.endpointId !== endpointId) throw new Error('Session view is not owned by this renderer')
    return held
  }

  private releaseAll(sender: WebContents): void {
    this.viewers.delete(sender)
    for (const [viewId, held] of this.views) {
      if (held.sender !== sender) continue
      this.views.delete(viewId)
      this.deps.releaseMedia?.(held.endpointId, held.view.viewId)
      void this.outbound.sessionView(held.endpointId, { ...held.view, requestId: this.requestId(), operation: 'views.close', body: {} })
    }
    const reasons = this.holds.get(sender)
    if (reasons) {
      this.holds.delete(sender)
      for (const reason of reasons)
        this.outbound.releaseConnections(ServiceRemoteControlIpc.holdKey(sender, reason))
    }
    const held = this.owned.get(sender)
    if (!held) return
    this.owned.delete(sender)
    for (const key of held) {
      const attach = this.attaches.get(key)
      if (attach?.sender !== sender) continue
      this.attaches.delete(key)
      void this.outbound.detachTerminal(attach.remoteEndpointId, attach.attachId)
    }
  }

  private assertOwner(sender: WebContents, remoteEndpointId: string, attachId: string): void {
    const owner = this.attaches.get(ServiceRemoteControlIpc.attachKey(remoteEndpointId, attachId))
    if (owner?.sender !== sender)
      throw new Error(`Remote terminal attach is not owned by this renderer: ${attachId}`)
  }

  /** The connector holds names, not objects, so the key has to tell two windows apart by itself. */
  private static holdKey(sender: WebContents, reason: RemoteConnectionsHoldReason): string {
    return `renderer ${sender.id} ${reason}`
  }

  private static attachKey(remoteEndpointId: string, attachId: string): string {
    return `${remoteEndpointId}\u0000${attachId}`
  }
}
