import type { ITheme } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'

import type { TerminalThemeName, UiSettingsValue } from '../../../../shared/uiSettings'
import { TerminalTheme } from './terminalTheme'

/**
 * `current()` reads computed styles and builds an xterm theme. The stylesheet is not loaded here, so
 * every token is set to its OWN NAME on the document: what comes back then says which token each
 * field was read from, which is what "assembled by name" means, and it keeps a colour out of a file
 * the token gate scans for one.
 *
 * The pair is `--terminal-background` / `--terminal-foreground` for every theme - which pair those
 * two lead to is `tokens.css`'s answer, under the attribute the store writes, and no stylesheet is
 * loaded here to give it. So `pair` stands in for that redirection: the test sets the two to what
 * the chosen block would have redirected them to, and what is asserted here is that the assembly
 * reads them at all rather than reaching past them for a pair of its own.
 */
describe('app-client-ui/renderer/panels/terminal/terminalTheme', () => {
  const tokensConst: readonly string[] = [
    '--font-mono',
    '--terminal-background',
    '--terminal-foreground',
    '--terminal-cursor',
    '--terminal-selection',
    '--color-surface-control-hover',
    '--color-text-5',
    '--color-accent-strong',
    ...Array.from({ length: 16 }, (_, index) => `--terminal-ansi-${index}`),
    ...Array.from({ length: 16 }, (_, index) => `--terminal-vscode-ansi-${index}`),
  ]

  /** What `tokens.css` redirects the pair to for each theme, mirrored here token name for token name. */
  const pairConst: Record<TerminalThemeName, readonly [string, string]> = {
    original: ['--color-background', '--color-text-1'],
    soft: ['--terminal-soft-background', '--terminal-soft-foreground'],
    vscodeDark: ['--terminal-vscode-background', '--terminal-vscode-foreground'],
  }

  function themeOf(terminalTheme: TerminalThemeName): ITheme {
    for (const token of tokensConst)
      document.documentElement.style.setProperty(token, token)
    const pair = pairConst[terminalTheme]
    if (pair !== undefined) {
      document.documentElement.style.setProperty('--terminal-background', pair[0])
      document.documentElement.style.setProperty('--terminal-foreground', pair[1])
    }
    const value: UiSettingsValue = {
      fontScalePercent: 100,
      fileViewerFontScalePercent: 100,
      terminalFontScalePercent: 100,
      terminalTheme,
    }
    return TerminalTheme.current(value).theme
  }

  /** The sixteen a program addresses by number, in the order `assemble` reads them. */
  function ansi(theme: ITheme): readonly (string | undefined)[] {
    return [
      theme.black, theme.red, theme.green, theme.yellow,
      theme.blue, theme.magenta, theme.cyan, theme.white,
      theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow,
      theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite,
    ]
  }

  afterEach(() => {
    for (const token of tokensConst)
      document.documentElement.style.removeProperty(token)
  })

  it('scales the 13px base by the percentage', () => {
    expect(TerminalTheme.fontSizeOf(70)).toBe(9)
    expect(TerminalTheme.fontSizeOf(100)).toBe(13)
    expect(TerminalTheme.fontSizeOf(150)).toBe(20)
  })

  // Why the live change compares pixels rather than percentages: on a 13px base a 5 % step is under
  // a pixel, so neighbouring steps ask for the same size and only one of them is a real resize.
  it('lands neighbouring steps on the same pixel size', () => {
    expect(TerminalTheme.fontSizeOf(105)).toBe(14)
    expect(TerminalTheme.fontSizeOf(110)).toBe(14)
  })

  // The default, and the whole of what it means: the terminal takes the window's own pair, so it
  // sits in the shell rather than in a rectangle pasted onto it.
  it('gives original the window pair and the shared palette', () => {
    const theme = themeOf('original')

    expect(theme.background).toBe('--color-background')
    expect(theme.foreground).toBe('--color-text-1')
    expect(theme.cursorAccent).toBe('--color-background')
    expect(theme.scrollbarSliderBackground).toBe('--color-surface-control-hover')
    expect(theme.scrollbarSliderHoverBackground).toBe('--color-text-5')
    expect(theme.scrollbarSliderActiveBackground).toBe('--color-accent-strong')
    expect(ansi(theme)[0]).toBe('--terminal-ansi-0')
    expect(ansi(theme)[15]).toBe('--terminal-ansi-15')
  })

  // The whole of V1's difference, and nothing else: the sixteen were already identical.
  it('gives soft its own pair over the palette original uses', () => {
    const original = themeOf('original')
    const soft = themeOf('soft')

    expect(soft.background).toBe('--terminal-soft-background')
    expect(soft.foreground).toBe('--terminal-soft-foreground')
    expect(soft.cursorAccent).toBe('--terminal-soft-background')
    expect(ansi(soft)).toEqual(ansi(original))
    expect(soft.cursor).toBe(original.cursor)
    expect(soft.selectionBackground).toBe(original.selectionBackground)
  })

  // The one of the three that carries a palette of its own, which is why it is in the set at all.
  it('gives vscodeDark sixteen colours of its own', () => {
    const original = themeOf('original')
    const vscodeDark = themeOf('vscodeDark')

    expect(vscodeDark.background).toBe('--terminal-vscode-background')
    expect(vscodeDark.foreground).toBe('--terminal-vscode-foreground')
    expect(ansi(vscodeDark)).toEqual(
      Array.from({ length: 16 }, (_, index) => `--terminal-vscode-ansi-${index}`),
    )
    expect(ansi(vscodeDark)).not.toEqual(ansi(original))
    expect(vscodeDark.cursor).toBe(original.cursor)
    expect(vscodeDark.selectionBackground).toBe(original.selectionBackground)
  })

  it('refuses a name outside the three rather than drawing something', () => {
    expect(() => themeOf('powershell' as TerminalThemeName)).toThrow(/Unknown terminal theme/)
  })
})
