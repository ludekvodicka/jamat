import { describe, expect, it } from 'vitest'

import type { SvnBounds, SvnLoggedRow, SvnResult, SvnRoot, SvnRootBounds } from '../../svn/svn.types'
import type { SessionRecord, SvnActionRoot } from '../records/sessionRecord.types'
import type { SvnLabelledRevision } from '../sessionManagerApi.types'
import { SessionStepWords } from './sessionStepWords'
import { type SvnLabelsPort, type SvnLabelsRead, SvnRevisionLabels } from './svnRevisionLabels'

describe('lib-orchestrator/sessionManager/lifecycle/svnRevisionLabels', () => {
  const worktree = 'Q:/Work/App/.worktrees/014-fix'
  const mount = `${worktree}/lib`
  const app = 'https://svn.test/repos/app'
  const lib = 'https://svn.test/repos/lib'
  const ok = <T>(value: T): SvnResult<T> => ({ ok: true, value })
  const row = (revision: number, path: string): SvnLoggedRow => ({ revision, action: 'M', path })
  const bound = (repository: string): SvnRootBounds => ({ repository, base: '/trunk', rootBase: 41, since: 50 })

  /** Each read answers what its field says; every call is logged. */
  class FakeSvn implements SvnLabelsPort {
    readonly log: string[] = []
    roots_: SvnRoot[] = [{ path: worktree, own: '', changed: [] }]
    own: Record<string, SvnLoggedRow[]> = {}
    /** The revisions `svn log -v` confirms below a root. */
    confirmed: Record<number, SvnLoggedRow[]> = {}
    provenRows: SvnLoggedRow[] | null = []
    since: SvnLoggedRow[] = []

    roots(): Promise<SvnResult<SvnRoot[]>> {
      return Promise.resolve(ok(this.roots_))
    }

    lowerBounds(roots: readonly SvnRoot[]): Promise<SvnResult<SvnBounds>> {
      this.log.push(`lowerBounds ${roots.map((root) => root.own || '.').join(',')}`)
      return Promise.resolve(ok(Object.fromEntries(roots.map((root) => [root.own, bound(root.own === '' ? app : lib)]))))
    }

    ownCommits(root: SvnRoot, onRevision?: (revision: number, index: number, count: number) => void)
      : Promise<SvnResult<{ repository: string; rows: SvnLoggedRow[] }>> {
      const rows = this.own[root.own] ?? []
      const revisions = [...new Set(rows.map((entry) => entry.revision))]
      revisions.forEach((revision, index) => onRevision?.(revision, index + 1, revisions.length))
      return Promise.resolve(ok({ repository: root.own === '' ? app : lib, rows }))
    }

    reviewed(root: SvnRoot, bounds: SvnBounds, revision: number): Promise<SvnResult<SvnLoggedRow[]>> {
      this.log.push(`reviewed ${root.own || '.'} r${revision} since ${bounds[root.own].since}`)
      const rows = this.confirmed[revision]
      return Promise.resolve(rows === undefined ? { ok: false, code: 'refused', detail: 'not here' } : ok(rows))
    }

    proven(root: SvnRoot): Promise<SvnResult<SvnLoggedRow[]>> {
      this.log.push(`proven ${root.own || '.'}`)
      return Promise.resolve(this.provenRows === null ? { ok: false, code: 'refused', detail: 'moved' } : ok(this.provenRows))
    }

    changedSince(root: SvnRoot): Promise<SvnResult<SvnLoggedRow[]>> {
      this.log.push(`changedSince ${root.own || '.'}`)
      return Promise.resolve(ok(this.since))
    }
  }

  const receipts = (...entries: [string, number | null, number][]): SessionRecord['commitReceipts'] =>
    entries.map(([scopeRoot, revision, at]) => ({ scopeRoot, revision, paths: [], at }))
  const parentWith = (commitReceipts: SessionRecord['commitReceipts']): SessionRecord => ({
    sessionId: 's1', kind: 'agent', title: 't', createdAt: 0, life: 'ended', binding: null, directory: { mode: 'default' }, commitReceipts,
  })
  const actionRoot = (changed: string[], own = ''): SvnActionRoot =>
    ({ path: own === '' ? worktree : mount, own, changed, bounds: bound(own === '' ? app : lib) })

  it('reads the commits of each root since the checkout, and the receipts of its split the log confirms', async () => {
    const svn = new FakeSvn()
    svn.roots_ = [{ path: mount, own: 'lib', changed: [] }, { path: worktree, own: '', changed: [] }]
    svn.own = { lib: [row(7, 'lib/a.ts')], '': [row(43, 'a.txt'), row(43, 'b.txt')] }
    svn.confirmed = { 44: [row(44, 'c.txt')] }

    expect(await new SvnRevisionLabels(svn).ownCommits(worktree,
      receipts([worktree, 44, 5], [worktree, null, 6], [worktree, 45, 7], ['Q:/elsewhere', 46, 8], [worktree, 40, 1]), 2))
      .toEqual(ok([
        { repository: app, revision: 43, label: 'base-proof' },
        { repository: app, revision: 44, label: 'receipt' },
        { repository: lib, revision: 7, label: 'base-proof' },
      ]))
    // A receipt is confirmed from the checkout on; only the worktree root had one, and only after `since`.
    expect(svn.log).toEqual(['lowerBounds .', 'reviewed . r44 since 0', 'reviewed . r45 since 0'])
  })

  it('names the root of each read it makes, so a mount names its mount', async () => {
    const svn = new FakeSvn()
    svn.roots_ = [{ path: mount, own: 'lib', changed: [] }, { path: worktree, own: '', changed: [] }]
    svn.own = { lib: [row(7, 'lib/a.ts')], '': [row(43, 'a.txt'), row(45, 'b.txt')] }
    svn.confirmed = { 44: [row(44, 'c.txt')] }
    const reads: SvnLabelsRead[] = []
    const labels = new SvnRevisionLabels(svn)

    const counted = await labels.ownCommits(worktree, receipts([worktree, 44, 5]), 2, (read) => reads.push(read))
    expect(reads.map((read) => {
      const step = SvnRevisionLabels.stepOf(read)
      return `${SessionStepWords.of(step.facts, step.progress).detail}`
    })).toEqual([
      'svn status -v --xml in lib',
      'svn log -v -r7 (1 of 1 revision) in lib',
      'svn status -v --xml',
      'svn log -v -r43 (1 of 2 revisions)',
      'svn log -v -r45 (2 of 2 revisions)',
      'svn log -v -r44',
    ])
    expect(reads.map((read) => read.root.own)).toEqual(['lib', 'lib', '', '', '', ''])
    expect(SvnRevisionLabels.stepOf(reads[1])).toEqual({
      facts: { kind: 'read', read: 'own-commits', revision: 7, mount: 'lib' }, progress: { done: 1, total: 1 },
    })
    expect(SessionStepWords.textOf(SvnRevisionLabels.stepOf(reads[5]).facts)).toBe('Confirming the commits from the session\'s split')
    expect(await labels.ownCommits(worktree, receipts([worktree, 44, 5]), 2)).toEqual(counted)
  })

  it('labels a review by its confirmed receipt first, else by the BASE proof, and an unreadable proof proves nothing', async () => {
    const svn = new FakeSvn()
    svn.confirmed = { 51: [row(51, 'a.txt')] }
    svn.provenRows = [row(52, 'a.txt')]
    const labels = new SvnRevisionLabels(svn)

    expect(await labels.afterReview(parentWith(receipts([worktree, 51, 10])), 5, actionRoot(['a.txt'])))
      .toEqual([{ repository: app, revision: 51, label: 'receipt' }])
    expect(await labels.afterReview(parentWith(receipts([worktree, 51, 3])), 5, actionRoot(['a.txt'])))
      .toEqual([{ repository: app, revision: 52, label: 'base-proof' }])
    svn.provenRows = null
    expect(await labels.afterReview(parentWith([]), 5, actionRoot(['a.txt']))).toEqual([])
    expect(await labels.afterReview(parentWith([]), 5, { ...actionRoot(['a.txt']), bounds: undefined })).toEqual([])
  })

  it('infers from the log only the revisions inside the paths the action saw changed', async () => {
    const svn = new FakeSvn()
    svn.since = [row(53, 'src/a.txt'), row(54, 'other/b.txt'), row(55, 'src')]

    expect(await new SvnRevisionLabels(svn).inferred(actionRoot(['src/a.txt'])))
      .toEqual([{ repository: app, revision: 53, label: 'inferred' }, { repository: app, revision: 55, label: 'inferred' }])
  })

  it('keeps one entry per repository and revision, a receipt over a proof over an inference', () => {
    const entry = (repository: string, revision: number, label: SvnLabelledRevision['label']): SvnLabelledRevision => ({ repository, revision, label })

    expect(SvnRevisionLabels.merged(
      [entry(lib, 7, 'inferred'), entry(app, 44, 'base-proof')],
      [entry(app, 44, 'receipt'), entry(app, 43, 'inferred'), entry(lib, 7, 'base-proof'), entry(app, 44, 'inferred')],
    )).toEqual([entry(app, 43, 'inferred'), entry(app, 44, 'receipt'), entry(lib, 7, 'base-proof')])
    expect(SvnRevisionLabels.textOf(entry(app, 44, 'receipt'))).toBe(`${app}:r44`)
  })
})
