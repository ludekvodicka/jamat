import type { AgentCliUpdateSource, CliInstallation } from '../agentCliUpdateSource'
import { CliUpdateCommand } from '../shared/cliUpdateCommand'
import { CliVersion } from '../shared/cliVersion'
import { ReleaseFeed } from '../shared/releaseFeed'

export class AntigravityCliUpdateSource implements AgentCliUpdateSource {
  private static readonly manifestBaseUrlConst =
    'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests'

  readonly id = 'antigravity'
  readonly label = 'Antigravity'
  private readonly commands: CliUpdateCommand
  private readonly feed: ReleaseFeed
  private readonly platform: NodeJS.Platform
  private readonly arch: NodeJS.Architecture

  constructor(
    commands: CliUpdateCommand,
    feed: ReleaseFeed,
    platform: NodeJS.Platform = process.platform,
    arch: NodeJS.Architecture = process.arch,
  ) {
    this.commands = commands
    this.feed = feed
    this.platform = platform
    this.arch = arch
  }

  inspect(signal: AbortSignal): Promise<CliInstallation | null> {
    return this.commands.inspect('agy', 'latest', /^(\S+)$/, signal)
  }

  async latest(_installation: CliInstallation, signal: AbortSignal): Promise<string> {
    const url = AntigravityCliUpdateSource.manifestUrl(this.platform, this.arch)
    const value: unknown = JSON.parse(await this.feed.text(url, signal))
    if (typeof value !== 'object' || value === null || !('version' in value) || typeof value.version !== 'string')
      throw new Error('The Antigravity release feed returned no CLI version')
    return CliVersion.parse(value.version)
  }

  update(installation: CliInstallation, signal: AbortSignal, output: (text: string) => void): Promise<void> {
    return this.commands.update(installation, signal, output)
  }

  static manifestUrl(platform: NodeJS.Platform, arch: NodeJS.Architecture): string {
    let os: string
    if (platform === 'win32') os = 'windows'
    else if (platform === 'darwin') os = 'darwin'
    else if (platform === 'linux') os = 'linux'
    else throw new Error(`Unsupported Antigravity CLI platform: ${platform}`)

    let cpu: string
    if (arch === 'x64') cpu = 'amd64'
    else if (arch === 'arm64') cpu = 'arm64'
    else throw new Error(`Unsupported Antigravity CLI architecture: ${arch}`)

    return `${AntigravityCliUpdateSource.manifestBaseUrlConst}/${os}_${cpu}.json`
  }
}
