export type AccountAgentId = 'claude' | 'codex'
export type AccountId = string
export interface AccountIdentity { key: string; label: string }
export interface AccountLaunchSettings { yolo?: boolean; model?: string; effort?: string }
export type AccountState = 'active' | 'pending-login' | 'needs-login' | 'disabled'

export interface AccountView {
  agentId: AccountAgentId
  accountId: AccountId
  label: string
  isMain: boolean
  state: AccountState
  identity: AccountIdentity | null
  profileProblem: string | null
  defaultChoice?: { noFreeAccount: boolean; resetsAt: string | null }
}

/** Fulfillment, independently of a bounded request result, proves that the profile is no longer used. */
export type RetainProfile = (until: Promise<void>) => void
