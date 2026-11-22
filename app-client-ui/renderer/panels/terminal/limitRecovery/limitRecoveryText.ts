import type {
  LimitRecoveryAction,
  LimitWindow,
  SessionLimitRecoveryInfo,
} from '../../../../../lib-orchestrator/limitRecovery/limitRecoveryApi.types'
import { DurationFormat } from '../../../../shared/durationFormat'

export interface LimitRecoveryButton { action: LimitRecoveryAction; label: string }

export interface LimitRecoveryView {
  title: string
  lines: string[]
  buttons: LimitRecoveryButton[]
}

/** What the usage-limit popup of one tab says at `now`, and which answers it offers. */
export class LimitRecoveryText {
  private static readonly statesConst: readonly string[] = ['countdown', 'queued', 'running', 'waiting', 'failed'] satisfies SessionLimitRecoveryInfo['state'][]

  /** A remote peer on a newer build may send a state this build cannot draw; its tab then shows none. */
  static drawable(info: SessionLimitRecoveryInfo): boolean {
    return LimitRecoveryText.statesConst.includes(info.state)
  }

  static of(info: SessionLimitRecoveryInfo, now: number): LimitRecoveryView {
    const limit = info.limit
    const title = `Account ${limit.account.label} reached its ${LimitRecoveryText.windowOf(limit.window)} limit`
    const reset = limit.resetsAt === null ? null : `It resets in ${DurationFormat.of(limit.resetsAt - now)}.`
    const cancel: LimitRecoveryButton = { action: 'cancel', label: 'Cancel' }
    const shells = 'stopsBackgroundShells' in info && info.stopsBackgroundShells === true
      ? ['Switching restarts the session and stops its background shells.'] : []
    switch (info.state) {
      case 'countdown': {
        const seconds = Math.max(0, Math.ceil((info.deadlineAt - now) / 1_000))
        return info.reason === 'switch'
          ? { title, lines: [`Switching to ${info.target.label} in ${seconds} s.`, ...shells], buttons: [{ action: 'now', label: 'Switch now' }, cancel] }
          : { title, lines: [`The limit has reset. Continuing on ${info.target.label} in ${seconds} s.`],
            buttons: [{ action: 'now', label: 'Continue now' }, cancel] }
      }
      case 'queued':
        return { title, lines: [`${info.reason === 'switch' ? `Switching to ${info.target.label}` : `Continuing on ${info.target.label}`
          } after the sessions ahead of it (place ${info.position} in line).`, ...shells], buttons: [cancel] }
      case 'running':
        return { title, lines: [info.reason === 'switch' ? `Switching to ${info.target.label}…` : `Continuing on ${info.target.label}…`], buttons: [] }
      case 'waiting':
        return { title, lines: [
          'Every account is exhausted.',
          info.nextAccount !== null && info.wakeAt !== null
            ? `Jamat continues when ${info.nextAccount.label} resets, in about ${DurationFormat.of(info.wakeAt - now)}.`
            : 'No reset time is known yet; Jamat continues when an account has quota again.',
          ...(reset === null ? [] : [reset]),
        ], buttons: [cancel] }
      case 'failed':
        return { title, lines: [info.detail], buttons: [{ action: 'dismiss', label: 'Close' }] }
      default: throw new Error(`Unknown limit recovery state: ${JSON.stringify(info)}`)
    }
  }

  private static windowOf(window: LimitWindow): string {
    switch (window) {
      case 'session': return '5-hour'
      case 'weekly': return 'weekly'
      case 'other': return 'usage'
      default: throw new Error(`Unknown limit window: ${JSON.stringify(window)}`)
    }
  }
}
