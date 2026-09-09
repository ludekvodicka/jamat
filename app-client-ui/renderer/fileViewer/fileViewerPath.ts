import { PathText } from '../../shared/pathText'

export class FileViewerPath {
  /** The window's one path comparison. Kept as a name here because every caller in this feature
   *  reads better for it, and because `resolve` below is what this class is really for. */
  static equal(left: string, right: string): boolean {
    return PathText.equal(left, right)
  }

  /**
   * Where a link inside a document points, as a path the main process can be asked about.
   *
   * Two things it must not do, both of which it used to.
   *
   * It must not eat more `..` than there are segments. The overflow produced a RELATIVE string,
   * which `FileViewer.openWorkspace` then re-anchors in the session root - so
   * `[x](../../../../../../etc/hosts)` in `C:/work/docs/index.md` did not read as "outside the
   * root", it read as `C:/work/etc/hosts` and opened a different file. The reference is returned
   * untouched instead, so main answers about the thing that was actually written.
   *
   * And it must not lose the leading separator of an absolute POSIX base. Splitting
   * `/home/me/docs/notes.md` puts an empty first segment before the leading `/`, which the loop
   * skipped, so every link in a document on macOS or Linux resolved to a relative path. Windows is
   * the first release platform, which is why nobody had seen it.
   */
  static resolve(baseFile: string, reference: string): string {
    const clean = reference.replace(/[?#].*$/, '')
    if (/^[a-zA-Z]:[/\\]/.test(clean) || clean.startsWith('/')) return clean
    const separator = baseFile.includes('\\') ? '\\' : '/'
    const base = baseFile.replace(/[/\\][^/\\]*$/, '')
    const joined = `${base}${separator}${clean}`
    const rooted = /^[/\\]/.test(joined)
    const parts: string[] = []
    // A drive letter is a floor of its own: `C:` alone is not a directory anyone can walk out of.
    const floor = /^[a-zA-Z]:$/.test(joined.split(/[/\\]+/)[0] ?? '') ? 1 : 0
    for (const part of joined.split(/[/\\]+/)) {
      if (!part || part === '.') continue
      if (part !== '..') {
        parts.push(part)
        continue
      }
      if (parts.length <= floor) return reference
      parts.pop()
    }
    return (rooted ? separator : '') + parts.join(separator)
  }

}
