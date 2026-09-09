import { homedir } from 'node:os'

export type PathCandidate =
  | { kind: 'direct'; path: string; line: number | null; column: number | null }
  | { kind: 'search'; partial: string; line: number | null }

export interface PathReference {
  path: string
  line: number | null
  column: number | null
}

export interface PathResolveContext {
  projectDir: string | null
}

/**
 * Turns one token a user right-clicked in a terminal into the on-disk candidates worth probing.
 * Pure apart from `homedir()`: no filesystem access, no DOM. The buffer scan that grew the token
 * lives in the renderer and carries its own character class.
 */
export class TerminalPathExtractor {
  private static readonly wildcardsMaxConst = 4

  /**
   * Order is load-bearing: quotes, then trailing punctuation, then the `:line[:col]` split, then
   * punctuation again. Splitting before the first strip leaves `:2188` glued to `foo.md:2188.`
   * and the disk probe fails.
   */
  parse(raw: string): PathReference {
    // Only at the two ends: a quote inside the token belongs to the name (`bob's docs`), and
    // stripping globally turned those into paths that exist nowhere.
    const unquoted = raw.trim().replace(/^["`']+/, '').replace(/["`']+$/, '')
    const value = TerminalPathExtractor.stripTail(this.clean(unquoted))
    const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(value)
    // A bare drive letter (`C:12`) is not a line reference - keep the token whole.
    if (match === null || match[1].length <= 1) return { path: value.trim(), line: null, column: null }
    return {
      path: TerminalPathExtractor.stripTail(match[1]).trim(),
      line: Number.parseInt(match[2], 10),
      column: match[3] === undefined ? null : Number.parseInt(match[3], 10),
    }
  }

  resolve(token: string, context: PathResolveContext): PathCandidate[] {
    const { path, line, column } = this.parse(token)
    if (path === '') return []
    const candidates: PathCandidate[] = []
    const direct = this.directPath(path, context.projectDir)
    if (direct !== null) candidates.push({ kind: 'direct', path: direct, line, column })
    if (TerminalPathExtractor.looksSearchable(path))
      candidates.push({ kind: 'search', partial: path.replace(/\//g, '\\'), line })
    return candidates
  }

  /** A `file://` URI becomes a native path. Codex's `/C:/...` Markdown link target loses the
   *  one URI-style slash that would otherwise turn it into a root-relative Windows path. */
  protected clean(raw: string): string {
    const driveLink = /^[\\/][a-zA-Z]:[\\/]/.test(raw) ? raw.slice(1) : raw
    const match = /^file:\/\/([^/]*)(\/.*)$/i.exec(driveLink)
    if (match === null) return driveLink
    const path = TerminalPathExtractor.percentDecoded(match[2])
    if (match[1] !== '') return `//${match[1]}${path}`
    return /^\/[a-zA-Z]:/.test(path) ? path.slice(1) : path
  }

  /** Absolute path, or null when the token cannot become one. `~` is expanded here so that
   *  everything downstream - the detection store, VS Code, the grant roots - holds real paths. */
  protected directPath(cleaned: string, projectDir: string | null): string | null {
    const path = cleaned.replace(/\//g, '\\')
    if (path === '~' || path.startsWith('~\\')) return homedir() + path.slice(1)
    if (/^[a-zA-Z]:[\\/]/.test(path)) return path
    if (path.startsWith('\\')) return path
    if (projectDir !== null) return `${projectDir.replace(/[\\/]+$/, '')}\\${path}`
    return null
  }

  /** Worth a suffix search: path-ish, with a filename-like last segment. A name elided more than a
   *  few times is not a real path any more, it is a pattern that would match half the tree. */
  static looksSearchable(cleaned: string): boolean {
    const segments = TerminalPathExtractor.segmentsOf(cleaned)
    const last = segments[segments.length - 1] ?? ''
    if (!last.includes('.')) return false
    return TerminalPathExtractor.wildcardsIn(cleaned) <= TerminalPathExtractor.wildcardsMaxConst
  }

  static segmentsOf(value: string): string[] {
    return value.replace(/\//g, '\\').split('\\').filter((segment) => segment !== '' && segment !== '…' && segment !== '...')
  }

  /**
   * A segment carrying `…`, `...` or `*` is a wildcard; otherwise an exact compare. Both sides are
   * expected lowercased by the caller.
   *
   * Matched by walking, never by a regex. The regex this replaced turned each wildcard into `.*`
   * with nothing anchoring the pieces, which backtracks catastrophically: 22 wildcards against a
   * 49-character name measured 160 seconds for one call, on the main process, reachable from a
   * banner of asterisks in ordinary agent output. Anchoring the first and last piece and taking
   * every middle piece at its earliest position is linear and gives the same answer.
   */
  static segTester(patternSegment: string): (fileSegment: string) => boolean {
    const parts = patternSegment.split(/…|\.\.\.|\*/)
    if (parts.length === 1) return (fileSegment) => fileSegment === patternSegment
    return (fileSegment) => TerminalPathExtractor.matchesParts(fileSegment, parts)
  }

  /** Does the file's trailing segment list end with the (possibly wildcard) pattern segments? */
  static matchesSuffix(fileSegsLower: readonly string[], patternSegsLower: readonly string[]): boolean {
    if (patternSegsLower.length > fileSegsLower.length) return false
    for (let index = 1; index <= patternSegsLower.length; index++) {
      const test = TerminalPathExtractor.segTester(patternSegsLower[patternSegsLower.length - index])
      if (!test(fileSegsLower[fileSegsLower.length - index])) return false
    }
    return true
  }

  private static matchesParts(value: string, parts: readonly string[]): boolean {
    const last = parts.length - 1
    if (!value.startsWith(parts[0]) || !value.endsWith(parts[last])) return false
    let at = parts[0].length
    const end = value.length - parts[last].length
    if (at > end) return false
    for (let index = 1; index < last; index++) {
      const found = value.indexOf(parts[index], at)
      if (found === -1 || found + parts[index].length > end) return false
      at = found + parts[index].length
    }
    return true
  }

  private static wildcardsIn(value: string): number {
    return (value.match(/…|\.\.\.|\*/g) ?? []).length
  }

  private static stripTail(value: string): string {
    return value.replace(/[.,;:!?\s]+$/, '')
  }

  private static percentDecoded(value: string): string {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
}
