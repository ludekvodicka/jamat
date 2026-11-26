import { isAbsolute, resolve } from 'node:path'

import { PathCompare } from '../../shared/pathCompare'

/**
 * The paths a shell command may have written, read from its text alone: absolute names (`Q:\a`,
 * `Q:/a`), Git Bash names (`/q/a`) and relative names, which count against every base (the session
 * directory and the working copy root). Whether the command wrote one is decided elsewhere, by the
 * path's write time against the run (`FileChangesShellRuns.ranAt`); a name here is only a candidate.
 */
export class ShellPathNames {
  /** A command that names more is a generated one (a file list); the rest of it is not read. */
  static readonly maxTokensConst = 64

  private static readonly separatorsConst = /[\s"'`;|&<>(){}[\],=]+/
  private static readonly drivePathConst = /^[a-zA-Z]:[\\/]/
  private static readonly gitBashPathConst = /^\/([a-zA-Z])\/(.+)$/
  private static readonly fileNameConst = /\.[A-Za-z0-9]+$/

  /** Absolute candidates, each once (compared the way the platform compares paths). */
  static of(command: string, bases: readonly string[]): string[] {
    const found = new Map<string, string>()
    let tokens = 0
    for (const token of command.split(ShellPathNames.separatorsConst)) {
      const candidates = ShellPathNames.candidatesOf(token, bases)
      if (candidates === null) continue
      tokens += 1
      if (tokens > ShellPathNames.maxTokensConst) break
      for (const candidate of candidates)
        found.set(PathCompare.comparable(candidate), candidate)
    }
    return [...found.values()]
  }

  /** Null for a token that names no path: a word, a flag, a URL. */
  private static candidatesOf(token: string, bases: readonly string[]): string[] | null {
    if (token === '' || token.startsWith('-') || token.includes('://') || token.includes('$')) return null
    if (ShellPathNames.drivePathConst.test(token)) return [resolve(token)]
    const gitBash = ShellPathNames.gitBashPathConst.exec(token)
    if (gitBash !== null) return [resolve(`${gitBash[1]!.toUpperCase()}:/${gitBash[2]!}`)]
    if (isAbsolute(token)) return null
    if (!/[\\/]/.test(token) && !ShellPathNames.fileNameConst.test(token)) return null
    return bases.map((base) => resolve(base, token))
  }
}
