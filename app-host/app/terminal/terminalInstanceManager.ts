import type { RuntimeLaunchSpec } from '../wire/hostWire.js'
import { ConsoleReaper } from './consoleReaper.js'
import { TerminalInstance } from './terminalInstance.js'
import type {
  TerminalInstanceDriver,
  TerminalInstanceEvent,
  TerminalInstanceFactory,
} from './terminal.types.js'

export class TerminalInstanceManager {
  private readonly instances = new Map<string, TerminalInstanceDriver>()
  private readonly onEvent: (event: TerminalInstanceEvent) => void
  private readonly factory: TerminalInstanceFactory
  private readonly consoles: Pick<ConsoleReaper, 'exited' | 'dispose'> | null

  /**
   * Without a factory the instances are real PTYs, and their leftover consoles are reaped; an injected
   * factory owns no console, so nothing is reaped unless `consoles` is given as well.
   */
  constructor(
    onEvent: (event: TerminalInstanceEvent) => void,
    factory?: TerminalInstanceFactory,
    consoles?: Pick<ConsoleReaper, 'exited' | 'dispose'>,
  ) {
    this.factory = factory ?? ((runtimeSessionId, generation, outputEpoch, launch, eventSink) =>
      new TerminalInstance(runtimeSessionId, generation, outputEpoch, launch, eventSink))
    this.consoles = consoles ?? (factory ? null : new ConsoleReaper(() => this.list()))
    this.onEvent = (event) => {
      if (event.type === 'exit') this.consoles?.exited()
      onEvent(event)
    }
  }

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

  async stopAll(): Promise<string[]> {
    const instances = this.list()
    const results = await Promise.allSettled(instances.map((instance) => instance.stop()))
    return results.flatMap((result, index) => result.status === 'rejected'
      ? [`${instances[index].runtimeSessionId}: ${String(result.reason)}`] : [])
  }

  dispose(): void {
    this.consoles?.dispose()
    for (const instance of this.instances.values()) instance.dispose()
    this.instances.clear()
  }
}
