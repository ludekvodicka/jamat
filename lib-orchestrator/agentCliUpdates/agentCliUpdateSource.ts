import type { AgentCommand } from '../sessionManager/agentCommandView'

export interface CliInstallation {
  command: AgentCommand
  version: string
  channel: string
  updateSupported: boolean
}

export interface AgentCliUpdateSource {
  readonly id: string
  readonly label: string
  inspect(signal: AbortSignal): Promise<CliInstallation | null>
  latest(installation: CliInstallation, signal: AbortSignal): Promise<string>
  update(installation: CliInstallation, signal: AbortSignal, output: (text: string) => void): Promise<void>
}
