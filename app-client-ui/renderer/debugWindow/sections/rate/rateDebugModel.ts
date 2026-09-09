import type {
  RateAgentId,
  RateExtra,
  RateMonitorDebugStatus,
  RateProviderDebug,
  RateProviderState,
  RateWindow,
} from '../../../../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
import { DebugTimeFormat } from '../debugTimeFormat'

export interface RateDebugState {
  /** Null until the first read answers. */
  status: RateMonitorDebugStatus | null
  refreshing: boolean
  /** What an action or a read failed with, in the words of whoever refused. */
  problem: string | null
}

export type RateDebugInput =
  | { input: 'load' }
  | { input: 'status-arrived'; status: RateMonitorDebugStatus }
  | { input: 'refresh-asked' }
  | { input: 'refresh-answered' }
  | { input: 'failed'; detail: string }

export type RateDebugEffect = { effect: 'load' } | { effect: 'refresh' }

export interface RateDebugStep {
  state: RateDebugState
  effects: readonly RateDebugEffect[]
}

/**
 * What the rate section knows and what it decides, with no I/O in sight.
 *
 * Everything it draws is the unreduced answer of `rate:debug-status`, and the reductions the status
 * bar makes are deliberately not repeated here: the model-scoped weekly windows the widget leaves out
 * are the ones somebody opens this screen to see, so nothing is filtered on the way to the table.
 *
 * The section has no clock of its own, so every age and every countdown is measured against the
 * `capturedAt` the main process stamped on the status. A `Date.now()` here would put two different
 * "now"s on one screen: one the numbers were composed against and one they are read against.
 */
export class RateDebugModel {
  static initial(): RateDebugState {
    return { status: null, refreshing: false, problem: null }
  }

  static transition(state: RateDebugState, input: RateDebugInput): RateDebugStep {
    if (input.input === 'load')
      return { state, effects: [{ effect: 'load' }] }
    else if (input.input === 'status-arrived')
      return { state: { ...state, status: input.status }, effects: [] }
    else if (input.input === 'refresh-asked')
      // A refresh that is still out is not asked again: the floor in the main process would answer
      // the second one with what it already has, and the button would look like it did something.
      return state.refreshing
        ? { state, effects: [] }
        : { state: { ...state, refreshing: true, problem: null }, effects: [{ effect: 'refresh' }] }
    else if (input.input === 'refresh-answered')
      // The refresh answers with a snapshot, and the attempt times this screen is about are not in
      // one. A read that moved nothing sends no `rate:changed` either, so the status is re-read here.
      return { state: { ...state, refreshing: false }, effects: [{ effect: 'load' }] }
    else if (input.input === 'failed')
      // The latch is released here as well: `refreshing` is set by the button and cleared only by
      // an answer, so a rejected invoke would otherwise leave it pressed for good.
      return { state: { ...state, refreshing: false, problem: input.detail }, effects: [] }
    else
      throw new Error(`Unknown rate debug input: ${JSON.stringify(input)}`)
  }

  static titleOf(agentId: RateAgentId): string {
    if (agentId === 'claude')
      return 'Claude'
    else if (agentId === 'codex')
      return 'Codex'
    else
      throw new Error(`Unknown rate agent: ${JSON.stringify(agentId)}`)
  }

  /** The state, and the reason whenever there is one to give. */
  static stateLineOf(state: RateProviderState): string {
    if (state.kind === 'ok')
      return 'ok'
    else if (state.kind === 'stale')
      return `stale - ${state.reason}`
    else if (state.kind === 'unconfigured')
      return `unconfigured - ${state.reason}`
    else if (state.kind === 'never-read')
      return 'never read'
    else
      throw new Error(`Unknown rate provider state: ${JSON.stringify(state)}`)
  }

  /** Every window the API answered with, in the order it answered - nothing is dropped here. */
  static windowsOf(state: RateProviderState): readonly RateWindow[] {
    if (state.kind === 'ok')
      return state.windows
    else if (state.kind === 'stale')
      return state.windows
    else if (state.kind === 'unconfigured')
      return []
    else if (state.kind === 'never-read')
      return []
    else
      throw new Error(`Unknown rate provider state: ${JSON.stringify(state)}`)
  }

  static pollFactsOf(status: RateMonitorDebugStatus): readonly [string, string][] {
    return [
      ['A window is visible', status.poll.windowVisible ? 'yes' : 'no'],
      ['Cadence', `${status.poll.cadenceMilliseconds} ms`],
      ['Claude floor', `${status.poll.claudeFloorMilliseconds} ms`],
      ['Composed at', DebugTimeFormat.at(status.capturedAt)],
    ]
  }

  /**
   * The attempt and the success are two lines and never one. They agree while a provider is healthy
   * and part the moment it is not, and that gap is the whole reason to open this screen: "last
   * updated" would read as fresh while every read since has been failing.
   */
  static providerFactsOf(provider: RateProviderDebug, now: number): readonly [string, string][] {
    return [
      ['State', RateDebugModel.stateLineOf(provider.state)],
      ['Last attempt', RateDebugModel.stampOf(provider.lastAttemptAt, now)],
      ['Last success', RateDebugModel.stampOf(provider.lastSuccessAt, now)],
      ['Last reason', provider.lastReason ?? 'none'],
      ['OAuth token', RateDebugModel.expiryLineOf(provider.oauthExpiresAt, now)],
    ]
  }

  static extraFactsOf(extras: readonly RateExtra[]): readonly [string, string][] {
    return extras.map((extra): [string, string] => [extra.label, extra.detail])
  }

  /** A window as its four facts: how long it is, whose it is, how much is gone, when it comes back. */
  static windowRowOf(window: RateWindow): readonly [string, string, string, string] {
    return [
      `${window.durationMinutes} min (${RateDebugModel.minutes(window.durationMinutes)})`,
      window.model ?? 'any',
      `${window.usedPercent}%`,
      window.resetsAt === null ? '—' : new Date(window.resetsAt).toLocaleString(),
    ]
  }

  /** The expiry as a time AND as what is left of it; Codex has no OAuth token and answers with a dash. */
  static expiryLineOf(oauthExpiresAt: number | null, now: number): string {
    if (oauthExpiresAt === null)
      return '—'
    if (oauthExpiresAt > now)
      return `${DebugTimeFormat.at(oauthExpiresAt)} (expires in `
        + `${DebugTimeFormat.duration(oauthExpiresAt - now)})`
    return `${DebugTimeFormat.at(oauthExpiresAt)} (expired `
      + `${DebugTimeFormat.duration(now - oauthExpiresAt)} ago)`
  }

  /**
   * The whole body the provider answered with, verbatim, so a bucket this tree's mapper knows nothing
   * about is still on the screen. The credential travels in a request header and the endpoint answers
   * with usage, so there is nothing here to withhold - and a filter over these keys would blank
   * `token_limit` and every `*_tokens` field on the one screen that exists to show them.
   */
  static rawOf(raw: unknown): string {
    if (raw === null || raw === undefined)
      return 'nothing has been read yet'
    return JSON.stringify(raw, null, 2) ?? 'not representable as JSON'
  }

  private static stampOf(value: number | null, now: number): string {
    if (value === null)
      return 'never'
    return `${DebugTimeFormat.at(value)} `
      + `(${DebugTimeFormat.duration(Math.max(0, now - value))} ago)`
  }

  private static minutes(value: number): string {
    if (value % 1_440 === 0)
      return `${value / 1_440}d`
    if (value % 60 === 0)
      return `${value / 60}h`
    return `${value}m`
  }
}
