/**
 * A name, not a set of colours: the values live in `tokens.css` with every other colour, and a name
 * is the only thing worth reading in a file that is edited by hand.
 */
export type TerminalThemeName = 'original' | 'soft' | 'vscodeDark'

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
}

/**
 * What a save answers. The codes are `ConfigOpResult`'s letter for letter, but the type is this
 * package's, so the renderer compiles no file of the library to read one.
 */
export type UiSettingsSaveResult =
  | { ok: true }
  | { ok: false; code: 'config-latched' | 'invalid-section'; detail: string }

/**
 * The rules of the three font scales and of the terminal's palette, with no React, no DOM and no
 * imports at all: this file compiles into the node program and the web one alike, which is what
 * lets the renderer take its slider bounds and the main process validate a write from the same
 * four numbers, and the combobox its three names from the same list.
 *
 * Reads are lenient and writes are strict, the asymmetry every store in this tree uses: a percentage
 * nobody can use is reported and read as 100, while a save carrying one is refused, because coercing
 * a write would store something other than what was asked for.
 */
export class UiSettings {
  static readonly minPercentConst = 70
  static readonly maxPercentConst = 150
  static readonly stepPercentConst = 5
  static readonly defaultPercentConst = 100
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
      fontScalePercent: UiSettings.defaultPercentConst,
      fileViewerFontScalePercent: UiSettings.defaultPercentConst,
      terminalFontScalePercent: UiSettings.defaultPercentConst,
      terminalTheme: UiSettings.defaultTerminalThemeConst,
    }
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
        'The ui section of config.json is not an object; reading every font scale as '
        + `${UiSettings.defaultPercentConst} %`,
      )
      return UiSettings.defaultValue()
    }
    const document = value as Partial<Record<keyof UiSettingsValue, unknown>>
    // The RAW object first, because what a save writes back is what a read returned: `config.json`
    // is meant to be edited by hand and its own README promises that a key this build does not know
    // is preserved, so a note or a field of a later version written inside `ui` has to come back out
    // of a read that understands neither. The cast names the fields that are READ; the spread
    // carries whatever else is there, which rebuilding the section from those alone would delete.
    return {
      ...document,
      fontScalePercent:
        UiSettings.coercePercent(document.fontScalePercent, 'fontScalePercent', report),
      fileViewerFontScalePercent: UiSettings.coercePercent(
        document.fileViewerFontScalePercent,
        'fileViewerFontScalePercent',
        report,
      ),
      terminalFontScalePercent:
        UiSettings.coercePercent(document.terminalFontScalePercent, 'terminalFontScalePercent', report),
      terminalTheme: UiSettings.coerceTerminalTheme(document.terminalTheme, report),
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
    return UiSettings.isValidPercent(document.fontScalePercent)
      && UiSettings.isValidPercent(document.fileViewerFontScalePercent)
      && UiSettings.isValidPercent(document.terminalFontScalePercent)
      && UiSettings.isValidTerminalTheme(document.terminalTheme)
  }

  /** Into the range first, then onto the step: both ends are multiples of it, so that order holds. */
  static snap(percent: number): number {
    if (!Number.isFinite(percent))
      return UiSettings.defaultPercentConst
    const clamped = Math.min(
      UiSettings.maxPercentConst,
      Math.max(UiSettings.minPercentConst, percent),
    )
    return Math.round(clamped / UiSettings.stepPercentConst) * UiSettings.stepPercentConst
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
    report: (message: string) => void,
  ): number {
    if (value === undefined)
      return UiSettings.defaultPercentConst
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      report(
        `The ui section of config.json has an unusable ${field} (${JSON.stringify(value)}); `
        + `reading it as ${UiSettings.defaultPercentConst} %`,
      )
      return UiSettings.defaultPercentConst
    }
    if (!UiSettings.isValidPercent(value)) {
      const snapped = UiSettings.snap(value)
      report(
        `The ui section of config.json has ${field} at ${value} %, which is outside `
        + `${UiSettings.minPercentConst}-${UiSettings.maxPercentConst} % or off the `
        + `${UiSettings.stepPercentConst} % step; reading it as ${snapped} %`,
      )
      return snapped
    }
    return value
  }

  private static isValidTerminalTheme(value: unknown): value is TerminalThemeName {
    return typeof value === 'string'
      && (UiSettings.terminalThemesConst as readonly string[]).includes(value)
  }

  private static isValidPercent(value: unknown): value is number {
    if (typeof value !== 'number' || !Number.isFinite(value))
      return false
    if (value < UiSettings.minPercentConst || value > UiSettings.maxPercentConst)
      return false
    return value % UiSettings.stepPercentConst === 0
  }
}
