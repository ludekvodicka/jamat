import { describe, expect, it } from 'vitest'

import { DisplayGrouping } from './displayGrouping'
import type { ProjectEntry, VirtualFolderDef } from '../projectManagerApi.types'

describe('lib-orchestrator/projectManager/projects/displayGrouping', () => {
  function project(name: string): ProjectEntry {
    return { name, path: `Q:/root/${name}`, lastActivity: null }
  }

  const folders: VirtualFolderDef[] = [
    { prefix: 'temporary', title: 'Temporary' },
    { prefix: 'tmp-', title: 'Scratch' },
  ]

  function namesOf(projects: readonly ProjectEntry[]): string[] {
    return projects.map((entry) => entry.name)
  }

  describe('matchesVirtualPrefix', () => {
    it('needs an upper case letter after the prefix', () => {
      expect(DisplayGrouping.matchesVirtualPrefix('temporaryFoo', 'temporary')).toBe(true)
      expect(DisplayGrouping.matchesVirtualPrefix('temporaryfoo', 'temporary')).toBe(false)
      expect(DisplayGrouping.matchesVirtualPrefix('temporary1', 'temporary')).toBe(false)
    })

    it('accepts a plain prefix match when the prefix ends in a separator', () => {
      expect(DisplayGrouping.matchesVirtualPrefix('tmp-foo', 'tmp-')).toBe(true)
      expect(DisplayGrouping.matchesVirtualPrefix('tmp_foo', 'tmp_')).toBe(true)
    })

    it('rejects the bare prefix and anything that does not start with it', () => {
      expect(DisplayGrouping.matchesVirtualPrefix('temporary', 'temporary')).toBe(false)
      expect(DisplayGrouping.matchesVirtualPrefix('tmp-', 'tmp-')).toBe(false)
      expect(DisplayGrouping.matchesVirtualPrefix('AppFoo', 'temporary')).toBe(false)
    })
  })

  describe('buildDisplayEntries', () => {
    it('puts matching projects into their folder and leaves the rest flat', () => {
      const entries = DisplayGrouping.buildDisplayEntries(
        [project('AppOne'), project('temporaryFoo'), project('tmp-bar'), project('temporaryfoo')],
        folders,
      )
      expect(entries).toHaveLength(4)
      expect(entries[0]).toMatchObject({ kind: 'virtualFolder', prefix: 'tmp-', title: 'Scratch' })
      expect(entries[1]).toMatchObject({ kind: 'virtualFolder', prefix: 'temporary', title: 'Temporary' })
      expect(entries.slice(2)).toEqual([
        { kind: 'project', project: project('AppOne') },
        { kind: 'project', project: project('temporaryfoo') },
      ])
    })

    it('carries the grouped projects as children', () => {
      const entries = DisplayGrouping.buildDisplayEntries(
        [project('temporaryFoo'), project('temporaryBar')],
        [{ prefix: 'temporary', title: 'Temporary' }],
      )
      expect(entries).toHaveLength(1)
      const folder = entries[0]
      if (folder.kind !== 'virtualFolder') throw new Error(`expected a virtual folder: ${folder.kind}`)
      expect(namesOf(folder.children)).toEqual(['temporaryFoo', 'temporaryBar'])
    })

    it('does not emit a virtual folder nothing matched', () => {
      const entries = DisplayGrouping.buildDisplayEntries([project('AppOne')], folders)
      expect(entries).toEqual([{ kind: 'project', project: project('AppOne') }])
    })

    // V1 grouped each folder independently and only used the match to keep a project out of the
    // flat list, so overlapping prefixes show the same project twice on purpose.
    it('shows a project claimed by two folders in both, and not in the flat list', () => {
      const entries = DisplayGrouping.buildDisplayEntries(
        [project('a-b-Foo')],
        [{ prefix: 'a-b-', title: 'Beta' }, { prefix: 'a-', title: 'Alpha' }],
      )
      expect(entries).toHaveLength(2)
      expect(entries[0]).toMatchObject({ kind: 'virtualFolder', title: 'Alpha' })
      expect(entries[1]).toMatchObject({ kind: 'virtualFolder', title: 'Beta' })
      expect(entries.some((entry) => entry.kind === 'project')).toBe(false)
    })

    it('leaves every project flat when the category has no virtual folders', () => {
      const entries = DisplayGrouping.buildDisplayEntries([project('AppOne'), project('tmp-bar')], [])
      expect(entries).toEqual([
        { kind: 'project', project: project('AppOne') },
        { kind: 'project', project: project('tmp-bar') },
      ])
    })
  })

  describe('applyPrefix', () => {
    it('moves a project into a folder, capitalising the first letter', () => {
      expect(DisplayGrouping.applyPrefix('foo', folders, 'temporary')).toBe('temporaryFoo')
    })

    it('concatenates when the target prefix ends in a separator', () => {
      expect(DisplayGrouping.applyPrefix('foo', folders, 'tmp-')).toBe('tmp-foo')
      expect(DisplayGrouping.applyPrefix('foo', folders, 'tmp_')).toBe('tmp_foo')
    })

    it('takes a project out of every folder on null', () => {
      expect(DisplayGrouping.applyPrefix('temporaryFoo', folders, null)).toBe('Foo')
      expect(DisplayGrouping.applyPrefix('tmp-foo', folders, null)).toBe('foo')
    })

    it('moves between folders by dropping the current prefix first', () => {
      expect(DisplayGrouping.applyPrefix('temporaryFoo', folders, 'tmp-')).toBe('tmp-Foo')
      expect(DisplayGrouping.applyPrefix('tmp-foo', folders, 'temporary')).toBe('temporaryFoo')
    })

    it('leaves a name that is in no folder alone when it is asked to leave one', () => {
      expect(DisplayGrouping.applyPrefix('AppOne', folders, null)).toBe('AppOne')
    })
  })
})
