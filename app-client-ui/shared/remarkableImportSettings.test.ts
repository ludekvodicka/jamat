import { describe, expect, it } from 'vitest'

import { RemarkableImportSettings } from './remarkableImportSettings'

describe('app-client-ui/shared/remarkableImportSettings', () => {
  it('reads an absent section as not previewing by itself', () => {
    const reports: string[] = []
    expect(RemarkableImportSettings.coerce(undefined, (message) => reports.push(message)))
      .toEqual({ autoPreviewOnOpen: false })
    expect(reports).toEqual([])
    expect(RemarkableImportSettings.isDamaged(undefined)).toBe(false)
  })

  it('keeps a boolean and reports anything else once', () => {
    expect(RemarkableImportSettings.coerce({ autoPreviewOnOpen: true }, () => undefined))
      .toEqual({ autoPreviewOnOpen: true })

    const reports: string[] = []
    expect(RemarkableImportSettings.coerce(
      { autoPreviewOnOpen: 'yes' },
      (message) => reports.push(message),
    )).toEqual({ autoPreviewOnOpen: false })
    expect(reports).toHaveLength(1)
    expect(RemarkableImportSettings.isDamaged({ autoPreviewOnOpen: 'yes' })).toBe(true)
  })

  /** Reads are lenient and writes are strict, the asymmetry every settings module here uses. */
  it('refuses a write that is not one boolean', () => {
    expect(RemarkableImportSettings.isValid({ autoPreviewOnOpen: false })).toBe(true)
    expect(RemarkableImportSettings.isValid({})).toBe(false)
    expect(RemarkableImportSettings.isValid({ autoPreviewOnOpen: 1 })).toBe(false)
    expect(RemarkableImportSettings.isValid([])).toBe(false)
    expect(RemarkableImportSettings.isValid(null)).toBe(false)
  })

  /** An unreadable section is not damage: it is read as the default and rewritten on the next save. */
  it('calls a section damaged only when it holds an unusable flag', () => {
    expect(RemarkableImportSettings.isDamaged({ autoPreviewOnOpen: true })).toBe(false)
    expect(RemarkableImportSettings.isDamaged({})).toBe(false)
    expect(RemarkableImportSettings.isDamaged('on')).toBe(true)
  })
})
