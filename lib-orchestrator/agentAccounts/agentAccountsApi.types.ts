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
  /** The sign-in link a running login captured instead of opening a browser. */
  loginLink?: string
  /** The last quota reading or estimate; absent when the account has none. */
  quota?: AccountQuota
  /** Absent from older peers; read as weight 1 (`PlanWeight.of`). */
  capacity?: AccountCapacity
}

/** The plan the login names, and the weekly capacity weight Jamat gives it (Max 20x 10, Max 5x 5, otherwise 1). */
export interface AccountCapacity { weight: number; tier: string | null }

/** Used percent of the plain 5-hour and weekly windows, null for a window without a reading. */
export interface AccountQuota { sessionUsedPercent: number | null; weeklyUsedPercent: number | null; weeklyResetsAt: string | null }

/** Fulfillment, independently of a bounded request result, proves that the profile is no longer used. */
export type RetainProfile = (until: Promise<void>) => void
