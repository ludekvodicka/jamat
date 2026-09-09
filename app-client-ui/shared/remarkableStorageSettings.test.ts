import { describe, expect, it } from 'vitest'

import { RemarkableStorageSettings } from './remarkableStorageSettings'

describe('app-client-ui/shared/remarkableStorageSettings', () => {
  it('reads an absent section as global storage with the default folder', () => {
    const reports: string[] = []
    expect(RemarkableStorageSettings.coerce(undefined, (message) => reports.push(message)))
      .toEqual({ scope: 'global', projectDirectory: '.remarkable' })
    expect(reports).toEqual([])
    expect(RemarkableStorageSettings.isDamaged(undefined)).toBe(false)
  })

  it('keeps a usable value and reports each unusable field once', () => {
    const kept = { scope: 'project', projectDirectory: '.aidocs/remarkable' }
    expect(RemarkableStorageSettings.coerce(kept, () => undefined)).toEqual(kept)

    const reports: string[] = []
    expect(RemarkableStorageSettings.coerce(
      { scope: 'somewhere', projectDirectory: 'C:/elsewhere' },
      (message) => reports.push(message),
    )).toEqual({ scope: 'global', projectDirectory: '.remarkable' })
    expect(reports).toHaveLength(2)
    expect(RemarkableStorageSettings.isDamaged({ scope: 'somewhere' })).toBe(true)
  })

  /**
   * The main process joins this fragment onto a directory it chose itself, so everything a fragment
   * could use to leave that directory is refused here rather than detected after the join.
   */
  it('refuses every folder that could point outside the project', () => {
    const refused = [
      '',
      '/absolute',
      '\\absolute',
      'C:/drive',
      'C:drive',
      '../sibling',
      'inside/../../outside',
      './here',
      'double//step',
      'trailing/',
      ' leading',
      'trailing ',
      'name.',
      'stream:name',
      'star*',
      'question?',
      'quote"',
      'pipe|',
      'less<',
      'more>',
      `control${String.fromCharCode(7)}`,
      'x'.repeat(201),
    ]

    for (const value of refused)
      expect(RemarkableStorageSettings.projectDirectoryProblem(value), value).not.toBeNull()
    for (const value of ['.remarkable', '.aidocs/remarkable', 'docs\\pages', 'a/b/c'])
      expect(RemarkableStorageSettings.projectDirectoryProblem(value), value).toBeNull()
  })

  it('never lets an invalid value out of the coercer', () => {
    for (const value of [null, [], 'text', 7, { scope: 3, projectDirectory: {} }])
      expect(RemarkableStorageSettings.isValid(RemarkableStorageSettings.coerce(value, () => undefined)))
        .toBe(true)
  })
})
