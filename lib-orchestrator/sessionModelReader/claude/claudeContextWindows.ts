/**
 * The context window and the human label for a Claude model id.
 *
 * The window here is GUESSED from the id, because a Claude transcript stores the bare id and says
 * nothing about the tier it ran on. It is the fallback: a session Jamat started reports its own
 * window through the status line relay (`sessionManager/launch/claudeStatusLine.ts`), and this table
 * answers only where no snapshot does. An id it does not recognise answers null and the caller draws
 * what it does know.
 */
export class ClaudeContextWindows {
  private static readonly millionTokensConst = 1_000_000
  private static readonly twoHundredThousandTokensConst = 200_000
  private static readonly oneMillionSuffixConst = /\[1m\]$/i
  /**
   * Models whose account DEFAULT is the million tier: `/model` lists `Opus 5.5 (1M context)
   * (default)` and `Fable 5.1 (1M context)`, and a session that lands on one of them with no tier
   * named anywhere runs on it, while no file records that tier. Believed only when nothing names
   * THIS model; the day a default moves, this list is wrong until it is edited.
   *
   * Fable 5.1 joined on 2026-10-13: a session whose transcript said `claude-fable-5-1` under a
   * settings file saying `opus` drew a fifth of its window, because the settings model, which named
   * another family, still counted as "something is configured" and kept the default out.
   */
  private static readonly defaultMillionModelsConst = ['claude-opus-5-5', 'claude-fable-5-1']
  private static readonly familyPatternConst = /^claude-([a-z]+)-/i
  /**
   * The minor is optional because the ids lost it: V1 read `claude-opus-4-7` and this generation
   * ships `claude-opus-5`. Requiring both groups is what made a current model draw its own bare id.
   * It is capped at two digits and must not be followed by another, or the release date behind it
   * takes the slot and `claude-sonnet-5-20260101` reads as `Sonnet 5.20260101`.
   */
  private static readonly labelPatternConst = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/i

  /**
   * The suffix is the only source of the million WITHIN an id: a family that answered a million on
   * its own made the suffix decide nothing and read every bare `opus`/`sonnet` id as five times
   * roomier than it is. That error ran the unsafe way - a session at 45 percent drew 9, stayed
   * uncoloured and was never offered a compact - so an id whose tier is not stated is read as the
   * smaller window.
   *
   * `configured` is the second source, and it is the one that made this readable at all: a Claude
   * transcript records the id the API answered with, `claude-opus-5`, while the tier lives only in
   * what the session was STARTED with - this app's own `--model claude-opus-5[1m]`, or, where it
   * named nothing, `"model": "opus[1m]"` in Claude's own settings. Which of the two is handed over
   * is the caller's decision. Without either, every 1M session drew a fifth of its window, which is
   * the same error the other way round - 91k of a million read as 46 percent, compact offered and
   * auto-compact fired on a session at 9 percent.
   *
   * It is believed only when it MATCHES the id in the transcript, because it is configuration and
   * `/model` can move a running session off it. A configured model that names another model is
   * evidence about that other model and counts as nothing here, so the account default of the
   * model the transcript names still applies; a matching one that names no tier is the smaller
   * window.
   */
  static windowOf(model: string, configured?: string | null): number | null {
    if (ClaudeContextWindows.oneMillionSuffixConst.test(model))
      return ClaudeContextWindows.millionTokensConst
    const named = configured !== undefined && configured !== null && configured !== ''
      && ClaudeContextWindows.names(model, configured) ? configured : null
    if (named !== null && ClaudeContextWindows.oneMillionSuffixConst.test(named))
      return ClaudeContextWindows.millionTokensConst
    if (named === null && ClaudeContextWindows.defaultMillionModelsConst
      .some((id) => ClaudeContextWindows.names(model, id)))
      return ClaudeContextWindows.millionTokensConst
    const family = ClaudeContextWindows.familyPatternConst.exec(model)?.[1]?.toLowerCase()
    // `fable` was missing until 2026-08-24, so a bare `claude-fable-5` session drew no window at
    // all while `claude-fable-5[1m]` drew a million. The families come off `GET /v1/models`.
    if (family === 'opus' || family === 'sonnet' || family === 'haiku' || family === 'fable')
      return ClaudeContextWindows.twoHundredThousandTokensConst
    else return null
  }

  /**
   * Whether a configured model names the model a transcript recorded. An alias (`opus`) names its
   * whole family, because it resolves to whichever member is newest; a full id names that release
   * and the dated ids under it (`claude-opus-5` covers `claude-opus-5-20260101`), and nothing else:
   * a plain prefix made `claude-opus-5[1m]` name `claude-opus-5-5`, another release.
   */
  static names(model: string, configured: string): boolean {
    const bare = configured.replace(ClaudeContextWindows.oneMillionSuffixConst, '').toLowerCase()
    const id = model.toLowerCase()
    if (bare.startsWith('claude-')) return id === bare || new RegExp(`^${bare}-\\d{8}$`).test(id)
    return ClaudeContextWindows.familyPatternConst.exec(id)?.[1]?.toLowerCase() === bare
  }

  /**
   * `claude-sonnet-4-5-20260101` becomes `Sonnet 4.5` and `claude-opus-5` becomes `Opus 5`; an id
   * off the pattern is its own label.
   */
  static labelOf(model: string): string {
    if (!model) return 'unknown'
    const bare = model.replace(ClaudeContextWindows.oneMillionSuffixConst, '')
    const parts = ClaudeContextWindows.labelPatternConst.exec(bare)
    if (parts === null) return model
    const family = parts[1]!
    const version = parts[3] === undefined ? parts[2] : `${parts[2]}.${parts[3]}`
    return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}`
  }
}
