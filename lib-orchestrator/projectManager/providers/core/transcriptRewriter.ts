import { readFile, rename, unlink, writeFile } from 'node:fs/promises'

import { ErrorText } from '../../../shared/errorText'

/**
 * The file operations the rewriter performs, injectable so a test can produce the one failure that
 * matters here and cannot be provoked otherwise: a file another process holds open.
 */
export interface RewriterIo {
  readFile(file: string): Promise<string>
  writeFile(file: string, content: string): Promise<void>
  rename(oldFile: string, newFile: string): Promise<void>
  unlink(file: string): Promise<void>
}

export type RewriteOutcome = 'rewritten' | 'unchanged' | 'left-locked'
export type MoveOutcome = 'moved' | 'copied-pending-delete'

/**
 * The one place a provider transcript is rewritten. Both providers go through it: the file formats
 * differ, the danger does not - these are the user's conversations in someone else's application, and
 * Jamat cannot reproduce a single byte it destroys.
 */
export class TranscriptRewriter {
  private static readonly backslashPatternConst = /\\/g
  private static readonly forwardSlashPatternConst = /\//g
  /**
   * What may follow an occurrence of the old path for it to be that path and not the beginning of a
   * longer name. In the raw JSON of a transcript a path is either closed by its quote, or continues
   * with a separator into a subdirectory - and an escaped end of line is a backslash too. Anything
   * else (a letter, a digit, '-', '.', a space, a comma) can be the rest of a sibling's name:
   * renaming `…/AppJamat` must not touch `…/AppJamatV3`, whose encoded shape `Q--Apps-AppJamat` is a
   * prefix as well. Missing an occurrence shows up as one session that cannot be found; rewriting a
   * sibling silently corrupts text nobody can restore.
   */
  private static readonly boundaryCharactersConst: ReadonlySet<string> = new Set(['"', '\\', '/'])
  private static readonly lockedCodesConst: ReadonlySet<string> = new Set(['EBUSY', 'EPERM'])
  private static readonly temporarySuffixConst = '.tmp'
  private static readonly nodeIoConst: RewriterIo = {
    readFile: (file) => readFile(file, 'utf8'),
    writeFile: (file, content) => writeFile(file, content, 'utf8'),
    rename: (oldFile, newFile) => rename(oldFile, newFile),
    unlink: (file) => unlink(file),
  }

  /**
   * The shapes a project path takes inside a transcript: the JSON-escaped backslash form the raw file
   * actually holds ("Q:\\Apps\\Foo") and the forward-slash form.
   *
   * A provider that also derives a name from the path passes `encode` to add that shape too - Claude
   * names its store directories that way, Codex has no such name and passes nothing, because
   * replacing a shape a format never contains can only corrupt unrelated text. The encoding itself
   * stays with the provider that owns it: two copies of that rule are how history goes missing.
   */
  static replacementsOf(
    oldPath: string,
    newPath: string,
    encode?: (path: string) => string,
  ): [string, string][] {
    const replacements: [string, string][] = [
      [TranscriptRewriter.jsonEscaped(oldPath), TranscriptRewriter.jsonEscaped(newPath)],
      [TranscriptRewriter.forwardSlashed(oldPath), TranscriptRewriter.forwardSlashed(newPath)],
    ]
    if (encode)
      replacements.push([encode(oldPath), encode(newPath)])
    return replacements
  }

  /** Windows refuses to rename or unlink a file another process holds open; that is the whole set. */
  static isLockedError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    const code = (error as NodeJS.ErrnoException).code
    return code !== undefined && TranscriptRewriter.lockedCodesConst.has(code)
  }

  /**
   * Read, replace, and only then touch the disk. The new content lands in a sibling `.tmp` and takes
   * the original's place by rename, because a transcript truncated and rewritten in place is gone if
   * the power fails mid-write - that is finding 099, one destroyed conversation, and it is why V1's
   * version of this function is not ported. A file whose content did not change is not written at all.
   *
   * A rename the operating system refuses because the transcript is open is classified rather than
   * thrown: the caller records a leftover and the operation carries on. Every other failure is
   * thrown - a rewriter that swallows errors reports success over data it never wrote.
   */
  static async rewriteInPlace(
    file: string,
    replacements: readonly [string, string][],
    io: RewriterIo = TranscriptRewriter.nodeIoConst,
  ): Promise<RewriteOutcome> {
    const original = await io.readFile(file)
    const rewritten = TranscriptRewriter.apply(original, replacements)
    if (rewritten === original) return 'unchanged'
    const temporaryFile = `${file}${TranscriptRewriter.temporarySuffixConst}`
    await io.writeFile(temporaryFile, rewritten)
    try {
      await io.rename(temporaryFile, file)
    } catch (error) {
      await TranscriptRewriter.discard(temporaryFile, io, error)
      if (TranscriptRewriter.isLockedError(error)) return 'left-locked'
      throw error
    }
    return 'rewritten'
  }

  /**
   * The move half of the same core: the rewritten content is written where the file is going, and the
   * original is removed only afterwards, so an interruption between the two leaves both copies rather
   * than neither. A locked original is classified - the new copy stands and the stale one becomes a
   * leftover the startup sweep deletes later.
   */
  static async moveWithRewrite(
    oldFile: string,
    newFile: string,
    replacements: readonly [string, string][],
    io: RewriterIo = TranscriptRewriter.nodeIoConst,
  ): Promise<MoveOutcome> {
    const rewritten = TranscriptRewriter.apply(await io.readFile(oldFile), replacements)
    const temporaryFile = `${newFile}${TranscriptRewriter.temporarySuffixConst}`
    await io.writeFile(temporaryFile, rewritten)
    try {
      await io.rename(temporaryFile, newFile)
    } catch (error) {
      await TranscriptRewriter.discard(temporaryFile, io, error)
      throw error
    }
    try {
      await io.unlink(oldFile)
    } catch (error) {
      if (TranscriptRewriter.isLockedError(error)) return 'copied-pending-delete'
      throw error
    }
    return 'moved'
  }

  private static apply(content: string, replacements: readonly [string, string][]): string {
    let result = content
    for (const [search, replacement] of replacements)
      result = TranscriptRewriter.replaceBounded(result, search, replacement)
    return result
  }

  /** Replaces the occurrences that end where a path may end; see `boundaryCharactersConst`. */
  private static replaceBounded(content: string, search: string, replacement: string): string {
    let result = ''
    let from = 0
    for (;;) {
      const at = content.indexOf(search, from)
      if (at === -1) return result + content.slice(from)
      const after = at + search.length
      result += content.slice(from, at)
        + (TranscriptRewriter.endsAName(content, after) ? replacement : search)
      from = after
    }
  }

  private static endsAName(content: string, index: number): boolean {
    if (index >= content.length) return true
    return TranscriptRewriter.boundaryCharactersConst.has(content[index])
  }

  /** A Windows path inside a JSON string is stored with its separators doubled; the raw text is
   *  what is searched, so the search term carries the doubling too. */
  private static jsonEscaped(path: string): string {
    return path
      .replace(TranscriptRewriter.forwardSlashPatternConst, '\\')
      .replace(TranscriptRewriter.backslashPatternConst, '\\\\')
  }

  private static forwardSlashed(path: string): string {
    return path.replace(TranscriptRewriter.backslashPatternConst, '/')
  }

  /**
   * The half-written sibling does not survive the failure that stopped it. Failing to remove it is
   * reported alongside the failure that caused it rather than in its place: the rename error is the
   * one that explains what happened to the transcript.
   */
  private static async discard(file: string, io: RewriterIo, cause: unknown): Promise<void> {
    try {
      await io.unlink(file)
    } catch (error) {
      throw new Error(
        `${ErrorText.of(cause)} (and ${file} could not be removed: ${ErrorText.of(error)})`,
      )
    }
  }
}
