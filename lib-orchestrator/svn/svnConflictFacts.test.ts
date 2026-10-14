import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { SvnTreeFacts } from './svn.types'
import { SvnConflictFacts } from './svnConflictFacts'

// Captured by `pnpm smoke:svn-worktree --capture` from the conflict spike (`scripts/smoke/svnConflictShapes.ts`):
// one svnadmin repository per case, r2 the base, r3 the incoming commit. The smoke proves on every
// run that this svn still writes what they hold.
const root = resolve('fixture-conflicts')
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'worktree', 'conflicts', name), 'utf8')
    .replaceAll('{ROOT}', root.replaceAll(sep, '/')).replaceAll('{REPO}', 'file:///repository')

const nameOf = (victim: string): string => victim === '.' ? '.' : victim.slice(victim.lastIndexOf('/') + 1)
const entryOf = (shape: string, victim: string) => {
  const entry = SvnConflictFacts.infoConflicts(fixture(`info-${shape}.xml`)).find((candidate) => candidate.name === nameOf(victim))
  if (entry === undefined) throw new Error(`no info entry for ${victim} in ${shape}`)
  return entry
}
const sidecarsOf = (shape: string, victim: string): string[] =>
  Object.values(entryOf(shape, victim).sidecars).flatMap((path) => path === null ? [] : [path.slice(path.lastIndexOf('/') + 1)])
const tree = (reason: SvnTreeFacts['reason'], action: SvnTreeFacts['action'], localKind: SvnTreeFacts['localKind'],
  incomingKind: SvnTreeFacts['incomingKind'], localHistory = false): SvnTreeFacts =>
  ({ reason, action, localKind, incomingKind, incomingRevision: 3, localHistory })

describe('lib-orchestrator/svn/svnConflictFacts', () => {
  describe('the spike fixtures', () => {
    const trees: [string, string, SvnTreeFacts][] = [
      ['obstructed-dir', '.aidocs/engines', tree('unversioned', 'added', 'dir', 'dir')],
      ['obstructed-dir-same-name', '.aidocs/engines', tree('unversioned', 'added', 'dir', 'dir')],
      ['obstructed-file-equal', 'src/new.txt', tree('unversioned', 'added', 'file', 'file')],
      ['obstructed-file-differing', 'src/new.txt', tree('unversioned', 'added', 'file', 'file')],
      ['added-both', 'src/new.txt', tree('added', 'added', 'file', 'file')],
      ['added-both-history', 'src/new.txt', tree('added', 'added', 'file', 'file', true)],
      ['kind-mismatch', 'docs', tree('unversioned', 'added', 'file', 'dir')],
      ['edit-vs-delete', 'src/legacy.txt', tree('edited', 'deleted', 'file', 'none', true)],
      ['edit-vs-replace', 'src/legacy.txt', tree('edited', 'replaced', 'file', 'file', true)],
      ['delete-vs-edit', 'src/legacy.txt', tree('deleted', 'edited', 'file', 'file')],
      ['moved-vs-edit', 'src/legacy.txt', tree('moved-away', 'edited', 'file', 'file')],
      ['delete-vs-delete', 'src/legacy.txt', tree('deleted', 'deleted', 'file', 'none')],
    ]

    it.each(trees)('reads the tree conflict of %s at %s as the spike printed it', (shape, victim, facts) => {
      expect(SvnConflictFacts.conflictedRows(fixture(`status-${shape}.xml`), root)).toEqual([{ path: victim, tree: true, text: false, property: false }])
      expect(entryOf(shape, victim)).toMatchObject({ tree: facts, text: false, property: false })
    })

    it.each([
      ['text-overlap', 'src/catalog.ts', ['catalog.ts.r2', 'catalog.ts.mine', 'catalog.ts.r3']],
      ['text-eol', 'src/catalog.ts', ['catalog.ts.r2', 'catalog.ts.mine', 'catalog.ts.r3']],
      ['binary-differing', 'assets/logo.png', ['logo.png.r2', 'logo.png.r3']],
      ['text-utf16', 'docs/notes.txt', ['notes.txt.r2', 'notes.txt.r3']],
      ['non-ascii', 'složka/přehled.md', ['přehled.md.r2', 'přehled.md.mine', 'přehled.md.r3']],
    ])('reads the text conflict of %s at %s with its sidecars', (shape, victim, sidecars) => {
      expect(SvnConflictFacts.conflictedRows(fixture(`status-${shape}.xml`), root)).toEqual([{ path: victim, tree: false, text: true, property: false }])
      expect(entryOf(shape, victim)).toMatchObject({ tree: null, text: true, property: false })
      expect(sidecarsOf(shape, victim)).toEqual(sidecars)
    })

    it.each([
      ['ignore', '.', 'dir_conflicts.prej'],
      ['externals', '.', 'dir_conflicts.prej'],
      ['property-differing', 'a.txt', 'a.txt.prej'],
    ])('reads the property conflict of %s at %s with its .prej file', (shape, victim, prej) => {
      expect(SvnConflictFacts.conflictedRows(fixture(`status-${shape}.xml`), root)).toEqual([{ path: victim, tree: false, text: false, property: true }])
      expect(entryOf(shape, victim)).toMatchObject({ tree: null, text: false, property: true })
      expect(sidecarsOf(shape, victim)).toEqual([prej])
    })

    it.each(['missing-vs-delete', 'binary-equal', 'mergeinfo', 'property-equal'])('reads no conflict where svn settles %s itself', (shape) => {
      expect(SvnConflictFacts.conflictedRows(fixture(`status-${shape}.xml`), root)).toEqual([])
    })

    it('reads the BASE checksum of an obstructed file, which holds the incoming side', () => {
      expect(entryOf('obstructed-file-equal', 'src/new.txt')).toMatchObject({ kind: 'file', checksum: '2c985b161217a952b7a410fd91495cebc349f520' })
    })

    it('reads the status rows with their item, BASE and conflict', () => {
      expect(SvnConflictFacts.itemRows(fixture('status-obstructed-dir.xml'), root)).toEqual([
        { path: '.aidocs/engines', item: 'deleted', conflict: true, base: 3 },
        { path: '.aidocs/engines/t1', item: 'unversioned', conflict: false, base: 0 },
      ])
    })
  })

  describe('words svn may add', () => {
    it('reads an unknown reason, action or kind as unrecognized and never throws', () => {
      const xml = fixture('info-obstructed-dir.xml').replace('reason="unversioned"', 'reason="teleported"')
        .replace('action="add"', 'action="fold"').replace(/(<tree-conflict[^>]*?)kind="dir"/, '$1kind="symlink"')
      expect(SvnConflictFacts.infoConflicts(xml).find((entry) => entry.name === 'engines')?.tree)
        .toEqual({ reason: 'unrecognized', action: 'unrecognized', localKind: 'unrecognized', incomingKind: 'dir', incomingRevision: 3, localHistory: false })
    })

    it('reads an entry whose revision svn writes as a sentence', () => {
      expect(fixture('info-added-both.xml')).toContain('revision="Resource is not under version control."')
      expect(entryOf('added-both', 'src/new.txt').tree?.reason).toBe('added')
    })

    it('refuses a document that is no svn info', () => {
      expect(() => SvnConflictFacts.infoConflicts('<?xml version="1.0"?><status/>')).toThrow(/no <info>/)
    })
  })

  describe('properties', () => {
    const url = 'file:///repository/src'
    const listed = `<?xml version="1.0"?><properties><target path="${url}"><property name="svn:ignore">node_modules&#13;
dist
</property></target><target path="${url}/p%C5%99ehled.md"><property name="bin" encoding="base64">${Buffer.from('a\u0000b').toString('base64')}</property>`
      + '<property name="empty"/></target></properties>'

    it('names URL targets relative to the read URL, decodes entities, base64 and an empty value', () => {
      const values = SvnConflictFacts.propertiesOf(listed, url)
      expect(values.get('.')?.get('svn:ignore')).toBe('node_modules\r\ndist\n')
      expect(values.get('přehled.md')).toEqual(new Map([['bin', 'a\u0000b'], ['empty', '']]))
    })

    it('reads an empty list and names working-copy targets as svn wrote them', () => {
      expect(SvnConflictFacts.propertiesOf('<?xml version="1.0"?>\n<properties>\n</properties>\n')).toEqual(new Map())
      expect([...SvnConflictFacts.propertiesOf('<properties><target path="src\\a.txt"><property name="p">v</property></target></properties>').keys()]).toEqual(['src/a.txt'])
    })

    it('counts a property changed on both sides as conflicted, and one changed on one side only as not', () => {
      const older = new Map([['svn:ignore', 'a\n'], ['owner', 'x'], ['same', 'v']])
      const mine = new Map([['svn:ignore', 'a\nb\n'], ['owner', 'x'], ['same', 'w'], ['new', 'mine']])
      const theirs = new Map([['svn:ignore', 'a\nc\n'], ['owner', 'y'], ['same', 'w'], ['new', 'theirs']])
      expect(SvnConflictFacts.conflictedProperties(older, mine, theirs)).toEqual([
        { name: 'new', older: null, mine: 'mine', theirs: 'theirs' },
        { name: 'svn:ignore', older: 'a\n', mine: 'a\nb\n', theirs: 'a\nc\n' },
      ])
    })
  })

  describe('content', () => {
    const bytes = (text: string): Uint8Array => Buffer.from(text, 'utf8')

    it('tells equal bytes, equal after CRLF to LF and differing text apart', () => {
      expect(SvnConflictFacts.contentOf(bytes('a\nb\n'), bytes('a\nb\n'))).toEqual({ binary: false, unreadable: false, equal: 'bytes' })
      expect(SvnConflictFacts.contentOf(bytes('a\r\nb\r\n'), bytes('a\nb\n'))).toEqual({ binary: false, unreadable: false, equal: 'eol' })
      expect(SvnConflictFacts.contentOf(bytes('a\n'), bytes('b\n'))).toEqual({ binary: false, unreadable: false, equal: 'differs' })
      expect(SvnConflictFacts.contentOf(bytes('a\n'), null)).toEqual({ binary: false, unreadable: false, equal: null })
    })

    it('reads a NUL byte as binary, a UTF-16 byte order mark or invalid UTF-8 as unreadable', () => {
      expect(SvnConflictFacts.contentOf(Uint8Array.from([0x89, 0x50, 0x00, 0x01]), Uint8Array.from([0x89, 0x50, 0x00, 0x02])))
        .toEqual({ binary: true, unreadable: false, equal: 'differs' })
      expect(SvnConflictFacts.contentOf(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\r\n', 'utf16le')]), null))
        .toMatchObject({ unreadable: true })
      expect(SvnConflictFacts.contentOf(Uint8Array.from([0x61, 0xe9, 0x0a]), Uint8Array.from([0x61, 0x0a])))
        .toEqual({ binary: false, unreadable: true, equal: 'differs' })
    })
  })
})
