import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ProductGroup } from './productGroup'

describe('shared/productGroup', () => {
  const roots: string[] = []
  const group = (text: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-group-'))
    roots.push(root)
    writeFileSync(join(root, '.appgroup'), text)
    return root
  }
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it.each(['', ' \n', '{"kind":"collection"}'])('selects only the member of a collection %j', (text) => {
    const root = group(text)
    expect(ProductGroup.scopeOf(join(root, 'Jamat', 'lib')))
      .toEqual({ ok: true, ownerDir: join(root, 'Jamat'), setupScope: 'project' })
    expect(ProductGroup.scopeOf(root)).toMatchObject({ ok: false, detail: expect.stringContaining('choose a member') })
    expect(ProductGroup.scopeOf(join(root, '.private'))).toMatchObject({ ok: false })
    expect(ProductGroup.rootOf(join(root, 'Jamat'))).toBe(root)
  })

  it('selects the whole explicitly declared product, including its shared files', () => {
    const root = group('{"kind":"product"}')
    for (const dir of [root, join(root, 'Web', 'src'), join(root, 'components')])
      expect(ProductGroup.scopeOf(dir)).toEqual({ ok: true, ownerDir: root, setupScope: 'members' })
  })

  it('respects a nested product inside a collection of templates', () => {
    const root = group('{"kind":"collection"}')
    const product = join(root, 'ProductTemplate')
    mkdirSync(product)
    writeFileSync(join(product, '.appgroup'), '{"kind":"product"}')
    expect(ProductGroup.scopeOf(join(product, 'App')))
      .toEqual({ ok: true, ownerDir: product, setupScope: 'members' })
  })

  it.each(['{', 'null', '[]', '{}', '{"kind":"unknown"}', '{"kind":"product","extra":true}'])
  ('refuses malformed metadata instead of widening or falling back: %s', (text) => {
    const root = group(text)
    expect(ProductGroup.scopeOf(join(root, 'Jamat'))).toMatchObject({ ok: false, detail: expect.stringContaining('.appgroup') })
  })

  it('reports an unreadable marker and accepts a BOM', () => {
    const root = group('\uFEFF{"kind":"product"}')
    expect(ProductGroup.readAt(root)).toEqual({ ok: true, kind: 'product' })
    rmSync(join(root, '.appgroup'))
    mkdirSync(join(root, '.appgroup'))
    expect(ProductGroup.readAt(root)).toMatchObject({ ok: false })
  })
})
