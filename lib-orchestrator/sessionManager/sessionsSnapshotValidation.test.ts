import { describe, expect, it } from 'vitest'

import type { SessionsSnapshot } from './sessionManagerApi.types'
import { SessionsSnapshotValidation310 } from './fixtures/sessionsSnapshotValidation310'
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

  /*
   * An older peer sends only the legacy setup fields, and the tree of this build reads the new ones:
   * the link nests the install under its parent, and the badge says what the parent waits for.
   */
  it('turns the legacy setup fields of an older peer into the script link and the badge', () => {
    const parsed = SessionsSnapshotValidation.parse(snapshot([
      session({ sessionId: 'parent', life: 'starting', setup: { state: 'running', setupSessionId: 'install', commands: ['pnpm install'] } }),
      session({ sessionId: 'install', setupFor: 'parent' }),
      session({ sessionId: 'resolver', resolveFor: 'parent' }),
    ]))

    expect(parsed?.sessions[1]?.script).toEqual({ parentId: 'parent', phase: 'before', scriptId: 'setup' })
    expect(parsed?.sessions[2]?.script).toEqual({ parentId: 'parent', phase: 'after', scriptId: 'merge-resolve' })
    expect(parsed?.sessions[0]?.scripts).toEqual({
      runs: [],
      badge: {
        phase: 'before',
        state: 'running',
        text: 'installing dependencies',
        title: 'Installing dependencies:\npnpm install',
        runId: 'install',
      },
      waitingOn: 'install',
    })
  })

  it('keeps the script fields this build composes as they are', () => {
    const run = {
      runId: 'install', phase: 'before', scriptId: 'setup', name: 'setup', title: 'Setup 012', state: 'failed',
      summary: 'Setup 012 · failed · exit 1 · 2.0 s', startedAt: 1, endedAt: 2_001, durationText: '2.0 s', exitCode: 1,
      commands: ['pnpm install'], row: true, log: 'unavailable', logDetail: 'the Host never ran it',
    }
    const scripts = { runs: [run], badge: { phase: 'before', state: 'failed', text: 'setup failed', title: 'Setup failed', runId: 'install' } }
    const script = { parentId: 'parent', phase: 'before', scriptId: 'setup' }

    const parsed = SessionsSnapshotValidation.parse(snapshot([
      session({ sessionId: 'parent', scripts, setup: { state: 'failed', setupSessionId: 'install', commands: [] } }),
      session({ sessionId: 'install', script, setupFor: 'parent' }),
    ]))

    expect(parsed?.sessions[0]?.scripts).toEqual(scripts)
    expect(parsed?.sessions[1]?.script).toEqual(script)
  })

  // A newer peer's new value costs the field it is in, never the snapshot.
  it('drops an unknown setup state, script phase, badge state or run, and never throws on one', () => {
    const run = {
      runId: 'r', phase: 'before', scriptId: 'setup', name: 'setup', title: 'Setup', state: 'running',
      summary: 'Setup · running', startedAt: 1, commands: [], row: true, log: 'none',
    }
    const parsed = SessionsSnapshotValidation.parse(snapshot([
      session({ sessionId: 'a', setup: { state: 'queued', setupSessionId: 'x', commands: [] } }),
      session({ sessionId: 'b', script: { parentId: 'a', phase: 'during', scriptId: 'hook' } }),
      session({ sessionId: 'c', script: { parentId: 'a', phase: 'during', scriptId: 'hook' }, setupFor: 'a' }),
      session({
        sessionId: 'd',
        scripts: {
          runs: [run, { ...run, runId: 'q', state: 'queued' }, { ...run, runId: 'i', phase: 'during' }, null],
          badge: { phase: 'before', state: 'paused', text: 'paused', title: 'Paused' },
          waitingOn: 7,
        },
      }),
      session({ sessionId: 'e', scripts: 'everything' }),
    ]))

    expect(parsed).not.toBeNull()
    expect(parsed?.sessions[0]?.setup).toBeUndefined()
    expect(parsed?.sessions[0]?.scripts).toBeUndefined()
    expect(parsed?.sessions[1]?.script).toBeUndefined()
    // Every run but the resolver still carries `setupFor`, which keeps it nested.
    expect(parsed?.sessions[2]?.script).toEqual({ parentId: 'a', phase: 'before', scriptId: 'setup' })
    expect(parsed?.sessions[3]?.scripts).toEqual({ runs: [run] })
    expect(parsed?.sessions[4]?.scripts).toBeUndefined()
  })

  it('keeps a requested run and its link', () => {
    const run = {
      runId: 'r', phase: 'inner', scriptId: 'requested', name: 'tests', title: 'tests', state: 'failed',
      summary: 'tests · failed · exit 1 · 2 s', startedAt: 1, endedAt: 3, exitCode: 1, commands: ['pnpm test'],
      row: true, log: 'saved',
    }
    const script = { parentId: 'parent', phase: 'inner', scriptId: 'requested' }
    const parsed = SessionsSnapshotValidation.parse(snapshot([
      session({ sessionId: 'parent', scripts: { runs: [run] } }),
      session({ sessionId: 'r', script, setupFor: 'parent' }),
    ]))

    expect(parsed?.sessions[0]?.scripts).toEqual({ runs: [run] })
    expect(parsed?.sessions[1]?.script).toEqual(script)
  })

  it('refuses anything that is not a snapshot at all', () => {
    for (const value of [null, undefined, 42, 'snapshot', [], {}])
      expect(SessionsSnapshotValidation.parse(value), JSON.stringify(value ?? null)).toBeNull()
  })

  // A 3.11 snapshot reaches peers of 3.10 as well; the fixture is that build's own validator.
  it('composes an SVN action a 3.10 peer still accepts, and drops what this build cannot draw', () => {
    const worktree = {
      worktreePath: 'Q:/work/.worktrees/014-fix', branch: 'https://svn/repo/trunk', baseCommit: 'r41', kind: 'svn',
      choices: ['commit', 'keep', 'discard'], diff: null, baseMoved: false, liveFinish: true,
      finish: { phase: 'reviewing', scopeRoot: 'Q:/work/.worktrees/014-fix' },
    }
    const svnAction = { kind: 'finish', stage: 'cleaning', needs: null, needsKind: null, review: null }
    const run = (runId: string, scriptId: string) => ({
      runId, phase: 'after', scriptId, name: 'update', title: 'svn update 014-fix', state: 'running', summary: 'svn update 014-fix · running',
      startedAt: 1, commands: ['svn update'], row: true, log: 'none',
    })
    const parent = session({ sessionId: 'p', worktree, svnAction, scripts: { runs: [run('r1', 'svn'), run('r2', 'future-kind')] } })
    const child = session({ sessionId: 'r1', setupFor: 'p', script: { parentId: 'p', phase: 'after', scriptId: 'future-kind' } })

    expect(SessionsSnapshotValidation310.parse(snapshot([parent, child]))).not.toBeNull()
    const parsed = SessionsSnapshotValidation.parse(snapshot([parent, child]))
    expect(parsed?.sessions[0]?.svnAction).toEqual(svnAction)
    expect(parsed?.sessions[0]?.worktree?.liveFinish).toBe(true)
    expect(parsed?.sessions[0]?.scripts?.runs.map((entry) => entry.runId)).toEqual(['r1'])
    expect(parsed?.sessions[1]?.script).toEqual({ parentId: 'p', phase: 'before', scriptId: 'setup' })

    const damaged = SessionsSnapshotValidation.parse(snapshot([session({ worktree: { ...worktree, liveFinish: 'yes' },
      svnAction: { ...svnAction, stage: 'landing' } })]))
    expect(damaged?.sessions[0]?.svnAction).toBeUndefined()
    expect(damaged?.sessions[0]?.worktree?.liveFinish).toBeUndefined()
  })

  it('draws a resolver run and an action that waits on its verification, which a 3.10 peer still accepts', () => {
    const worktree = {
      worktreePath: 'Q:/work/.worktrees/014-fix', branch: 'https://svn/repo/trunk', baseCommit: 'r41', kind: 'svn',
      choices: ['commit', 'keep', 'discard'], diff: null, baseMoved: false, finish: { phase: 'updating' },
    }
    const svnAction = { kind: 'finish', stage: 'verifying', needs: 'the resolver left conflicts in: a.txt', needsKind: 'resolver-failed', review: null }
    const resolverRun = {
      runId: 'r1', phase: 'after', scriptId: 'svn-resolve', name: 'resolver', title: 'Resolve conflicts 014-fix', state: 'succeeded',
      summary: 'Resolve conflicts 014-fix · succeeded', startedAt: 1, commands: [], row: true, log: 'none',
    }
    const parent = session({ sessionId: 'p', worktree, svnAction, scripts: { runs: [resolverRun] } })

    expect(SessionsSnapshotValidation310.parse(snapshot([parent]))).not.toBeNull()
    const parsed = SessionsSnapshotValidation.parse(snapshot([parent]))
    expect(parsed?.sessions[0]?.svnAction).toEqual(svnAction)
    expect(parsed?.sessions[0]?.scripts?.runs.map((entry) => entry.scriptId)).toEqual(['svn-resolve'])
  })

  it('draws a landed row and an UPDATE with its diff run, which a 3.10 peer still accepts, and drops a landing it cannot read', () => {
    const landing = { mainCopy: 'Q:/work', behind: 3, newest: ['https://svn/repo:r52'] }
    const retiredWorktree = { worktreePath: 'Q:/work/.worktrees/014-fix', revisions: ['https://svn/repo:r52'], landing }
    const svnAction = { kind: 'update-main', stage: 'diffing', needs: null, needsKind: null, review: null }
    const diffRun = {
      runId: 'r1', phase: 'after', scriptId: 'svn', name: 'diff', title: 'svn diff work', state: 'running',
      summary: 'svn diff work · running', startedAt: 1, commands: ['svn diff -- a.txt@'], row: true, log: 'none',
    }
    const landed = session({ sessionId: 'p', life: 'ended', retiredWorktree, svnAction, admits: ['newBeside', 'updateMain', 'remove'],
      scripts: { runs: [diffRun] } })
    const unknown = session({ sessionId: 'q', life: 'ended', retiredWorktree: { ...retiredWorktree, landing: { ...landing, behind: null } } })

    expect(SessionsSnapshotValidation310.parse(snapshot([landed, unknown]))).not.toBeNull()
    const parsed = SessionsSnapshotValidation.parse(snapshot([landed, unknown]))
    expect(parsed?.sessions[0]?.retiredWorktree?.landing).toEqual(landing)
    expect(parsed?.sessions[0]?.svnAction).toEqual(svnAction)
    expect(parsed?.sessions[1]?.retiredWorktree?.landing?.behind).toBeNull()

    const damaged = SessionsSnapshotValidation.parse(snapshot([session({ retiredWorktree: { ...retiredWorktree, landing: { ...landing, behind: -1 } } })]))
    expect(damaged?.sessions[0]?.retiredWorktree).toEqual({ worktreePath: retiredWorktree.worktreePath, revisions: retiredWorktree.revisions })
  })
})
