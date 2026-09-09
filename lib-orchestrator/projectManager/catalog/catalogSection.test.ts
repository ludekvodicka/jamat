import { describe, expect, it } from 'vitest'

import type { CatalogCategoryDto } from '../projectManagerApi.types'
import { CatalogSection } from './catalogSection'

describe('lib-orchestrator/projectManager/catalog/catalogSection', () => {
  const nodejs = { id: 'nodejs', label: 'NodeJs', path: 'C:/Projects/NodeJs' }

  function categoriesOf(...entries: Record<string, unknown>[]): CatalogCategoryDto[] {
    return entries as unknown as CatalogCategoryDto[]
  }

  function coerce(value: unknown): { categories: CatalogCategoryDto[]; reports: string[] } {
    const reports: string[] = []
    return {
      categories: CatalogSection.spec.coerce(value, (message) => reports.push(message)),
      reports,
    }
  }

  it('owns the categories key and nothing else', () => {
    expect(CatalogSection.spec.key).toBe('categories')
  })

  it('reads an absent key as no roots at all, without a word', () => {
    expect(coerce(undefined)).toEqual({ categories: [], reports: [] })
  })

  /**
   * The section contract asks for a total coercion: a `categories` key that is not a list is this
   * owner's problem and nobody else's, so it is said out loud and the rest of the file stays
   * readable rather than the whole document latching over it.
   */
  it('reads a key that is not a list as no roots, out loud', () => {
    const read = coerce({ nodejs: 'C:/Projects/NodeJs' })

    expect(read.categories).toEqual([])
    expect(read.reports).toHaveLength(1)
    expect(read.reports[0]).toMatch(/not a list/)
  })

  /**
   * The other half of that decision: the empty list is what the app DRAWS, never what it writes
   * back. A `categories` key that is present and not a list is damage, so this owner is held off its
   * own save until somebody repairs it, while every foreign section writes straight past it.
   */
  it('calls a present non-list damaged, and nothing else', () => {
    const damaged = CatalogSection.spec.damaged
    if (!damaged) throw new Error('The catalog section must declare its own damage')

    expect(damaged({ nodejs: 'C:/Projects/NodeJs' })).toBe(true)
    expect(damaged(5)).toBe(true)
    expect(damaged('C:/Projects/NodeJs')).toBe(true)
    expect(damaged(null)).toBe(true)
    // A fresh machine has no key at all, and a list holding one unusable entry drops that entry
    // aloud - the roots beside it are exactly what the file says.
    expect(damaged(undefined)).toBe(false)
    expect(damaged([])).toBe(false)
    expect(damaged([nodejs, { id: 'broken' }])).toBe(false)
  })

  it('drops an unusable category aloud and keeps the rest', () => {
    const read = coerce([nodejs, { id: 'broken', label: 'Broken' }])

    expect(read.categories).toEqual([nodejs])
    expect(read.reports).toHaveLength(1)
    expect(read.reports[0]).toMatch(/dropping a category \(category broken: path/)
  })

  it('drops the second of two roots that share an id', () => {
    const read = coerce([nodejs, { ...nodejs, label: 'Second' }])

    expect(read.categories).toEqual([nodejs])
    expect(read.reports[0]).toMatch(/duplicate category id nodejs/)
  })

  /** The file is edited by hand and by future builds; a key this build cannot name is still theirs. */
  it('carries a key it does not know through the read untouched', () => {
    const read = coerce([{ ...nodejs, _README_id: 'stable', futureCategoryKey: 42 }])

    expect(read.categories[0]['futureCategoryKey']).toBe(42)
    expect(read.reports).toEqual([])
  })

  it('accepts a list every rule is happy with', () => {
    expect(CatalogSection.spec.validate(categoriesOf({
      ...nodejs,
      hiddenFolders: ['node_modules'],
      flattenFolders: ['Plugins'],
      virtualFolders: [{ prefix: 'temporary', title: 'Temporary' }],
      afterCreate: { command: 'svn', args: ['add', '{dir}'] },
    }))).toBeNull()
  })

  // A write is strict where a read is lenient: coercing a bad write would quietly replace what the
  // user meant to store.
  it('names the rule a write broke instead of dropping the root', () => {
    const cases: [string, CatalogCategoryDto[], RegExp][] = [
      ['not a list', 'nope' as unknown as CatalogCategoryDto[], /must be an array/],
      ['empty id', categoriesOf({ ...nodejs, id: '  ' }), /id must be a non-empty string/],
      ['no label', categoriesOf({ ...nodejs, label: '' }), /label must be a non-empty string/],
      ['no path', categoriesOf({ ...nodejs, path: '' }), /path must be a non-empty string/],
      ['duplicate id', categoriesOf(nodejs, { ...nodejs, label: 'Second' }), /duplicate category id/],
      [
        'bad hiddenFolders',
        categoriesOf({ ...nodejs, hiddenFolders: 'node_modules' }),
        /hiddenFolders must be an array of non-empty strings/,
      ],
      [
        'bad virtualFolder',
        categoriesOf({ ...nodejs, virtualFolders: [{ prefix: 'x' }] }),
        /needs a non-empty prefix and title/,
      ],
      [
        'bad afterCreate',
        categoriesOf({ ...nodejs, afterCreate: { args: ['add'] } }),
        /afterCreate.command must be a non-empty string/,
      ],
      [
        'bad afterCreate args',
        categoriesOf({ ...nodejs, afterCreate: { command: 'svn', args: [7] } }),
        /afterCreate.args must be an array of strings/,
      ],
    ]
    for (const [name, value, reason] of cases)
      expect(CatalogSection.spec.validate(value), name).toMatch(reason)
  })
})
