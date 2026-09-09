import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ConfigStore } from './configStore'
import type { ConfigSectionSpec } from './configStore.types'

describe('lib-orchestrator/configStore/configStore', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface UiValue {
    fontScalePercent: number
  }

  const uiSpec: ConfigSectionSpec<UiValue> = {
    key: 'ui',
    coerce: (value, report) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        if (value !== undefined) report(`ui section is not an object (${JSON.stringify(value)}); using 100 %`)
        return { fontScalePercent: 100 }
      }
      const percent = (value as Partial<UiValue>).fontScalePercent
      if (typeof percent !== 'number') {
        report('ui.fontScalePercent is not a number; using 100 %')
        return { fontScalePercent: 100 }
      }
      return { fontScalePercent: percent }
    },
    validate: (value) => (value.fontScalePercent >= 70 ? null : 'fontScalePercent below 70'),
  }

  const categoriesSpec: ConfigSectionSpec<string[]> = {
    key: 'categories',
    coerce: (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []),
    damaged: (value) => value !== undefined && !Array.isArray(value),
    validate: (value) => (Array.isArray(value) ? null : 'categories must be an array'),
  }

  interface Harness {
    configDir: string
    configFile: string
    snapshotsDirectory: string
    reports: string[]
    store: ConfigStore
  }

  /**
   * `legacySnapshotSection` is what the consumer says about the snapshots this machine took before
   * the ring was split by section: they carry no key in their name, and only whoever wrote them
   * knows whose they are. On this machine that is the catalog, so the tests below hand it over the
   * way `catalogView.ts` and `appHub.ts` do. Omitting it is the other legal answer, and one test
   * below takes it.
   */
  function harness(initial?: unknown, options?: { legacySnapshotSection?: string }): Harness {
    const configDir = mkdtempSync(join(tmpdir(), 'jamat-v3-config-'))
    created.push(configDir)
    const configFile = join(configDir, 'config.json')
    if (initial !== undefined)
      writeFileSync(configFile, typeof initial === 'string' ? initial : JSON.stringify(initial), 'utf8')
    const snapshotsDirectory = join(configDir, 'snapshots')
    const reports: string[] = []
    const store = ConfigStore.load(configDir, {
      snapshotsDirectory,
      report: (message) => reports.push(message),
      legacySnapshotSection: options === undefined ? categoriesSpec.key : options.legacySnapshotSection,
    })
    return { configDir, configFile, snapshotsDirectory, reports, store }
  }

  // A section owns the value of its key and nothing else.
  it('writes only its own key and carries the rest of the document through', () => {
    const { store, configFile } = harness({
      schemaVersion: 1,
      _README: 'copy me',
      categories: ['nodejs'],
      ui: { fontScalePercent: 120 },
    })

    expect(store.saveSection(uiSpec, { fontScalePercent: 130 })).toEqual({ ok: true })

    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({
      schemaVersion: 1,
      _README: 'copy me',
      categories: ['nodejs'],
      ui: { fontScalePercent: 130 },
    })
    expect(store.readSection(categoriesSpec)).toEqual(['nodejs'])
  })

  it('reads a missing file as an empty document and writes nothing to read it', () => {
    const { store, configFile, reports } = harness()

    expect(store.readSection(uiSpec)).toEqual({ fontScalePercent: 100 })
    expect(store.readSection(categoriesSpec)).toEqual([])
    expect(existsSync(configFile)).toBe(false)
    expect(reports).toEqual([])
  })

  // The damaged file and its snapshots are the only copies of the user's own document.
  it('latches on an unreadable file, reports once and never overwrites it', () => {
    const { store, configFile, reports } = harness('{ "schemaVersion": 1, "categories"')
    const rawBefore = readFileSync(configFile, 'utf8')

    expect(store.readSection(uiSpec)).toEqual({ fontScalePercent: 100 })
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatch(/is unreadable/)

    const first = store.saveSection(uiSpec, { fontScalePercent: 120 })
    const second = store.saveSection(categoriesSpec, ['nodejs'])
    expect(first).toEqual({ ok: false, code: 'config-latched', detail: expect.any(String) })
    expect(second.ok).toBe(false)
    expect(reports.filter((message) => message.includes('nothing is written'))).toHaveLength(1)
    expect(readFileSync(configFile, 'utf8')).toBe(rawBefore)
  })

  // One file, one version: a section that ever needs a shape migration does it inside its coerce.
  it('latches on an unsupported schema version the same way', () => {
    const { store, reports } = harness({ schemaVersion: 2, ui: { fontScalePercent: 120 } })

    expect(store.readSection(uiSpec)).toEqual({ fontScalePercent: 100 })
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatch(/unsupported schema version 2/)
    expect(store.saveSection(uiSpec, { fontScalePercent: 120 }))
      .toEqual({ ok: false, code: 'config-latched', detail: expect.any(String) })
  })

  // The latch is about a damaged file. A file that reads again is one the user repaired, and refusing
  // every save for the rest of the session would be refusing over a problem that is gone.
  it('saves again once the file it latched on has been repaired', () => {
    const { store, configFile } = harness('{ "schemaVersion": 1, "categories"')
    expect(store.saveSection(uiSpec, { fontScalePercent: 120 }).ok).toBe(false)

    writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, _README: 'copy me' }), 'utf8')
    const future = new Date(Date.now() + 5_000)
    utimesSync(configFile, future, future)

    expect(store.saveSection(uiSpec, { fontScalePercent: 120 })).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(configFile, 'utf8')))
      .toEqual({ schemaVersion: 1, _README: 'copy me', ui: { fontScalePercent: 120 } })
  })

  // A value one owner cannot use is that owner's business: the file stays readable, and the raw value
  // is safe from every writer but the one that owns it.
  it('coerces a damaged section value without latching and keeps the raw one through a foreign save', () => {
    const { store, configFile, reports } = harness({ schemaVersion: 1, ui: 5, categories: ['nodejs'] })

    expect(store.readSection(uiSpec)).toEqual({ fontScalePercent: 100 })
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatch(/ui section is not an object/)

    expect(store.saveSection(categoriesSpec, ['web'])).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(configFile, 'utf8')))
      .toEqual({ schemaVersion: 1, ui: 5, categories: ['web'] })

    expect(store.saveSection(uiSpec, { fontScalePercent: 120 })).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(configFile, 'utf8')))
      .toEqual({ schemaVersion: 1, ui: { fontScalePercent: 120 }, categories: ['web'] })
  })

  /**
   * The narrow half of the same rule. A section that declares its value damaged is held off its OWN
   * key, because the default its `coerce` handed out is the app's fallback rather than anything the
   * file says - and writing that fallback back would delete a hand-edit nobody can recover.
   */
  it('refuses the owner of a damaged value while every other section saves past it', () => {
    const { store, configFile, snapshotsDirectory } = harness({
      schemaVersion: 1,
      categories: { nodejs: 'Q:/x' },
      _note: 'hand',
    })

    const refused = store.saveSection(categoriesSpec, ['web'])

    expect(refused).toEqual({ ok: false, code: 'section-damaged', detail: expect.any(String) })
    expect(existsSync(snapshotsDirectory)).toBe(false)

    expect(store.saveSection(uiSpec, { fontScalePercent: 120 })).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({
      schemaVersion: 1,
      categories: { nodejs: 'Q:/x' },
      _note: 'hand',
      ui: { fontScalePercent: 120 },
    })
  })

  /**
   * A refusal is said out loud, not only handed back. The editor that asked may be gone by the time
   * the answer arrives - a settings card closed over an in-flight write - and then the returned
   * result reaches nobody, while `report` is what the client turns into an error the window shows.
   */
  it('reports every refusal of a write, not only the latched one', () => {
    const { store, reports } = harness({ schemaVersion: 1, categories: { nodejs: 'Q:/x' } })

    expect(store.saveSection(categoriesSpec, ['web']).ok).toBe(false)
    expect(reports.filter((message) => message.includes('cannot read'))).toHaveLength(1)

    expect(store.saveSection(uiSpec, 'not a ui value' as unknown as UiValue).ok).toBe(false)
    expect(reports.filter((message) => message.includes('was not written'))).toHaveLength(1)
  })

  // The check is on what is on disk, so it lasts exactly as long as the damage does.
  it('saves the section again once its value on disk has been repaired', () => {
    const { store, configFile } = harness({ schemaVersion: 1, categories: 5 })
    expect(store.saveSection(categoriesSpec, ['web']).ok).toBe(false)

    writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, categories: [] }), 'utf8')
    const future = new Date(Date.now() + 5_000)
    utimesSync(configFile, future, future)

    expect(store.saveSection(categoriesSpec, ['web'])).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(configFile, 'utf8')))
      .toEqual({ schemaVersion: 1, categories: ['web'] })
  })

  // A section that declares no `damaged` keeps the old behaviour: its default IS the right reading.
  it('lets a section with no damage rule write over whatever it found', () => {
    const { store, configFile } = harness({ schemaVersion: 1, ui: 'not an object' })

    expect(store.saveSection(uiSpec, { fontScalePercent: 120 })).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(configFile, 'utf8')))
      .toEqual({ schemaVersion: 1, ui: { fontScalePercent: 120 } })
  })

  /** Asking what a save would answer must not spend the one line the latch is reported with. */
  it('answers the same refusal to a question about a save as to the save itself', () => {
    const { store, reports } = harness('{ "schemaVersion": 1, "categories"')

    expect(store.sectionDamage(uiSpec))
      .toEqual({ ok: false, code: 'config-latched', detail: expect.any(String) })
    expect(reports.filter((message) => message.includes('nothing is written'))).toHaveLength(0)

    expect(store.saveSection(uiSpec, { fontScalePercent: 120 }))
      .toEqual({ ok: false, code: 'config-latched', detail: expect.any(String) })
    expect(reports.filter((message) => message.includes('nothing is written'))).toHaveLength(1)
  })

  it('refuses an invalid section instead of storing it, and spends no snapshot on it', () => {
    const { store, configFile, snapshotsDirectory } = harness({ schemaVersion: 1, ui: { fontScalePercent: 100 } })
    const stored = readFileSync(configFile, 'utf8')

    expect(store.saveSection(uiSpec, { fontScalePercent: 10 }))
      .toEqual({ ok: false, code: 'invalid-section', detail: 'fontScalePercent below 70' })
    expect(readFileSync(configFile, 'utf8')).toBe(stored)
    expect(existsSync(snapshotsDirectory)).toBe(false)
  })

  // Last-write-wins makes the ring the only thing between a bad save and a lost config.
  it('spends one snapshot per successful save and keeps the last ten', () => {
    const { store, snapshotsDirectory } = harness({ schemaVersion: 1 })

    expect(store.saveSection(uiSpec, { fontScalePercent: 105 })).toEqual({ ok: true })
    expect(readdirSync(snapshotsDirectory)).toHaveLength(1)

    for (let index = 0; index < 12; index += 1)
      store.saveSection(uiSpec, { fontScalePercent: 100 + index })

    const snapshots = readdirSync(snapshotsDirectory)
    expect(snapshots).toHaveLength(10)
    expect(snapshots.every((name) => name.startsWith('config-1'))).toBe(true)
    expect(snapshots.every((name) => name.includes('-ui-'))).toBe(true)
  })

  /**
   * Ten of the cheapest save in the product must not cost the rarest its recovery points. Moving two
   * sliders and pressing Save is one write of `ui`; a root added on purpose is one write of
   * `categories`, and months of them fit in ten.
   */
  it('keeps ten per section, so a run of one section evicts nothing of another', () => {
    const { store, snapshotsDirectory } = harness({ schemaVersion: 1 })

    expect(store.saveSection(categoriesSpec, ['nodejs'])).toEqual({ ok: true })
    for (let index = 0; index < 10; index += 1)
      store.saveSection(uiSpec, { fontScalePercent: 100 + index })

    const snapshots = readdirSync(snapshotsDirectory)
    expect(snapshots.filter((name) => name.includes('-categories-'))).toHaveLength(1)
    expect(snapshots.filter((name) => name.includes('-ui-'))).toHaveLength(10)
  })

  /**
   * Machines already hold `config-<epochMs>-<uuid>.json`, every one of them a catalog save from
   * before the ring was split. They rotate as the catalog's rather than standing there forever, and
   * nothing deletes them wholesale.
   */
  it('rotates a name written without a section key in with the catalog ones', () => {
    const { store, snapshotsDirectory } = harness({ schemaVersion: 1 })
    mkdirSync(snapshotsDirectory, { recursive: true })
    const legacy = Array.from({ length: 12 }, (_entry, index) =>
      `config-17000000000${(index + 10).toString()}-0e6f2b1a-1234-4321-abcd-0123456789ab.json`)
    for (const name of legacy)
      writeFileSync(join(snapshotsDirectory, name), '{}', 'utf8')

    store.saveSection(uiSpec, { fontScalePercent: 120 })
    expect(readdirSync(snapshotsDirectory).filter((name) => legacy.includes(name)))
      .toHaveLength(12)

    store.saveSection(categoriesSpec, ['nodejs'])

    const kept = readdirSync(snapshotsDirectory)
    // Twelve legacy plus the one just taken, rotated down to the ten newest of that section.
    expect(kept.filter((name) => legacy.includes(name))).toHaveLength(9)
    expect(kept.filter((name) => legacy.includes(name)).sort()).toEqual(legacy.slice(3))
    expect(kept.filter((name) => name.includes('-categories-'))).toHaveLength(1)
    expect(kept.filter((name) => name.includes('-ui-'))).toHaveLength(1)
  })

  /*
   * The other legal answer, and the reason the store no longer knows one consumer's section by name:
   * a product that never wrote a key-less snapshot claims none of them. They belong to no ring and
   * rotate on their own, which is what a fresh machine sees anyway - and the ring of the section
   * being written is unaffected either way.
   */
  it('leaves the key-less names alone when nobody claims them', () => {
    const { store, snapshotsDirectory } = harness({ schemaVersion: 1 }, {})
    mkdirSync(snapshotsDirectory, { recursive: true })
    const legacy = Array.from({ length: 12 }, (_entry, index) =>
      `config-17000000000${(index + 10).toString()}-0e6f2b1a-1234-4321-abcd-0123456789ab.json`)
    for (const name of legacy)
      writeFileSync(join(snapshotsDirectory, name), '{}', 'utf8')

    store.saveSection(categoriesSpec, ['nodejs'])

    const kept = readdirSync(snapshotsDirectory)
    expect(kept.filter((name) => legacy.includes(name))).toHaveLength(12)
    expect(kept.filter((name) => name.includes('-categories-'))).toHaveLength(1)
  })

  // The report reaches the user as an error, and the catalog is read once per project listing.
  it('reports damage in a section once per read of the file, not once per readSection', () => {
    const { store, configFile, reports } = harness({ schemaVersion: 1, ui: 'not an object' })

    expect(store.readSection(uiSpec)).toEqual({ fontScalePercent: 100 })
    store.readSection(uiSpec)
    store.readSection(uiSpec)
    expect(reports).toHaveLength(1)

    writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, ui: 'still not an object' }), 'utf8')
    const later = new Date()
    utimesSync(configFile, later, later)

    expect(store.readSection(uiSpec)).toEqual({ fontScalePercent: 100 })
    expect(reports).toHaveLength(2)
  })

  // Saving without a recovery point is exactly what the ring exists to prevent.
  it('refuses to save when it was loaded read-only', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'jamat-v3-config-ro-'))
    created.push(configDir)
    const store = ConfigStore.load(configDir)
    expect(() => store.saveSection(uiSpec, { fontScalePercent: 100 })).toThrow(/read-only/)
  })
})
