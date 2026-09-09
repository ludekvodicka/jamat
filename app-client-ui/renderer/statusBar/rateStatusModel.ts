import { DurationFormat } from '../../shared/durationFormat'
import type {
  RateAgentId,
  RateMonitorSnapshot,
  RateProviderState,
  RateWindow,
} from '../../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
// A VALUE import, and the fourth in the registry of rule 1: the window durations identify a
// window on both ends of this wire, and two copies of them are two spellings of one fact.
import { RateMonitorLimits } from '../../../lib-orchestrator/rateMonitor/rateMonitorLimits'

/** One window as the bar draws it: a letter, and a percentage 0 to 100 or nothing at all. */
export interface RateSegment {
  letter: string
  /** null draws V1's `?` form: the provider is known and named no window this letter stands for. */
  usedPercent: number | null
}

/** What the bar draws for the one provider whose terminal is the tab in front. */
export interface RateReading {
  /** The provider's name. The line no longer carries it: the tab in front says whose reading it is. */
  name: string
  /** `S: 42% [████░░░░░░], W: 12% [█░░░░░░░░░]`, the `?` form, or the placeholder glyph. */
  text: string
  /** Old numbers, no numbers, or no provider behind them: dimmed rather than hidden, reason in tooltip. */
  dim: boolean
  tooltip: string
  /** Claude publishes a usage page and Codex does not; null is "there is nowhere to send anyone". */
  usageUrl: string | null
}

/**
 * The one derivation of a rate snapshot into what a status bar can hold, and the whole of what this
 * widget decides. It answers for ONE provider - the one whose terminal is the tab in front - so the
 * line has room for every window the answer carried: the session, the plain weekly, and each
 * model-scoped weekly after them. Under two providers the scoped ones lived in the tooltip, which is
 * the one place a user who is out of opus cannot see them.
 *
 * Windows are matched on their duration and on whether they name a model, never on their position:
 * the answer's shape is a provider's business and a weekly-only answer is a normal one.
 */
export class RateStatusModel {
  private static readonly sessionLetterConst = 'S'
  private static readonly weeklyLetterConst = 'W'
  private static readonly namesConst: Readonly<Record<RateAgentId, string>> = {
    claude: 'Claude',
    codex: 'Codex',
  }
  /**
   * The letters V1's emptyLabel stood up, for a provider that has answered nothing at all. Both
   * providers answer both windows - Codex reports its own five-hour one as `windowDurationMins: 300`
   * - so the placeholder is the same width as the answer that replaces it, which is the whole point
   * of drawing letters rather than nothing.
   */
  private static readonly unknownLettersConst: readonly string[]
    = [RateStatusModel.sessionLetterConst, RateStatusModel.weeklyLetterConst]
  /** A page a provider publishes for its own limits, and Codex publishes none. */
  private static readonly usageUrlsConst: Readonly<Record<RateAgentId, string | null>> = {
    claude: 'https://claude.ai/settings/usage',
    codex: null,
  }
  private static readonly meterWidthConst = 10
  private static readonly spentGlyphConst = '█'
  private static readonly leftGlyphConst = '░'
  /** Read, and there is no provider behind it at all. Grey rather than hidden: a slot is information. */
  private static readonly absentGlyphConst = '-'
  private static readonly unknownPercentConst = '?'
  private static readonly meteredSeparatorConst = ', '
  /** V1's emptyLabel was one word per window with a space between them: `S:? W:?`. */
  private static readonly unknownSeparatorConst = ' '

  static readingOf(
    snapshot: RateMonitorSnapshot,
    agentId: RateAgentId,
    now: number,
  ): RateReading {
    const state = snapshot.providers[agentId]
    const name = RateStatusModel.namesConst[agentId]
    const tooltip = RateStatusModel.tooltipOf(name, state, now)
    const usageUrl = RateStatusModel.usageUrlsConst[agentId]
    if (state.kind === 'unconfigured')
      return { name, text: RateStatusModel.absentGlyphConst, dim: true, tooltip, usageUrl }
    else if (state.kind === 'never-read' || state.kind === 'ok' || state.kind === 'stale') {
      const segments = RateStatusModel.segmentsOf(state)
      const metered = segments.some((segment) => segment.usedPercent !== null)
      return {
        name,
        text: RateStatusModel.textOf(segments),
        dim: !metered || state.kind === 'stale',
        tooltip,
        usageUrl,
      }
    }
    else
      throw new Error(`Unknown rate provider state in readingOf: ${JSON.stringify(state)}`)
  }

  /**
   * V1's line: the session window, the plain weekly one, and every model-scoped window after them as
   * a segment of its own.
   *
   * A provider that answered no window this bar has a letter for keeps its letters and loses its
   * numbers - `S:? W:?` for Claude, `W:?` for Codex - so a reading that says nothing still says
   * WHICH nothing, and its size on the bar does not change when the numbers arrive.
   */
  static segmentsOf(state: RateProviderState): readonly RateSegment[] {
    const windows = RateStatusModel.windowsOf(state)
    const segments: RateSegment[] = []
    const session = RateStatusModel.sessionOf(windows)
    if (session !== null)
      segments.push(RateStatusModel.segmentOf(RateStatusModel.sessionLetterConst, session))
    const weekly = RateStatusModel.weeklyOf(windows)
    if (weekly !== null)
      segments.push(RateStatusModel.segmentOf(RateStatusModel.weeklyLetterConst, weekly))
    for (const window of windows) {
      if (window === session || window === weekly)
        continue
      // A window this bar has no letter for is still a number somebody is being measured by. Drawn
      // by its own length rather than dropped: dropping it is how a provider answering one window of
      // an unfamiliar length ended up under the placeholder that says nothing was read at all.
      segments.push(RateStatusModel.segmentOf(
        window.model === undefined
          ? RateStatusModel.durationLetterOf(window.durationMinutes)
          : RateStatusModel.scopedLetterOf(window.model),
        window,
      ))
    }
    if (segments.length > 0)
      return segments
    return RateStatusModel.unknownLettersConst.map((letter) => ({ letter, usedPercent: null }))
  }

  /** `1440` becomes `24h`, `45` becomes `45m`: short enough to sit where a letter would. */
  private static durationLetterOf(durationMinutes: number): string {
    return durationMinutes >= 60
      ? `${Math.round(durationMinutes / 60)}h`
      : `${Math.round(durationMinutes)}m`
  }

  /**
   * `S: 42% [████░░░░░░]`, ported cell for cell from V1: the meter is exactly ten characters wide
   * whatever the number is, and the percentage is padded to two so a single digit does not pull the
   * meter beside it one place to the left.
   */
  static segmentTextOf(segment: RateSegment): string {
    if (segment.usedPercent === null)
      return `${segment.letter}:${RateStatusModel.unknownPercentConst}`
    const spent = Math.round((segment.usedPercent / 100) * RateStatusModel.meterWidthConst)
    const meter = RateStatusModel.spentGlyphConst.repeat(spent)
      + RateStatusModel.leftGlyphConst.repeat(RateStatusModel.meterWidthConst - spent)
    return `${segment.letter}: ${String(segment.usedPercent).padStart(2)}% [${meter}]`
  }

  /**
   * Segments carrying a meter are joined by `', '`, because each one ends in a bracket and a bare
   * space between two brackets reads as one strip. The `?` form is V1's emptyLabel and joins on the
   * space alone.
   */
  private static textOf(segments: readonly RateSegment[]): string {
    const separator = segments.some((segment) => segment.usedPercent !== null)
      ? RateStatusModel.meteredSeparatorConst
      : RateStatusModel.unknownSeparatorConst
    return segments.map((segment) => RateStatusModel.segmentTextOf(segment)).join(separator)
  }

  private static segmentOf(letter: string, window: RateWindow): RateSegment {
    return { letter, usedPercent: RateStatusModel.percentOf(window.usedPercent) }
  }

  /**
   * The model's initial, which is all V1 ever needed (`F` for fable). `sonnet` collides with the
   * session's own letter, so a colliding initial takes a second character rather than the letter
   * beside it: a segment that reads as another one is worse than a two-character one.
   */
  private static scopedLetterOf(model: string): string {
    const initial = model.slice(0, 1).toUpperCase()
    if (initial !== RateStatusModel.sessionLetterConst
      && initial !== RateStatusModel.weeklyLetterConst)
      return initial
    return `${initial}${model.slice(1, 2).toLowerCase()}`
  }

  private static windowsOf(state: RateProviderState): readonly RateWindow[] {
    if (state.kind === 'ok' || state.kind === 'stale')
      return state.windows
    else if (state.kind === 'never-read' || state.kind === 'unconfigured')
      return []
    else
      throw new Error(`Unknown rate provider state in windowsOf: ${JSON.stringify(state)}`)
  }

  /** The five-hour window, and only the one that is not scoped to a model. */
  private static sessionOf(windows: readonly RateWindow[]): RateWindow | null {
    return windows.find((window) =>
      window.durationMinutes === RateMonitorLimits.sessionMinutes
      && window.model === undefined) ?? null
  }

  private static weeklyOf(windows: readonly RateWindow[]): RateWindow | null {
    return windows.find((window) =>
      window.durationMinutes === RateMonitorLimits.weeklyMinutes
      && window.model === undefined) ?? null
  }

  /** Whole and inside 0 to 100: the meter's width is read straight off it. */
  private static percentOf(usedPercent: number): number {
    return Math.max(0, Math.min(100, Math.round(usedPercent)))
  }

  private static tooltipOf(name: string, state: RateProviderState, now: number): string {
    if (state.kind === 'never-read')
      return `${name} usage has not been read yet`
    else if (state.kind === 'unconfigured')
      return `${name} usage is unavailable: ${state.reason}`
    else if (state.kind === 'ok')
      return [
        `${name} usage · read ${DurationFormat.ago(now - state.fetchedAt)}`,
        ...RateStatusModel.windowLinesOf(state.windows, now),
      ].join('\n')
    else if (state.kind === 'stale')
      return [
        `${name} usage · ${state.reason}`,
        state.fetchedAt === null
          ? 'never read successfully'
          : `last read ${DurationFormat.ago(now - state.fetchedAt)}`,
        ...RateStatusModel.windowLinesOf(state.windows, now),
      ].join('\n')
    else
      throw new Error(`Unknown rate provider state in tooltipOf: ${JSON.stringify(state)}`)
  }

  private static windowLinesOf(windows: readonly RateWindow[], now: number): readonly string[] {
    return windows.map((window) => {
      const used = `${RateStatusModel.labelOf(window)} ${RateStatusModel.percentOf(window.usedPercent)}%`
      const resetsAt = window.resetsAt === null ? null : Date.parse(window.resetsAt)
      if (resetsAt === null || Number.isNaN(resetsAt))
        return used
      return `${used} · resets in ${DurationFormat.of(resetsAt - now)}`
    })
  }

  private static labelOf(window: RateWindow): string {
    let label: string
    if (window.durationMinutes === RateMonitorLimits.sessionMinutes)
      label = 'Session'
    else if (window.durationMinutes === RateMonitorLimits.weeklyMinutes)
      label = 'Weekly'
    else
      label = `${window.durationMinutes} min`
    return window.model === undefined ? label : `${label} (${window.model})`
  }

}
