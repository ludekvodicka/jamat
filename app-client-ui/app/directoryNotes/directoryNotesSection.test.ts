import { describe, expect, it } from 'vitest'

import type { DirectoryNote } from '../../shared/directoryNotes'
import { DirectoryNotesSection } from './directoryNotesSection'

describe('app-client-ui/app/directoryNotes/directoryNotesSection', () => {
  it('owns directoryNotes and reads a missing key as no notes', () => {
    expect(DirectoryNotesSection.spec.key).toBe('directoryNotes')
    expect(DirectoryNotesSection.spec.coerce(undefined, () => {})).toEqual({})
  })

  it('calls a broken shape damaged, so the store refuses to write over it', () => {
    expect(DirectoryNotesSection.spec.damaged?.(undefined)).toBe(false)
    expect(DirectoryNotesSection.spec.damaged?.({ 'C:/a': ['note'] })).toBe(false)
    expect(DirectoryNotesSection.spec.damaged?.({ 'C:/a': 'note' })).toBe(true)
  })

  it('validates the shape and leaves the limits to the service', () => {
    const many = Array.from({ length: 60 }, () => ({ text: 'x' }))

    expect(DirectoryNotesSection.spec.validate({ 'C:/a': many })).toBeNull()
    expect(DirectoryNotesSection.spec.validate({ 'C:/a': [{ text: 1 } as unknown as DirectoryNote] }))
      .not.toBeNull()
  })
})
