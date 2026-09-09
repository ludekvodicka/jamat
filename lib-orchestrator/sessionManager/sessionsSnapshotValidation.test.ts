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

  it('refuses anything that is not a snapshot at all', () => {
    for (const value of [null, undefined, 42, 'snapshot', [], {}])
      expect(SessionsSnapshotValidation.parse(value), JSON.stringify(value ?? null)).toBeNull()
  })
})
