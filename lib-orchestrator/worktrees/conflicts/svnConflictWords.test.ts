import { describe, expect, it } from 'vitest'

import type { SvnActionConflictEntry, SvnActionConflictSet } from '../../sessionManager/worktreeSessionRecords'
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

  it('names the place of a move and says where keep-both puts the other side\'s change (UA1-J05-6)', () => {
    const local = SvnConflictWords.infoOf({ ...tree('delete-vs-edit', { reason: 'moved-away', action: 'edited', movedTo: 'src/b.ts' }), options: ['keep-both', 'keep-mine'] })
    expect(local.description).toBe('Your session moved this file to src/b.ts; r421 changed it.')
    expect(local.options[0]).toEqual({ id: 'keep-both', label: 'Apply to src/b.ts', loses: 'nothing',
      note: 'applies the change of r421 to src/b.ts, where the session moved this file; lines both sides changed become a text conflict there' })
    const incoming = SvnConflictWords.infoOf({ ...tree('edit-vs-delete', { reason: 'edited', action: 'deleted', incomingKind: 'none', movedTo: 'src/b.ts' }),
      options: ['keep-both', 'merged', 'take-incoming', 'keep-mine'] })
    expect(incoming.description).toBe('Your session changed this file; r421 moved it to src/b.ts.')
    expect(incoming.options[0]).toEqual({ id: 'keep-both', label: 'Move my changes to src/b.ts', loses: 'nothing',
      note: 'applies the session\'s changes to src/b.ts, where r421 moved this file, and drops the old place; lines both sides changed become a text conflict there; a copy is saved first' })
    expect(SvnConflictWords.descriptionOf(tree('edit-vs-delete', { localKind: 'dir', incomingKind: 'none', movedTo: 'lib' })))
      .toBe('Your session changed this folder; r421 moved it to lib. Jamat cannot carry folder changes there: copy them into lib by hand, then take incoming.')
  })

  it('says what taking the incoming side of a file or a property drops: the session\'s own changes, saved first', () => {
    const takeOf = (input: SvnActionConflictEntry): string | undefined =>
      SvnConflictWords.infoOf(input).options.find((option) => option.id === 'take-incoming')?.note
    expect(takeOf(entry('text-overlap'))).toBe('takes the version of r421 and drops the session\'s own changes to this file; a copy is saved first')
    expect(takeOf(entry('binary'))).toBe('takes the version of r421 and drops the session\'s own changes to this file; a copy is saved first')
    expect(takeOf(tree('edit-vs-replace', {}))).toBe('takes the version of r421 and drops the session\'s own changes to this file; a copy is saved first')
    expect(takeOf(entry('property-value', { kind: 'property', facts: { incomingRevision: 421, properties: ['svn:keywords'] } })))
      .toBe('takes the value of r421 and drops the session\'s own value of svn:keywords; a copy is saved first')
  })

  it('says that nothing is left once every conflict is settled, and names the press that goes on', () => {
    expect(SvnConflictWords.settledOf(set([entry('text-overlap', { state: 'settled', by: 'person' }), entry('binary', { state: 'settled', by: 'person' }),
      entry('text-overlap', { state: 'settled', by: 'jamat' })]), 'Try again'))
      .toBe('3 conflicts: Jamat fixed 1, you fixed 2; all are settled, press Try again to go on')
    expect(SvnConflictWords.checkAgainConst).toBe('Check again')
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

  it('names the summary and at most 20 paths in a need, and carries every open entry on the wire', () => {
    const many = set(Array.from({ length: 25 }, (_, index) => entry('text-overlap', { path: `f${index}.ts` })), 5)
    expect(SvnConflictWords.reasonOf(many, 'press Finish again'))
      .toMatch(/^30 conflicts need you: f0.ts, f1.ts, .*f19.ts and 10 more; settle them, then press Finish again$/)
    expect(SvnConflictWords.reasonOf(set([tree('kind-mismatch', {}), entry('text-overlap', { path: 'b.ts' })]), 'press UPDATE again'))
      .toBe('2 conflicts need you: src/a.ts (tree), b.ts; settle them, then press UPDATE again')
    const listed = SvnConflictWords.listOf(many, 10)
    expect(listed.entries).toHaveLength(25)
    expect(listed.more).toBe(5)
  })

  it('names only the open paths in a need, not the settled ones before them (UA1-J05-4)', () => {
    const settled = Array.from({ length: 21 }, (_, index) => entry('text-overlap', { path: `s${index}.ts`, state: 'settled', by: 'person' }))
    expect(SvnConflictWords.reasonOf(set([...settled, tree('kind-mismatch', { incomingKind: 'dir' }), entry('text-overlap', { path: 'src/marker.txt' })]), 'press Check again'))
      .toBe('23 conflicts: you fixed 21, 2 need you: src/a.ts (tree), src/marker.txt; settle them, then press Check again')
  })

  it('carries every open entry on the wire before the settled ones, which fill the bound (UA1-J05-2)', () => {
    const settled = Array.from({ length: 50 }, (_, index) => entry('text-overlap', { path: `t${index}.ts`, state: 'settled', by: 'agent' }))
    const open = Array.from({ length: 10 }, (_, index) => entry('text-overlap', { path: `o${index}.ts` }))
    const listed = SvnConflictWords.listOf(set([...settled.slice(0, 25), ...open.slice(0, 5), ...settled.slice(25), ...open.slice(5)]), 50)
    expect(listed.entries.slice(0, 10).map((info) => info.path)).toEqual(open.map((info) => info.path))
    expect(listed.entries.slice(10).map((info) => info.path)).toEqual(settled.slice(0, 40).map((info) => info.path))
    expect(listed.more).toBe(10)
    const crowded = SvnConflictWords.listOf(set([...settled, ...Array.from({ length: 60 }, (_, index) => entry('binary', { path: `b${index}.bin`, state: 'agent' }))], 3), 50)
    expect(crowded.entries).toHaveLength(60)
    expect(crowded.entries.every((info) => info.state === 'agent')).toBe(true)
    expect(crowded.more).toBe(53)
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

  it('names who settled each path and with which option, the worker apart from the merger (UA1-J05-5)', () => {
    const settled = (by: SvnActionConflictEntry['by'], settledWith?: SvnActionConflictEntry['settledWith']) =>
      SvnConflictWords.infoOf(entry('text-overlap', { state: 'settled', by, ...settledWith === undefined ? {} : { settledWith } }))
    expect(settled('agent', 'keep-mine').settled).toBe('fixed by the worker: Keep mine')
    expect(settled('merger', 'merged')).toMatchObject({ by: 'agent', settled: 'fixed by the merger: Merge' })
    expect(settled('person', 'take-incoming').settled).toBe('fixed by you: Take incoming')
    expect(settled('person').settled).toBe('fixed by you outside Jamat; svn no longer marks it')
    expect(SvnConflictWords.infoOf({ ...tree('obstructed-dir', { localKind: 'dir', incomingKind: 'dir' }), state: 'settled', by: 'jamat', settledWith: 'keep-both' }).settled)
      .toBe("fixed by Jamat's rule: Keep both")
    expect(SvnConflictWords.infoOf({ ...tree('obstructed-dir', { localKind: 'dir', incomingKind: 'dir' }), state: 'rule', rule: 'keep-both' }).settled)
      .toBe("Jamat's rule applies Keep both")
    expect(SvnConflictWords.infoOf(entry('text-overlap')).settled).toBeUndefined()
    expect(SvnConflictWords.summaryOf(set([entry('text-overlap', { state: 'settled', by: 'agent' }), entry('text-overlap', { state: 'settled', by: 'merger' }),
      entry('text-overlap', { state: 'settled', by: 'merger' })]))).toBe('3 conflicts: worker fixed 1, merger fixed 2')
  })

  it('names an unpublished path that is still in conflict once, with a note for its svn conflict files (UA1-J10-10)', () => {
    expect(SvnConflictWords.remainingOf(['src/limit.txt', 'a.txt', 'src/done.txt'], [entry('text-overlap', { path: 'src/limit.txt' }),
      entry('property-value', { path: 'src/limit.txt', kind: 'property' }), entry('text-overlap', { path: 'src/done.txt', state: 'settled', by: 'person' })]))
      .toEqual(['src/limit.txt (in conflict, with its svn conflict files)', 'a.txt', 'src/done.txt'])
  })

  it('names the kind of each settlement of a file with a text and a property conflict (UA1-J05-1)', () => {
    expect(SvnConflictWords.resultLinesOf([
      entry('text-overlap', { path: 'src/both.txt', state: 'settled', by: 'person', settledWith: 'merged' }),
      entry('property-value', { path: 'src/both.txt', kind: 'property', state: 'settled', by: 'person', settledWith: 'take-incoming' }),
    ])).toEqual(['SETTLED: src/both.txt (text: merged) by the person', 'SETTLED: src/both.txt (property: take incoming) by the person'])
  })

  it('lists every settlement in the durable result with its option and who chose it (UA1-J05-5)', () => {
    expect(SvnConflictWords.resultLinesOf([
      { ...tree('obstructed-dir', {}), path: '.aidocs', state: 'settled', by: 'jamat', settledWith: 'keep-both', saved: 'R:/saved/.aidocs' },
      entry('text-overlap', { path: 'src/w.txt', state: 'settled', by: 'agent', settledWith: 'keep-mine' }),
      entry('text-overlap', { path: 'src/m.txt', state: 'settled', by: 'merger', settledWith: 'merged' }),
      entry('binary', { path: 'pic.bin', state: 'settled', by: 'person', settledWith: 'take-incoming', saved: 'R:/saved/pic.bin' }),
      entry('text-overlap', { path: 'src/o.txt', state: 'settled', by: 'person' }),
      entry('text-overlap', { path: 'src/open.txt' }),
    ])).toEqual([
      'FIXED: .aidocs (keep both)',
      '   saved copies: R:/saved/.aidocs',
      'SETTLED: src/w.txt (keep mine) by the worker',
      'SETTLED: src/m.txt (merged) by the merger',
      'SETTLED: pic.bin (take incoming) by the person',
      '   saved copies: R:/saved/pic.bin',
      'SETTLED: src/o.txt by the person outside Jamat',
    ])
  })
})
