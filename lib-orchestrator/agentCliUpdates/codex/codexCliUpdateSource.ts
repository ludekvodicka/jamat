import type { AgentCliUpdateSource, CliInstallation } from '../agentCliUpdateSource'
import { CliUpdateCommand } from '../shared/cliUpdateCommand'
import { ReleaseFeed } from '../shared/releaseFeed'
import { CliVersion } from '../shared/cliVersion'

export class CodexCliUpdateSource implements AgentCliUpdateSource {
  readonly id = 'codex'
  readonly label = 'Codex'
  private readonly commands: CliUpdateCommand
  private readonly feed: ReleaseFeed

  constructor(commands: CliUpdateCommand, feed: ReleaseFeed) {
    this.commands = commands
    this.feed = feed
  }

  inspect(signal: AbortSignal): Promise<CliInstallation | null> {
    return this.commands.inspect('codex', 'latest', /^codex-cli (\S+)$/, signal)
  }

  async latest(_installation: CliInstallation, signal: AbortSignal): Promise<string> {
    const value: unknown = JSON.parse(await this.feed.text('https://registry.npmjs.org/@openai%2Fcodex/latest', signal))
    if (typeof value !== 'object' || value === null || !('version' in value) || typeof value.version !== 'string')
      throw new Error('The Codex release feed returned no version')
    return CliVersion.parse(value.version)
  }

  update(installation: CliInstallation, signal: AbortSignal, output: (text: string) => void): Promise<void> {
    return this.commands.update(installation, signal, output)
  }
}
