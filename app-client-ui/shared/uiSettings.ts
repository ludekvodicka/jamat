/**
 * A name, not a set of colours: the values live in `tokens.css` with every other colour, and a name
 * is the only thing worth reading in a file that is edited by hand.
 */
export type TerminalThemeName = 'original' | 'soft' | 'vscodeDark'

/**
 * The bounds of one kind of percentage: what a slider offers, what a hand-written value is snapped
 * onto, and what a save is refused against. A kind rather than a field, because the two kinds here
 * want different numbers and the fields inside each want the same ones.
 */
export interface UiSettingsRange {
  minPercent: number
  maxPercent: number
  stepPercent: number
  defaultPercent: number
}

export interface UiSettingsValue {
  /** Everything this shell draws except the status bar, as a percentage of the size tokens. */
  fontScalePercent: number
  /**
   * The document a file viewer draws, on top of `fontScalePercent` rather than instead of it: a
   * file is read for minutes at a time and a tree row is glanced at, so the two want different
   * sizes out of one window.
   */
  fileViewerFontScalePercent: number
  /** The terminal alone: xterm paints its own text and no CSS token of ours reaches it. */
  terminalFontScalePercent: number
  /** Which colours the terminal paints in. `original` is what every terminal had before this. */
  terminalTheme: TerminalThemeName
  /**
   * How far one turn of the wheel moves anything this window scrolls EXCEPT the terminal: a list, a
   * tree, a document. At 100 % nothing of ours touches a wheel event and Chromium scrolls as it
   * always did, which is why that is the default and why the handler is not even installed there.
   */
  scrollSpeedPercent: number
  /**
   * The terminal alone, which scrolls a buffer of its own. It is a separate row because it is a
   * separate mechanism - xterm takes the multiplier as an option and never sees a wheel event of
   * ours - and because a screen of output and a list of files are read at different speeds.
   */
  terminalScrollSpeedPercent: number
}

/**
 * What a save answers. The codes are `ConfigOpResult`'s letter for letter, but the type is this
 * package's, so the renderer compiles no file of the library to read one.
 */
export type UiSettingsSaveResult =
  | { ok: true }
  | { ok: false; code: 'config-latched' | 'invalid-section'; detail: string }

/**
 * The rules of the three font scales, the two scroll speeds and the terminal's palette, with no
 * React, no DOM and no imports at all: this file compiles into the node program and the web one
 * alike, which is what lets the renderer take its slider bounds and the main process validate a
 * write from the same ranges, and the combobox its three names from the same list.
 *
 * Reads are lenient and writes are strict, the asymmetry every store in this tree uses: a percentage
 * nobody can use is reported and read as 100, while a save carrying one is refused, because coercing
 * a write would store something other than what was asked for.
 */
export class UiSettings {
  /**
   * The three font scales. A narrow range and a small step: this is the size of text somebody reads
   * for hours, and the sizes either side of the one that fits are worth having.
   */
  static readonly fontRangeConst: UiSettingsRange = {
    minPercent: 70,
    maxPercent: 150,
    stepPercent: 5,
    defaultPercent: 100,
  }

  /**
   * The two scroll speeds. Wider and coarser than a font's, because this multiplies a gesture
   * rather than sizing anything: 400 % is four turns' worth of movement out of one turn, and the
   * half below 100 % is there for a wheel that overshoots.
   */
  static readonly scrollRangeConst: UiSettingsRange = {
    minPercent: 50,
    maxPercent: 400,
    stepPercent: 25,
    defaultPercent: 100,
  }

  /** In the order the tab offers them, the default first. */
  static readonly terminalThemesConst: readonly TerminalThemeName[] = [
    'original',
    'soft',
    'vscodeDark',
  ]

  static readonly defaultTerminalThemeConst: TerminalThemeName = 'original'

  /** Today's appearance throughout, so a machine with no `ui` section looks exactly as it did. */
  static defaultValue(): UiSettingsValue {
    return {
      fontScalePercent: UiSettings.fontRangeConst.defaultPercent,
      fileViewerFontScalePercent: UiSettings.fontRangeConst.defaultPercent,
      terminalFontScalePercent: UiSettings.fontRangeConst.defaultPercent,
      terminalTheme: UiSettings.defaultTerminalThemeConst,
      scrollSpeedPercent: UiSettings.scrollRangeConst.defaultPercent,
      terminalScrollSpeedPercent: UiSettings.scrollRangeConst.defaultPercent,
    }
  }

  /**
   * A scroll percentage as the multiplier its reader wants. One conversion for both of them: xterm
   * takes it as `scrollSensitivity` and the window's own handler multiplies a delta by it, and the
   * two dividing by different numbers would be two speeds under one slider.
   */
  static scrollFactorOf(percent: number): number {
    return percent / 100
  }

  /**
   * Total by the section contract: an unusable `ui` key is this owner's problem alone and latches
   * nothing. A field that is merely absent is not damage - it is a file written before the field
   * existed - so only a value that IS there and cannot be used is said out loud.
   */
  static coerce(value: unknown, report: (message: string) => void): UiSettingsValue {
    if (value === undefined)
      return UiSettings.defaultValue()
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      report(
        'The ui section of config.json is not an object; reading every font scale and scroll speed '
        + `as ${UiSettings.fontRangeConst.defaultPercent} %`,
      )
      return UiSettings.defaultValue()
    }
    const document = value as Partial<Record<keyof UiSettingsValue, unknown>>
    const font = UiSettings.fontRangeConst
    const scroll = UiSettings.scrollRangeConst
    // The RAW object first, because what a save writes back is what a read returned: `config.json`
    // is meant to be edited by hand and its own README promises that a key this build does not know
    // is preserved, so a note or a field of a later version written inside `ui` has to come back out
    // of a read that understands neither. The cast names the fields that are READ; the spread
    // carries whatever else is there, which rebuilding the section from those alone would delete.
    return {
      ...document,
      fontScalePercent:
        UiSettings.coercePercent(document.fontScalePercent, 'fontScalePercent', font, report),
      fileViewerFontScalePercent: UiSettings.coercePercent(
        document.fileViewerFontScalePercent,
        'fileViewerFontScalePercent',
        font,
        report,
      ),
      terminalFontScalePercent: UiSettings.coercePercent(
        document.terminalFontScalePercent,
        'terminalFontScalePercent',
        font,
        report,
      ),
      terminalTheme: UiSettings.coerceTerminalTheme(document.terminalTheme, report),
      scrollSpeedPercent:
        UiSettings.coercePercent(document.scrollSpeedPercent, 'scrollSpeedPercent', scroll, report),
      terminalScrollSpeedPercent: UiSettings.coercePercent(
        document.terminalScrollSpeedPercent,
        'terminalScrollSpeedPercent',
        scroll,
        report,
      ),
    }
  }

  /**
   * A name outside the three is read as the default and said out loud, the way an unusable
   * percentage is: there is nothing to snap it onto, so nothing of what was typed can be kept.
   */
  static coerceTerminalTheme(value: unknown, report: (message: string) => void): TerminalThemeName {
    if (value === undefined)
      return UiSettings.defaultTerminalThemeConst
    if (UiSettings.isValidTerminalTheme(value))
      return value
    report(
      `The ui section of config.json has an unusable terminalTheme (${JSON.stringify(value)}); `
      + `reading it as ${UiSettings.defaultTerminalThemeConst}`,
    )
    return UiSettings.defaultTerminalThemeConst
  }

  /**
   * Shape, bounds and step, field by field. `SidebarsState` carries why it is never a
   * `JSON.stringify` of the coerced value against the raw one: that compares TEXT, so the same two
   * numbers written in the other order would be refused as damaged.
   */
  static isValid(value: unknown): value is UiSettingsValue {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return false
    const document = value as Partial<Record<keyof UiSettingsValue, unknown>>
    const font = UiSettings.fontRangeConst
    const scroll = UiSettings.scrollRangeConst
    return UiSettings.isValidPercent(document.fontScalePercent, font)
      && UiSettings.isValidPercent(document.fileViewerFontScalePercent, font)
      && UiSettings.isValidPercent(document.terminalFontScalePercent, font)
      && UiSettings.isValidTerminalTheme(document.terminalTheme)
      && UiSettings.isValidPercent(document.scrollSpeedPercent, scroll)
      && UiSettings.isValidPercent(document.terminalScrollSpeedPercent, scroll)
  }

  /** Into the range first, then onto the step: both ends are multiples of it, so that order holds. */
  static snap(percent: number, range: UiSettingsRange): number {
    if (!Number.isFinite(percent))
      return range.defaultPercent
    const clamped = Math.min(range.maxPercent, Math.max(range.minPercent, percent))
    return Math.round(clamped / range.stepPercent) * range.stepPercent
  }

  /**
   * A number that is merely off the grid is snapped, not defaulted. The file is meant to be edited
   * by hand, and someone who typed 137 asked for a bigger font, not for the size they already had;
   * 135 keeps that and 100 throws it away. Only a value that is not a number carries no intent to
   * keep, so that one reads as the default.
   */
  private static coercePercent(
    value: unknown,
    field: keyof UiSettingsValue,
    range: UiSettingsRange,
    report: (message: string) => void,
  ): number {
    if (value === undefined)
      return range.defaultPercent
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      report(
        `The ui section of config.json has an unusable ${field} (${JSON.stringify(value)}); `
        + `reading it as ${range.defaultPercent} %`,
      )
      return range.defaultPercent
    }
    if (!UiSettings.isValidPercent(value, range)) {
      const snapped = UiSettings.snap(value, range)
      report(
        `The ui section of config.json has ${field} at ${value} %, which is outside `
        + `${range.minPercent}-${range.maxPercent} % or off the `
        + `${range.stepPercent} % step; reading it as ${snapped} %`,
      )
      return snapped
    }
    return value
  }

  private static isValidTerminalTheme(value: unknown): value is TerminalThemeName {
    return typeof value === 'string'
      && (UiSettings.terminalThemesConst as readonly string[]).includes(value)
  }

  private static isValidPercent(value: unknown, range: UiSettingsRange): value is number {
    if (typeof value !== 'number' || !Number.isFinite(value))
      return false
    if (value < range.minPercent || value > range.maxPercent)
      return false
    return value % range.stepPercent === 0
  }
}
