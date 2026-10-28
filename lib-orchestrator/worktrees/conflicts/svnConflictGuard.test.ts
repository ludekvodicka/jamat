import { describe, expect, it } from 'vitest'

import type { SvnItemRow } from '../../svn/svn.types'
import type { SvnActionConflictEntry, SvnActionConflictSet } from '../../sessionManager/worktreeSessionRecords'
import { SvnConflictGuard } from './svnConflictGuard'

describe('lib-orchestrator/sessionManager/lifecycle/svnConflictGuard', () => {
  const engines: SvnActionConflictEntry = {
    path: '.aidocs/engines', kind: 'tree', shape: 'obstructed-dir', state: 'settled', by: 'person', options: ['keep-both', 'take-incoming', 'keep-mine'],
    facts: { reason: 'unversioned', action: 'added', localKind: 'dir', incomingKind: 'dir', incomingRevision: 2 },
  }
  const catalog: SvnActionConflictEntry = {
    path: 'src/catalog.ts', kind: 'text', shape: 'text-overlap', state: 'settled', by: 'person', settledWith: 'merged',
    options: ['merged', 'take-incoming', 'keep-mine'], facts: { incomingRevision: 2 },
  }
  const set = (entries: SvnActionConflictEntry[]): SvnActionConflictSet => ({ readAt: 1, baseRevision: 1, revision: 2, entries, more: 0 })
  const row = (path: string, item: SvnItemRow['item'], conflict = false): SvnItemRow => ({ path, item, conflict, base: 2 })
  /** What `svn resolve --accept working` leaves of the incident: the victim and r2's tree scheduled for deletion. */
  const acceptedWorking = [row('.aidocs/engines', 'deleted'), row('.aidocs/engines/t1', 'unversioned'), row('.aidocs/engines/t2', 'deleted'),
    row('.aidocs/engines/t2/brief.md', 'deleted'), row('.aidocs/engines/t2/report.md', 'deleted'), row('.aidocs/engines/t2/trail.md', 'deleted'),
    row('src/wallets.ts', 'modified')]

  it('finds that --accept working on the incident would delete what r2 added below the folder', () => {
    expect(SvnConflictGuard.check({ set: set([engines]), rows: acceptedWorking, marked: [] })).toEqual([{
      kind: 'drops-incoming', path: '.aidocs/engines', revision: 2,
      dropped: ['.aidocs/engines', '.aidocs/engines/t2', '.aidocs/engines/t2/brief.md', '.aidocs/engines/t2/report.md', '.aidocs/engines/t2/trail.md'],
    }])
  })

  it('lets a keep-mine pass whose loss the person confirmed, and so the commit deletes those files', () => {
    expect(SvnConflictGuard.check({ set: set([{ ...engines, settledWith: 'keep-mine', confirmedLoss: true }]), rows: acceptedWorking, marked: [] })).toEqual([])
  })

  it('reopens a settled text file that holds a marker line, and a settled path svn still marks', () => {
    expect(SvnConflictGuard.check({ set: set([catalog]), rows: [row('src/catalog.ts', 'modified')], marked: ['src/catalog.ts'] }))
      .toEqual([{ kind: 'markers', path: 'src/catalog.ts' }])
    expect(SvnConflictGuard.check({ set: set([catalog]), rows: [row('src/catalog.ts', 'conflicted', true)], marked: [] }))
      .toEqual([{ kind: 'still-marked', path: 'src/catalog.ts' }])
  })

  it('judges settled entries only, and a delete only below a victim whose incoming side added, changed or replaced it', () => {
    const open = { ...engines, state: 'person' as const }
    expect(SvnConflictGuard.check({ set: set([open, { ...catalog, state: 'person' }]), rows: acceptedWorking, marked: ['src/catalog.ts'] })).toEqual([])
    const deletedBoth = { ...engines, path: 'src/legacy.ts', shape: 'delete-vs-delete' as const, facts: { reason: 'deleted' as const, action: 'deleted' as const } }
    expect(SvnConflictGuard.check({ set: set([deletedBoth]), rows: [row('src/legacy.ts', 'deleted')], marked: [] })).toEqual([])
    expect(SvnConflictGuard.check({ set: set([engines]), rows: [row('.aidocs/engines-old/a.md', 'missing')], marked: [] })).toEqual([])
  })

  it('names every svn conflict file a Finish would refuse to publish, but not the ones beside a path svn still marks (UA1-J05-4)', () => {
    const rows = [row('src/take.txt', 'modified'), row('src/take.txt.r3', 'unversioned'), row('src/open.txt', 'conflicted', true),
      row('src/open.txt.mine', 'unversioned'), row('src/open.txt.r3', 'unversioned'), row('docs/dir_conflicts.prej', 'unversioned'),
      row('notes.r2d2', 'unversioned'), row('src/catalog.ts', 'modified')]
    expect(SvnConflictGuard.check({ set: set([catalog]), rows, marked: ['src/catalog.ts'], finish: true })).toEqual([
      { kind: 'markers', path: 'src/catalog.ts' },
      { kind: 'leftovers', paths: ['docs/dir_conflicts.prej', 'src/take.txt.r3'] },
    ])
    expect(SvnConflictGuard.check({ set: set([catalog]), rows, marked: [] })).toEqual([])
    expect(SvnConflictGuard.pathOf({ kind: 'leftovers', paths: ['src/take.txt.r3'] })).toBeNull()
  })

  describe('after a merger', () => {
    const brief: SvnActionConflictEntry = { path: '.aidocs/engines/t1/brief.md', kind: 'diverged', shape: 'diverged', state: 'settled', by: 'agent',
      options: ['merged', 'take-incoming', 'keep-mine'], facts: { incomingRevision: 2 } }
    const hashes = (entries: Record<string, string>): ReadonlyMap<string, string> => new Map(Object.entries(entries))

    it('names an edit of a file the session had already changed, which path sets alone would miss, and a new changed path', () => {
      expect(SvnConflictGuard.afterMerger({
        set: set([engines, catalog, brief]),
        before: hashes({ 'src/wallets.ts': 'w1', 'src/catalog.ts': 'c1' }),
        now: hashes({ 'src/wallets.ts': 'w2', 'src/catalog.ts': 'c2', 'notes.md': 'n1' }),
        baseAbove: null,
      })).toEqual([{ kind: 'outside-set', paths: ['notes.md', 'src/wallets.ts'] }])
    })

    it('lets a change inside the set, below a tree victim or to a diverged target pass, and an unchanged path', () => {
      expect(SvnConflictGuard.afterMerger({
        set: set([engines, catalog, brief]),
        before: hashes({ 'src/catalog.ts': 'c1', '.aidocs/engines/t1/brief.md': 'b1', 'src/wallets.ts': 'w1' }),
        now: hashes({ 'src/catalog.ts': 'c2', '.aidocs/engines/t1/brief.md': 'b2', '.aidocs/engines/t2/x.md': 'x', 'src/wallets.ts': 'w1' }),
        baseAbove: null,
      })).toEqual([])
    })

    it('lets the files svn writes beside a conflicted path pass when a resolve removes them, and no other name like them', () => {
      const root: SvnActionConflictEntry = { ...catalog, path: '.', kind: 'property', shape: 'property-value' }
      expect(SvnConflictGuard.afterMerger({
        set: set([catalog, root]),
        before: hashes({ 'src/catalog.ts.mine': 'm', 'src/catalog.ts.r4': 'a', 'src/catalog.ts.r5': 'b', 'src/catalog.ts.2.prej': 'p',
          'dir_conflicts.prej': 'd', 'src/catalog.ts.bak': 'k' }),
        now: hashes({ 'src/catalog.ts.mine': 'missing', 'src/catalog.ts.r4': 'missing', 'src/catalog.ts.r5': 'missing',
          'src/catalog.ts.2.prej': 'missing', 'dir_conflicts.prej': 'missing', 'src/catalog.ts.bak': 'missing' }),
        baseAbove: null,
      })).toEqual([{ kind: 'outside-set', paths: ['src/catalog.ts.bak'] }])
    })

    it('names a commit from the worktree by the BASE past the update, and counts every outside change without a handover', () => {
      expect(SvnConflictGuard.afterMerger({ set: set([catalog]), before: hashes({}), now: hashes({}), baseAbove: 3 }))
        .toEqual([{ kind: 'committed', revision: 3 }])
      expect(SvnConflictGuard.afterMerger({ set: set([catalog]), before: null, now: hashes({ 'src/wallets.ts': 'w1' }), baseAbove: null }))
        .toEqual([{ kind: 'outside-set', paths: ['src/wallets.ts'] }])
    })

    it('reopens no entry for a finding on the worktree', () => {
      expect(SvnConflictGuard.pathOf({ kind: 'outside-set', paths: ['a'] })).toBeNull()
      expect(SvnConflictGuard.pathOf({ kind: 'committed', revision: 3 })).toBeNull()
      expect(SvnConflictGuard.pathOf({ kind: 'markers', path: 'a' })).toBe('a')
    })
  })
})
