import { describe, expect, it } from 'vitest'

import type { SvnResult } from '../../svn/svn.types'
import type { SessionRecord } from '../records/sessionRecord.types'
import type { SvnLabelledRevision } from '../sessionManagerApi.types'
import { LandedRows, type LandedRowsPort } from './landedRows'

describe('lib-orchestrator/sessionManager/lifecycle/landedRows', () => {
  const ownerConst = 'Q:\\Work\\App'
  const mountConst = `${ownerConst}\\shared\\frontend`
  const appConst = 'https://svn.test/repos/app'
  const sharedConst = 'https://svn.test/repos/shared'
  const revision = (repository: string, number: number, label: SvnLabelledRevision['label'] = 'receipt'): SvnLabelledRevision =>
    ({ repository, revision: number, label })

  /** Root revisions by path, mount paths of the main copy, and the server distance; every read is logged. */
  function world() {
    const log: string[] = []
    const roots = new Map<string, SvnResult<{ repository: string; revision: number }>>([
      [ownerConst, { ok: true, value: { repository: appConst, revision: 50 } }],
      [mountConst, { ok: true, value: { repository: sharedConst, revision: 7 } }],
    ])
    const state = {
      mounts: { ok: true, value: [mountConst] } as SvnResult<string[]>,
      behind: { ok: true, value: 3 } as SvnResult<number>,
      now: 1_000,
    }
    const svn: LandedRowsPort = {
      rootRevisionOf: async (path) => {
        log.push(`info ${path}`)
        return roots.get(path) ?? { ok: false, code: 'not-a-working-copy', detail: `${path} is no working copy` }
      },
      mountRootsOf: async (path) => {
        log.push(`mounts ${path}`)
        return state.mounts
      },
      behind: async (path) => {
        log.push(`behind ${path}`)
        return state.behind
      },
    }
    return { rows: new LandedRows({ svn, now: () => state.now }), log, roots, state }
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

  it('holds once the owner root is at or past the newest landed revision, which an update from any client brings', async () => {
    const it_ = world()
    expect(await it_.rows.holds(ownerConst, [revision(appConst, 49), revision(appConst, 51)])).toBe(false)
    it_.roots.set(ownerConst, { ok: true, value: { repository: appConst, revision: 51 } })
    expect(await it_.rows.holds(ownerConst, [revision(appConst, 49), revision(appConst, 51)])).toBe(true)
    // Its own repository needs no mount listing.
    expect(it_.log.filter((entry) => entry.startsWith('mounts'))).toEqual([])
    expect(await it_.rows.holds(ownerConst, [])).toBe(true)
  })

  it('reads a landed revision of an external repository at the mount root, and keeps the row without such a mount', async () => {
    const it_ = world()
    expect(await it_.rows.holds(ownerConst, [revision(sharedConst, 8)])).toBe(false)
    it_.roots.set(mountConst, { ok: true, value: { repository: sharedConst, revision: 8 } })
    expect(await it_.rows.holds(ownerConst, [revision(sharedConst, 8)])).toBe(true)
    // The mount listing is read once and held; the mount's revision is read each time.
    expect(it_.log.filter((entry) => entry.startsWith('mounts'))).toEqual([`mounts ${ownerConst}`])
    expect(await it_.rows.holds(ownerConst, [revision('https://svn.test/repos/other', 1)])).toBe(false)
  })

  it('answers unknown while svn cannot read the main copy or its mounts', async () => {
    const it_ = world()
    it_.roots.delete(ownerConst)
    expect(await it_.rows.holds(ownerConst, [revision(appConst, 51)])).toBeNull()
    const mounts = world()
    mounts.state.mounts = { ok: false, code: 'svn-failed', detail: 'status failed' }
    expect(await mounts.rows.holds(ownerConst, [revision(sharedConst, 1)])).toBeNull()
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

  it('reads how far behind HEAD a main copy is every 10 minutes, as null while offline or unread', async () => {
    const it_ = world()
    const landed = [revision(appConst, 52), revision(appConst, 51)]
    expect(it_.rows.infoOf(ownerConst, landed)).toEqual({ mainCopy: ownerConst, behind: null, newest: [`${appConst}:r52`] })
    expect(it_.rows.behindDue(ownerConst)).toBe(true)
    expect(await it_.rows.refreshBehind(ownerConst)).toBe(true)
    expect(it_.rows.infoOf(ownerConst, landed).behind).toBe(3)
    expect(it_.rows.behindDue(ownerConst)).toBe(false)
    expect(await it_.rows.refreshBehind(ownerConst)).toBe(false)

    it_.state.now += LandedRows.behindRefreshMillisecondsConst
    expect(it_.rows.behindDue(ownerConst)).toBe(true)
    it_.state.behind = { ok: false, code: 'svn-failed', detail: 'E170013: Unable to connect' }
    expect(await it_.rows.refreshBehind(ownerConst)).toBe(true)
    expect(it_.rows.infoOf(ownerConst, landed).behind).toBeNull()

    it_.rows.retain([])
    expect(it_.rows.behindDue(ownerConst)).toBe(true)
  })
})
