import { describe, expect, it } from 'vitest'
import { PathCompare } from './pathCompare'
import { PathSet } from './pathSet'

describe('PathSet', () => {
  const members = ['Q:/app/src/a.ts', 'Q:\\app\\docs', 'q:/app/new/deep/b.ts', 'Q:/other/', 'D:/', '//server/share/x']
  const asked = ['Q:/app/src/a.ts', 'Q:/APP/SRC/A.TS', 'Q:/app/src', 'Q:/app/src/a.tsx', 'Q:/app/srcx/a.ts', 'Q:/app',
    'Q:/', 'Q:/app/docs/guide.md', 'Q:/app/docs', 'Q:/app/docsx', 'Q:/app/new/deep', 'Q:/app/new/deep/b.ts/c',
    'Q:/other', 'Q:/other/z', 'Q:/otherx', 'D:/any/thing', 'D:/', 'C:/app/src/a.ts', '//server/share', '//server/share/x/y', '//server/sharex']
  const set = new PathSet(members)

  it('answers like PathCompare.isInside against each member', () => {
    for (const path of asked) {
      expect(set.has(path), path).toBe(members.some((member) => PathCompare.comparable(member) === PathCompare.comparable(path)))
      expect(set.hasAncestorOrSelf(path), path).toBe(members.some((member) => PathCompare.isInside(member, path)))
      expect(set.hasDescendantOrSelf(path), path).toBe(members.some((member) => PathCompare.isInside(path, member)))
    }
  })

  it('an empty set contains nothing', () => {
    const empty = new PathSet([])
    expect(empty.has('Q:/app')).toBe(false)
    expect(empty.hasAncestorOrSelf('Q:/app')).toBe(false)
    expect(empty.hasDescendantOrSelf('Q:/')).toBe(false)
  })

  it('stays fast for thousands of members', () => {
    const paths = Array.from({ length: 5_000 }, (_, index) => `Q:/app/dir${index % 50}/file-${index}.ts`)
    const many = new PathSet(paths)
    const at = performance.now()
    expect(paths.every((path) => many.hasAncestorOrSelf(path) && many.hasDescendantOrSelf(path))).toBe(true)
    expect(performance.now() - at).toBeLessThan(2_000)
  })
})
