import type { AgentCliUpdateSource } from './agentCliUpdateSource'
import { ClaudeCliUpdateSource } from './claude/claudeCliUpdateSource'
import { CodexCliUpdateSource } from './codex/codexCliUpdateSource'
import { CliUpdateCommand } from './shared/cliUpdateCommand'
import { ReleaseFeed } from './shared/releaseFeed'

export class AgentCliUpdateSources {
  static create(environment: NodeJS.ProcessEnv, claudeSettingsFile: string): readonly AgentCliUpdateSource[] {
    const commands = new CliUpdateCommand(environment)
    const feed = new ReleaseFeed()
    return [new CodexCliUpdateSource(commands, feed), new ClaudeCliUpdateSource(commands, feed, claudeSettingsFile)]
  }
}
