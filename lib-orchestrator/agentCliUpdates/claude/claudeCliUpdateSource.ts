import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentCliUpdateSource, CliInstallation } from '../agentCliUpdateSource'
import { CliUpdateCommand } from '../shared/cliUpdateCommand'
import { ReleaseFeed } from '../shared/releaseFeed'
import { CliVersion } from '../shared/cliVersion'
import { ErrnoCode } from '../../shared/errnoCode'

export class ClaudeCliUpdateSource implements AgentCliUpdateSource {
  readonly id = 'claude'
  readonly label = 'Claude Code'
  private readonly commands: CliUpdateCommand
  private readonly feed: ReleaseFeed
  private readonly settingsFile: string

  constructor(commands: CliUpdateCommand, feed: ReleaseFeed, settingsFile = join(homedir(), '.claude', 'settings.json')) {
    this.commands = commands
    this.feed = feed
    this.settingsFile = settingsFile
  }

  async inspect(signal: AbortSignal): Promise<CliInstallation | null> {
    let settings: { autoUpdatesChannel?: unknown } = {}
    try { settings = JSON.parse(await readFile(this.settingsFile, 'utf8')) }
    catch (error) { if (ErrnoCode.of(error) !== 'ENOENT') throw error }
    const channel = settings?.autoUpdatesChannel ?? 'latest'
    if (channel !== 'latest' && channel !== 'stable') throw new Error(`Unsupported Claude update channel: ${channel}`)
    return this.commands.inspect('claude', channel, /^(\S+) \(Claude Code\)$/, signal)
  }

  async latest(installation: CliInstallation, signal: AbortSignal): Promise<string> {
    if (installation.channel !== 'latest' && installation.channel !== 'stable') throw new Error('Unsupported Claude update channel')
    return CliVersion.parse(await this.feed.text(`https://downloads.claude.ai/claude-code-releases/${installation.channel}`, signal))
  }

  update(installation: CliInstallation, signal: AbortSignal, output: (text: string) => void): Promise<void> {
    return this.commands.update(installation, signal, output)
  }
}
