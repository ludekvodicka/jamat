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
import { ServiceIpcBase } from '../shared/serviceIpcBase'

interface RemoteRendererAttach {
  sender: WebContents
  remoteEndpointId: string
  attachId: string
}

export interface ServiceRemoteControlIpcDeps {
  revision(): number
  acceptsRenderer(sender: WebContents): boolean
  requestId?(): string
  operationId?(): string
}

export class ServiceRemoteControlIpc
  extends ServiceIpcBase<typeof ServiceRemoteControlIpc.channelsConst> {
  static readonly channelsConst = {
    'remote:snapshot': true,
    'remote:connect': true,
    'remote:select-session': true,
    'remote:disconnect': true,
    'remote:release': true,
    'remote:agents-describe': true,
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
  } as const

  private readonly owned = new Map<WebContents, Set<string>>()
  private readonly attaches = new Map<string, RemoteRendererAttach>()
  /** Window ownership releases an explicitly connected endpoint when its dialog closes. */
  private readonly holds = new Map<WebContents, Set<RemoteConnectionsHoldReason>>()
  private readonly wired = new WeakSet<WebContents>()
  private readonly requestId: () => string
  private readonly operationId: () => string

  constructor(
    private readonly outbound: RemoteConnectionsManager,
    private readonly inbound: RemoteControlInboundRegistry,
    private readonly deps: ServiceRemoteControlIpcDeps,
  ) {
    super()
    this.requestId = deps.requestId ?? randomUUID
    this.operationId = deps.operationId ?? randomUUID
  }

  initialize(): void {
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
    this.register('remote:projects-list', (_event, endpointId, request) =>
      this.outbound.execute(endpointId, this.projectsRequest(request)))
    this.register('remote:sessions-create', (_event, endpointId, spec, operationId) =>
      this.outbound.execute(endpointId, this.createRequest(spec, operationId)))
    this.register('remote:sessions-reopen', (_event, endpointId, sessionId) =>
      this.outbound.execute(endpointId, this.sessionRequest('sessions.reopen', sessionId)))
    this.register('remote:sessions-finalize', (_event, endpointId, sessionId) =>
      this.outbound.execute(endpointId, this.sessionRequest('sessions.finalize', sessionId)))
    // The one remote channel that sends nothing over the wire: what it answers is composed from the
    // snapshot that computer already pushed.
    this.register('remote:sessions-reference', (_event, endpointId, sessionId) =>
      this.outbound.sessionReference(endpointId, sessionId))
    this.register('remote:terminal-attach', async (event, endpointId, attachId, spec) => {
      if (!this.deps.acceptsRenderer(event.sender))
        throw new Error('The workspace window is closing')
      if (!this.outbound.isSessionSelected(endpointId, spec.sessionId))
        return { ok: false, error: { code: 'unavailable', detail: 'Select this session in Remote computers to connect it.' } }
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
      return { ...common, operation }
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

  private releaseAll(sender: WebContents): void {
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
