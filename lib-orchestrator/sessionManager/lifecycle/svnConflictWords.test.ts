import { describe, expect, it } from 'vitest'

import type { SvnActionConflictEntry, SvnActionConflictSet } from '../records/sessionRecord.types'
import { SvnConflictWords } from './svnConflictWords'

const entry = (shape: SvnActionConflictEntry['shape'], more: Partial<SvnActionConflictEntry> = {}): SvnActionConflictEntry => ({
  path: 'src/a.ts', kind: 'text', shape, state: 'person', options: ['merged', 'take-incoming', 'keep-mine'], facts: { incomingRevision: 421 }, ...more,
})
const tree = (shape: SvnActionConflictEntry['shape'], facts: SvnActionConflictEntry['facts']): SvnActionConflictEntry =>
  entry(shape, { kind: 'tree', facts: { incomingRevision: 421, localKind: 'file', incomingKind: 'file', ...facts } })
const set = (entries: SvnActionConflictEntry[], more = 0): SvnActionConflictSet =>
  ({ readAt: 1, baseRevision: 420, revision: 421, entries, more })

describe('lib-orchestrator/sessionManager/lifecycle/svnConflictWords', () => {
  it('describes each shape from its facts', () => {
    const described: [SvnActionConflictEntry, string][] = [
      [tree('obstructed-dir', { localKind: 'dir', incomingKind: 'dir', files: { local: 2, incoming: 3, same: 0, differing: 0 } }),
        'Your session added this folder with 2 files; r421 added it with 3 files.'],
      [tree('obstructed-dir', { localKind: 'dir', incomingKind: 'dir', files: { local: 1, incoming: 1, same: 0, differing: 1 } }),
        'Your session added this folder with 1 file; r421 added it with 1 file. 1 file with the same name differs.'],
      [tree('obstructed-file', {}), 'Your session added this file; r421 added it too.'],
      [tree('added-both', { localKind: 'dir', incomingKind: 'dir' }), 'Your session and r421 both added this folder.'],
      [tree('kind-mismatch', { incomingKind: 'dir' }), 'Your session has a file here; r421 added a folder.'],
      [tree('edit-vs-delete', { incomingKind: 'none' }), 'Your session changed this file; r421 deleted it.'],
      [tree('edit-vs-replace', {}), 'Your session changed this file; r421 replaced it.'],
      [tree('delete-vs-edit', { reason: 'moved-away' }), 'Your session moved away this file; r421 changed it.'],
      [tree('delete-vs-delete', { reason: 'missing' }), 'Your session and r421 both deleted this file.'],
      [tree('replace-or-case', {}), 'Your session replaced this file; r421 changed it.'],
      [entry('text-overlap'), 'Your session and r421 changed the same lines of this file.'],
      [entry('text-same'), 'Your session and r421 wrote the same text; only the line ends differ.'],
      [entry('binary'), 'Your session and r421 both changed this binary file.'],
      [entry('text-unreadable'), 'Your session and r421 both changed this file, which is not UTF-8 text.'],
      [entry('line-list-property', { kind: 'property', facts: { incomingRevision: 421, properties: ['svn:ignore'] } }),
        'Your session and r421 both changed svn:ignore.'],
      [entry('externals', { kind: 'property', facts: { properties: ['svn:externals'] } }), 'Your session and the other commit both changed svn:externals.'],
    ]
    for (const [input, sentence] of described) expect(SvnConflictWords.descriptionOf(input), input.shape).toBe(sentence)
    expect(SvnConflictWords.descriptionOf(entry('name-unsafe'))).toMatch(/svn cannot take this name/)
    expect(SvnConflictWords.descriptionOf(entry('unrecognized'))).toMatch(/Jamat does not know/)
    expect(() => SvnConflictWords.descriptionOf(entry('melted' as SvnActionConflictEntry['shape']))).toThrow(/Unknown conflict shape/)
  })

  it('labels each option, says what it does from the facts and what it loses', () => {
    const info = SvnConflictWords.infoOf(tree('obstructed-dir', { localKind: 'dir', incomingKind: 'dir', files: { local: 2, incoming: 3, same: 0, differing: 0 } }))
    expect(info).toMatchObject({ path: 'src/a.ts', kind: 'tree', state: 'person', by: null, saved: null,
      description: 'Your session added this folder with 2 files; r421 added it with 3 files.' })
    const dir = SvnConflictWords.infoOf({ ...tree('obstructed-dir', { localKind: 'dir', incomingKind: 'dir' }), options: ['keep-both', 'take-incoming', 'keep-mine'] })
    expect(dir.options).toEqual([
      { id: 'keep-both', label: 'Keep both', note: 'restores the files r421 added and keeps the session\'s files beside them', loses: 'nothing' },
      { id: 'take-incoming', label: 'Take incoming', note: 'restores what r421 added; the session\'s files are saved first, then removed', loses: 'mine' },
      { id: 'keep-mine', label: 'Keep mine', note: 'keeps the session\'s version; what r421 brought is dropped', loses: 'incoming' },
    ])
    const added = SvnConflictWords.infoOf({ ...tree('obstructed-dir', { localKind: 'dir', incomingKind: 'dir', action: 'added' }), options: ['keep-mine'] })
    expect(added.options[0]?.note).toBe('keeps the session\'s version; the commit would delete the files r421 added')
    const file = SvnConflictWords.infoOf({ ...tree('obstructed-file', { action: 'added' }), options: ['keep-mine'] })
    expect(file.options[0]?.note).toBe('keeps the session\'s version; the commit would delete the file r421 added')
    const counted = SvnConflictWords.infoOf({ ...tree('obstructed-dir', { localKind: 'dir', incomingKind: 'dir', action: 'added',
      files: { local: 2, incoming: 3, same: 0, differing: 0 } }), options: ['keep-mine'] })
    expect(counted.options[0]?.note).toBe('keeps the session\'s version; the commit would delete the 3 files r421 added')
    expect(SvnConflictWords.infoOf(entry('text-overlap')).options.map((option) => [option.label, option.loses])).toEqual([
      ['Merge', 'nothing'], ['Take incoming', 'mine'], ['Keep mine', 'incoming'],
    ])
  })

  it('summarizes the set by who works on it', () => {
    expect(SvnConflictWords.summaryOf(set([entry('obstructed-dir'), entry('text-overlap'), entry('text-overlap')]))).toBe('3 conflicts need you')
    expect(SvnConflictWords.summaryOf(set([entry('text-overlap')]))).toBe('1 conflict needs you')
    expect(SvnConflictWords.summaryOf(set([entry('obstructed-dir', { state: 'rule' }), entry('text-overlap', { state: 'agent' }),
      entry('text-overlap', { state: 'agent' })]))).toBe('3 conflicts: Jamat fixed 1, merger on 2')
    expect(SvnConflictWords.summaryOf(set([entry('text-overlap', { state: 'settled', by: 'person' }), entry('text-overlap', { state: 'person' })])))
      .toBe('2 conflicts: you fixed 1, 1 needs you')
    expect(SvnConflictWords.summaryOf(set([entry('text-overlap', { state: 'agent' })], 2))).toBe('3 conflicts: merger on 1, 2 need you')
  })

  it('names the summary and at most 20 paths in a need, and bounds the wire list', () => {
    const many = set(Array.from({ length: 25 }, (_, index) => entry('text-overlap', { path: `f${index}.ts` })), 5)
    expect(SvnConflictWords.reasonOf(many, 'press Finish again'))
      .toMatch(/^30 conflicts need you: f0.ts, f1.ts, .*f19.ts and 10 more; settle them, then press Finish again$/)
    expect(SvnConflictWords.reasonOf(set([tree('kind-mismatch', {}), entry('text-overlap', { path: 'b.ts' })]), 'press UPDATE again'))
      .toBe('2 conflicts need you: src/a.ts (tree), b.ts; settle them, then press UPDATE again')
    const listed = SvnConflictWords.listOf(many, 10)
    expect(listed.entries).toHaveLength(10)
    expect(listed.more).toBe(20)
  })

  it('says that the session differed only in line ends when it takes the incoming text, and how a union treats each side', () => {
    const eol = SvnConflictWords.infoOf(entry('text-same'))
    expect(eol.options.find((option) => option.id === 'take-incoming')?.note)
      .toBe('takes the version of r421, which keeps its svn:eol-style; the session\'s version differed only in line ends')
    const ignore = SvnConflictWords.infoOf({ ...entry('line-list-property', { kind: 'property' }), options: ['union'] })
    expect(ignore.options[0]?.note).toBe('keeps the lines of r421, adds the lines the session added and leaves out the ones it removed')
    const mergeinfo = SvnConflictWords.infoOf({ ...entry('mergeinfo', { kind: 'property' }), options: ['union'] })
    expect(mergeinfo.options[0]?.note).toBe('keeps the merged revision ranges of both sides')
  })

  it('names what Jamat fixed: one FIXED line per path, at most 20, the saved folder, and the check of the conflicts', () => {
    expect(SvnConflictWords.fixedLinesOf([], 'R:\\saved')).toEqual([])
    expect(SvnConflictWords.fixedLinesOf([{ path: '.aidocs/engines', option: 'keep-both' }, { path: 'a.png', option: 'take-incoming' }], 'R:\\saved'))
      .toEqual(['FIXED: .aidocs/engines (keep both)', 'FIXED: a.png (take incoming)', '   saved copies: R:\\saved'])
    const many = SvnConflictWords.fixedLinesOf(Array.from({ length: 23 }, (_, index) => ({ path: `f${index}`, option: 'merged' as const })), 'R:\\saved')
    expect(many).toHaveLength(22)
    expect(many.at(-2)).toBe('FIXED: 3 more; fixes.log beside the saved copies lists them')
    expect(SvnConflictWords.fixingOf({ conflicts: 3, fixed: 1, left: 2 })).toBe('Jamat fixed 1 of 3 conflicts')
    expect(SvnConflictWords.fixingOf({ conflicts: 2, fixed: 0, left: 2 })).toBe('2 conflicts left')
    expect(SvnConflictWords.fixingOf({ conflicts: 2, fixed: 0, left: 0 })).toBe('no conflict left')
  })
})
