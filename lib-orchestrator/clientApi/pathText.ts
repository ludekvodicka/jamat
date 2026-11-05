/**
 * Comparing two paths that arrived as text, on the side of the window that has no `node:path`.
 *
 * There were three of these and they disagreed about case: the file viewer's lowercased only a path
 * that starts with a drive letter, the library's `PathCompare` lowercases on win32, and the sessions
 * tree's lowercased always. The last one calls two different files equal on a case-sensitive
 * filesystem; this keeps the file viewer's rule, which is the one that matches how the platforms
 * actually behave - a Windows path is case-insensitive, a POSIX path is not.
 *
 * It does NOT resolve. A renderer has no cwd worth resolving against, and every path it compares was
 * already made absolute by the main process.
 */
export class PathText {
  /** Forward slashes, no trailing separator, and still spelled in the original case. */
  static normalized(value: string): string {
    return value.replaceAll('\\', '/').replace(/\/+$/, '')
  }

  static comparable(value: string): string {
    const normalized = PathText.normalized(value)
    return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized
  }

  static equal(left: string, right: string): boolean {
    return PathText.comparable(left) === PathText.comparable(right)
  }
}
