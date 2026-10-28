import { describe, expect, it } from 'vitest'

import type { SvnBehindRoot, SvnLandingProof, SvnResult } from '../../svn/svn.types'
import type { SessionRecord } from '../../sessionManager/worktreeSessionRecords'
import type { SessionWorkflowInfo, SvnLabelledRevision } from '../../sessionManager/sessionManagerApi.types'
import { LandedRows, type LandedRowsPort } from './landedRows'

describe('lib-orchestrator/sessionManager/lifecycle/landedRows', () => {
  const ownerConst = 'Q:\\Work\\App'
  const appConst = 'https://svn.test/repos/app'
  const sharedConst = 'https://svn.test/repos/shared'
  const revision = (repository: string, number: number, label: SvnLabelledRevision['label'] = 'receipt'): SvnLabelledRevision =>
    ({ repository, revision: number, label })

  /** Root revisions by path, mount paths of the main copy, and the server distance; every read is logged. */
  function world() {
    const log: string[] = []
    const state = {
      proof: { ok: true, value: { holds: false, reason: 'app/a.ts still at r480 (conflict)' } } as SvnResult<SvnLandingProof>,
      behind: { ok: true, value: [{ own: '', behind: 3 }] } as SvnResult<SvnBehindRoot[]>,
      now: 1_000,
      /** The stamps of the main copy's working copies, one per read; the last one repeats. */
      stamps: [null] as (string | null)[],
    }
    const svn: LandedRowsPort = {
      landingProof: async (path, receipts) => { log.push(JSON.stringify({ path, receipts })); return state.proof },
      landingStamp: async () => state.stamps.length > 1 ? state.stamps.shift()! : state.stamps[0],
      behind: async (path) => {
        log.push(`behind ${path}`)
        return state.behind
      },
    }
    return { rows: new LandedRows({ svn, now: () => state.now }), log, state }
  }

  function retiredRecord(): SessionRecord {
    return {
      sessionId: 's1', kind: 'agent', title: '014 - fix', createdAt: 0, life: 'ended', binding: null, completed: true,
      directory: { mode: 'project', categoryId: 'work', projectPath: ownerConst },
      retiredWorktree: { worktreePath: `${ownerConst}\\.worktrees\\014-fix`, kind: 'svn', revisions: [], removedAt: 5, ownerDir: ownerConst },
    }
  }

  it('turns the tombstone of a committed ending into a landed row that is not completed', () => {
    const landed = LandedRows.retiredOf(retiredRecord(), ownerConst, [revision(appConst, 52), revision(appConst, 51, 'base-proof'), revision(appConst, 52, 'inferred')])

    expect(landed.completed).toBeUndefined()
    expect(landed.retiredWorktree).toMatchObject({ ownerDir: ownerConst, landed: [revision(appConst, 51, 'base-proof'), revision(appConst, 52)] })
    expect(LandedRows.landingOf(landed)).toEqual({ mainCopy: ownerConst, landed: landed.retiredWorktree?.landed })
    expect(LandedRows.landingOf(retiredRecord())).toBeNull()
    expect(() => LandedRows.retiredOf({ ...retiredRecord(), retiredWorktree: undefined }, ownerConst, [])).toThrow(/no removed worktree/)
  })

  it('waits for the newest revision of each repository only', () => {
    expect(LandedRows.newestOf([revision(appConst, 51), revision(sharedConst, 9), revision(appConst, 53, 'inferred'), revision(sharedConst, 8)]))
      .toEqual([revision(appConst, 53, 'inferred'), revision(sharedConst, 9)])
  })

  it('retains every older path obligation and the skipped-node diagnosis until all paths land', async () => {
    const h = world()
    const receipts = [{ ...revision(appConst, 49), paths: ['/trunk/older'] }, { ...revision(appConst, 51), paths: ['/trunk/newer'] }]
    expect(await h.rows.holds(ownerConst, receipts)).toBe(false)
    expect(JSON.parse(h.log[0]).receipts).toEqual(receipts)
    expect(h.rows.infoOf(ownerConst, receipts).reason).toBe('app/a.ts still at r480 (conflict)')
    h.state.proof = { ok: true, value: { holds: true } }
    expect(await h.rows.holds(ownerConst, receipts)).toBe(true)
    expect(h.rows.infoOf(ownerConst, receipts).reason).toBeUndefined()
    expect(await h.rows.holds(ownerConst, [])).toBe(true)
    expect(LandedRows.proofKey(ownerConst, receipts)).not.toBe(LandedRows.proofKey(ownerConst, receipts.slice(1)))
  })

  it('says which local state of the main copy keeps the landing unproven, what the person can do, and forgets it once proven', async () => {
    const h = world()
    const receipts = [revision(appConst, 51)]
    h.state.proof = { ok: true, value: { holds: false, reason: 'docs/gone.txt is locally deleted', local: { path: 'docs/gone.txt', item: 'deleted' } } }
    expect(await h.rows.holds(ownerConst, receipts)).toBe(false)
    expect(h.rows.infoOf(ownerConst, receipts).local).toEqual({ path: 'docs/gone.txt', item: 'deleted',
      summary: 'docs/gone.txt is locally deleted in the main copy, and an update does not change that, so the landing cannot be proven. '
        + 'Revert or commit the local delete in an SVN client. To accept it, Remove this row; the worktree result stays.' })
    h.state.proof = { ok: true, value: { holds: false, reason: 'docs/gone.txt still at r40 (normal)' } }
    expect(await h.rows.holds(ownerConst, receipts)).toBe(false)
    expect(h.rows.infoOf(ownerConst, receipts).local).toBeUndefined()
    h.state.proof = { ok: true, value: { holds: false, reason: 'x', local: { path: 'x', item: 'conflicted' } } }
    await h.rows.holds(ownerConst, receipts)
    h.rows.markStale(ownerConst)
    expect(h.rows.infoOf(ownerConst, receipts).local).toBeUndefined()
  })

  it('puts the local state on the summary of the UPDATE offer only while the offer waits', () => {
    const section = (kind: SessionWorkflowInfo['kind'], open = true): SessionWorkflowInfo =>
      ({ kind, workflowId: kind, title: kind, badge: 'update main copy', summary: 'Update the main copy now or leave this step for later', open, rounds: [], actions: [] })
    const local = { path: 'docs/gone.txt', item: 'deleted' as const, summary: 'docs/gone.txt is locally deleted in the main copy.' }
    const landing = { mainCopy: ownerConst, behind: 0, newest: [], local }
    const sections = [section('update-main', false), section('script'), section('update-main')]
    expect(LandedRows.offerOf(sections, landing, 'main-update').map((entry) => entry.summary))
      .toEqual(['Update the main copy now or leave this step for later', 'Update the main copy now or leave this step for later', local.summary])
    expect(LandedRows.offerOf(sections, landing, 'updating')).toBe(sections)
    expect(LandedRows.offerOf(sections, { ...landing, local: undefined }, 'main-update')).toBe(sections)
    expect(LandedRows.offerOf(sections, undefined, undefined)).toBe(sections)
  })

  it.each([
    ['added', 'is locally added', 'Revert or commit the local add'],
    ['replaced', 'is locally replaced', 'Revert or commit the local replace'],
    ['conflicted', 'is in conflict', 'Resolve the conflict'],
    ['obstructed', 'is obstructed', 'Move what is in its place away'],
    ['unversioned', 'is unversioned', 'Move the unversioned'],
    ['ignored', 'is unversioned and ignored', 'Move the unversioned'],
    ['external', 'is an external definition', 'svn:externals'],
    ['merged', 'is locally merged', 'Revert or commit the local merge'],
  ] as const)('words the local state %s', (item, state, advice) => {
    const summary = LandedRows.localSummaryOf({ path: 'a', item })
    expect(summary).toContain(`a ${state} in the main copy`)
    expect(summary).toContain(advice)
    expect(summary).not.toMatch(/[–—]/)
  })

  it('proves again only after an svn write moved the stamp of the working copies', async () => {
    const h = world()
    const receipts = [revision(appConst, 51)]
    h.state.stamps = ['s1']
    expect(await h.rows.holds(ownerConst, receipts)).toBe(false)
    expect(await h.rows.holds(ownerConst, receipts)).toBe(false)
    expect(h.log).toHaveLength(1)
    expect(h.rows.infoOf(ownerConst, receipts).reason).toBe('app/a.ts still at r480 (conflict)')
    h.state.proof = { ok: true, value: { holds: true } }
    h.state.stamps = ['s2']
    expect(await h.rows.holds(ownerConst, receipts)).toBe(true)
    expect(await h.rows.holds(ownerConst, receipts)).toBe(true)
    expect(h.log).toHaveLength(2)
    h.rows.markStale(ownerConst)
    expect(await h.rows.holds(ownerConst, receipts)).toBe(true)
    expect(h.log).toHaveLength(3)
  })

  it('keeps no answer proven while svn wrote, outside a working copy, or that failed', async () => {
    const h = world()
    const receipts = [revision(appConst, 51)]
    h.state.stamps = ['before', 'after', 'after']
    expect(await h.rows.holds(ownerConst, receipts)).toBe(false)
    expect(await h.rows.holds(ownerConst, receipts)).toBe(false)
    expect(h.log).toHaveLength(2)
    expect(await h.rows.holds(ownerConst, receipts)).toBe(false)
    expect(h.log).toHaveLength(2)

    h.state.stamps = [null]
    h.rows.markStale(ownerConst)
    for (let read = 0; read < 2; read++) await h.rows.holds(ownerConst, receipts)
    expect(h.log).toHaveLength(4)

    h.state.stamps = ['s3']
    h.state.proof = { ok: false, code: 'locked', detail: 'E155004: Working copy locked' }
    for (let read = 0; read < 2; read++) expect(await h.rows.holds(ownerConst, receipts)).toBeNull()
    expect(h.log).toHaveLength(6)
  })

  it('lets callers that ask while a proof runs share it', async () => {
    const receipts = [revision(appConst, 51)]
    const proofs: string[] = []
    let release = () => {}
    const blocked = new Promise<void>((done) => { release = done })
    const rows = new LandedRows({ now: () => 1_000, svn: {
      landingProof: async () => { proofs.push('proof'); await blocked; return { ok: true, value: { holds: false } } },
      landingStamp: async () => null,
      behind: async () => ({ ok: true, value: [] }),
    } })
    const asks = [rows.holds(ownerConst, receipts), rows.holds(ownerConst, receipts)]
    release()
    expect(await Promise.all(asks)).toEqual([false, false])
    expect(proofs).toHaveLength(1)
    expect(await rows.holds(ownerConst, receipts)).toBe(false)
    expect(proofs).toHaveLength(2)
  })

  it('answers unknown while per-path evidence cannot be read', async () => {
    const h = world()
    h.state.proof = { ok: false, code: 'svn-failed', detail: 'offline' }
    expect(await h.rows.holds(ownerConst, [revision(appConst, 51)])).toBeNull()
  })

  it('asks the poll for the local check at most every 10 s per main copy, and at once after an ending moved it', () => {
    const it_ = world()
    expect(it_.rows.claimHolds(ownerConst)).toBe(true)
    expect(it_.rows.claimHolds(ownerConst.toLowerCase())).toBe(false)
    it_.state.now += LandedRows.holdsRefreshMillisecondsConst
    expect(it_.rows.claimHolds(ownerConst)).toBe(true)
    it_.rows.markStale(ownerConst)
    expect(it_.rows.claimHolds(ownerConst)).toBe(true)
  })

  it('reads how far behind HEAD a main copy is once, again after an ending, and retries only a refused read', async () => {
    const it_ = world()
    const landed = [revision(appConst, 52), revision(appConst, 51)]
    expect(it_.rows.infoOf(ownerConst, landed)).toEqual({ mainCopy: ownerConst, behind: null, newest: [`${appConst}:r52`] })
    expect(it_.rows.behindDue(ownerConst)).toBe(true)
    expect(await it_.rows.refreshBehind(ownerConst)).toBe(true)
    expect(it_.rows.infoOf(ownerConst, landed).behind).toBe(3)
    expect(it_.rows.behindDue(ownerConst)).toBe(false)
    it_.state.now += 10 * LandedRows.behindRefreshMillisecondsConst
    expect(it_.rows.behindDue(ownerConst)).toBe(false)

    it_.rows.markStale(ownerConst)
    expect(it_.rows.behindDue(ownerConst)).toBe(true)
    it_.state.behind = { ok: false, code: 'svn-failed', detail: 'E170013: Unable to connect' }
    expect(await it_.rows.refreshBehind(ownerConst)).toBe(true)
    expect(it_.rows.infoOf(ownerConst, landed).behind).toBeNull()
    expect(it_.rows.behindDue(ownerConst)).toBe(false)
    it_.state.now += LandedRows.behindRefreshMillisecondsConst
    expect(it_.rows.behindDue(ownerConst)).toBe(true)

    it_.rows.retain([])
    expect(it_.rows.behindDue(ownerConst)).toBe(true)
  })

  it('counts the external working copies of a main copy too, and names each root that is behind', async () => {
    const it_ = world()
    const landed = [revision(sharedConst, 4)]
    it_.state.behind = { ok: true, value: [{ own: '', behind: 0 }, { own: 'lib/ea', behind: 1 }, { own: 'lib/eb', behind: 2 }] }
    expect(await it_.rows.refreshBehind(ownerConst)).toBe(true)
    expect(it_.rows.infoOf(ownerConst, landed)).toEqual({ mainCopy: ownerConst, behind: 3, newest: [`${sharedConst}:r4`],
      behindRoots: [{ root: 'lib/ea', behind: 1 }, { root: 'lib/eb', behind: 2 }] })

    it_.state.behind = { ok: true, value: [{ own: '', behind: 0 }, { own: 'lib/ea', behind: 2 }, { own: 'lib/eb', behind: 1 }] }
    expect(await it_.rows.refreshBehind(ownerConst)).toBe(true)
    it_.state.behind = { ok: true, value: [{ own: '', behind: 2 }, { own: 'lib/ea', behind: 0 }] }
    expect(await it_.rows.refreshBehind(ownerConst)).toBe(true)
    expect(it_.rows.infoOf(ownerConst, landed).behindRoots).toEqual([{ root: '.', behind: 2 }])
    it_.state.behind = { ok: true, value: [{ own: '', behind: 0 }, { own: 'lib/ea', behind: 0 }] }
    expect(await it_.rows.refreshBehind(ownerConst)).toBe(true)
    expect(it_.rows.infoOf(ownerConst, landed)).toEqual({ mainCopy: ownerConst, behind: 0, newest: [`${sharedConst}:r4`] })
  })
})
