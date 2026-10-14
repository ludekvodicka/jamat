import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/**
 * Paths as clipboard text, in both directions: the text that names files on this computer, and the
 * text that pastes a path so an agent reads it.
 */
export class ClipboardPastePaths {
  /** More lines than this are a text that happens to hold paths, not a selection of files. */
  private static readonly linesMaxConst = 20

  /**
   * The files a clipboard text names, or null when it is anything else. Every non-empty line must be
   * an absolute path to an existing file, quoted or not: Explorer's "Copy as path" quotes each one.
   * One line that is not keeps the whole text a text.
   */
  static filesOf(text: string): string[] | null {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
    if (lines.length === 0 || lines.length > ClipboardPastePaths.linesMaxConst) return null
    const paths = lines.map((line) => line.replace(/^"(.*)"$/, '$1'))
    return paths.every(ClipboardPastePaths.isFile) ? paths : null
  }

  /** Both agents read a pasted path as a file; one with a space is quoted the way a dropped file is. */
  static textOf(path: string): string {
    return /\s/.test(path) ? `"${path}"` : path
  }

  private static isFile(path: string): boolean {
    if (!isAbsolute(path)) return false
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  }
}
