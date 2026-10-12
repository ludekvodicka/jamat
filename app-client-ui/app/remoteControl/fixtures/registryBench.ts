import { RemoteControlRegistry } from '../../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import type { RemoteControlStepResult } from '../../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlConst } from '../../../../lib-orchestrator/remoteControl/remoteControlProtocol'

/**
 * One registry for the operations a test registers, called the way the window calls it: by name,
 * with a fresh operation id for every write, answered as a step result.
 */
export class RegistryBench {
  readonly errors: string[] = []
  readonly registry = new RemoteControlRegistry({ onError: (message) => this.errors.push(message) })
  private writes = 0

  async call(operation: string, body: unknown = {}): Promise<RemoteControlStepResult<unknown>> {
    const answer = await this.registry.execute({
      protocol: RemoteControlConst.protocol,
      requestId: `bench-${operation}`,
      operation,
      ...(this.registry.isWrite(operation) ? { operationId: `bench-write-${++this.writes}` } : {}),
      body,
    }, { callerId: 'window:bench', callerKind: 'window', allowedOperations: this.registry.names() })
    return answer.ok ? { ok: true, value: answer.value } : { ok: false, error: answer.error }
  }
}
