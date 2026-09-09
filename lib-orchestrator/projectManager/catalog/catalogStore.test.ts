import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ConfigStore } from '../../configStore/configStore'
import type { CatalogCategoryDto } from '../projectManagerApi.types'
import { CatalogStore } from './catalogStore'

describe('lib-orchestrator/projectManager/catalog/catalogStore', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface Harness {
    configDir: string
    configFile: string
    reports: string[]
    store: CatalogStore
  }

  function harness(initial?: unknown): Harness {
    const configDir = mkdtempSync(join(tmpdir(), 'jamat-v3-catalog-'))
    created.push(configDir)
    const configFile = join(configDir, 'config.json')
    if (initial !== undefined)
      writeFileSync(configFile, typeof initial === 'string' ? initial : JSON.stringify(initial), 'utf8')
    const reports: string[] = []
    const store = new CatalogStore(ConfigStore.load(configDir, {
      snapshotsDirectory: join(configDir, 'snapshots'),
      report: (message) => reports.push(message),
    }))
    return { configDir, configFile, reports, store }
  }

  function documentWith(...categories: Record<string, unknown>[]): Record<string, unknown> {
    return { schemaVersion: 1, categories }
  }

  function categoriesOf(...entries: Record<string, unknown>[]): CatalogCategoryDto[] {
    return entries as unknown as CatalogCategoryDto[]
  }

  const nodejs = { id: 'nodejs', label: 'NodeJs', path: 'C:/Projects/NodeJs' }

  /** The editor's read answers a domain result; this is the value inside an accepted one. */
  async function editedBy(store: CatalogStore): Promise<CatalogCategoryDto[]> {
    const read = await store.getCategories()
    if (!read.ok) throw new Error(`Expected an accepted read, got ${read.code}`)
    return read.value
  }

  it('reads a missing file as an empty catalog without complaining', async () => {
    const { store, reports } = harness()
    expect(store.categories()).toEqual([])
    expect(await store.getCategories()).toEqual({ ok: true, value: [] })
    expect(reports).toEqual([])
  })

  it('exposes only id, label and path through the reading contract', () => {
    const { store } = harness(documentWith({ ...nodejs, hiddenFolders: ['node_modules'] }))
    expect(store.categories()).toEqual([nodejs])
  })

  // The rules themselves are the section's; what this proves is that the section's voice reaches
  // whoever the store was built to report to.
  it('says out loud which category it dropped on the way in', () => {
    const { store, reports } = harness(documentWith(nodejs, { id: 'broken', label: 'Broken' }))
    expect(store.categories()).toEqual([nodejs])
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatch(/dropping a category/)
  })

  // The damaged file and its snapshots are the only copies of the user's own document.
  it('answers a latched file with the code the wire has always carried', async () => {
    const { store, configFile, reports } = harness('{ "schemaVersion": 1, "categories"')
    const rawBefore = readFileSync(configFile, 'utf8')

    expect(store.categories()).toEqual([])
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatch(/is unreadable/)

    const first = await store.saveCategories(categoriesOf(nodejs))
    const second = await store.saveCategories(categoriesOf(nodejs))
    expect(first).toEqual({ ok: false, code: 'catalog-latched', detail: expect.any(String) })
    expect(second.ok).toBe(false)
    expect(reports.filter((message) => message.includes('nothing is written'))).toHaveLength(1)
    expect(readFileSync(configFile, 'utf8')).toBe(rawBefore)
  })

  it('saves again once the file it latched on has been repaired', async () => {
    const { store, configFile } = harness('{ "schemaVersion": 1, "categories"')
    expect((await store.saveCategories(categoriesOf(nodejs))).ok).toBe(false)

    writeFileSync(configFile, JSON.stringify(documentWith(nodejs)), 'utf8')
    const future = new Date(Date.now() + 5_000)
    utimesSync(configFile, future, future)

    const repaired = categoriesOf({ ...nodejs, label: 'Repaired' })
    expect(await store.saveCategories(repaired)).toEqual({ ok: true, value: undefined })
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual(documentWith(...repaired))
  })

  // The comment on the read path promises the caller owns what it gets.
  it('hands out a copy of the roots, not the ones it holds', async () => {
    const { store } = harness(documentWith(nodejs))

    const categories = await editedBy(store)
    categories[0].label = 'edited but never saved'
    categories.push({ id: 'sneaked', label: 'Sneaked', path: 'Q:/Sneaked' })

    expect(store.categories()).toEqual([nodejs])
    expect(await editedBy(store)).toEqual([nodejs])
  })

  /**
   * What the migration to a section bought: the catalog writes one key, and everything the file
   * holds beside it - a hand-written note, a section belonging to somebody else - is not this
   * writer's to touch. A key inside a category is still the catalog's own, and still survives.
   */
  it('writes the categories key alone and leaves the rest of the file where it was', async () => {
    const { store, configFile } = harness({
      schemaVersion: 1,
      _README: 'copy me',
      ui: { fontScalePercent: 130 },
      categories: [nodejs],
    })

    const saved = await store.saveCategories(
      categoriesOf({ ...nodejs, label: 'Renamed', _README_id: 'stable', futureCategoryKey: 42 }),
    )

    expect(saved).toEqual({ ok: true, value: undefined })
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({
      schemaVersion: 1,
      _README: 'copy me',
      ui: { fontScalePercent: 130 },
      categories: [{ ...nodejs, label: 'Renamed', _README_id: 'stable', futureCategoryKey: 42 }],
    })
    expect((await editedBy(store))[0]['futureCategoryKey']).toBe(42)
  })

  /**
   * The file parses, so the store is not latched and every other section still saves. What may not
   * happen is this owner writing an empty list over a `categories` value somebody hand-edited.
   */
  it('refuses to write over its own damaged value, under its own code', async () => {
    const { store, configFile } = harness({
      schemaVersion: 1,
      categories: { nodejs: 'C:/Projects/NodeJs' },
      _note: 'hand',
    })
    const stored = readFileSync(configFile, 'utf8')

    const refused = await store.saveCategories(categoriesOf(nodejs))

    expect(refused).toEqual({ ok: false, code: 'catalog-damaged', detail: expect.any(String) })
    expect(refused.ok ? '' : refused.detail).toMatch(/repaired by hand/)
    expect(readFileSync(configFile, 'utf8')).toBe(stored)
  })

  // The empty list is the app's fallback, not what the file says, and the tab that showed it would
  // have the user add a root and save over the ones on disk.
  it('refuses the editor read of a damaged value instead of answering no roots', async () => {
    const { store } = harness({ schemaVersion: 1, categories: 5 })

    expect(store.categories()).toEqual([])
    expect(await store.getCategories())
      .toEqual({ ok: false, code: 'catalog-damaged', detail: expect.any(String) })
  })

  it('reads and saves again once the damaged value has been repaired', async () => {
    const { store, configFile } = harness({ schemaVersion: 1, categories: 5, _note: 'hand' })
    expect((await store.saveCategories(categoriesOf(nodejs))).ok).toBe(false)

    writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, categories: [], _note: 'hand' }), 'utf8')
    const future = new Date(Date.now() + 5_000)
    utimesSync(configFile, future, future)

    expect(await editedBy(store)).toEqual([])
    expect(await store.saveCategories(categoriesOf(nodejs))).toEqual({ ok: true, value: undefined })
    expect(JSON.parse(readFileSync(configFile, 'utf8')))
      .toEqual({ schemaVersion: 1, categories: [nodejs], _note: 'hand' })
  })

  it('refuses an invalid list under the code the wire has always carried', async () => {
    const { store, configFile } = harness(documentWith(nodejs))
    const stored = readFileSync(configFile, 'utf8')

    const refused = await store.saveCategories(categoriesOf(nodejs, { ...nodejs, label: 'Second' }))

    expect(refused).toEqual({
      ok: false,
      code: 'invalid-config',
      detail: 'duplicate category id nodejs',
    })
    expect(readFileSync(configFile, 'utf8')).toBe(stored)
  })

  // The file is meant to be edited by hand while the app runs.
  it('re-reads the file after it changed on disk', async () => {
    const { store, configFile } = harness(documentWith(nodejs))
    expect(store.categories()).toEqual([nodejs])

    const replacement = { id: 'web', label: 'Web', path: 'C:/Projects/Web' }
    writeFileSync(configFile, JSON.stringify(documentWith(replacement)), 'utf8')
    const future = new Date(Date.now() + 5_000)
    utimesSync(configFile, future, future)

    expect(await editedBy(store)).toEqual([replacement])
    expect(store.categories()).toEqual([replacement])
  })

  it('builds a runtime category with lookup sets and a comparable root', () => {
    const { store } = harness(documentWith({
      ...nodejs,
      hiddenFolders: ['node_modules'],
      flattenFolders: ['Plugins'],
    }))
    const category = store.runtimeCategory('nodejs')
    expect(category?.hiddenFolders.has('node_modules')).toBe(true)
    expect(category?.flattenFolders.has('Plugins')).toBe(true)
    expect(category?.path).toBe('C:/Projects/NodeJs')
    expect(store.runtimeCategory('missing')).toBeNull()
  })

  // Saving without a recovery point is exactly what the ring exists to prevent, and the store it
  // was handed is what refuses: a read-only one reaches nothing this class can soften.
  it('lets a read-only store refuse the save on its own terms', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'jamat-v3-catalog-ro-'))
    created.push(configDir)
    const store = new CatalogStore(ConfigStore.load(configDir))
    await expect(store.saveCategories(categoriesOf(nodejs))).rejects.toThrow(/read-only/)
  })
})
