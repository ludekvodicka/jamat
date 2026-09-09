import { describe, expect, it } from 'vitest'

import type { RuntimeCategory } from '../catalog/catalog.types'
import { ProjectNameRules } from './projectNameRules'

describe('lib-orchestrator/projectManager/projects/projectNameRules', () => {
  function category(flattenFolders: string[] = []): RuntimeCategory {
    return {
      id: 'nodejs',
      label: 'NodeJs',
      path: 'C:/Projects/NodeJs',
      comparablePath: 'c:/projects/nodejs',
      hiddenFolders: new Set(),
      flattenFolders: new Set(flattenFolders),
      virtualFolders: [],
      afterCreate: null,
    }
  }

  function rejects(name: string, flattenFolders: string[] = []): string {
    const result = ProjectNameRules.validate(name, category(flattenFolders))
    if (result.ok) throw new Error(`expected ${JSON.stringify(name)} to be rejected`)
    return result.detail
  }

  it('accepts an ordinary project name', () => {
    expect(ProjectNameRules.validate('AppJamatV3', category())).toEqual({ ok: true })
  })

  it('rejects an empty or whitespace-only name', () => {
    expect(rejects('')).toMatch(/empty/)
    expect(rejects('   ')).toMatch(/empty/)
  })

  it('rejects tree walking', () => {
    expect(rejects('..')).toMatch(/walks the directory tree/)
    expect(rejects('.')).toMatch(/walks the directory tree/)
    expect(rejects('Plugins/..', ['Plugins'])).toMatch(/walks the directory tree/)
    expect(rejects('../sibling')).toMatch(/"\/"/)
  })

  it('rejects path separators', () => {
    expect(rejects('foo\\bar')).toMatch(/path separator/)
    expect(rejects('foo/bar')).toMatch(/not a flattened container/)
    expect(rejects('a/b/c', ['a'])).toMatch(/more than one "\/"/)
  })

  it('rejects absolute and drive-relative paths', () => {
    expect(rejects('C:\\Temp')).toMatch(/is a path/)
    expect(rejects('C:relative')).toMatch(/is a path/)
    expect(rejects('/etc/foo')).toMatch(/is a path/)
    expect(rejects('C:/Projects/NodeJs/AppJamatV3')).toMatch(/is a path/)
  })

  it('rejects win32 device names whatever their case and extension', () => {
    expect(rejects('CON')).toMatch(/reserved Windows device name/)
    expect(rejects('con')).toMatch(/reserved Windows device name/)
    expect(rejects('nul.txt')).toMatch(/reserved Windows device name/)
    expect(rejects('COM1')).toMatch(/reserved Windows device name/)
    expect(rejects('LPT9')).toMatch(/reserved Windows device name/)
    expect(rejects('Plugins/AUX', ['Plugins'])).toMatch(/reserved Windows device name/)
  })

  it('accepts names that only look like device names', () => {
    expect(ProjectNameRules.validate('COM10', category())).toEqual({ ok: true })
    expect(ProjectNameRules.validate('CONsole', category())).toEqual({ ok: true })
  })

  it('rejects trailing dots and spaces, which Windows drops on creation', () => {
    expect(rejects('AppJamatV3.')).toMatch(/ends with a dot or a space/)
    expect(rejects('AppJamatV3 ')).toMatch(/ends with a dot or a space/)
  })

  it('allows one "/" only under a flattened container', () => {
    expect(ProjectNameRules.validate('Plugins/foo', category(['Plugins']))).toEqual({ ok: true })
    expect(rejects('Plugins/foo')).toMatch(/not a flattened container/)
    expect(rejects('/foo')).toMatch(/is a path/)
    expect(rejects('Plugins/', ['Plugins'])).toMatch(/empty path segment/)
  })
})
