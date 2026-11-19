/**
 * The wire surface of the Claude account broker (`docs/architecture/account-broker.md`). It imports
 * nothing, so the CLI and the renderer can read it. Version 1 is frozen: a later version only adds
 * members, and a client ignores the members it does not know.
 */

export type AccountBrokerPurpose = 'interactive' | 'background'

/** `chosen` is the one answer that is no fallback; a client shows the reason as text and never branches on it. */
export type AccountBrokerReason = 'chosen' | 'no-eligible-account' | 'account-unusable'
  | 'jamat-unavailable' | 'instance-conflict' | 'unsupported' | 'timeout' | 'error'

export interface AccountBrokerAnswer {
  brokerVersion: 1
  provider: 'claude'
  /** `identityKey` is `<organizationUuid>/<email>`; null when the login is unknown. */
  account: { id: string; label: string; identityKey: string | null; tier: string | null }
  /** The change to the environment of the Claude process: delete each `unset` name, then assign each `set` pair. */
  env: { set: Record<string, string>; unset: string[] }
  /** True when the choice failed and the answer is Main. */
  fallback: boolean
  reason: AccountBrokerReason
  /** How long a caller may reuse this answer. */
  reuseSeconds: number
}

export interface AccountBrokerRequest { caller: string; purpose: AccountBrokerPurpose }

/** One pick that reached Jamat, one line of the caller log; it holds no prompt, argument or path. */
export interface AccountCallerEntry {
  at: number
  caller: string
  purpose: AccountBrokerPurpose
  accountId: string
  accountLabel: string
  fallback: boolean
  reason: AccountBrokerReason
  durationMs: number
}

export interface AccountCallerSummary {
  caller: string
  lastAt: number
  calls: number
  fallbacks: number
  purposes: Record<AccountBrokerPurpose, number>
  accounts: readonly { accountId: string; label: string; calls: number }[]
}

/** The callers of the last `windowDays` days, newest caller first, and the newest calls, newest first. */
export interface AccountCallersView {
  capturedAt: number
  windowDays: number
  callers: readonly AccountCallerSummary[]
  recent: readonly AccountCallerEntry[]
  /** The broker command of this instance to copy, or null when it cannot be built. */
  command: string | null
}
