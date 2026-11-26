import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, type BigIntStats } from 'node:fs'

/**
 * SHA-1 of a working file in the form svn stores in `NODES.checksum`, remembered by path, time and
 * size. A file with `svn:eol-style` is hashed with every CRLF and lone CR read as LF, its
 * repository-normal form.
 */
export class ContentHashCache {
  static readonly entriesConst = 4_096
  private static readonly chunkConst = 1 << 20
  private static readonly lfConst = Buffer.from('\n')

  private readonly entries = new Map<string, string>()
  private fileReads = 0

  /** How many files were read since this cache was made. */
  get reads(): number { return this.fileReads }

  get size(): number { return this.entries.size }

  sha1(path: string, stats: BigIntStats, eolNormalized: boolean): string {
    const key = `${path}|${stats.mtimeNs}|${stats.size}|${eolNormalized ? 'lf' : 'raw'}`
    const known = this.entries.get(key)
    if (known !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, known)
      return known
    }
    this.fileReads++
    const digest = ContentHashCache.digest(path, eolNormalized)
    this.entries.set(key, digest)
    if (this.entries.size > ContentHashCache.entriesConst) this.entries.delete(this.entries.keys().next().value!)
    return digest
  }

  private static digest(path: string, eolNormalized: boolean): string {
    const hash = createHash('sha1'), buffer = Buffer.allocUnsafe(ContentHashCache.chunkConst)
    const fd = openSync(path, 'r')
    let pendingCr = false
    try {
      for (;;) {
        const count = readSync(fd, buffer, 0, buffer.length, null)
        if (count === 0) break
        const chunk = buffer.subarray(0, count)
        if (!eolNormalized) {
          hash.update(chunk)
          continue
        }
        let start = 0
        if (pendingCr) {
          hash.update(ContentHashCache.lfConst)
          pendingCr = false
          if (chunk[0] === 0x0a) start = 1
        }
        for (let cr = chunk.indexOf(0x0d, start); cr !== -1; cr = chunk.indexOf(0x0d, start)) {
          hash.update(chunk.subarray(start, cr))
          if (cr + 1 === count) {
            pendingCr = true
            start = count
            break
          }
          hash.update(ContentHashCache.lfConst)
          start = chunk[cr + 1] === 0x0a ? cr + 2 : cr + 1
        }
        if (start < count) hash.update(chunk.subarray(start))
      }
      if (pendingCr) hash.update(ContentHashCache.lfConst)
    }
    finally { closeSync(fd) }
    return hash.digest('hex')
  }
}
