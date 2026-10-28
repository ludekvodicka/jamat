import { homedir } from 'node:os'
import { join } from 'node:path'
import { ClaudeConfigHome } from '../shared/claudeConfigHome'
import { claudeShareTable } from './claude/claudeProfile'
import { ClaudeIdentityProbe } from './claude/claudeIdentityProbe'
import { mergeClaudeJson } from './claude/claudeJsonMerge'
import type { AgentAccountsDeps } from './agentAccounts'
import { codexProfileEnvironment, codexShareTable } from './codex/codexProfile'
import { CodexIdentityProbe } from './codex/codexIdentityProbe'
import { CodexProfileConfiguration } from './codex/codexProfileConfiguration'

export function builtInAccountProfiles(environment: NodeJS.ProcessEnv): Pick<AgentAccountsDeps, 'mainHomes' | 'specs'> {
  const claudeHome = ClaudeConfigHome.resolve(environment.CLAUDE_CONFIG_DIR)
  const probe = new ClaudeIdentityProbe()
  const mainJsonPath = join(environment.CLAUDE_CONFIG_DIR || homedir(), '.claude.json')
  const codexHome = environment.CODEX_HOME || join(homedir(), '.codex')
  const codexProbe = new CodexIdentityProbe(environment)
  const codexConfig = new CodexProfileConfiguration(environment)
  return {
    mainHomes: { claude: claudeHome, codex: codexHome },
    specs: [{ agentId: 'claude', mainHome: () => claudeHome, shareTable: claudeShareTable,
      homeVariable: 'CLAUDE_CONFIG_DIR', extraEnv: () => ({}), loginCommand: 'claude auth login',
      probe: home => probe.read(home === claudeHome ? mainJsonPath : join(home, '.claude.json')),
      beforeLaunch: async home => mergeClaudeJson(home, mainJsonPath),
    }, { agentId: 'codex', mainHome: () => codexHome, shareTable: codexShareTable,
      homeVariable: 'CODEX_HOME', extraEnv: codexProfileEnvironment, loginCommand: 'codex login',
      probe: (home, retain) => codexProbe.read(home, codexHome, retain),
      beforeLaunch: (home, main, cwd, settings, retain) => codexConfig.verify(home, main, cwd ?? home, settings, retain),
    }],
  }
}
