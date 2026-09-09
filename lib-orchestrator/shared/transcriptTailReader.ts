import { FileTail } from './fileTail'

/**
 * What the cache key is made of. Three fields, and they are the whole invalidation: a rewrite, a
 * truncation, a rotation and a fresh file at the same path all move the mtime or the size.
 *
 * Named structurally rather than imported: this base has no business knowing that the thing which
 * resolves one is the project manager's transcript view, and `shared/` naming a subsystem's type
 * would point the dependency the wrong way.
 */
export interface TranscriptTailRef {
  file: string
  mtimeMs: number
  size: number
}

export interface TranscriptTailContent {
  content: string
  scannedBytes: number
  startedAtFileBeginning: boolean
}

/**
 * Reading one session's transcript tail, cached by the stat the resolver already had to take.
 *
 * Two readers do this - what a session is RUNNING on, and what it last SAID - and they held the same
 * fifty lines twice: the cache record, the sixteen-entry cap, the stat key, the delete-then-set touch
 * and the eviction. When the model reader's key gained a salt, the other one was left behind, and
 * nothing failed.
 *
 * The two cache INSTANCES stay separate, which is the reason `CLAUDE.md` gives for two subsystem
 * roots: the two answer different questions off the same file and neither wants the other's entry.
 * A subclass gets its own map by being its own object. What is shared is the mechanism.
 *
 * Nothing here follows the file. A reading is the tail retold from scratch, which is what makes a
 * poll over an ended session free: the file has not moved, so it is never opened again.
 */
export abstract class TranscriptTailReader<TContext, TReading, TRef extends TranscriptTailRef> {
  /** Sixteen: the tabs one window can hold open, near enough, and each is one small reading. */
  private static readonly maxCacheEntriesConst = 16

  private readonly cache = new Map<string, { key: string; reading: TReading }>()

  static async file(
    ref: Pick<TranscriptTailRef, 'file' | 'size'>,
    maxBytes: number,
  ): Promise<TranscriptTailContent> {
    const reading = await FileTail.readBounded(ref.file, ref.size, maxBytes)
    return {
      content: reading.content,
      scannedBytes: reading.bytesRead,
      startedAtFileBeginning: reading.startedAtFileBeginning,
    }
  }

  protected constructor(
    private readonly resolveRef: (context: TContext) => Promise<TRef | null>,
  ) {}

  /** What this reader answers where no transcript resolves at all. */
  protected abstract missing(): TReading

  /**
   * Anything the STAT cannot see, as a string that joins the key. Empty where the file is the whole
   * input; Claude's effort lives in settings files the transcript knows nothing about, so without it
   * an ended session would keep drawing the effort it had at its last turn.
   */
  protected abstract saltOf(context: TContext): Promise<string>

  protected abstract readFrom(ref: TRef, context: TContext): Promise<TReading>

  protected cacheable(_reading: TReading): boolean {
    return true
  }

  protected async readTail(context: TContext): Promise<TReading> {
    const ref = await this.resolveRef(context)
    if (ref === null) return this.missing()
    const key = `${ref.file}\0${ref.mtimeMs}\0${ref.size}\0${await this.saltOf(context)}`
    let entry = this.cache.get(ref.file)
    if (!entry || entry.key !== key) {
      const reading = await this.readFrom(ref, context)
      if (!this.cacheable(reading)) {
        this.cache.delete(ref.file)
        return reading
      }
      entry = { key, reading }
      // Delete then set: the map's own order is the LRU order, and re-setting an existing key would
      // leave it where it was rather than at the young end.
      this.cache.delete(ref.file)
      this.cache.set(ref.file, entry)
      while (this.cache.size > TranscriptTailReader.maxCacheEntriesConst)
        this.cache.delete(this.cache.keys().next().value!)
    }
    return entry.reading
  }
}
