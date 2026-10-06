import { describe, expect, it } from 'vitest'

import type { SessionsSnapshot } from './sessionManagerApi.types'
import { SessionsSnapshotValidation } from './sessionsSnapshotValidation'

/**
 * The one place a sessions snapshot crosses a PROCESS boundary and comes back as `unknown`: a peer
 * AppClientUI hands one over remote control, and it may be a different build. Everything the
 * compiler proves about `SessionsSnapshot` stops at that seam, which is why this file exists at all.
 *
 * It was written the day a field left `SessionInfo` and this validator still required it. Nothing
 * failed to compile, every unit test stayed green, and `smoke:remote-app` refused every connection:
 * the controller called the snapshot invalid, `synchronize` returned false, and the outbound entry
 * never reached `connected`.
 */
describe('lib-orchestrator/sessionManager/sessionsSnapshotValidation', () => {
  function snapshot(sessions: unknown[] = [session()]): unknown {
    return {
      revision: 1,
      reconciled: true,
      host: {
        presence: 'running',
        hostVersion: '2026.08.24',
        hostInstanceId: 'host-1',
        liveCount: 1,
        lastStartError: null,
      },
      categories: [],
      sessions,
      orphans: [],
    }
  }

  function session(overrides: Record<string, unknown> = {}): unknown {
    return {
      sessionId: 's1',
      kind: 'shell',
      title: '015 - wizard',
      tabTitle: 'AppJamatV3 - 015',
      titleParts: { number: '015', name: 'wizard' },
      directory: { mode: 'default' },
      project: { kind: 'adHoc', path: 'Q:\work' },
      life: 'live',
      activity: null,
      admits: ['reopen'],
      ...overrides,
    }
  }

  it('takes a snapshot shaped the way this build composes one', () => {
    expect(SessionsSnapshotValidation.parse(snapshot())).not.toBeNull()
  })

  /*
   * The peer may be an older build, and a client that refuses a snapshot for carrying a field it no
   * longer reads is a client that cannot talk to yesterday's. Extra members are ignored.
   */
  it('takes a snapshot from a build that still sends fields this one dropped', () => {
    const older = snapshot([session({ outputSeq: 12, lastOutputAt: 5_000, somethingNew: true })])

    const parsed = SessionsSnapshotValidation.parse(older) as SessionsSnapshot | null

    expect(parsed).not.toBeNull()
    expect(parsed?.sessions).toHaveLength(1)
  })

  it('takes the optional background detail and refuses it outside working activity', () => {
    expect(SessionsSnapshotValidation.parse(snapshot([
      session({ kind: 'agent', activity: 'working', activityDetail: 'background' }),
    ]))).not.toBeNull()
    expect(SessionsSnapshotValidation.parse(snapshot([
      session({ kind: 'agent', activity: 'idle', activityDetail: 'background' }),
    ]))).toBeNull()
    expect(SessionsSnapshotValidation.parse(snapshot([
      session({ kind: 'agent', activity: 'working', activityDetail: 'foreground' }),
    ]))).toBeNull()
  })

  it('refuses a session missing a field this build does read', () => {
    for (const field of ['sessionId', 'kind', 'title', 'tabTitle', 'life', 'admits']) {
      const broken = { ...(session() as Record<string, unknown>) }
      delete broken[field]
      expect(SessionsSnapshotValidation.parse(snapshot([broken])), field).toBeNull()
    }
  })

  it('accepts optional compaction only as foreground working activity', () => {
    const current = snapshot([
      session({ kind: 'agent', activity: 'working', compacting: true }),
    ])
    expect(SessionsSnapshotValidation.parse(current)).not.toBeNull()
    for (const fields of [
      { activity: 'idle', compacting: true },
      { activity: 'working', compacting: false },
      { activity: 'working', compacting: 'true' },
      { activity: 'working', compacting: true, activityDetail: 'background' },
    ])
      expect(SessionsSnapshotValidation.parse(snapshot([session(fields)]))).toBeNull()
  })

  it('validates every optional worktree field before a caller reads its path', () => {
    const worktree = {
      worktreePath: 'Q:\\worktrees\\one',
      branch: 'session/one',
      baseCommit: 'abc123',
      diff: { added: 1, removed: 2, changedFiles: 3, capturedAt: 4 },
      baseMoved: false,
    }
    expect(SessionsSnapshotValidation.parse(snapshot([session({ worktree })]))).not.toBeNull()
    for (const invalid of [
      null,
      {},
      { ...worktree, worktreePath: null },
      { ...worktree, worktreePath: '' },
      { ...worktree, branch: 1 },
      { ...worktree, baseCommit: false },
      { ...worktree, baseMoved: 'false' },
      { ...worktree, diff: {} },
      { ...worktree, diff: { ...worktree.diff, changedFiles: -1 } },
    ])
      expect(SessionsSnapshotValidation.parse(snapshot([session({ worktree: invalid })])))
        .toBeNull()
  })

  /*
   * An older peer requires `branch` and `baseCommit` as non-empty strings and ignores keys it does
   * not know, which is why SVN fills them with the URL and `r<rev>` rather than leaving them out.
   * This build's worktree check is those rules plus the kind, so a pass here is a pass there.
   */
  it('takes an SVN worktree and a tombstone, and reads a worktree without a kind as git', () => {
    const svn = {
      worktreePath: 'Q:\\repo\\.worktrees\\014-fix',
      branch: 'https://svn.example.test/repos/app/trunk',
      baseCommit: 'r41',
      kind: 'svn',
      diff: null,
      baseMoved: false,
    }
    const older = { ...svn, branch: 'session/one', baseCommit: 'abc123', kind: undefined }
    const retiredWorktree = { worktreePath: 'Q:\\repo\\.worktrees\\013-old', revisions: ['https://svn.example.test/repos/app:r40'] }

    const parsed = SessionsSnapshotValidation.parse(snapshot([
      session({ sessionId: 's1', worktree: svn }),
      session({ sessionId: 's2', worktree: older }),
      session({ sessionId: 's3', retiredWorktree }),
    ]))

    expect(parsed?.sessions.map((entry) => entry.worktree?.kind)).toEqual(['svn', 'git', undefined])
    expect(parsed?.sessions[2]?.retiredWorktree).toEqual(retiredWorktree)
  })

  // An older peer composed no choices; its library offered by kind alone, and so does this reading.
  it('composes the Finish choices an older peer did not send, and takes the ones a peer did', () => {
    const svn = {
      worktreePath: 'Q:\\repo\\.worktrees\\014-fix', branch: 'https://svn.example.test/repos/app/trunk', baseCommit: 'r41',
      kind: 'svn', diff: null, baseMoved: false,
    }
    const git = { ...svn, branch: 'session/one', baseCommit: 'abc123', kind: undefined }
    const legacy = { ...git, kind: 'git', choices: ['keep', 'discard'] }

    const parsed = SessionsSnapshotValidation.parse(snapshot([
      session({ sessionId: 's1', worktree: svn }),
      session({ sessionId: 's2', worktree: git }),
      session({ sessionId: 's3', worktree: legacy }),
    ]))

    expect(parsed?.sessions.map((entry) => entry.worktree?.choices))
      .toEqual([['commit', 'keep', 'discard'], ['merge', 'keep', 'discard'], ['keep', 'discard']])
  })

  // The tree draws a badge per finish phase and per result, and a value it does not know throws there.
  it('takes a running finish and an outcome only in the vocabulary this build draws', () => {
    const worktree = {
      worktreePath: 'Q:\\wt', branch: 'https://svn.example.test/repos/app/trunk', baseCommit: 'r1', kind: 'svn',
      choices: ['commit', 'keep', 'discard'], diff: null, baseMoved: false,
    }
    const outcome = { result: 'partial', revisions: ['https://svn.example.test/repos/app:r2'], main: 'updated', worktree: 'kept', lines: ['PARTIAL'], at: 1 }
    expect(SessionsSnapshotValidation.parse(snapshot([session({
      worktree: { ...worktree, finish: { phase: 'reviewing', scopeRoot: 'Q:\\wt' }, outcome },
    })]))).not.toBeNull()
    const cleanup = { phase: 'pending', reason: 'in use', summary: 'waiting to remove (in use)' }
    expect(SessionsSnapshotValidation.parse(snapshot([session({ worktree: { ...worktree, cleanup } })]))).not.toBeNull()
    for (const invalid of [
      { ...worktree, cleanup: { ...cleanup, phase: 'removed' } },
      { ...worktree, cleanup: { ...cleanup, reason: 3 } },
      { ...worktree, cleanup: { phase: 'kept' } },
      { ...worktree, choices: ['push'] },
      { ...worktree, finish: { phase: 'pushing' } },
      { ...worktree, outcome: { ...outcome, result: 'shipped' } },
      { ...worktree, outcome: { ...outcome, worktree: 'gone' } },
      { ...worktree, outcome: { ...outcome, lines: [1] } },
    ])
      expect(SessionsSnapshotValidation.parse(snapshot([session({ worktree: invalid })]))).toBeNull()
  })

  it('refuses an unknown worktree kind and a tombstone it cannot read', () => {
    const worktree = { worktreePath: 'Q:\\wt', branch: 'b', baseCommit: 'r1', diff: null, baseMoved: false }
    expect(SessionsSnapshotValidation.parse(snapshot([session({ worktree: { ...worktree, kind: 'hg' } })])))
      .toBeNull()
    for (const invalid of [null, {}, { worktreePath: '', revisions: [] }, { worktreePath: 'Q:\\wt', revisions: [1] }])
      expect(SessionsSnapshotValidation.parse(snapshot([session({ retiredWorktree: invalid })])))
        .toBeNull()
  })

  it('refuses anything that is not a snapshot at all', () => {
    for (const value of [null, undefined, 42, 'snapshot', [], {}])
      expect(SessionsSnapshotValidation.parse(value), JSON.stringify(value ?? null)).toBeNull()
  })
})
