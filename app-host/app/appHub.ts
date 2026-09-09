import type { WebSocket } from 'ws'

import type { AppContext } from './appContext.js'
import { AttachHub } from './attach/attachHub.js'
import { ControllerLeaseManager } from './controller/controllerLeaseManager.js'
import { ServiceController } from './controller/serviceController.js'
import { EventHub } from './events/eventHub.js'
import { HostStatePaths } from './hostRuntime/hostStatePaths.js'
import type { HostOperationRouter } from './hostTransport/hostOperationRouter.js'
import { ServiceSessions } from './sessions/serviceSessions.js'
import { SessionManager } from './sessions/sessionManager.js'
import { SessionStore } from './sessions/sessionStore.js'
import type { HostEventPayload } from './wire/hostWire.js'

/**
 * The one composition layer. V2 reached its domains through two classes that only forwarded calls
 * (AppHub onto ModuleRuntimeSessions onto the objects), so a new method had to be written three
 * times to become reachable. This assembles the domains directly and exposes only what app.ts calls.
 */
export class AppHub {
  private readonly events = new EventHub()
  private readonly leases = new ControllerLeaseManager()
  private readonly sessions: SessionManager
  private readonly attach: AttachHub
  private readonly serviceSessions: ServiceSessions
  private readonly serviceController: ServiceController

  constructor(context: AppContext) {
    const { configIdentity } = context.config.identity
    const channel = context.config.runtimeChannel
    // Constructed empty, never loaded: a new Host instance inherits nothing, because nothing a dead
    // Host wrote can still be true. See the class comment on SessionStore.
    const store = new SessionStore(
      HostStatePaths.registry(configIdentity, channel),
      (message) => context.log(`WARN ${message}`),
    )
    this.sessions = new SessionManager(store, this.events, context.hostInstanceId)
    this.attach = new AttachHub(this.sessions, this.leases, this.events)
    this.serviceSessions = new ServiceSessions(this.sessions, this.leases, this.events)
    this.serviceController = new ServiceController(this.leases)
  }

  /** Both services together cover the wire surface; `assertComplete` is what proves it at boot. */
  registerOperations(router: HostOperationRouter): void {
    this.serviceController.registerOperations(router)
    this.serviceSessions.registerOperations(router)
  }

  handleWebSocket(webSocket: WebSocket): void {
    this.attach.handle(webSocket)
  }

  liveRuntimeCount(): number {
    return this.sessions.liveCount()
  }

  runtimeCounts(): { live: number; dead: number } {
    return this.sessions.counts()
  }

  stopAllRuntimes(beforeMutation?: () => void): Promise<void> {
    return this.sessions.stopAll(beforeMutation)
  }

  publish(event: HostEventPayload): void {
    this.events.publish(event)
  }

  eventRevision(): number {
    return this.events.revision
  }

  requireController(controllerLeaseId: string): void {
    this.leases.require(controllerLeaseId)
  }

  destroy(): void {
    this.sessions.destroy()
  }
}
