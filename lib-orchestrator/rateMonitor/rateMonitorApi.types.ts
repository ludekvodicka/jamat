/**
 * The wire surface of the rate monitor, mirroring `sessionManagerApi.types.ts`: it imports nothing at
 * all, because the renderer's TypeScript program compiles it and a `node:` import or a sibling module
 * here stops the web build.
 *
 * Nothing declared here has a field for a credential, and that is the point rather than an omission:
 * the Claude side reads an OAuth token out of a file this process may only read, and the only thing
 * that may ever travel is when that token expires.
 */

export type RateAgentId = 'claude' | 'codex'

export interface RateWindow {
  /** 300 is the session window, 10080 the weekly one. Windows are matched on this, never on position. */
  durationMinutes: number
  usedPercent: number
  /** ISO, or null when the provider named no reset. */
  resetsAt: string | null
  /** Set on a model-scoped weekly window (opus, sonnet, ...) and absent on the plain ones. */
  model?: string
}

/** A fact with no window of its own, such as extra usage credits. Text for a tooltip and the Debug window. */
export interface RateExtra {
  label: string
  detail: string
}

export type RateProviderState =
  | { kind: 'ok'; fetchedAt: number; windows: readonly RateWindow[] }
  /**
   * A read failed and the last good windows stand. `fetchedAt` is the last SUCCESS, so it is what
   * says how old they are; null when this provider has never answered at all.
   */
  | { kind: 'stale'; fetchedAt: number | null; windows: readonly RateWindow[]; reason: string }
  | { kind: 'unconfigured'; reason: string }
  | { kind: 'never-read' }

export interface RateSample {
  at: number
  agentId: RateAgentId
  accountId: string
  source: RateSampleSource
  windows: readonly RateWindow[]
}

export interface RateAccountKey { agentId: RateAgentId; accountId: string }
export type RateSampleSource = 'poll' | 'statusline' | 'rollout'
export interface RateEstimate { estimated: true; windows: readonly RateWindow[]; sampleAt: number; ageMilliseconds: number }
export interface RateAccountState {
  key: RateAccountKey
  label: string
  state: RateProviderState
  estimated: RateEstimate | null
  source: RateSampleSource | null
}
export interface RatePool {
  agentId: RateAgentId
  weeklyRemaining: number
  weeklyCapacity: number
  sessionRemaining: number
  sessionCapacity: number
}

export interface RateMonitorSnapshot {
  revision: number
  providers: Readonly<Record<RateAgentId, RateProviderState>>
  /** Optional for snapshots from older clients. New monitors always provide both collections. */
  accounts?: readonly RateAccountState[]
  pools?: readonly RatePool[]
}

/** The unreduced truth, for the one surface built to look at it. */
export interface RateProviderDebug {
  state: RateProviderState
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  lastReason: string | null
  /** Epoch ms out of `claudeAiOauth.expiresAt`; Codex has no such thing and answers null. */
  oauthExpiresAt: number | null
  extras: readonly RateExtra[]
  /** The last parsed response BODY. The credential travels in a request header and never in a body. */
  raw: unknown
}

export interface RateMonitorDebugStatus {
  capturedAt: number
  poll: { windowVisible: boolean; cadenceMilliseconds: number; claudeFloorMilliseconds: number }
  providers: Readonly<Record<RateAgentId, RateProviderDebug>>
  accounts?: readonly { key: RateAccountKey; label: string; provider: RateProviderDebug; source: RateSampleSource | null }[]
}
