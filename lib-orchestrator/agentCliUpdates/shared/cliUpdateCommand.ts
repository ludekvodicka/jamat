import { homedir } from 'node:os'
import { AgentCommandView, type AgentCommand } from '../../sessionManager/agentCommandView'
import { CommandInvoker } from '../../shared/commandInvoker'
import { CliVersion } from './cliVersion'
import type { CliInstallation } from '../agentCliUpdateSource'

export class CliUpdateCommand {
  private readonly environment: NodeJS.ProcessEnv
  private readonly invoker: Pick<CommandInvoker, 'run'>

  constructor(environment: NodeJS.ProcessEnv, invoker: Pick<CommandInvoker, 'run'> = new CommandInvoker()) {
    this.environment = { ...environment }
    this.invoker = invoker
  }

  async inspect(name: string, channel: string, versionPattern: RegExp, signal: AbortSignal): Promise<CliInstallation | null> {
    const command = await AgentCommandView.resolve(name, this.environment)
    if (command === null) return null
    const version = CliVersion.parse(versionPattern.exec((await this.run(command, ['--version'], signal)).trim())?.[1] ?? '')
    const help = await this.run(command, ['--help'], signal)
    return { command, version, channel, updateSupported: /^\s+update(?:\s|\|)/m.test(help) }
  }

  async update(installation: CliInstallation, signal: AbortSignal, output: (text: string) => void): Promise<void> {
    await this.run(installation.command, ['update'], signal, output)
  }

  private async run(command: AgentCommand, args: string[], signal: AbortSignal, output?: (text: string) => void): Promise<string> {
    const result = await this.invoker.run({
      command: command.command, args: [...command.prefixArgs, ...args], env: this.environment,
      cwd: homedir(), signal, timeoutMs: output ? 10 * 60_000 : 15_000,
      retain: { tailBytes: 32_768 }, onStdout: output, onStderr: output,
    })
    if (result.code !== 0 || result.failure !== null)
      throw new Error(result.stderr.trim() || result.stdout.trim() || `CLI command failed (${result.failure ?? result.code}).`)
    return result.stdout
  }
}
