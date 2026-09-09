import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { AppCommands } from '../shared/commands'

class TokensGate {
  private static readonly packageRootConst = join(dirname(fileURLToPath(import.meta.url)), '..')
  private static readonly tokensFileConst = 'renderer/styles/tokens.css'
  /** The base, since 2026-08-10: one constant for every window of this shell, and the gate on it. */
  private static readonly windowFileConst = 'app/shell/shellWindowBase.ts'
  private static readonly scannedExtensionsConst = ['.css', '.ts', '.tsx']
  private static readonly hexPatternConst = /#[0-9a-fA-F]{3,8}\b/

  /** `path:line: source` for every raw colour outside the token file. */
  static hexFindings(): string[] {
    const findings: string[] = []
    for (const file of TokensGate.rendererFiles()) {
      const display = TokensGate.display(file)
      if (display === TokensGate.tokensFileConst)
        continue
      readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
        if (TokensGate.hexPatternConst.test(line))
          findings.push(`${display}:${index + 1}: ${line.trim()}`)
      })
    }
    return findings
  }

  static tokensHeader(): string {
    return readFileSync(
      join(TokensGate.packageRootConst, TokensGate.tokensFileConst),
      'utf8',
    ).split('*/')[0]
  }

  static tokenBackground(): string {
    return TokensGate.matchOne(
      TokensGate.tokensFileConst,
      /--color-background:\s*(#[0-9a-fA-F]{3,8})\s*;/,
    )
  }

  static windowBackground(): string {
    return TokensGate.matchOne(
      TokensGate.windowFileConst,
      /backgroundColorConst\s*=\s*'(#[0-9a-fA-F]{3,8})'/,
    )
  }

  /** The pair a document falls back to, which is the first declaration of each in the file. */
  static terminalDefaultPair(): string[] {
    return [
      TokensGate.matchOne(
        TokensGate.tokensFileConst,
        /--terminal-background:\s*var\((--[a-z0-9-]+)\)/,
      ),
      TokensGate.matchOne(
        TokensGate.tokensFileConst,
        /--terminal-foreground:\s*var\((--[a-z0-9-]+)\)/,
      ),
    ]
  }

  /** The two token names `:root[data-terminal-theme='<name>']` redirects the pair to, in order. */
  static terminalPairOf(name: string): string[] {
    const block = TokensGate.matchOne(
      TokensGate.tokensFileConst,
      new RegExp(`:root\\[data-terminal-theme='${name}'\\]\\s*\\{([^}]*)\\}`),
    )
    return [...block.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1])
  }

  private static matchOne(relativePath: string, pattern: RegExp): string {
    const source = readFileSync(join(TokensGate.packageRootConst, relativePath), 'utf8')
    const match = pattern.exec(source)
    if (!match)
      throw new Error(`${relativePath} carries no ${pattern.source}`)
    return match[1].toLowerCase()
  }

  private static rendererFiles(): string[] {
    const files: string[] = []
    TokensGate.collect(join(TokensGate.packageRootConst, 'renderer'), files)
    return files
  }

  /**
   * Every source file of the package, for the rules that are not about the renderer alone. The
   * list is every top-level source directory: while the programs sat under one `app/`, walking
   * that one name covered them all, and after the split it would have covered the main process
   * alone while still reporting green. `start.ts` is named separately because it is the one source
   * file that is not inside any of them.
   */
  private static packageFiles(): string[] {
    const files: string[] = [join(TokensGate.packageRootConst, 'start.ts')]
    for (const directory of ['app', 'preload', 'renderer', 'shared', 'scripts'])
      TokensGate.collect(join(TokensGate.packageRootConst, directory), files)
    return files
  }

  /** The files carrying a CRLF, which is what turns a three-line edit into a whole-file diff. */
  static crlfFindings(): string[] {
    return TokensGate.packageFiles()
      .filter((file) => readFileSync(file, 'latin1').includes('\r\n'))
      .map((file) => TokensGate.display(file))
  }

  private static collect(directory: string, files: string[]): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory())
        TokensGate.collect(full, files)
      else if (TokensGate.scannedExtensionsConst.some((extension) => entry.name.endsWith(extension)))
        files.push(full)
    }
  }

  private static display(file: string): string {
    return relative(TokensGate.packageRootConst, file).split('\\').join('/')
  }
}

describe('app-client-ui/scripts/tokensGate', () => {
  // One file holds the palette, or the palette is wherever someone last needed a colour.
  it('finds no raw colour under renderer/ outside tokens.css', () => {
    expect(TokensGate.hexFindings()).toEqual([])
  })

  // The header explains the rule, so it has to name the directory the gate actually walks. It named
  // `src/renderer`, a path this package deliberately does not have.
  // Four files were committed with CRLF and `svn diff` rendered each of them as a whole-file
  // rewrite, so the actual change could not be read. Two different tools did it, days apart, which
  // is why this is a gate and not a habit.
  it('keeps every source file on LF', () => {
    expect(TokensGate.crlfFindings()).toEqual([])
  })

  it('names the scanned directory in the tokens header', () => {
    expect(TokensGate.tokensHeader()).toContain('renderer/')
    expect(TokensGate.tokensHeader()).not.toContain('app/renderer')
    expect(TokensGate.tokensHeader()).not.toContain('src/renderer')
  })

  // The window paints before the document does; two different values flash on every launch.
  it('paints the window in the same colour as the background token', () => {
    expect(TokensGate.windowBackground()).toBe(TokensGate.tokenBackground())
  })

  /**
   * Choosing a terminal theme is a NAME written onto the document, and this file is the only place
   * that name becomes a colour - for xterm and for the panel around its canvas alike. A block that
   * is missing or points at the wrong pair fails silently in the worst way there is: the terminal
   * keeps the default pair, which is what "the setting did nothing" looks like.
   */
  it('turns every terminal theme name into the pair that theme brings', () => {
    expect(TokensGate.terminalDefaultPair()).toEqual(['--color-background', '--color-text-1'])
    expect(TokensGate.terminalPairOf('soft'))
      .toEqual(['--terminal-soft-background', '--terminal-soft-foreground'])
    expect(TokensGate.terminalPairOf('vscodeDark'))
      .toEqual(['--terminal-vscode-background', '--terminal-vscode-foreground'])
  })

  // The design-time rule of D7, made runnable: a key the shell takes is a key the terminal loses.
  it('gives no command an accelerator that belongs to the terminal', () => {
    const reserved: readonly string[] = AppCommands.reservedTerminalKeysConst
    const taken = AppCommands.all()
      .filter((descriptor) => descriptor.accelerator
        && reserved.includes(descriptor.accelerator))
      .map((descriptor) => `${descriptor.id} took ${descriptor.accelerator}`)
    expect(taken).toEqual([])
  })

  /**
   * The other half of the same rule, and the one the terminal cannot enforce for itself.
   * `TerminalKeyGate` decides whether xterm turns a keystroke into bytes; it cannot stop the native
   * menu from firing, because an accelerator fires wherever the focus is. So a command declared NOT
   * terminal-safe has to be display-only, or it runs over a focused terminal anyway.
   *
   * Vacuous today: every command is terminal-safe. It is here for the first one that is not.
   */
  it('keeps every command that is not terminal-safe from owning its key', () => {
    const armed = AppCommands.all()
      .filter((descriptor) => !descriptor.terminalSafe
        && descriptor.accelerator !== undefined
        && descriptor.registerAccelerator !== false)
      .map((descriptor) => `${descriptor.id} would fire over a focused terminal`)
    expect(armed).toEqual([])
  })
})
