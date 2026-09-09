import type {
  SessionModelAgentId,
  SessionModelInfo,
} from '../../../lib-orchestrator/sessionModelReader/sessionModelReaderApi.types'
import type { ActiveAgentTerminal } from './useActiveAgentTerminal'
import { SessionContextUsage } from '../sessionModel/sessionContextUsage'

/** How full the context is, as the bar colours it. `none` is every fill below the first threshold. */
export type ContextLevel = 'none' | 'notice' | 'warn' | 'danger'

/**
 * The one derivation of a session's model reading into the line the bar draws, the colour it draws
 * it in and the tooltip behind it - and the whole of what this widget decides.
 *
 * The three thresholds are V1's defaults and they are fixed. A threshold a user can move is a
 * threshold nobody can name afterwards, and the colours they map onto are tokens rather than values,
 * so the palette stays in the one file that holds it.
 */
export class SessionModelLine {
  private static readonly noticePercentConst = 45
  private static readonly warnPercentConst = 75
  private static readonly dangerPercentConst = 85
  private static readonly separatorConst = ' · '

  /**
   * `Sonnet 4.5 · high · 90k / 1M · 9%`. An effort nobody configured is left out, and a model the
   * window table does not know keeps its tokens and loses only `/ 1M · 9%`: V1 answered a zero
   * window there and the caller hid the whole widget, so a new model family read as "nothing to say".
   */
  static lineOf(info: SessionModelInfo): string {
    const parts = [info.modelLabel]
    if (info.effortLevel !== null)
      parts.push(info.effortLevel)
    parts.push(SessionModelLine.contextOf(info))
    return parts.join(SessionModelLine.separatorConst)
  }

  /**
   * The precondition is stated at the top rather than as a fall-through: this branches on a RANGE
   * and not on a fixed set, so its last arm is the complement of the one before it and a closing
   * `else throw` could only ever be reached by a value that is no number - which is a caller's
   * mistake, and says so here instead of hiding as an unreachable arm.
   */
  static levelOf(percent: number | null): ContextLevel {
    if (percent === null)
      return 'none'
    if (!Number.isFinite(percent))
      throw new Error(`Unreachable context percent: ${JSON.stringify(percent)}`)
    if (percent < SessionModelLine.noticePercentConst)
      return 'none'
    else if (percent < SessionModelLine.warnPercentConst)
      return 'notice'
    else if (percent < SessionModelLine.dangerPercentConst)
      return 'warn'
    else
      return 'danger'
  }

  /**
   * Whether compacting is worth offering beside the line, and the whole of it is: the session is
   * still running.
   *
   * It asked for the fill as well until 2026-08-27 - V1's popup-only 35 per cent - and that
   * threshold is gone. Compacting early is a decision a user is allowed to make, and a button that
   * arrives only once the context is filling is missing exactly while it would cost least. What is
   * left are the ways it would be wrong, and every one of them is about the session rather than
   * about its numbers: a session that ended or was lost has nothing left to compact and nothing
   * that would read the command, and one still starting has said nothing worth compacting yet. A
   * model whose window the table does not know keeps the button now - the missing percentage takes
   * the colour away and no longer takes the action with it.
   */
  static compactVisible(life: ActiveAgentTerminal['life']): boolean {
    if (life === 'live')
      return true
    else if (life === 'starting' || life === 'ended' || life === 'lost')
      return false
    else
      throw new Error(`Unknown session life: ${JSON.stringify(life)}`)
  }

  /** The exact numbers the line rounds away, and where the Claude effort says what it is. */
  static tooltipOf(
    info: SessionModelInfo,
    agentId: SessionModelAgentId,
    age: number | null = null,
  ): string {
    const lines = [`Model: ${info.model}`, SessionModelLine.contextLineOf(info)]
    if (info.effortLevel !== null)
      lines.push(SessionModelLine.effortLineOf(info.effortLevel, agentId))
    if (age !== null && SessionContextUsage.isStale(age))
      lines.push(`Last read ${SessionModelLine.agoOf(age)} - this session stopped answering`)
    return lines.join('\n')
  }

  /** `40s`, `3min`, `2h`, `1d` - the same shape the rate widget uses one bar item away. */
  static agoOf(age: number): string {
    const seconds = Math.max(0, Math.round(age / 1_000))
    if (seconds < 60) return `${seconds}s ago`
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return `${minutes}min ago`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    return `${Math.round(hours / 24)}d ago`
  }

  private static contextOf(info: SessionModelInfo): string {
    const tokens = SessionContextUsage.shortTokens(info.contextTokens)
    const percent = SessionContextUsage.percentOf(info)
    if (info.contextWindow === null || percent === null)
      return tokens
    return `${tokens} / ${SessionContextUsage.shortTokens(info.contextWindow)}`
      + `${SessionModelLine.separatorConst}${percent}%`
  }

  private static contextLineOf(info: SessionModelInfo): string {
    const tokens = SessionContextUsage.exactTokens(info.contextTokens)
    const percent = SessionContextUsage.percentOf(info)
    if (info.contextWindow === null || percent === null)
      return `Context: ${tokens} tokens · this model carries no known window, so there is no percentage`
    return `Context: ${tokens} / ${SessionContextUsage.exactTokens(info.contextWindow)} tokens (${percent}%)`
  }

  /**
   * The Claude number is what the PROJECT is configured to ask for, read out of the settings
   * cascade, and it does not move when the running agent is told otherwise mid-session. Codex writes
   * its own effort into the transcript, so what is drawn for it is the session's own answer and it
   * carries no such caveat.
   */
  private static effortLineOf(effortLevel: string, agentId: SessionModelAgentId): string {
    if (agentId === 'claude')
      return `Effort: ${effortLevel} · the project's setting, not the running agent's live state`
    else if (agentId === 'codex')
      return `Effort: ${effortLevel}`
    else
      throw new Error(`Unknown session model agent: ${JSON.stringify(agentId)}`)
  }
}
