import type { AgentCliUpdateSource, CliInstallation } from '../agentCliUpdateSource'
import { CliUpdateCommand } from '../shared/cliUpdateCommand'
import { CliVersion } from '../shared/cliVersion'
import { ReleaseFeed } from '../shared/releaseFeed'

export class AntigravityCliUpdateSource implements AgentCliUpdateSource {
  private static readonly changelogUrlConst = 'https://antigravity.google/docs/changelog.md'
  private static readonly changelogMaxBytesConst = 2 * 1_048_576

  readonly id = 'antigravity'
  readonly label = 'Antigravity'
  private readonly commands: CliUpdateCommand
  private readonly feed: ReleaseFeed

  constructor(commands: CliUpdateCommand, feed: ReleaseFeed) {
    this.commands = commands
    this.feed = feed
  }

  inspect(signal: AbortSignal): Promise<CliInstallation | null> {
    return this.commands.inspect('agy', 'latest', /^(\S+)$/, signal)
  }

  async latest(_installation: CliInstallation, signal: AbortSignal): Promise<string> {
    const markdown = await this.feed.text(
      AntigravityCliUpdateSource.changelogUrlConst,
      signal,
      AntigravityCliUpdateSource.changelogMaxBytesConst,
    )
    return AntigravityCliUpdateSource.parseLatestFromChangelog(markdown)
  }

  update(installation: CliInstallation, signal: AbortSignal, output: (text: string) => void): Promise<void> {
    return this.commands.update(installation, signal, output)
  }

  static parseLatestFromChangelog(markdown: string): string {
    const sectionMatch = /^##\s+Antigravity CLI\b[^\n]*\r?\n([\s\S]*?)(?=^##\s+|\s*$)/im.exec(markdown)
    if (!sectionMatch)
      throw new Error('The Antigravity release feed contained no Antigravity CLI section')
    const section = sectionMatch[1]!
    const versionMatch = /^(?:#{3,6}\s+v?|\*\*v?|v?)(\d+\.\d+\.\d+)\b/m.exec(section)
    if (!versionMatch)
      throw new Error('The Antigravity release feed returned no CLI version')
    return CliVersion.parse(versionMatch[1]!)
  }
}
