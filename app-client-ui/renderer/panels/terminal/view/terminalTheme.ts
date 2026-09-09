import type { ITheme } from '@xterm/xterm'

import type { TerminalThemeName, UiSettingsValue } from '../../../../shared/uiSettings'

export interface TerminalAppearance {
  fontFamily: string
  fontSize: number
  theme: ITheme
}

/**
 * The one place a terminal's colours are assembled, and the reason they are assembled rather than
 * written: xterm wants concrete strings, `tokens.css` is the only file allowed to hold one, and the
 * gate fails a hex found anywhere else under `renderer/`. Reading the computed values keeps both
 * true at once, and a palette swapped in `tokens.css` reaches the next terminal opened without a
 * line changing here.
 *
 * A theme is a NAME here and one token name inside: the pair comes from `--terminal-background` and
 * `--terminal-foreground` whatever the theme, because `tokens.css` already redirects those per
 * theme for the panel around the canvas to paint in. Reading them here rather than choosing between
 * three pairs leaves ONE map of name to colour, in the file that holds the colours; what is left of
 * the name here is the sixteen a program addresses by number, which no CSS property of ours carries.
 */
export class TerminalTheme {
  /** The size at 100 %, and the size every terminal had before the scale existed. */
  private static readonly fontSizeConst = 13

  /**
   * The one conversion of the scale into pixels: the attach reads it and so does a live change, and
   * the two disagreeing would be a terminal whose next refit resized it back.
   */
  static fontSizeOf(terminalFontScalePercent: number): number {
    return Math.round(TerminalTheme.fontSizeConst * terminalFontScalePercent / 100)
  }

  static current(value: UiSettingsValue): TerminalAppearance {
    const style = getComputedStyle(document.documentElement)
    const read = (name: string): string => style.getPropertyValue(name).trim()
    return {
      fontFamily: read('--font-mono'),
      fontSize: TerminalTheme.fontSizeOf(value.terminalFontScalePercent),
      theme: TerminalTheme.paletteOf(value.terminalTheme, read),
    }
  }

  /** `soft` differs from `original` in the pair alone; only `vscodeDark` brings sixteen of its own. */
  private static paletteOf(name: TerminalThemeName, read: (name: string) => string): ITheme {
    if (name === 'original' || name === 'soft')
      return TerminalTheme.assemble(read, '--terminal-ansi-')
    else if (name === 'vscodeDark')
      return TerminalTheme.assemble(read, '--terminal-vscode-ansi-')
    else
      throw new Error(`Unknown terminal theme: ${JSON.stringify(name)}`)
  }

  private static assemble(read: (name: string) => string, ansiPrefix: string): ITheme {
    const background = read('--terminal-background')
    return {
      background,
      foreground: read('--terminal-foreground'),
      cursor: read('--terminal-cursor'),
      // What the cursor draws the character under it in: the background, or the glyph disappears.
      cursorAccent: background,
      selectionBackground: read('--terminal-selection'),
      scrollbarSliderBackground: read('--color-surface-control-hover'),
      scrollbarSliderHoverBackground: read('--color-text-5'),
      scrollbarSliderActiveBackground: read('--color-accent-strong'),
      black: read(`${ansiPrefix}0`),
      red: read(`${ansiPrefix}1`),
      green: read(`${ansiPrefix}2`),
      yellow: read(`${ansiPrefix}3`),
      blue: read(`${ansiPrefix}4`),
      magenta: read(`${ansiPrefix}5`),
      cyan: read(`${ansiPrefix}6`),
      white: read(`${ansiPrefix}7`),
      brightBlack: read(`${ansiPrefix}8`),
      brightRed: read(`${ansiPrefix}9`),
      brightGreen: read(`${ansiPrefix}10`),
      brightYellow: read(`${ansiPrefix}11`),
      brightBlue: read(`${ansiPrefix}12`),
      brightMagenta: read(`${ansiPrefix}13`),
      brightCyan: read(`${ansiPrefix}14`),
      brightWhite: read(`${ansiPrefix}15`),
    }
  }
}
