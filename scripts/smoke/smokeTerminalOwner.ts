import { LocalHostConnection } from '../../lib-orchestrator/hostClient/hostConnection'
import { HostDescriptorPaths } from '../../lib-orchestrator/hostClient/hostDescriptorPaths'
import { TerminalAttachSocket } from '../../lib-orchestrator/hostClient/terminalAttachSocket'
import { TerminalGateway } from '../../lib-orchestrator/sessionManager/terminalGateway'
import type { SessionManagerDeps } from '../../lib-orchestrator/sessionManager/sessionManager'
import type { TerminalActivitySink } from '../../lib-orchestrator/sessionManager/terminalPort'

/** Node smoke composition owns the same local dependencies that the utility process owns in Electron. */
export class SmokeTerminalOwner {
  readonly sessionDeps: Pick<SessionManagerDeps, 'connection' | 'connectionDebug' | 'terminals' | 'terminalsFeed' | 'closeTerminals'>
  private readonly connection: LocalHostConnection
  private readonly terminals: TerminalGateway
  private readonly unsubscribe: () => void

  constructor(deps: Pick<SessionManagerDeps, 'configIdentity' | 'channel' | 'onError'> & {
    controllerId?: string; activity: TerminalActivitySink
  }) {
    this.connection = new LocalHostConnection({
      descriptorFile: HostDescriptorPaths.descriptorFile(deps.configIdentity, deps.channel),
      controllerId: deps.controllerId, onError: deps.onError,
    })
    this.terminals = new TerminalGateway({ descriptorOf: () => this.connection.descriptor(),
      leaseIdOf: () => this.connection.leaseId(), socketFactory: args => new TerminalAttachSocket(args),
      activity: deps.activity, onError: deps.onError })
    this.unsubscribe = this.connection.onChanged(() => {
      if (this.connection.leaseId() !== null) this.terminals.leaseChanged()
    })
    this.sessionDeps = { connection: this.connection, connectionDebug: () => this.connection.debugView(),
      terminals: this.terminals, terminalsFeed: this.terminals, closeTerminals: async () => this.terminals.closeAll() }
  }

  start(): void { this.connection.start() }
  async stop(): Promise<void> {
    this.terminals.closeAll()
    this.unsubscribe()
    await this.connection.stop()
  }
}
