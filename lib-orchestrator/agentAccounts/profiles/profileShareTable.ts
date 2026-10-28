import type { AccountAgentId, AccountIdentity, AccountLaunchSettings, RetainProfile } from '../agentAccountsApi.types'

export interface ProfileShareTable {
  directories: readonly string[]
  files: readonly string[]
  neverShared: readonly string[]
}

export type IdentityProbe = { kind: 'logged-in'; identity: AccountIdentity }
  | { kind: 'logged-out' } | { kind: 'failed'; reason: string }

export interface AgentProfileSpec {
  agentId: AccountAgentId
  mainHome(): string
  shareTable: ProfileShareTable
  homeVariable: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'
  extraEnv(mainHome: string): Record<string, string>
  loginCommand: string
  probe(home: string, retain?: RetainProfile): Promise<IdentityProbe>
  beforeLaunch?(profileHome: string, mainHome: string, cwd?: string, settings?: AccountLaunchSettings, retain?: RetainProfile): Promise<void>
}
