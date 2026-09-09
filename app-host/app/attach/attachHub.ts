import type { WebSocket } from 'ws'

import { ControllerLeaseManager } from '../controller/controllerLeaseManager.js'
import { EventHub } from '../events/eventHub.js'
import { SessionManager } from '../sessions/sessionManager.js'
import { AttachConnection } from './attachConnection.js'

export class AttachHub {
  constructor(
    private readonly sessions: SessionManager,
    private readonly leases: ControllerLeaseManager,
    private readonly events: EventHub,
  ) {}

  handle(webSocket: WebSocket): void {
    const connection = new AttachConnection(
      webSocket,
      this.sessions,
      this.leases,
      this.events,
    )
    // one frame at a time: a second terminal.attach must not run while the first awaits its snapshot.
    // onMessage reports its own failures to the client, so the catch only keeps the queue from poisoning.
    let handled: Promise<void> = Promise.resolve()
    webSocket.on('message', (raw: Buffer) => {
      handled = handled.then(() => connection.onMessage(raw)).catch(() => {})
    })
    webSocket.on('close', () => connection.teardown())
    webSocket.on('error', () => connection.teardown())
  }
}
