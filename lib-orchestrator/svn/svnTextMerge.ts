import { diffArrays } from 'diff'

interface Hunk { start: number; end: number; lines: string[]; side: 'mine' | 'theirs' }

/**
 * A three-way line merge of text whose line ends may differ between the sides: the sides are compared
 * as LF, and the result takes the line ends of the incoming side. A conflict on a file one side saved
 * with other line ends is a whole-file conflict to svn, though only some lines changed (Finish 072).
 * Changes of both sides that overlap or touch, other than the same change, are a conflict, so a clean
 * result keeps every line either side changed. jsdiff 9 dropped its merge; this sits on `diffArrays`.
 */
export class SvnTextMerge {
  /** The merged bytes, or null when the sides conflict or the incoming side mixes line ends. */
  static merge(older: Uint8Array, mine: Uint8Array, theirs: Uint8Array): Buffer | null {
    const incoming = Buffer.from(theirs).toString('utf8')
    const crlf = incoming.split('\r\n').length - 1
    const lf = incoming.split('\n').length - 1
    // Mixed line ends cannot be written back without changing lines nobody touched.
    if (crlf !== 0 && crlf !== lf) return null
    const base = SvnTextMerge.lines(older)
    const hunks = [...SvnTextMerge.hunks(base, SvnTextMerge.lines(mine), 'mine'), ...SvnTextMerge.hunks(base, SvnTextMerge.lines(theirs), 'theirs')]
      .sort((a, b) => a.start - b.start || a.end - b.end)
    const applied: Hunk[] = []
    for (const hunk of hunks) {
      const overlap = applied.filter((other) => other.side !== hunk.side && hunk.start <= other.end && other.start <= hunk.end)
      if (overlap.length === 0) applied.push(hunk)
      else if (overlap.length > 1 || !SvnTextMerge.same(overlap[0], hunk)) return null
    }
    const merged: string[] = []
    let at = 0
    for (const hunk of applied) {
      merged.push(...base.slice(at, hunk.start), ...hunk.lines)
      at = hunk.end
    }
    merged.push(...base.slice(at))
    return Buffer.from(merged.join(crlf > 0 ? '\r\n' : '\n'), 'utf8')
  }

  private static lines(bytes: Uint8Array): string[] {
    return Buffer.from(bytes).toString('utf8').replaceAll('\r\n', '\n').split('\n')
  }

  /** The changed ranges of `side` against `base`: base lines [start, end) replaced by `lines`. */
  private static hunks(base: readonly string[], side: readonly string[], name: Hunk['side']): Hunk[] {
    const hunks: Hunk[] = []
    let at = 0
    let open: Hunk | null = null
    for (const change of diffArrays(base as string[], side as string[])) {
      const count = change.count ?? change.value.length
      if (!change.added && !change.removed) {
        if (open !== null) hunks.push(open)
        open = null
        at += count
        continue
      }
      open ??= { start: at, end: at, lines: [], side: name }
      if (change.removed) { at += count; open.end = at }
      else open.lines.push(...change.value)
    }
    if (open !== null) hunks.push(open)
    return hunks
  }

  private static same(a: Hunk, b: Hunk): boolean {
    return a.start === b.start && a.end === b.end && a.lines.length === b.lines.length && a.lines.every((line, index) => line === b.lines[index])
  }
}
