import { homedir } from 'node:os'
import { join } from 'node:path'
import { AntigravityConfigHome } from '../shared/antigravityConfigHome'
import { ClaudeConfigHome } from '../shared/claudeConfigHome'
import { AntigravityIdentityProbe } from './antigravity/antigravityIdentityProbe'
import { claudeShareTable } from './claude/claudeProfile'
import { ClaudeIdentityProbe } from './claude/claudeIdentityProbe'
import { mergeClaudeJson } from './claude/claudeJsonMerge'
import type { AgentAccountsDeps } from './agentAccounts'
import { codexProfileEnvironment, codexShareTable } from './codex/codexProfile'
import { CodexIdentityProbe } from './codex/codexIdentityProbe'
import { CodexProfileConfiguration } from './codex/codexProfileConfiguration'

export function builtInAccountProfiles(
  environment: NodeJS.ProcessEnv,
  antigravityAccountFile?: string,
): Pick<AgentAccountsDeps, 'mainHomes' | 'mainProbes' | 'specs'> {
  const claudeHome = ClaudeConfigHome.resolve(environment.CLAUDE_CONFIG_DIR)
  const probe = new ClaudeIdentityProbe()
  const mainJsonPath = join(environment.CLAUDE_CONFIG_DIR || homedir(), '.claude.json')
  const codexHome = environment.CODEX_HOME || join(homedir(), '.codex')
  const codexProbe = new CodexIdentityProbe(environment)
  const codexConfig = new CodexProfileConfiguration(environment)
  const antigravityHome = AntigravityConfigHome.resolve()
  const antigravityProbe = new AntigravityIdentityProbe()
  return {
    mainHomes: { claude: claudeHome, codex: codexHome, antigravity: antigravityHome },
    ...(antigravityAccountFile === undefined
      ? {}
      : { mainProbes: { antigravity: () => antigravityProbe.read(antigravityAccountFile) } }),
    specs: [{ agentId: 'claude', mainHome: () => claudeHome, shareTable: claudeShareTable,
      homeVariable: 'CLAUDE_CONFIG_DIR', extraEnv: () => ({}), loginCommand: 'claude auth login', loginLinkVariable: 'BROWSER',
      probe: home => probe.read(home === claudeHome ? mainJsonPath : join(home, '.claude.json')),
      beforeLaunch: async home => mergeClaudeJson(home, mainJsonPath),
    }, { agentId: 'codex', mainHome: () => codexHome, shareTable: codexShareTable,
      homeVariable: 'CODEX_HOME', extraEnv: codexProfileEnvironment, loginCommand: 'codex login',
      probe: (home, retain) => codexProbe.read(home, codexHome, retain),
      beforeLaunch: (home, main, cwd, settings, retain) => codexConfig.verify(home, main, cwd ?? home, settings, retain),
    }],
  }
}
