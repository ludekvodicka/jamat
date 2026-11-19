import type { AccountAgentId, AccountIdentity, AccountLaunchSettings, RetainProfile } from '../agentAccountsApi.types'

export interface ProfileShareTable {
  directories: readonly string[]
  files: readonly string[]
  neverShared: readonly string[]
}

/** `rateLimitTier` is the plan the provider names for the login, such as `default_claude_max_20x`. */
export type IdentityProbe = { kind: 'logged-in'; identity: AccountIdentity; rateLimitTier?: string }
  | { kind: 'logged-out' } | { kind: 'failed'; reason: string }

export interface AgentProfileSpec {
  agentId: AccountAgentId
  mainHome(): string
  shareTable: ProfileShareTable
  homeVariable: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'
  extraEnv(mainHome: string): Record<string, string>
  loginCommand: string
  /** The variable naming the program the login command opens its sign-in link with, so Jamat can hold the link instead. */
  loginLinkVariable?: 'BROWSER'
  probe(home: string, retain?: RetainProfile): Promise<IdentityProbe>
  beforeLaunch?(profileHome: string, mainHome: string, cwd?: string, settings?: AccountLaunchSettings, retain?: RetainProfile): Promise<void>
}
