import { JsonShape } from '../shared/jsonShape'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { AtomicJsonFile } from '../shared/atomicJsonFile'
import { ErrorText } from '../shared/errorText'
import type { ConfigOpRefusal, ConfigOpResult, ConfigSectionSpec } from './configStore.types'

/** The document as it sits on disk: the envelope, plus whatever keys the file happens to carry. */
type RawDocument = { schemaVersion: 1 } & Record<string, unknown>

export interface ConfigStoreOptions {
  /** Where the ten recovery points live. Without it the store is read-only, see `saveSection`. */
  snapshotsDirectory?: string
  report?: (message: string) => void
  /**
   * Which section OWNS the snapshots this machine took before the ring was split by section. They
   * carry no key in their name, and only the consumer that wrote them knows which section they are.
   *
   * Passed in rather than known here: this store's own contract is that a section owns its key and
   * nothing else, and it used to hold `'categories'` - one consumer's section name - as a constant.
   * A second product on this store would have inherited a ring where every key-less file counted as
   * a section it does not have. Absent means the key-less ones belong to nobody and rotate on their
   * own, which is what a fresh machine sees anyway.
   */
  legacySnapshotSection?: string
}

/**
 * The one writer over `<configDir>/config.json`, shared by every section owner.
 *
 * A save merges the owner's single key into the RAW document read off disk, so unknown keys and
 * foreign sections survive it untouched. Passing the coerced view through instead would let a write
 * of one section launder another section's hand-edited value through that other section's coercion.
 *
 * The latch is file-level: unparsable JSON, a document that is not an object, and an unsupported
 * schema version stop every save until the file reads again. A section value its owner cannot use
 * does not latch anything - the owner reports it and falls back to its default, while the raw value
 * stays on disk for whoever wrote it there. What it does stop is that owner's OWN save, through
 * `ConfigSectionSpec.damaged`: the fallback is not what the file holds, and writing it back would
 * throw away a hand-edit nobody could recover. Reading never writes, here as in every store in this
 * library: a damaged file is the user's own document and is left exactly as it is.
 *
 * There is no compare-and-swap. Concurrent edits are last-write-wins by decision, which makes the
 * snapshot ring the only thing standing between a bad save and a lost config, so every successful
 * save takes one - a copy of the whole file, so one section's recovery point holds every other
 * section too. The ring is kept PER SECTION, because the sections are saved at wildly different
 * rates: ten of the cheapest save in the product would otherwise push out ten of the rarest, and the
 * catalog's last good copy would be gone after an afternoon of moving a font slider. The file is
 * meant to be edited by hand while the app runs, so the read path re-reads whenever its mtime moved.
 */
export class ConfigStore {
  private static readonly configFileNameConst = 'config.json'
  private static readonly snapshotKeepConst = 10
  /** The section key is optional in the name: see `snapshotSectionOf` for the ones written without it. */
  private static readonly snapshotPatternConst =
    /^config-\d+-(?:([A-Za-z0-9_-]+)-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/
  private raw: RawDocument | null = null
  private readonly coerced = new Map<string, unknown>()
  private loadedMtimeMs = -1
  private readFailed = false
  private refusalReported = false

  private constructor(
    private readonly configFile: string,
    private readonly snapshotsDirectory: string | null,
    private readonly report: (message: string) => void,
    private readonly legacySnapshotSection: string | null,
  ) {}

  /** A missing file is an empty document, never an error: a fresh machine has no config.json at all. */
  static load(configDir: string, options?: ConfigStoreOptions): ConfigStore {
    return new ConfigStore(
      join(configDir, ConfigStore.configFileNameConst),
      options?.snapshotsDirectory ?? null,
      options?.report ?? ((message) => console.warn(message)),
      options?.legacySnapshotSection ?? null,
    )
  }

  /**
   * Synchronous by contract: the sessions tree builds its roots before it has anywhere to await.
   *
   * The coerced value is held until the file is read again, and that is about the REPORT, not the
   * cost: an owner that cannot use what it finds says so through `report`, which reaches the user as
   * an error, and a section read once per listing would repeat that line for as long as the damage
   * sits in the file. Callers share the value and must not mutate it - hand out `structuredClone` if
   * the caller edits.
   */
  readSection<T>(spec: ConfigSectionSpec<T>): T {
    const raw = this.currentRaw()
    if (this.coerced.has(spec.key)) return this.coerced.get(spec.key) as T
    const value = spec.coerce(raw[spec.key], this.report)
    this.coerced.set(spec.key, value)
    return value
  }

  /**
   * The refusal a save of this section would answer with over what is on disk right now, or null
   * when nothing stands in its way. It lives here rather than in the owner because the sentence is
   * the store's: an EDITOR of a section has to say why the value it was handed is not what the file
   * holds, and the same words have to come back out of the save it then refuses.
   */
  sectionDamage<T>(spec: ConfigSectionSpec<T>): ConfigOpRefusal | null {
    const raw = this.currentRaw()
    if (this.readFailed) return this.latchedRefusal()
    if (spec.damaged?.(raw[spec.key]) !== true) return null
    return {
      ok: false,
      code: 'section-damaged',
      detail: `The ${spec.key} section of ${this.configFile} holds a value its owner cannot read; `
        + 'nothing is written over it until it is repaired by hand',
    }
  }

  /**
   * Synchronous body, and that is what serializes two sections: neither write can interleave with
   * the other, and a second one failing leaves the first validly on disk.
   */
  saveSection<T>(spec: ConfigSectionSpec<T>, value: T): ConfigOpResult {
    if (!this.snapshotsDirectory)
      throw new Error('ConfigStore was loaded read-only: saving needs a snapshots directory')
    const damaged = this.sectionDamage(spec)
    if (damaged) {
      // Said over a write and not over a question about one: an editor asking what state the file is
      // in has not asked for anything to be written, so it must not spend the one line the latch gets.
      if (damaged.code === 'config-latched') this.reportRefusal()
      else this.report(damaged.detail)
      return damaged
    }
    const invalid = spec.validate(value)
    if (invalid) {
      this.report(`The ${spec.key} of ${this.configFile} was not written: ${invalid}`)
      return { ok: false, code: 'invalid-section', detail: invalid }
    }
    const next: RawDocument = { ...this.currentRaw(), schemaVersion: 1, [spec.key]: value }
    AtomicJsonFile.ensureDirectory(dirname(this.configFile))
    this.snapshotCurrent(spec.key)
    AtomicJsonFile.write(this.configFile, next)
    this.raw = structuredClone(next)
    this.coerced.clear()
    this.loadedMtimeMs = ConfigStore.mtimeOf(this.configFile)
    return { ok: true }
  }

  /**
   * Reading is synchronous because `readSection` is, and a config file is small. The rule against
   * synchronous I/O in this process is about the provider stores, which are gigabytes.
   */
  private currentRaw(): RawDocument {
    const mtimeMs = ConfigStore.mtimeOf(this.configFile)
    if (this.raw && mtimeMs === this.loadedMtimeMs)
      return this.raw
    this.raw = this.readRaw()
    this.coerced.clear()
    this.loadedMtimeMs = mtimeMs
    return this.raw
  }

  private static emptyDocument(): RawDocument {
    return { schemaVersion: 1 }
  }

  private static mtimeOf(file: string): number {
    try { return statSync(file).mtimeMs }
    catch { return -1 }
  }

  private readRaw(): RawDocument {
    if (!existsSync(this.configFile)) return this.readable(ConfigStore.emptyDocument())
    try {
      return this.readable(ConfigStore.parseEnvelope(readFileSync(this.configFile, 'utf8')))
    } catch (error) {
      this.readFailed = true
      this.report(
        `Config at ${this.configFile} is unreadable (${ErrorText.of(error)}); starting from an empty document`,
      )
      return ConfigStore.emptyDocument()
    }
  }

  /**
   * The latch protects a damaged file from being overwritten, so it lasts exactly as long as the
   * damage does: a file that reads again is one the user repaired, and refusing every save for the
   * rest of the session would be refusing over a problem that is gone.
   */
  private readable(raw: RawDocument): RawDocument {
    this.readFailed = false
    this.refusalReported = false
    return raw
  }

  /** File-level damage only. Every key beyond the envelope is a section's business, not the store's. */
  private static parseEnvelope(text: string): RawDocument {
    const document = JsonShape.record(JSON.parse(text))
    if (document === null) throw new Error('expected an object')
    if (document.schemaVersion !== 1)
      throw new Error(`unsupported schema version ${JSON.stringify(document.schemaVersion)}`)
    return { ...document, schemaVersion: 1 }
  }

  private latchedRefusal(): ConfigOpRefusal {
    return {
      ok: false,
      code: 'config-latched',
      detail: `Config at ${this.configFile} is unreadable; nothing is written until it is repaired`,
    }
  }

  /** Reported once: a latched config would otherwise repeat the same line on every section save. */
  private reportRefusal(): void {
    if (this.refusalReported) return
    this.refusalReported = true
    this.report(
      `Config at ${this.configFile} was unreadable; nothing is written until it is repaired`,
    )
  }

  /**
   * The timestamp stays FIRST and the section key goes after it, so the lexicographic sort the
   * rotation runs on is still the chronological one within a key.
   */
  private snapshotCurrent(key: string): void {
    if (!this.snapshotsDirectory || !existsSync(this.configFile)) return
    try {
      AtomicJsonFile.ensureDirectory(this.snapshotsDirectory)
      // Random tie-break, not a counter: a per-process counter restarts at zero every run, so two
      // runs snapshotting in the same millisecond overwrite each other's recovery point.
      copyFileSync(
        this.configFile,
        join(this.snapshotsDirectory, `config-${Date.now()}-${key}-${randomUUID()}.json`),
      )
      this.rotateSnapshots(key)
    } catch (error) {
      this.report(`Config snapshot failed: ${ErrorText.of(error)}`)
    }
  }

  /** Only this key's own copies are counted, and only they are ever deleted. */
  private rotateSnapshots(key: string): void {
    if (!this.snapshotsDirectory) return
    const names = readdirSync(this.snapshotsDirectory)
      .filter((name) => this.snapshotSectionOf(name) === key)
      .sort()
    for (const name of names.slice(0, Math.max(0, names.length - ConfigStore.snapshotKeepConst)))
      unlinkSync(join(this.snapshotsDirectory, name))
  }

  /**
   * Which section a snapshot file belongs to, or null when the name is none of ours. A name without
   * a key in it is one this machine already had, and whose section it is is the CONSUMER's to say -
   * see `legacySnapshotSection` on the options. Reading it as that consumer's is what keeps those
   * copies in a ring that rotates rather than in a pile that grows for ever; with nobody claiming
   * them they belong to no ring, which is what a fresh machine sees anyway.
   *
   * The uuid cannot be mistaken for a key: it carries four hyphens of its own, so a key split off
   * the front of it would leave too few for the remainder to still be a uuid.
   */
  private snapshotSectionOf(name: string): string | null {
    const match = ConfigStore.snapshotPatternConst.exec(name)
    if (!match) return null
    return match[1] ?? this.legacySnapshotSection
  }
}
