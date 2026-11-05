import { readFile, stat } from 'node:fs/promises'

import { ErrnoCode } from '../../shared/errnoCode'

type Outcome = { kind: 'parsed'; value: unknown } | { kind: 'failed'; error: unknown }

/**
 * The identity receipts a launch witness writes, read off the event loop and parsed again only when
 * their stat moved: every reconcile asks for the receipt of every tracked session, and a receipt
 * changes once per conversation. The key is mtime and size, the stat key `TranscriptTailReader` uses.
 */
export class IdentityReceiptFile {
  /** A receipt is a few hundred bytes; a larger file is not one. */
  private static readonly maxBytesConst = 8192
  private static readonly maxEntriesConst = 256
  /**
   * A file written this recently can be written again inside the same mtime tick with the same size
   * (a sequence 7 becoming 8), which the key cannot see. Such a read is not kept, the way git treats
   * an index entry as racily clean.
   */
  private static readonly settledMillisecondsConst = 2_000

  private readonly cache = new Map<string, { mtimeMs: number; size: number; outcome: Outcome }>()

  /** The parsed document, or null when there is no receipt; throws for one too large or not JSON. */
  async read(file: string): Promise<unknown> {
    let metadata
    try { metadata = await stat(file) }
    catch (error) {
      if (ErrnoCode.of(error) !== 'ENOENT') throw error
      this.cache.delete(file)
      return null
    }
    let entry = this.cache.get(file)
    if (entry === undefined || entry.mtimeMs !== metadata.mtimeMs || entry.size !== metadata.size) {
      entry = { mtimeMs: metadata.mtimeMs, size: metadata.size, outcome: await IdentityReceiptFile.parse(file, metadata.size) }
      this.cache.delete(file)
      if (Date.now() - metadata.mtimeMs >= IdentityReceiptFile.settledMillisecondsConst) this.cache.set(file, entry)
      while (this.cache.size > IdentityReceiptFile.maxEntriesConst)
        this.cache.delete(this.cache.keys().next().value!)
    }
    const outcome = entry.outcome
    switch (outcome.kind) {
      case 'parsed': return outcome.value
      case 'failed': throw outcome.error
      default: throw new Error(`Unknown receipt outcome: ${JSON.stringify(outcome satisfies never)}`)
    }
  }

  private static async parse(file: string, size: number): Promise<Outcome> {
    try {
      if (size > IdentityReceiptFile.maxBytesConst) throw new Error('Identity receipt exceeds 8 KiB')
      return { kind: 'parsed', value: JSON.parse(await readFile(file, 'utf8')) }
    } catch (error) {
      return { kind: 'failed', error }
    }
  }
}
