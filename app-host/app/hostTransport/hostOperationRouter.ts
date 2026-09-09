import { HostWireConst, type HostOpName } from '../wire/hostWire.js'

export type HostOperationHandler =
  (body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown> | unknown

export class HostOperationRouter {
  private readonly handlers = new Map<HostOpName, HostOperationHandler>()

  register(name: HostOpName, handler: HostOperationHandler): void {
    if (this.handlers.has(name)) throw new Error(`Host operation already registered: ${name}`)
    this.handlers.set(name, handler)
  }

  dispatch(
    name: HostOpName,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> | unknown {
    const handler = this.handlers.get(name)
    if (!handler) throw new Error(`Host operation is not registered: ${name}`)
    return handler(body, signal)
  }

  /** Called at boot: a wire op with no handler must fail the start, not a later request. */
  assertComplete(): void {
    for (const name of Object.keys(HostWireConst.ops) as HostOpName[])
      if (!this.handlers.has(name)) throw new Error(`Host operation is not registered: ${name}`)
  }
}
