import { ServiceIpcBase } from '../../../lib-orchestrator/clientApi/serviceIpcBase'
import type { ServiceCaller } from '../../../lib-orchestrator/clientApi/serviceTransport.types'
import type { SessionUncommittedOperations } from './sessionUncommittedOperations'

/** The read half of the uncommitted mark's snapshot pair (D12); the push is `sessions:uncommitted-changed`. */
export class ServiceSessionUncommittedIpc extends ServiceIpcBase<typeof ServiceSessionUncommittedIpc.channelsConst> {
  static readonly channelsConst = {
    'sessions:uncommitted': true,
  } as const

  private readonly operations: Pick<SessionUncommittedOperations, 'snapshot'>
  private readonly ownerIdOf: (caller: ServiceCaller) => string | null

  constructor(operations: Pick<SessionUncommittedOperations, 'snapshot'>, ownerIdOf: (caller: ServiceCaller) => string | null) {
    super()
    this.operations = operations
    this.ownerIdOf = ownerIdOf
  }

  initialize(): void {
    this.register('sessions:uncommitted', (caller) => {
      if (this.ownerIdOf(caller) === null) throw new Error('The uncommitted mark was asked for by an unknown workspace')
      return this.operations.snapshot()
    })
    this.assertComplete(ServiceSessionUncommittedIpc.channelsConst)
  }
}
