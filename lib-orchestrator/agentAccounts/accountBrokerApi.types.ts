/**
 * The wire surface of the Claude account broker (`docs/architecture/account-broker.md`). It imports
 * nothing, so the CLI and the renderer can read it. Version 1 is frozen: a later version only adds
 * members, and a client ignores the members it does not know.
 */

export type AccountBrokerPurpose = 'interactive' | 'background'

/** The reasons the CLI gives by itself, when no instance answered. */
export type AccountBrokerCliReason = 'jamat-unavailable' | 'instance-conflict' | 'unsupported' | 'timeout' | 'error'

/** `chosen` is the one answer that is no fallback; a client shows the reason as text and never branches on it. */
export type AccountBrokerReason = 'chosen' | 'no-eligible-account' | 'account-unusable' | AccountBrokerCliReason

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
  /**
   * The command line that records the token usage of a run made with this answer; the caller writes
   * Claude's result JSON to its stdin. Added 2026-11-21 inside version 1; absent from the CLI's own
   * fallback answers, because no instance answered them.
   */
  reportCommand?: string
}

export interface AccountBrokerRequest { caller: string; purpose: AccountBrokerPurpose }

/** The four counters of one model, as the token statistics keep them. */
export interface AccountUsageCounts { input: number; output: number; cacheRead: number; cacheWrite: number }

/** The token usage of one finished run of a caller, per model (`accounts report`). */
export interface AccountUsageReport {
  caller: string
  purpose: AccountBrokerPurpose
  accountId: string
  models: Record<string, AccountUsageCounts>
}

/** One reported run, one line of the usage log; it holds no prompt, argument or path. */
export interface AccountUsageEntry extends AccountUsageReport { at: number }

/** What `accounts report` prints: whether a running instance recorded the run. */
export type AccountUsageReportResult = { recorded: true } | { recorded: false; reason: AccountBrokerCliReason }

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
