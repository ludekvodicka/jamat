import { WorktreeWords } from '../worktrees/worktreeViews'
import type { WorktreeLifecycle } from '../worktrees/worktreeState'
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

  it('accepts the optional lifecycle view on current and 3.10 peers, dropping only malformed views', () => {
    const worktreeView = { version: 12, phase: 'finishing', step: 'committing', outOfDate: 0, conflicts: 0, summary: 'finishing/committing v12' }
    const good = snapshot([session({ worktreeView })])
    expect(SessionsSnapshotValidation310.parse(good)).not.toBeNull()
    expect(SessionsSnapshotValidation.parse(good)?.sessions[0].worktreeView).toEqual(worktreeView)
    for (const bad of [null, 'bad', { ...worktreeView, version: -1 }, { ...worktreeView, phase: 'future' },
      { ...worktreeView, step: undefined }, { ...worktreeView, wait: { kind: 'future', reason: '', at: 1 } }]) {
      const parsed = SessionsSnapshotValidation.parse(snapshot([session({ worktreeView: bad })]))
      expect(parsed?.sessions).toHaveLength(1)
      expect(parsed?.sessions[0].sessionId).toBe('s1')
      expect(parsed?.sessions[0].worktreeView).toBeUndefined()
    }
  })

  it('takes a snapshot shaped the way this build composes one', () => {
    expect(SessionsSnapshotValidation.parse(snapshot())).not.toBeNull()
  })

  it('retains the generated worktree presentation across the peer boundary', () => {
    const state: WorktreeLifecycle = { version: 12, actionId: 'finish', phase: 'waiting', step: 'reviewing',
      wait: { kind: 'review', reason: 'Validate the prepared application', at: 1 }, outOfDate: 0, journal: [],
      preparation: { format: 1, manifest: 'manifest', content: 'content', metadata: 'metadata', commands: 'commands', checks: 'none', checkedAt: 1, attempt: 1 },
      facts: { worker: { liveness: 'alive', resumeFailures: 0 } } }
    const worktreeView = { ...WorktreeWords.presentation(state), version: state.version, phase: state.phase,
      step: state.step, wait: state.wait, outOfDate: 0, conflicts: 0, summary: 'waiting/reviewing v12' }
    const parsed = SessionsSnapshotValidation.parse(JSON.parse(JSON.stringify(snapshot([session({ worktreeView })]))))
    expect(parsed?.sessions[0].worktreeView).toEqual(worktreeView)
    expect(parsed?.sessions[0].worktreeView?.title).toBe('Ready for validation')
    expect(parsed?.sessions[0].worktreeView?.actions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'discard' })]))
  })

  it('accepts bounded working-agent names and drops only malformed optional names', () => {
    const good = snapshot() as SessionsSnapshot
    good.host.workingAgents = ['Claude worker', 'Codex worker']
    expect(SessionsSnapshotValidation.parse(good)?.host.workingAgents).toEqual(good.host.workingAgents)
    for (const names of [null, 'worker', [42], ['x'.repeat(1025)], Array(1025).fill('worker')]) {
      const value = snapshot() as { host: Record<string, unknown> }
      value.host.workingAgents = names
      const parsed = SessionsSnapshotValidation.parse(value)
      expect(parsed?.sessions).toHaveLength(1)
      expect(parsed?.host.workingAgents).toBeUndefined()
    }
  })

  it('drops only a malformed actions section and accepts the sections on an older peer', () => {
    const section = { kind: 'before', workflowId: 'setup:s1', title: 'Setup', badge: 'done', summary: 'Done',
      open: false, rounds: [], actions: [] }
    const value = snapshot([session({ actions: { sections: [section, { ...section, kind: 'unknown' }, { ...section, workflowId: 'second' }] } })])
    expect(SessionsSnapshotValidation310.parse(value)).not.toBeNull()
    expect(SessionsSnapshotValidation.parse(value)?.sessions[0].actions?.sections.map((entry) => entry.workflowId))
      .toEqual(['setup:s1', 'second'])
  })

  it('drops unknown or malformed bodies without dropping the step or section', () => {
    const bodies = [{ kind: 'log', runId: 'r1' }, { kind: 'conflicts' }, { kind: 'log' }, { kind: 'future' }]
    const section = { kind: 'finish', workflowId: 'a1', title: 'Finish', badge: 'runs', summary: '', open: true,
      actions: [], rounds: [{ title: 'Finish', steps: bodies.map((body, index) => ({ key: String(index), title: 'Step',
        detail: '', state: 'done', startedAt: null, endedAt: null, target: { kind: 'none' }, body })) }] }
    const parsed = SessionsSnapshotValidation.parse(snapshot([session({ actions: { sections: [section] }, workflow: section })]))
    for (const workflow of [parsed?.sessions[0].workflow, parsed?.sessions[0].actions?.sections[0]]) {
      expect(workflow?.rounds[0].steps).toHaveLength(4)
      expect(workflow?.rounds[0].steps.map((step) => step.body)).toEqual([bodies[0], bodies[1], undefined, undefined])
    }
  })

  it('keeps the Resume worker press of a lost worker with its command (UA1-J14R-3)', () => {
    const resume = { id: 'resume-worker', label: 'Resume worker', primary: true, place: 'step' }
    const section = { kind: 'finish', workflowId: 'worker-lost:9', title: 'Worker of W', badge: 'Worker needs to be resumed', summary: '', open: true,
      actions: [resume], rounds: [] }
    const parsed = SessionsSnapshotValidation.parse(snapshot([session({ actions: { sections: [section] } })]))?.sessions[0].actions?.sections[0]
    expect(parsed?.actions).toEqual([{ ...resume, command: { operation: 'sessions.reopen', body: {} } }])
  })

  it('keeps the sessions body and requires explicit live IDs on Update, dropping only malformed additive fields', () => {
    const body = { kind: 'sessions', sessions: [{ sessionId: 'one', title: 'Coordinator', number: '021' }] }
    const update = { id: 'update-main', label: 'Update', primary: true, confirmLive: ['one'] }
    const section = { kind: 'update-main', workflowId: 'a1', title: 'Update', badge: 'waits', summary: '', open: true,
      actions: [update, { ...update, confirmLive: undefined }, { ...update, confirmLive: [3] }, { id: 'later', label: 'Later', primary: false, deferred: 'Left for later.' },
        { id: 'later', label: 'Later', primary: false, deferred: 3 }],
      rounds: [{ title: 'Update', steps: [body, { ...body, sessions: [{ sessionId: 'one', title: 'bad', number: 3 }] }].map((body, index) => ({
        key: String(index), title: 'Update', detail: '', state: 'waits', startedAt: null, endedAt: null, target: { kind: 'none' }, body,
      })) }] }
    const value = snapshot([session({ actions: { sections: [section] } })])
    expect(SessionsSnapshotValidation310.parse(value)).not.toBeNull()
    const parsed = SessionsSnapshotValidation.parse(value)?.sessions[0].actions?.sections[0]
    expect(parsed?.actions).toEqual([update, section.actions[3]].map((action) => ({ ...action, command: WorktreeWords.command(action as never) })))
    expect(parsed?.rounds[0].steps.map((step) => step.body)).toEqual([body, undefined])
  })

  /*
   * The peer may be an older build, and a client that refuses a snapshot for carrying a field it no
   * longer reads is a client that cannot talk to yesterday's. Extra members are ignored.
   */
  it('takes the Host memory reading when it is absent, null or well formed', () => {
    const reading = { lines: ['Memory 812 MB (heap 120 MB), up 2 d 4 h'], warning: null, suffix: null }
    for (const memory of [undefined, null, reading]) {
      const value = snapshot() as { host: Record<string, unknown> }
      if (memory !== undefined) value.host.memory = memory
      const parsed = SessionsSnapshotValidation.parse(value)
      expect(parsed, JSON.stringify(memory)).not.toBeNull()
      expect(parsed?.host.memory, JSON.stringify(memory)).toEqual(memory)
    }
  })

  it('drops a malformed Host memory reading and keeps the snapshot', () => {
    for (const memory of ['812 MB', { lines: 'one line', warning: null, suffix: null },
      { lines: [1], warning: null, suffix: null }, { lines: [], warning: 5, suffix: null }, { lines: [], warning: null }]) {
      const value = snapshot() as { host: Record<string, unknown> }
      value.host.memory = memory
      const parsed = SessionsSnapshotValidation.parse(value)
      expect(parsed, JSON.stringify(memory)).not.toBeNull()
      expect(parsed?.host, JSON.stringify(memory)).not.toHaveProperty('memory')
      expect(parsed?.host.liveCount).toBe(1)
    }
  })

  it('takes a snapshot from a build that still sends fields this one dropped', () => {
    const older = snapshot([session({ outputSeq: 12, lastOutputAt: 5_000, somethingNew: true })])

    const parsed = SessionsSnapshotValidation.parse(older) as SessionsSnapshot | null

    expect(parsed).not.toBeNull()
    expect(parsed?.sessions).toHaveLength(1)
  })

  it('takes a session with or without the create operation id, and null as sessions.list sends it', () => {
    for (const fields of [{}, { callerOperationId: 'op-1' }, { callerOperationId: null }])
      expect(SessionsSnapshotValidation.parse(snapshot([session(fields)])), JSON.stringify(fields)).not.toBeNull()
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
    const parent = session({ sessionId: 'p', worktree, svnAction, worktreeView: { phase: 'unknown' }, scripts: { runs: [run('r1', 'svn'), run('r2', 'future-kind')] } })
    const child = session({ sessionId: 'r1', setupFor: 'p', script: { parentId: 'p', phase: 'after', scriptId: 'future-kind' } })

    expect(SessionsSnapshotValidation310.parse(snapshot([parent, child]))).not.toBeNull()
    const parsed = SessionsSnapshotValidation.parse(snapshot([parent, child]))
    expect(parsed?.sessions[0]?.svnAction).toEqual(svnAction)
    expect(parsed?.sessions[0]?.worktreeView).toBeUndefined()
    expect(parsed?.sessions[0]?.worktree?.liveFinish).toBe(true)
    expect(parsed?.sessions[0]?.scripts?.runs.map((entry) => entry.runId)).toEqual(['r1'])
    expect(parsed?.sessions[1]?.script).toEqual({ parentId: 'p', phase: 'before', scriptId: 'setup' })

    const damaged = SessionsSnapshotValidation.parse(snapshot([session({ worktree: { ...worktree, liveFinish: 'yes' },
      svnAction: { ...svnAction, stage: 'landing' } })]))
    expect(damaged?.sessions[0]?.svnAction).toBeUndefined()
    expect(damaged?.sessions[0]?.worktree?.liveFinish).toBeUndefined()
  })

  it('keeps an action at fixing, whose legacy phase a 3.10 peer reads as updating, and a stop-agent action with its run', () => {
    const worktree = {
      worktreePath: 'Q:/work/.worktrees/014-fix', branch: 'https://svn/repo/trunk', baseCommit: 'r41', kind: 'svn',
      choices: ['commit', 'keep', 'discard'], diff: null, baseMoved: false, finish: { phase: 'updating' },
    }
    const svnAction = { kind: 'finish', stage: 'fixing', needs: null, needsKind: null, review: null }
    const workflow = { kind: 'finish', workflowId: 'a1', title: 'Finish of 014', badge: 'resolving', summary: 'Claude resolves the conflicts', open: true,
      rounds: [], actions: [{ id: 'stop-agent', label: 'Stop agent', primary: false, runId: 'cl' }, { id: 'stop-agent', label: 'Stop agent', primary: false }] }
    const parent = session({ sessionId: 'p', worktree, svnAction, workflow })

    expect(SessionsSnapshotValidation310.parse(snapshot([parent]))).not.toBeNull()
    const parsed = SessionsSnapshotValidation.parse(snapshot([parent]))
    expect(parsed?.sessions[0]?.svnAction).toEqual(svnAction)
    expect(parsed?.sessions[0]?.worktree?.finish).toEqual({ phase: 'updating' })
    expect(parsed?.sessions[0]?.workflow?.actions).toEqual([{ id: 'stop-agent', label: 'Stop agent', primary: false, runId: 'cl', command: { operation: 'sessions.finalize', sessionId: 'cl', body: { expect: 'stop' } } }])
  })

  it('keeps a stop-run action with its run and the live validation runs, dropping only malformed ones', () => {
    const stop = { id: 'stop-run', label: 'Stop', primary: false, runId: 'v1' }
    const validation = { cwd: 'Q:/wt', checks: 'none', canRun: true, runs: [{ runId: 'v1', title: 'Worktree validation', startedAt: 5, stop }] }
    const workflow = { kind: 'finish', workflowId: 'a1', title: 'Finish of 014', badge: 'Ready for validation', summary: 'Validate', open: true,
      rounds: [], actions: [stop, { id: 'stop-run', label: 'Stop', primary: false }], validation }
    const command = { operation: 'sessions.finalize', sessionId: 'v1', body: { expect: 'stop' } }

    const parsed = SessionsSnapshotValidation.parse(snapshot([session({ sessionId: 'p', workflow })]))
    expect(parsed?.sessions[0]?.workflow?.actions).toEqual([{ ...stop, command }])
    expect(parsed?.sessions[0]?.workflow?.validation?.runs).toEqual([{ runId: 'v1', title: 'Worktree validation', startedAt: 5, stop: { ...stop, command } }])
    const malformed = SessionsSnapshotValidation.parse(snapshot([session({ sessionId: 'p', workflow: { ...workflow,
      validation: { ...validation, runs: [{ runId: 'v1', title: 'Worktree validation', startedAt: 5, stop: { ...stop, runId: undefined } }] } } })]))
    expect(malformed?.sessions[0]?.workflow?.validation).toEqual({ cwd: 'Q:/wt', checks: 'none', canRun: true })
  })

  it('keeps a remove-run action that names its run and drops one that does not', () => {
    const remove = { id: 'remove-run', label: 'Remove', primary: false, runId: 'r1' }
    const workflow = { kind: 'script', workflowId: 'script:r1', title: 'j10-requested-fail', badge: 'failed', summary: 'exit 1', open: false,
      rounds: [], actions: [remove, { id: 'remove-run', label: 'Remove', primary: false }] }

    const parsed = SessionsSnapshotValidation.parse(snapshot([session({ sessionId: 'p', workflow })]))
    expect(parsed?.sessions[0]?.workflow?.actions).toEqual([{ ...remove, command: { operation: 'sessions.remove', sessionId: 'r1', body: {} } }])
  })

  it('keeps a confirm-stopped action that names its run and drops one that does not', () => {
    const confirm = { id: 'confirm-stopped', label: 'I stopped the processes manually', primary: false, runId: 'm1' }
    const workflow = { kind: 'finish', workflowId: 'finish:a1', title: 'Finish', badge: 'waits', summary: 'Processes may still run', open: true,
      rounds: [], actions: [confirm, { id: 'confirm-stopped', label: 'I stopped the processes manually', primary: false }] }

    const parsed = SessionsSnapshotValidation.parse(snapshot([session({ sessionId: 'p', workflow })]))
    expect(parsed?.sessions[0]?.workflow?.actions).toEqual([{ ...confirm, command: { operation: 'sessions.backToWork', body: { confirmStoppedRunId: 'm1' } } }])
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

  it('keeps an action at merging with its merger run and brief, which a 3.10 peer reads as updating, and drops a malformed run id', () => {
    const worktree = {
      worktreePath: 'Q:/work/.worktrees/014-fix', branch: 'https://svn/repo/trunk', baseCommit: 'r41', kind: 'svn',
      choices: ['commit', 'keep', 'discard'], diff: null, baseMoved: false, finish: { phase: 'updating' },
    }
    const svnAction = { kind: 'finish', stage: 'merging', needs: null, needsKind: null, review: null, mergerRunId: 'm1', mergeBrief: 'L:/m.md' }
    expect(SessionsSnapshotValidation310.parse(snapshot([session({ sessionId: 'p', worktree, svnAction })]))).not.toBeNull()
    expect(SessionsSnapshotValidation.parse(snapshot([session({ sessionId: 'p', worktree, svnAction })]))?.sessions[0]?.svnAction).toEqual(svnAction)
    const damaged = SessionsSnapshotValidation.parse(snapshot([session({ sessionId: 'p', worktree, svnAction: { ...svnAction, mergerRunId: 7 } })]))
    expect(damaged?.sessions[0]?.svnAction).toEqual({ kind: 'finish', stage: 'merging', needs: null, needsKind: null, review: null, mergeBrief: 'L:/m.md', title: 'The merger settles the conflicts the rules left' })
  })

  it('draws a merger run, which a 3.10 peer still accepts, and drops a run of an unknown kind without the session', () => {
    const run = (runId: string, scriptId: string) => ({
      runId, phase: 'after', scriptId, name: 'merger', title: 'Merge conflicts 014-fix', state: 'running',
      summary: 'Merge conflicts 014-fix · running', startedAt: 1, commands: [], row: true, log: 'none',
    })
    const parent = session({ sessionId: 'p', scripts: { runs: [run('m1', 'svn-merge'), run('x1', 'svn-later')] } })

    expect(SessionsSnapshotValidation310.parse(snapshot([parent]))).not.toBeNull()
    const parsed = SessionsSnapshotValidation.parse(snapshot([parent]))
    expect(parsed?.sessions.map((entry) => entry.sessionId)).toEqual(['p'])
    expect(parsed?.sessions[0]?.scripts?.runs.map((entry) => entry.scriptId)).toEqual(['svn-merge'])
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

  it('keeps the roots a landed main copy is behind in, and drops only that list when it is malformed', () => {
    const landing = { mainCopy: 'Q:/work', behind: 2, newest: ['https://svn/repo:r52'], behindRoots: [{ root: 'lib/ea', behind: 1 }, { root: '.', behind: 1 }] }
    const retiredWorktree = { worktreePath: 'Q:/work/.worktrees/014-fix', revisions: ['https://svn/repo:r52'], landing }
    const parsed = SessionsSnapshotValidation.parse(snapshot([session({ sessionId: 'p', life: 'ended', retiredWorktree })]))
    expect(parsed?.sessions[0]?.retiredWorktree?.landing).toEqual(landing)

    for (const behindRoots of [[{ root: '', behind: 1 }], [{ root: 'lib/ea', behind: 0 }], [{ root: 'lib/ea' }], 'lib/ea']) {
      const odd = SessionsSnapshotValidation.parse(snapshot([session({ sessionId: 'p', life: 'ended', retiredWorktree: { ...retiredWorktree, landing: { ...landing, behindRoots } } })]))
      expect(odd?.sessions[0]?.retiredWorktree?.landing).toEqual({ mainCopy: 'Q:/work', behind: 2, newest: ['https://svn/repo:r52'] })
    }
  })

  it('keeps the local state that keeps a landing unproven, and drops only that when it is malformed or of an unknown item', () => {
    const landing = { mainCopy: 'Q:/work', behind: 0, newest: ['https://svn/repo:r52'],
      local: { path: 'docs/gone.txt', item: 'deleted', summary: 'docs/gone.txt is locally deleted in the main copy.' } }
    const retiredWorktree = { worktreePath: 'Q:/work/.worktrees/014-fix', revisions: ['https://svn/repo:r52'], landing }
    expect(SessionsSnapshotValidation.parse(snapshot([session({ sessionId: 'p', life: 'ended', retiredWorktree })]))?.sessions[0]?.retiredWorktree?.landing)
      .toEqual(landing)
    for (const local of [null, 'docs/gone.txt', { ...landing.local, path: '' }, { ...landing.local, item: 'normal' }, { ...landing.local, summary: 3 }]) {
      const odd = SessionsSnapshotValidation.parse(snapshot([session({ sessionId: 'p', life: 'ended', retiredWorktree: { ...retiredWorktree, landing: { ...landing, local } } })]))
      expect(odd?.sessions[0]?.retiredWorktree?.landing).toEqual({ mainCopy: 'Q:/work', behind: 0, newest: ['https://svn/repo:r52'] })
    }
  })

  it('keeps a well-formed parent link, which a 3.10 peer still accepts, and drops a malformed one or an unknown kind', () => {
    const parent = { sessionId: 'p', kind: 'ticket', sameProject: false }
    const sessions = [
      session({ sessionId: 'a', parent }),
      session({ sessionId: 'b', parent: { kind: 'unit' } }),
      session({ sessionId: 'c', parent: { sessionId: 'p', kind: 'unit', sameProject: true } }),
      session({ sessionId: 'd', parent: { sessionId: 'p', kind: 'worker' } }),
      session({ sessionId: 'e', parent: 'p' }),
    ]

    expect(SessionsSnapshotValidation310.parse(snapshot(sessions))).not.toBeNull()
    const parsed = SessionsSnapshotValidation.parse(snapshot(sessions))
    expect(parsed?.sessions.map((entry) => entry.sessionId)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(parsed?.sessions[0]?.parent).toEqual(parent)
    expect(parsed?.sessions.slice(1).every((entry) => entry.parent === undefined)).toBe(true)
  })

  it('keeps a well-formed step, which a 3.10 peer still accepts, and drops a malformed one without the session', () => {
    const step = { text: 'Removing the worktree', detail: '12,000 of 48,000 files', progress: { done: 12_000, total: 48_000 }, startedAt: 5_000 }
    const sessions = [
      session({ sessionId: 'a', step }),
      session({ sessionId: 'b', step: { text: 'Reading conflicts after the update', detail: null, progress: null, startedAt: null } }),
      session({ sessionId: 'c', step: { ...step, text: 42 } }),
      session({ sessionId: 'd', step: { ...step, progress: { done: -1, total: 48_000 } } }),
      session({ sessionId: 'e', step: { ...step, progress: { done: 1, total: 'many' } } }),
      session({ sessionId: 'f', step: { ...step, progress: { done: 1, total: null } } }),
      session({ sessionId: 'g', step: 'Removing' }),
    ]

    expect(SessionsSnapshotValidation310.parse(snapshot(sessions))).not.toBeNull()
    const parsed = SessionsSnapshotValidation.parse(snapshot(sessions))
    expect(parsed?.sessions.map((entry) => entry.sessionId)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    expect(parsed?.sessions[0]?.step).toEqual(step)
    expect(parsed?.sessions[1]?.step?.text).toBe('Reading conflicts after the update')
    expect(parsed?.sessions.slice(2, 5).every((entry) => entry.step === undefined)).toBe(true)
    expect(parsed?.sessions[5]?.step?.progress).toEqual({ done: 1, total: null })
    expect(parsed?.sessions[6]?.step).toBeUndefined()
  })
  it('keeps a well-formed workflow, which a 3.10 peer still accepts, and drops one it cannot draw without the session', () => {
    const workflow = {
      kind: 'finish', workflowId: 'a1', title: 'Finish of 014', badge: 'updating', summary: 'Running svn update', open: true,
      rounds: [{ title: 'Finish', steps: [
        { key: '1:evidence', title: 'Read what the worktree committed', detail: '', state: 'done', startedAt: 1, endedAt: 2, target: { kind: 'none' } },
        { key: '1:updating', title: 'svn update', detail: 'svn update 014', state: 'running', startedAt: 2, endedAt: null, target: { kind: 'run', runId: 'u1' } },
      ] }],
      actions: [{ id: 'keep', label: 'Keep worktree', primary: false }, { id: 'merge-later', label: 'Later', primary: false }],
    }
    const step = workflow.rounds[0].steps[1]
    const sessions = [
      session({ sessionId: 'a', workflow }),
      session({ sessionId: 'b', workflow: { ...workflow, rounds: [{ title: 'Finish', steps: [{ ...step, state: 'paused' }] }] } }),
      session({ sessionId: 'c', workflow: { ...workflow, rounds: [{ title: 'Finish', steps: [{ ...step, target: { kind: 'run' } }] }] } }),
      session({ sessionId: 'd', workflow: { ...workflow, kind: 'deploy' } }),
      session({ sessionId: 'e', workflow: 'updating' }),
    ]

    expect(SessionsSnapshotValidation310.parse(snapshot(sessions))).not.toBeNull()
    const parsed = SessionsSnapshotValidation.parse(snapshot(sessions))
    expect(parsed?.sessions.map((entry) => entry.sessionId)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(parsed?.sessions[0]?.workflow).toEqual({ ...workflow, actions: [workflow.actions[0]].map((action) => ({ ...action, command: WorktreeWords.command(action as never) })) })
    expect(parsed?.sessions.slice(1).every((entry) => entry.workflow === undefined)).toBe(true)
  })

  it('keeps a conflict list and its step, which a 3.10 peer still accepts, and drops a malformed list without the action', () => {
    const entry = {
      path: '.aidocs/engines', kind: 'tree', state: 'person', by: null, saved: null,
      description: 'Your session added this folder with 2 files; r421 added it with 3 files.',
      options: [{ id: 'keep-both', label: 'Keep both', note: 'restores the files r421 added', loses: 'nothing' }],
    }
    const svnAction = {
      kind: 'finish', stage: 'updating', needs: '3 conflicts need you: .aidocs/engines (tree)', needsKind: 'conflict', review: null,
      summary: '3 conflicts need you', conflicts: { entries: [entry], more: 2 },
    }
    const workflow = {
      kind: 'finish', workflowId: 'a1', title: 'Finish of 014', badge: '3 conflicts need you', summary: 'Waits for you', open: true,
      rounds: [{ title: 'Finish', steps: [
        { key: '1:conflicts', title: 'Conflicts', detail: '3 conflicts need you', state: 'waits', startedAt: 1, endedAt: 2, target: { kind: 'conflicts' } },
      ] }],
      actions: [],
    }
    const sessions = [
      session({ sessionId: 'a', svnAction, workflow }),
      session({ sessionId: 'b', svnAction: { ...svnAction, conflicts: { entries: [{ ...entry, state: 'pondering' }], more: 0 } } }),
      session({ sessionId: 'c', svnAction: { ...svnAction, conflicts: { entries: [{ ...entry, options: [{ id: 'burn', label: 'x', note: '', loses: 'nothing' }] }], more: 0 } } }),
      session({ sessionId: 'd', svnAction: { ...svnAction, summary: 3, conflicts: { entries: [entry], more: -1 } } }),
    ]

    expect(SessionsSnapshotValidation310.parse(snapshot(sessions))).not.toBeNull()
    const parsed = SessionsSnapshotValidation.parse(snapshot(sessions))
    expect(parsed?.sessions[0]?.svnAction).toEqual(svnAction)
    expect(parsed?.sessions[0]?.workflow?.rounds[0]?.steps[0]?.target).toEqual({ kind: 'conflicts' })
    for (const damaged of parsed?.sessions.slice(1) ?? []) {
      expect(damaged.svnAction).toMatchObject({ kind: 'finish', stage: 'updating', needsKind: 'conflict' })
      expect(damaged.svnAction?.conflicts).toBeUndefined()
    }
    expect(parsed?.sessions[1]?.svnAction?.summary).toBe('3 conflicts need you')
    expect(parsed?.sessions[3]?.svnAction?.summary).toBeUndefined()
  })
})
