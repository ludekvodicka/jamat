import type { RuntimeLaunchSpec } from '../wire/hostWire.js'
import { TerminalInstance } from './terminalInstance.js'
import type {
  TerminalInstanceDriver,
  TerminalInstanceEvent,
  TerminalInstanceFactory,
} from './terminal.types.js'

export class TerminalInstanceManager {
  private readonly instances = new Map<string, TerminalInstanceDriver>()

  constructor(
    private readonly onEvent: (event: TerminalInstanceEvent) => void,
    private readonly factory: TerminalInstanceFactory = (
      runtimeSessionId,
      generation,
      outputEpoch,
      launch,
      eventSink,
    ) => new TerminalInstance(
      runtimeSessionId,
      generation,
      outputEpoch,
      launch,
      eventSink,
    ),
  ) {}

  create(
    runtimeSessionId: string,
    generation: number,
    outputEpoch: number,
    launch: RuntimeLaunchSpec,
  ): TerminalInstanceDriver {
    if (this.instances.has(runtimeSessionId))
      throw new Error(`Terminal instance already exists: ${runtimeSessionId}`)
    const instance = this.factory(
      runtimeSessionId,
      generation,
      outputEpoch,
      launch,
      this.onEvent,
    )
    this.instances.set(runtimeSessionId, instance)
    return instance
  }

  replace(
    runtimeSessionId: string,
    generation: number,
    outputEpoch: number,
    launch: RuntimeLaunchSpec,
  ): TerminalInstanceDriver {
    const existing = this.instances.get(runtimeSessionId)
    existing?.dispose()
    const instance = this.factory(
      runtimeSessionId,
      generation,
      outputEpoch,
      launch,
      this.onEvent,
    )
    this.instances.set(runtimeSessionId, instance)
    return instance
  }

  get(runtimeSessionId: string): TerminalInstanceDriver | undefined {
    return this.instances.get(runtimeSessionId)
  }

  remove(runtimeSessionId: string): TerminalInstanceDriver | undefined {
    const existing = this.instances.get(runtimeSessionId)
    if (!existing) return undefined
    this.instances.delete(runtimeSessionId)
    existing.dispose()
    return existing
  }

  list(): TerminalInstanceDriver[] {
    return [...this.instances.values()]
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.list().map((instance) => instance.stop()))
  }

  dispose(): void {
    for (const instance of this.instances.values()) instance.dispose()
    this.instances.clear()
  }
}
