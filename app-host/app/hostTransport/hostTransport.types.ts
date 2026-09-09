import type { WebSocket } from 'ws'

import type { HostHello } from '../wire/hostWire.js'

export interface HostTransportCallbacks {
  hello(): HostHello
  onWebSocket(webSocket: WebSocket): void
}
