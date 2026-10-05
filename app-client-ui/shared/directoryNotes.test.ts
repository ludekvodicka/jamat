import { describe, expect, it } from 'vitest'

import { DirectoryNotes, type DirectoryNote, type DirectoryNotesValue } from './directoryNotes'

describe('app-client-ui/shared/directoryNotes', () => {
  function coerced(value: unknown): { value: DirectoryNotesValue; reports: string[] } {
    const reports: string[] = []
    return { value: DirectoryNotes.coerce(value, (message) => reports.push(message)), reports }
  }

  describe('coerce', () => {
    it('reads a missing section as no notes, silently and undamaged', () => {
      expect(coerced(undefined)).toEqual({ value: {}, reports: [] })
      expect(DirectoryNotes.damaged(undefined)).toBe(false)
    })

    it('takes a bare string as a typed note and an object with its flags normalised', () => {
      const raw = {
        'C:/work/app': ['by hand', { text: 'large one', large: true, sticky: false }],
      }

      expect(coerced(raw)).toEqual({
        value: { 'C:/work/app': [{ text: 'by hand' }, { text: 'large one', large: true }] },
        reports: [],
      })
      expect(DirectoryNotes.damaged(raw)).toBe(false)
    })

    it('reports a section that is not an object and calls it damaged', () => {
      for (const raw of ['notes', ['C:/work'], null, 7]) {
        const read = coerced(raw)
        expect(read.value, JSON.stringify(raw)).toEqual({})
        expect(read.reports, JSON.stringify(raw)).toHaveLength(1)
        expect(DirectoryNotes.damaged(raw), JSON.stringify(raw)).toBe(true)
      }
    })

    it('reports a directory that holds no list and calls it damaged', () => {
      const raw = { 'C:/work/app': 'one note', 'C:/work/other': [{ text: 'kept' }] }
      const read = coerced(raw)

      expect(read.value).toEqual({ 'C:/work/other': [{ text: 'kept' }] })
      expect(read.reports).toHaveLength(1)
      expect(DirectoryNotes.damaged(raw)).toBe(true)
    })

    it('reports a note of the wrong type, keeps its neighbours and calls the section damaged', () => {
      const raw = {
        'C:/work/app': [{ text: 'kept' }, 12, { text: 3 }, { text: 'flag', sticky: 'yes' }],
      }
      const read = coerced(raw)

      expect(read.value).toEqual({ 'C:/work/app': [{ text: 'kept' }] })
      expect(read.reports).toHaveLength(3)
      expect(DirectoryNotes.damaged(raw)).toBe(true)
    })

    it('does not call a set over the limits damaged', () => {
      const raw = { 'C:/work/app': Array.from({ length: 60 }, () => ({ text: 'x' })) }

      expect(DirectoryNotes.damaged(raw)).toBe(false)
    })
  })

  describe('shapeProblemOf', () => {
    it('accepts the stored shape and refuses a note without a text', () => {
      expect(DirectoryNotes.shapeProblemOf({ 'C:/a': [{ text: 'x', sticky: true }] })).toBeNull()
      expect(DirectoryNotes.shapeProblemOf({ 'C:/a': [{ large: true } as unknown as DirectoryNote] }))
        .toContain('text')
      expect(DirectoryNotes.shapeProblemOf({ 'C:/a': 'x' as unknown as DirectoryNote[] }))
        .toContain('list')
    })
  })

  describe('at', () => {
    it('shows one empty note for a directory nobody wrote for', () => {
      expect(DirectoryNotes.at({}, 'C:/work/app')).toEqual([{ text: '' }])
      expect(DirectoryNotes.at({ 'C:/work/app': [] }, 'C:/work/app')).toEqual([{ text: '' }])
    })

    it('finds a Windows directory however it is spelled', () => {
      const value = { 'q:/apps/x/': [{ text: 'found' }] }

      expect(DirectoryNotes.at(value, 'Q:\\Apps\\X')).toEqual([{ text: 'found' }])
    })

    it('keeps two POSIX directories that differ in case apart', () => {
      const value = { '/home/me/Work': [{ text: 'upper' }], '/home/me/work': [{ text: 'lower' }] }

      expect(DirectoryNotes.at(value, '/home/me/Work')).toEqual([{ text: 'upper' }])
      expect(DirectoryNotes.at(value, '/home/me/work')).toEqual([{ text: 'lower' }])
    })
  })

  describe('withDirectory', () => {
    const otherConst = { '/srv/other': [{ text: 'other' }] }

    it('removes the key when the default set is saved and leaves other directories as they are', () => {
      const value = { ...otherConst, 'C:/work/app': [{ text: 'old' }] }

      const next = DirectoryNotes.withDirectory(value, 'C:/work/app', [{ text: '', large: false }])

      expect(next).toEqual(otherConst)
      expect(next['/srv/other']).toBe(otherConst['/srv/other'])
    })

    it('keeps an empty note that carries a flag', () => {
      expect(DirectoryNotes.withDirectory({}, 'C:/work/app', [{ text: '', sticky: true }]))
        .toEqual({ 'C:/work/app': [{ text: '', sticky: true }] })
    })

    it('writes no false flag', () => {
      const next = DirectoryNotes.withDirectory({}, 'C:/work/app', [
        { text: 'a', large: false, sticky: false },
        { text: 'b', large: true, sticky: false },
      ])

      expect(JSON.stringify(next)).toBe('{"C:/work/app":[{"text":"a"},{"text":"b","large":true}]}')
    })

    it('merges every spelling of one Windows directory into one key in the place of the first', () => {
      const value = {
        'c:/work/app/': [{ text: 'old' }],
        '/srv/other': [{ text: 'other' }],
        'C:\\Work\\App': [{ text: 'older' }],
      }

      const next = DirectoryNotes.withDirectory(value, 'C:\\work\\app', [{ text: 'new' }])

      expect(Object.keys(next)).toEqual(['C:\\work\\app', '/srv/other'])
      expect(next['C:\\work\\app']).toEqual([{ text: 'new' }])
    })
  })

  describe('withImported', () => {
    it('puts the prompt into the one empty note at index 0 and keeps its flags', () => {
      const value = { 'C:/work/app': [{ text: '', sticky: true }] }

      expect(DirectoryNotes.withImported(value, 'C:/work/app', 'draft')).toEqual({
        value: { 'C:/work/app': [{ text: 'draft', sticky: true }] },
        index: 0,
      })
      expect(DirectoryNotes.withImported({}, 'C:/work/app', 'draft')).toEqual({
        value: { 'C:/work/app': [{ text: 'draft' }] },
        index: 0,
      })
    })

    it('appends the prompt at index n to any other set', () => {
      const value = { 'C:/work/app': [{ text: 'one' }, { text: '' }] }

      expect(DirectoryNotes.withImported(value, 'C:/work/app', 'draft')).toEqual({
        value: { 'C:/work/app': [{ text: 'one' }, { text: '' }, { text: 'draft' }] },
        index: 2,
      })
      expect(DirectoryNotes.withImported({ 'C:/work/app': [{ text: 'one' }] }, 'C:/work/app', 'draft').index)
        .toBe(1)
    })
  })

  describe('problemOf', () => {
    it('accepts a set inside the limits', () => {
      expect(DirectoryNotes.problemOf(Array.from({ length: 50 }, () => ({ text: 'x'.repeat(20_000) }))))
        .toBeNull()
    })

    it('refuses 51 notes, a note of 20 001 characters and an empty list', () => {
      expect(DirectoryNotes.problemOf(Array.from({ length: 51 }, () => ({ text: '' })))).toContain('50')
      expect(DirectoryNotes.problemOf([{ text: 'x'.repeat(20_001) }])).toContain('20000')
      expect(DirectoryNotes.problemOf([])).not.toBeNull()
    })

    it('refuses a note that is not one', () => {
      expect(DirectoryNotes.problemOf([{ text: 1 } as unknown as DirectoryNote])).not.toBeNull()
    })
  })
})
