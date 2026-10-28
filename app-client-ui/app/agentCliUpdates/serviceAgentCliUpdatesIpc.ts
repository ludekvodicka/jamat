import type { AgentCliUpdates } from '../../../lib-orchestrator/agentCliUpdates/agentCliUpdates'
import { ServiceIpcBase } from '../shared/serviceIpcBase'

export class ServiceAgentCliUpdatesIpc extends ServiceIpcBase<typeof ServiceAgentCliUpdatesIpc.channelsConst> {
  static readonly channelsConst = {
    'agentCliUpdates:get': true,
    'agentCliUpdates:check': true,
    'agentCliUpdates:install': true,
  } as const
  private readonly updates: AgentCliUpdates

  constructor(updates: AgentCliUpdates) {
    super()
    this.updates = updates
  }

  initialize(): void {
    this.register('agentCliUpdates:get', () => this.updates.snapshot())
    this.register('agentCliUpdates:check', () => this.updates.check())
    this.register('agentCliUpdates:install', (_event, id) => this.updates.install(id))
    this.assertComplete(ServiceAgentCliUpdatesIpc.channelsConst)
  }
}
