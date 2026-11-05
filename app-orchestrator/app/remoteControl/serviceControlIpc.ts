import { randomUUID } from 'node:crypto'

import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import { RemoteControlConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { ServiceIpcBase } from '../../../lib-orchestrator/clientApi/serviceIpcBase'

/**
 * The window's one channel into the operation registry: every operation the control API offers, by
 * name, with the same schema, replay store and call log as a script over HTTP. The window is a caller
 * like any other, granted every operation, and named by its own window so the call log says which.
 */
export class ServiceControlIpc extends ServiceIpcBase<typeof ServiceControlIpc.channelsConst> {
  static readonly channelsConst = {
    'control:call': true,
  } as const

  private readonly registry: Pick<RemoteControlRegistry, 'execute' | 'isWrite' | 'names'>

  constructor(
    registry: Pick<RemoteControlRegistry, 'execute' | 'isWrite' | 'names'>,
  ) {
    super()
    this.registry = registry
  }

  initialize(): void {
    this.register('control:call', (event, operation, body) => this.registry.execute({
      protocol: RemoteControlConst.protocol,
      requestId: `window:${randomUUID()}`,
      operation,
      // A fresh id per press: the window never retries a write, so the replay store only has to
      // tell this write from every other one.
      ...(this.registry.isWrite(operation) ? { operationId: randomUUID() } : {}),
      body,
    }, {
      callerId: `window:${event.windowId}`,
      callerKind: 'window',
      allowedOperations: this.registry.names(),
    }))
    this.assertComplete(ServiceControlIpc.channelsConst)
  }
}
