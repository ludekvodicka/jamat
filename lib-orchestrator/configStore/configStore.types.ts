/**
 * The owner of one section of `config.json`. A section owns the VALUE of its key and nothing else:
 * the envelope, the unknown top-level keys and every foreign section belong to `ConfigStore`.
 */
export interface ConfigSectionSpec<T> {
  /** The top-level key: `categories`, `ui`. */
  readonly key: string
  /**
   * Lenient read, `undefined` when the key is absent. Total by contract: it never throws, because a
   * section the owner cannot use is reported and replaced by its default rather than latching the
   * whole file over one bad value. What the default must not do is get written back over the value
   * it replaced, which is what `damaged` below is for.
   */
  coerce(value: unknown, report: (message: string) => void): T
  /**
   * Whether the RAW value under this key is damaged rather than merely absent. Optional, and what it
   * buys is the one thing the total `coerce` gives away: an owner that answers `true` is refused its
   * own save, because the value `coerce` handed back is a fallback and writing that fallback would
   * replace a hand-edit the user can still repair. A section that leaves it out is one for which the
   * fallback IS the right reading of whatever it found, so a save over it loses nothing.
   *
   * It says nothing about anybody else's key: a foreign section saves straight through a value this
   * one calls damaged, which is what keeps the refusal narrower than the file-level latch.
   */
  damaged?(value: unknown): boolean
  /** Strict write: `null` when the value may be stored, otherwise the reason it may not. */
  validate(value: T): string | null
}

export type ConfigOpRefusal = {
  ok: false
  /**
   * `config-latched` is the whole file: it does not read, so nothing is written. `section-damaged` is
   * one key: the file reads, every other section still saves, and only this owner is held off its
   * own value. `invalid-section` is neither - the file and the stored value are fine and the OFFERED
   * value is not.
   */
  code: 'config-latched' | 'section-damaged' | 'invalid-section'
  detail: string
}

export type ConfigOpResult = { ok: true } | ConfigOpRefusal
