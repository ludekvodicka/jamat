import { describe, expect, it } from 'vitest'

import type { SessionRecord, SessionRecordSvnAction, SvnActionPass } from '../../sessionManager/worktreeSessionRecords'
import type { SessionWorkflowInfo } from '../../sessionManager/sessionManagerApi.types'
import { SessionWorkflows } from '../../sessionManager/worktreeSessionRuntime'
import { SvnActionWorkflow } from './svnActionWorkflow'
import { FinishProjection } from '../finish/finishProjection'
import { SessionActionHistory } from '../../sessionManager/records/sessionActionHistory'
import { WorktreeWords } from './worktreeWords'

describe('lib-orchestrator/sessionManager/lifecycle/svnActionWorkflow', () => {
  const worktreeConst = 'Q:/Work/App/.worktrees/014-fix-login'

  function action(overrides?: Partial<SessionRecordSvnAction>): SessionRecordSvnAction {
    return {
      kind: 'finish', actionId: 'a1', stage: 'updating', runId: 'u1', root: worktreeConst, checks: [], checkCursor: 0, rootCursor: 0,
      rounds: { incoming: 0, outOfDate: 0, lock: 0 }, evidence: [], requestedBy: 'window', startedAt: 100, stageAt: 300,
      ...overrides,
    }
  }

  function record(svnAction?: SessionRecordSvnAction, overrides?: Partial<SessionRecord>): SessionRecord {
    return {
      sessionId: 's1', kind: 'agent', title: '014 - fix login', createdAt: 0, life: 'ended', binding: null,
      directory: { mode: 'adHoc', path: worktreeConst },
      ...svnAction === undefined ? {} : { svnAction },
      ...overrides,
    }
  }

  const pass = (stage: SvnActionPass['stage'], startedAt: number, endedAt: number, extra?: Partial<SvnActionPass>): SvnActionPass =>
    ({ stage, startedAt, endedAt, result: 'done', ...extra })
  const runs = (titles: Record<string, string>) => (runId: string): SessionRecord | null => titles[runId] === undefined ? null
    : record(undefined, { sessionId: runId, title: titles[runId], kind: 'shell' })
  const steps = (workflow: SessionWorkflowInfo) => workflow.rounds.map((round) => [round.title,
    ...round.steps.map((step) => `${step.title}: ${step.state}`)])

  it('shows the live-session list and its exact confirmation on a waiting main-update after the Finish history', () => {
    const current = action({ stage: 'main-update', runId: undefined, passes: [pass('committing', 100, 200), pass('removing', 200, 250)] })
    const live = [{ sessionId: 'coordinator', title: 'Coordinator', number: '021' }]
    const sections = SessionWorkflows.sectionsOf(record(current), runs({}), { kind: 'known', sessions: live })
    const workflow = sections.at(-1)!
    expect(sections.map((section) => section.kind)).toEqual(['finish', 'update-main'])
    expect(steps(sections[0])).toEqual([['Finish', 'Commit: done', 'Remove the worktree: done', 'Record the result: done']])
    expect(steps(workflow)).toEqual([['UPDATE', 'Update main copy: waits']])
    expect(workflow.rounds[0].steps.at(-1)?.body).toEqual({ kind: 'sessions', sessions: live })
    expect(workflow.actions).toEqual([
      { id: 'update-main', label: 'Update', primary: true, place: 'step', confirmLive: ['coordinator'] },
      { id: 'later', label: 'Later', primary: false, place: 'step', deferred: 'Main copy update left for later. It still waits on this step.' },
    ])
    expect(SvnActionWorkflow.of(record(current), current, runs({})).actions[0].confirmLive).toEqual([])
  })

  it('names the tree menu in the Later line while the row is a landed row the tree can update', () => {
    const current = action({ stage: 'main-update', runId: undefined })
    const landed = record(current, { retiredWorktree: { worktreePath: worktreeConst, kind: 'svn', revisions: [], removedAt: 1, ownerDir: 'Q:/Work/App',
      landed: [{ repository: 'https://svn.test/app', revision: 7, label: 'receipt' }] } })
    expect(SvnActionWorkflow.of(landed, current, runs({})).actions.find((entry) => entry.id === 'later')?.deferred)
      .toBe('Main copy update left for later. It still waits on this step and in the session menu of the sessions tree: Update main copy.')
  })

  it('gives a Finish one done step per pass, the update running on its run, and the review and the removal pending', () => {
    const current = action({ passes: [pass('stopping', 100, 200), pass('evidence', 200, 300)] })
    const workflow = SvnActionWorkflow.of(record(current), current, runs({ u1: 'svn update 014-fix-login' }))
    expect(workflow).toMatchObject({ kind: 'finish', workflowId: 'a1', title: 'Finish of 014 - fix login', badge: 'updating',
      summary: 'Running svn update', open: true, actions: [] })
    expect(steps(workflow)).toEqual([['Finish', 'Stop the session: done', 'Read what the worktree committed: done',
      'svn update: running', 'Commit: pending', 'Remove the worktree: pending']])
    expect(workflow.rounds[0].steps[2]).toEqual({ key: '1:updating', title: 'svn update', detail: 'svn update 014-fix-login', state: 'running',
      startedAt: 300, endedAt: null, target: { kind: 'run', runId: 'u1' }, body: { kind: 'log', runId: 'u1' } })
    expect(workflow.rounds[0].steps[0]).toMatchObject({ startedAt: 100, endedAt: 200, target: { kind: 'none' } })
  })

  /**
   * The lifecycle Finish writes no passes. Its finished svn update, its check and its review had
   * vanished from Session actions, and the running svn commit had no output there, so the sessions
   * tree listed those runs instead.
   */
  it('shows every step a lifecycle Finish already did, and the running svn step with its live log', () => {
    const lifecycle = record(undefined, {
      scriptRuns: [{ runId: 'check', phase: 'after', scriptId: 'checks', name: 'tests', title: 'tests', commands: [], startedAt: 200, endedAt: 250,
        outcome: 'succeeded', log: { state: 'saved', bytes: 1, truncated: false } }],
      worktreeLifecycle: {
        version: 9, actionId: 'a1', phase: 'finishing', step: 'committing', outOfDate: 0, approvedAt: 300,
        facts: { worker: { liveness: 'alive', resumeFailures: 0 } },
        execution: { root: worktreeConst, checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 100 },
        journal: [
          { stepId: 'a1-sync', kind: 'update', attempt: 1, startedAt: 110, endedAt: 120, outcome: 'ok', runId: 'sync' },
          { stepId: 'a1-commit-.', kind: 'commit', attempt: 1, startedAt: 400, runId: 'commit' },
        ],
      },
    })
    const workflow = SvnActionWorkflow.of(lifecycle, FinishProjection.action(lifecycle)!, runs({}))
    expect(steps(workflow)).toEqual([['Finish', 'svn update: done', 'Check tests: done', 'Changes: done', 'Commit: running', 'Remove the worktree: pending']])
    const held = workflow.rounds[0].steps.flatMap((step) => step.body?.kind === 'log' ? [step.body.runId] : [])
    expect(held).toEqual(['sync', 'check', 'commit'])
    expect(workflow.rounds[0].steps.find((step) => step.state === 'running')?.startedAt).toBe(400)
  })

  it('names at the idle gate what holds the worker, with Publish anyway on the step (UA1-J13-1)', () => {
    const reason = 'a message to the worker is not delivered yet: Continue the interrupted worktree task in this conversation'
    const gate = record(undefined, {
      worktreeLifecycle: {
        version: 9, actionId: 'a1', phase: 'finishing', step: 'awaiting-idle', outOfDate: 0, approvedAt: 300, awaitingIdleAt: 310, awaitingIdleReason: reason,
        facts: { worker: { liveness: 'alive', resumeFailures: 0 } },
        execution: { root: worktreeConst, checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 100 },
        journal: [],
      },
    })
    const workflow = SvnActionWorkflow.of(gate, FinishProjection.action(gate)!, runs({}))
    const commit = workflow.rounds[0].steps.find((step) => step.title === 'Commit')
    expect(commit).toMatchObject({ state: 'waits', detail: `The worker is not idle: ${reason}` })
    expect(workflow.summary).toBe(`The worker is not idle: ${reason}`)
    expect(workflow.actions.filter((row) => row.place === 'step').map((row) => row.label)).toEqual(['Check worker idle', 'Publish anyway'])
  })

  it('names in a lifecycle conflict wait the press it draws: Check again while a path is open, Try again once all are settled', () => {
    const entry = (path: string, state: 'person' | 'settled') => ({ path, kind: 'text' as const, shape: 'text-overlap' as const, state, options: ['merged' as const],
      facts: { incomingRevision: 2 }, ...state === 'settled' ? { by: 'person' as const } : {} })
    const waiting = (step: 'worker-resolving' | 'checking', reason: string, states: ('person' | 'settled')[]) => record(undefined, {
      worktreeLifecycle: {
        version: 9, actionId: 'a1', phase: 'waiting', step, outOfDate: 0,
        facts: { worker: { liveness: 'alive', resumeFailures: 0 } },
        execution: { root: worktreeConst, checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 100 },
        journal: [], wait: { kind: 'conflict-person', at: 300, reason },
        syncConflictSet: { readAt: 200, baseRevision: 1, revision: 2, more: 0, waited: true, entries: states.map((state, index) => entry(`f${index}.ts`, state)) },
      },
    })
    const pressed = (lifecycle: SessionRecord) => {
      const workflow = SvnActionWorkflow.of(lifecycle, FinishProjection.action(lifecycle)!, runs({}))
      return { badge: workflow.badge, summary: workflow.summary, press: workflow.actions.find((action) => action.primary)?.label }
    }
    expect(pressed(waiting('worker-resolving', '2 conflicts: you fixed 1, 1 needs you: f0.ts, f1.ts; settle them, then press Check again', ['settled', 'person'])))
      .toEqual({ badge: 'Conflicts need your decision', press: 'Check again',
        summary: 'Waits for you: 2 conflicts: you fixed 1, 1 needs you: f0.ts, f1.ts; settle them, then press Check again' })
    expect(pressed(waiting('checking', '2 conflicts: you fixed 2; all are settled, press Try again to go on', ['settled', 'settled'])))
      .toEqual({ badge: 'Conflicts settled', press: 'Try again', summary: 'Waits for you: 2 conflicts: you fixed 2; all are settled, press Try again to go on' })
  })

  it('shows what Jamat fixed by itself as a done check of the conflicts, naming the option and the saved copy', () => {
    const fixed = { path: '.aidocs', kind: 'tree' as const, shape: 'obstructed-dir' as const, state: 'settled' as const, by: 'jamat' as const,
      settledWith: 'keep-both' as const, saved: 'D:/results/a1/saved/resolutions/o1/.aidocs', options: ['keep-both' as const], facts: { incomingRevision: 3 } }
    const lifecycle = (entries: NonNullable<NonNullable<SessionRecord['worktreeLifecycle']>['syncConflictSet']>['entries'], readAt = 130) => record(undefined, {
      worktreeLifecycle: {
        version: 9, actionId: 'a1', phase: 'finishing', step: 'checking', outOfDate: 0,
        facts: { worker: { liveness: 'alive', resumeFailures: 0 } },
        execution: { root: worktreeConst, checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 100 },
        journal: [{ stepId: 'a1-sync', kind: 'update', attempt: 1, startedAt: 110, endedAt: 120, outcome: 'ok', runId: 'sync' }],
        syncConflictSet: { readAt, baseRevision: 2, revision: 3, more: 0, entries },
      },
    })
    const done = lifecycle([fixed])
    const workflow = SvnActionWorkflow.of(done, FinishProjection.action(done)!, runs({}))
    const conflicts = workflow.rounds.flatMap((round) => round.steps).find((step) => step.title === 'Check the conflicts')
    expect(steps(workflow)[0].slice(1, 3)).toEqual(['svn update: done', 'Check the conflicts: done'])
    expect(conflicts).toMatchObject({ state: 'done', startedAt: 130, endedAt: 130,
      detail: '1 conflict: Jamat fixed 1; .aidocs (keep both), saved copy: D:/results/a1/saved/resolutions/o1/.aidocs',
      body: { kind: 'conflicts', summary: '1 conflict: Jamat fixed 1' } })
    const open = lifecycle([fixed, { path: '.aidocs/engines/brief.md', kind: 'diverged', shape: 'diverged', state: 'person',
      options: ['merged', 'take-incoming', 'keep-mine'], facts: { incomingRevision: 3 } }])
    const waiting = SvnActionWorkflow.of(open, FinishProjection.action(open)!, runs({}))
    expect(waiting.rounds.flatMap((round) => round.steps).filter((step) => step.title === 'Check the conflicts' && step.state === 'done')).toEqual([])
    const earlier = lifecycle([fixed], 90)
    expect(steps(SvnActionWorkflow.of(earlier, FinishProjection.action(earlier)!, runs({})))[0]).not.toContain('Check the conflicts: done')
  })

  it('counts the wait for the decision in the done check of the conflicts (UA1-J13-7)', () => {
    const merged = { path: 'src/limit.txt', kind: 'text' as const, shape: 'text-overlap' as const, state: 'settled' as const, by: 'person' as const,
      settledWith: 'merged' as const, options: ['merged' as const], facts: { incomingRevision: 3 } }
    const done = record(undefined, { worktreeLifecycle: {
      version: 9, actionId: 'a1', phase: 'finishing', step: 'checking', outOfDate: 0,
      facts: { worker: { liveness: 'alive', resumeFailures: 0 } },
      execution: { root: worktreeConst, checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 100 },
      journal: [{ stepId: 'a1-update-g-0', kind: 'update', attempt: 1, startedAt: 110, endedAt: 120, outcome: 'conflict', runId: 'sync' },
        { stepId: 'a1-conflict-abc', kind: 'resolve', attempt: 1, startedAt: 150, endedAt: 152, outcome: 'ok', runId: 'choice' },
        { stepId: 'a1-update-g-1', kind: 'update', attempt: 1, startedAt: 153, endedAt: 158, outcome: 'ok', runId: 'sync-ea' }],
      syncConflictSet: { readAt: 160, baseRevision: 2, revision: 3, more: 0, entries: [merged] },
    } })
    const check = SvnActionWorkflow.of(done, FinishProjection.action(done)!, runs({})).rounds.flatMap((round) => round.steps)
      .find((step) => step.title === 'Check the conflicts')
    expect(check).toMatchObject({ state: 'done', startedAt: 120, endedAt: 152 })
  })

  it('lists an open set with its options while the worker resolves it, before any wait for the person', () => {
    const resolving = record(undefined, {
      worktreeLifecycle: {
        version: 9, actionId: 'a1', phase: 'finishing', step: 'worker-resolving', outOfDate: 0,
        facts: { worker: { liveness: 'alive', resumeFailures: 0 } },
        execution: { root: worktreeConst, checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 100 },
        journal: [{ stepId: 'a1-sync', kind: 'update', attempt: 1, startedAt: 110, endedAt: 120, outcome: 'ok', runId: 'sync' }],
        syncConflictSet: { readAt: 130, baseRevision: 2, revision: 3, more: 0, entries: [
          { path: '.aidocs', kind: 'tree', shape: 'obstructed-dir', state: 'settled', by: 'jamat', settledWith: 'keep-both', saved: 'D:/saved/.aidocs',
            options: ['keep-both'], facts: { incomingRevision: 3 } },
          { path: '.aidocs/engines/brief.md', kind: 'diverged', shape: 'diverged', state: 'person', saved: 'D:/saved/.aidocs/engines/brief.md',
            options: ['merged', 'take-incoming', 'keep-mine'], facts: { incomingRevision: 3 } }] },
      },
    })
    const workflow = SvnActionWorkflow.of(resolving, FinishProjection.action(resolving)!, runs({}))
    const running = workflow.rounds.flatMap((round) => round.steps).find((step) => step.state === 'running')
    expect(running).toMatchObject({ title: 'Check the conflicts', target: { kind: 'conflicts' }, body: { kind: 'conflicts', summary: '2 conflicts: Jamat fixed 1, 1 needs you' } })
    const body = running?.body
    if (body?.kind !== 'conflicts') throw new Error('The running check of the conflicts has no list')
    expect(body.conflicts?.entries.map((entry) => [entry.path, entry.state, entry.saved, entry.options.map((option) => option.id)])).toEqual([
      ['.aidocs/engines/brief.md', 'person', 'D:/saved/.aidocs/engines/brief.md', ['merged', 'take-incoming', 'keep-mine']],
      ['.aidocs', 'settled', 'D:/saved/.aidocs', ['keep-both']],
    ])
  })

  it('starts the current lifecycle step when the last done step ended, not when the Finish started', () => {
    const removing = record(undefined, {
      worktreeLifecycle: {
        version: 9, actionId: 'a1', phase: 'finishing', step: 'removing', outOfDate: 0, approvedAt: 300,
        facts: { worker: { liveness: 'stopped', resumeFailures: 0 } },
        execution: { root: worktreeConst, checks: [], checkCursor: 0, rootCursor: 1, evidence: [], requestedBy: 'window', startedAt: 100 },
        journal: [{ stepId: 'a1-commit-.', kind: 'commit', attempt: 1, startedAt: 400, endedAt: 450, outcome: 'ok', runId: 'commit' }],
      },
    })
    const workflow = SvnActionWorkflow.of(removing, FinishProjection.action(removing)!, runs({}))
    expect(workflow.rounds.flatMap((round) => round.steps).find((step) => step.title === 'Remove the worktree')?.startedAt).toBe(450)
  })

  // A running check read 1 min 26 s 8 s after its run began, and a merger 1 min 8 s after 2 s (UA1-J14-8).
  it('counts a running check and a running merger from their own run, not from the last done step', () => {
    const lifecycle = (step: 'checking' | 'worker-resolving', execution: object) => record(undefined, {
      worktreeLifecycle: {
        version: 9, actionId: 'a1', phase: 'finishing', step, outOfDate: 0,
        facts: { worker: { liveness: 'alive', resumeFailures: 0 } },
        execution: { root: worktreeConst, checks: [{ key: 'tests', scriptId: 'checks', name: 'tests', commands: [] }], checkCursor: 0, rootCursor: 0,
          evidence: [], requestedBy: 'window', startedAt: 100, ...execution },
        journal: [{ stepId: 'a1-sync', kind: 'update', attempt: 1, startedAt: 110, endedAt: 300, outcome: 'ok', runId: 'sync' }],
      },
    })
    const runningOf = (current: SessionRecord) => SvnActionWorkflow.of(current, FinishProjection.action(current)!, runs({}))
      .rounds.flatMap((round) => round.steps).find((step) => step.state === 'running')
    expect(runningOf(lifecycle('checking', { runId: 'c1', checkStartedAt: 900 }))).toMatchObject({ title: 'Check tests', startedAt: 900 })
    expect(runningOf(lifecycle('worker-resolving', { runId: 'm1', merger: { runId: 'm1', setAt: 300, startedAt: 950 } })))
      .toMatchObject({ title: 'Merger', startedAt: 950 })
  })

  // A check stopped by Back to work read 3 min 28 s for a run of 2 min 7 s (UA1-J14-8).
  it('counts a check of a closed action from its own run', () => {
    const closed = action({ stage: 'checks', runId: 'c1', stageAt: undefined, checkStartedAt: 900,
      checks: [{ key: 'tests', scriptId: 'checks', name: 'tests', commands: [] }], passes: [pass('updating', 200, 300, { runId: 'u1' })] })
    const step = SvnActionWorkflow.of(record(closed), closed, runs({})).rounds.flatMap((round) => round.steps).find((step) => step.title === 'Check tests')
    expect(step?.startedAt).toBe(900)
  })

  it('counts a retried removal from its current attempt, waiting or done, never from the first one (UA1-J11-7)', () => {
    const lifecycle = (overrides: Partial<NonNullable<SessionRecord['worktreeLifecycle']>>, execution: object) => ({
      version: 9, actionId: 'a1', phase: 'waiting' as const, step: 'removing' as const, outOfDate: 0, approvedAt: 300,
      facts: { worker: { liveness: 'stopped' as const, resumeFailures: 0 } },
      execution: { root: worktreeConst, checks: [], checkCursor: 0, rootCursor: 1, evidence: [], requestedBy: 'window' as const, startedAt: 100, ...execution },
      journal: [{ stepId: 'a1-commit-.', kind: 'commit' as const, attempt: 1, startedAt: 400, endedAt: 450, outcome: 'ok' as const, runId: 'commit' }],
      ...overrides,
    })
    const blocked = record(undefined, { worktreeLifecycle: lifecycle({ wait: { kind: 'removal-blocked', reason: 'held', at: 42_700 } }, { removal: 'in-use', removalAt: 42_600 }) })
    const waiting = SvnActionWorkflow.of(blocked, FinishProjection.action(blocked)!, runs({}))
    expect(waiting.rounds.flatMap((round) => round.steps).find((step) => step.title === 'Remove the worktree')).toMatchObject({ startedAt: 42_600, endedAt: 42_700 })

    const removed = record(undefined, {
      worktreeLifecycle: lifecycle({ phase: 'finishing', step: 'recording' }, { removal: 'removed', removalAt: 42_600 }),
      retiredWorktree: { kind: 'svn', worktreePath: worktreeConst, revisions: [], removedAt: 42_700, ownerDir: 'Q:/Work/App' },
    })
    const done = SvnActionWorkflow.of(removed, FinishProjection.action(removed)!, runs({}))
    expect(done.rounds.flatMap((round) => round.steps).find((step) => step.title === 'Remove the worktree')).toMatchObject({ state: 'done', startedAt: 42_600, endedAt: 42_700 })
  })

  describe('the verification of a publication', () => {
    const check = { key: 'tests', scriptId: 'checks' as const, name: 'tests', commands: [{ command: 'node check.js', cwd: worktreeConst }] }
    const published = (lifecycle: Partial<NonNullable<SessionRecord['worktreeLifecycle']>>, overrides?: Partial<SessionRecord>) => record(undefined, {
      commitReceipts: [{ scopeRoot: worktreeConst, revision: 1481, paths: ['a.txt'], at: 450 }],
      scriptRuns: [{ runId: 'check', phase: 'after', scriptId: 'checks', name: 'tests', title: 'tests', commands: [], startedAt: 200, endedAt: 250,
        outcome: 'succeeded', log: { state: 'saved', bytes: 1, truncated: false } }],
      worktreeLifecycle: {
        version: 9, actionId: 'a1', phase: 'finishing', step: 'verifying', outOfDate: 0, approvedAt: 300,
        facts: { worker: { liveness: 'alive', resumeFailures: 0 } },
        execution: { root: worktreeConst, checks: [check], checkCursor: 1, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 100 },
        journal: [{ stepId: 'a1-commit-.', kind: 'commit', attempt: 1, startedAt: 400, endedAt: 450, outcome: 'ok', runId: 'commit', revision: 1481 }],
        ...lifecycle,
      },
      ...overrides,
    })

    it('names the published revision it verifies and has only the cleanup ahead, never the checks or a second commit', () => {
      const lifecycle = published({})
      const workflow = SvnActionWorkflow.of(lifecycle, FinishProjection.action(lifecycle)!, runs({ commit: 'svn commit' }))
      expect(steps(workflow)).toEqual([['Finish', 'Check tests: done', 'Changes: done', 'Commit: done', 'Verify the publication: running', 'Remove the worktree: pending']])
      expect(workflow.rounds[0].steps.find((step) => step.state === 'running')).toMatchObject({ detail: 'Checking r1481 in the repository and the worktree', startedAt: 450 })
      expect(workflow.summary).toBe('Verifying the publication r1481')
    })

    it('keeps the verification as a done step once it passed, and the removal after it', () => {
      const lifecycle = published({ step: 'recording', verified: [{ root: worktreeConst, revision: 1481, paths: ['a.txt'], at: 470 }],
        execution: { root: worktreeConst, checks: [check], checkCursor: 1, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 100, removal: 'removed' } },
      { retiredWorktree: { kind: 'svn', worktreePath: worktreeConst, revisions: [], removedAt: 500, ownerDir: 'Q:/Work/App' } })
      const workflow = SvnActionWorkflow.of(lifecycle, FinishProjection.action(lifecycle)!, runs({}))
      expect(steps(workflow)).toEqual([['Finish', 'Check tests: done', 'Changes: done', 'Commit: done', 'Verify the publication: done',
        'Remove the worktree: done', 'Record the result: running']])
      const shown = workflow.rounds[0].steps
      expect(shown.find((step) => step.title === 'Verify the publication')).toMatchObject({ detail: 'verified r1481', startedAt: 450, endedAt: 470 })
      expect(shown.find((step) => step.title === 'Record the result')?.startedAt).toBe(500)
    })

    it('keeps in the action history the own duration of recording the result', () => {
      const recording = published({ step: 'recording', verified: [{ root: worktreeConst, revision: 1481, paths: ['a.txt'], at: 470 }],
        execution: { root: worktreeConst, checks: [check], checkCursor: 1, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 100, removal: 'removed' } },
      { retiredWorktree: { kind: 'svn', worktreePath: worktreeConst, revisions: [], removedAt: 500, ownerDir: 'Q:/Work/App' } })
      const landed: SessionRecord = { ...recording, worktreeLifecycle: { ...recording.worktreeLifecycle!, phase: 'landed', step: undefined },
        worktreeOutcome: { result: 'committed', revisions: ['url:r1481'], main: 'none', worktree: 'removed', lines: ['committed'], at: 520 } }
      const preserved = SessionActionHistory.preserve(recording, landed, 520)
      const finish = SessionWorkflows.sectionsOf(preserved, runs({})).find((section) => section.workflowId === 'a1')!
      expect(finish.rounds.flatMap((round) => round.steps).find((step) => step.title === 'Record the result')).toMatchObject({ startedAt: 500, endedAt: 520 })
    })

    it('draws the waiting main-copy UPDATE of a landed Finish with its own step only, from the Finish result on', () => {
      const landed = published({ phase: 'landed', step: undefined, verified: [{ root: worktreeConst, revision: 1481, paths: ['a.txt'], at: 470 }],
        execution: { root: worktreeConst, checks: [check], checkCursor: 1, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 100, removal: 'removed' },
        journal: [
          { stepId: 'a1-update-.', kind: 'update', attempt: 1, startedAt: 150, endedAt: 160, outcome: 'ok', runId: 'u1' },
          { stepId: 'a1-update-lib/ea', kind: 'update', attempt: 1, startedAt: 160, endedAt: 170, outcome: 'ok', runId: 'u2' },
          { stepId: 'a1-commit-.', kind: 'commit', attempt: 1, startedAt: 400, endedAt: 450, outcome: 'ok', runId: 'commit', revision: 1481 },
        ] },
      { retiredWorktree: { kind: 'svn', worktreePath: worktreeConst, revisions: [], removedAt: 500, ownerDir: 'Q:/Work/App' },
        worktreeOutcome: { result: 'committed', revisions: ['url:r1481'], main: 'none', worktree: 'removed', lines: ['committed'], at: 520 } })
      const sections = SessionWorkflows.sectionsOf(landed, runs({}))
      const finish = sections.find((section) => section.workflowId === 'a1')!
      expect(finish.rounds.map((round) => round.title)).toEqual(['Finish'])
      expect(finish.rounds[0].steps.filter((step) => step.title === 'svn update')).toHaveLength(2)
      const update = sections.find((section) => section.workflowId === 'a1:update-main')!
      expect(steps(update)).toEqual([['UPDATE', 'Update main copy: waits']])
      expect(update.startedAt).toBe(520)
    })

    it('keeps the update of every target of one sync in one round, in a Finish and in an UPDATE', () => {
      const finish = action({ stage: 'checks', runId: 'c1', checks: [check], passes: [pass('updating', 200, 210, { runId: 'u1' }), pass('updating', 210, 220, { runId: 'u2' })] })
      expect(steps(SvnActionWorkflow.of(record(finish), finish, runs({})))).toEqual([['Finish', 'svn update: done', 'svn update: done', 'Check tests: running', 'Commit: pending', 'Remove the worktree: pending']])
      const update = action({ kind: 'update-main', root: 'Q:/Work/App', stage: 'updating', runId: 'u2', passes: [pass('updating', 200, 210, { runId: 'u1' })] })
      expect(steps(SvnActionWorkflow.of(record(update), update, runs({})))).toEqual([['UPDATE', 'svn update: done', 'svn update: running']])
    })

    it('keeps the words of the resolver check for an UPDATE of the main copy', () => {
      const workflow = SvnActionWorkflow.of(record(action({ kind: 'update-main', stage: 'verifying', runId: undefined })),
        action({ kind: 'update-main', stage: 'verifying', runId: undefined }), runs({}))
      expect(steps(workflow)).toEqual([['UPDATE', 'Verify the resolution: running', 'svn diff of the resolved files: pending']])
    })

    it('names on the record step of an UPDATE the conflicts the main copy held before it (UA1-J08-3)', () => {
      const update = action({ kind: 'update-main', stage: 'recording', runId: undefined, updateProtection: { before: ['src/old.txt'], overlaps: [], saved: [] } })
      const recording = SvnActionWorkflow.of(record(update), update, runs({})).rounds.flatMap((round) => round.steps).at(-1)!
      expect(recording).toMatchObject({ title: 'Record the result',
        detail: 'conflicts from before this UPDATE are not part of it and stay yours as svn left them: src/old.txt' })
    })
  })

  describe('the steps of a main-copy UPDATE (UA1-J08-7)', () => {
    const conflict = { path: 'src/limit.txt', kind: 'text' as const, shape: 'text-overlap' as const, state: 'person' as const, options: ['merged' as const], facts: {} }
    const scriptRun = (runId: string, title: string, startedAt: number, endedAt: number) => ({ runId, phase: 'after' as const, scriptId: 'svn' as const,
      name: 'update', title, commands: [], startedAt, endedAt, outcome: 'succeeded' as const, log: { state: 'saved' as const, bytes: 1, truncated: false } })
    const landedRow = (svnAction: SessionRecordSvnAction, journal: NonNullable<SessionRecord['worktreeLifecycle']>['journal'], scriptRuns: SessionRecord['scriptRuns']) =>
      record(svnAction, { scriptRuns, worktreeLifecycle: { version: 9, actionId: 'f1', phase: 'landed', outOfDate: 0,
        facts: { worker: { liveness: 'alive', resumeFailures: 0 } }, journal } })

    it('shows the update that left the conflicts once, with the duration of its own svn run', () => {
      const waiting = action({ kind: 'update-main', actionId: 'm1', root: 'Q:/Work/App', stage: 'updating', runId: 'u1', startedAt: 100, stageAt: 300,
        conflictSet: { readAt: 340, baseRevision: 3, revision: 4, entries: [conflict], more: 0, waited: true },
        needs: { kind: 'conflict', reason: '1 conflict needs you', at: 345 } })
      const row = landedRow(waiting, [{ stepId: 'm1-update-.', kind: 'update', attempt: 1, startedAt: 310, endedAt: 312, outcome: 'ok', runId: 'u1' }],
        [scriptRun('u1', 'Update . to r4', 310, 312)])
      const workflow = SvnActionWorkflow.of(row, FinishProjection.action(row)!, runs({}))
      expect(steps(workflow)).toEqual([['UPDATE', 'svn update: done', 'Conflicts: waits', 'Update main copy: waits']])
      expect(workflow.rounds[0].steps[0]).toMatchObject({ detail: 'Update . to r4 left 1 conflict', startedAt: 310, endedAt: 312 })
    })

    it('offers Resolve with agent for conflicts an agent may settle, and says a press only checked them again (Finish 072)', () => {
      const waiting = action({ kind: 'update-main', actionId: 'm1', root: 'Q:/Work/App', stage: 'updating', runId: undefined, startedAt: 100, stageAt: 300, resolverSpent: true,
        conflictSet: { readAt: 340, baseRevision: 3, revision: 813, entries: [conflict], more: 0, waited: true },
        needs: { kind: 'conflict', reason: '1 conflict: src/limit.txt; Resolve with agent merges them and checks them again', at: 345 } })
      const row = landedRow(waiting, [], [])
      const workflow = SvnActionWorkflow.of(row, FinishProjection.action(row)!, runs({}))
      expect(workflow.actions[0]).toMatchObject({ id: 'update-main', label: 'Resolve with agent', primary: true })
      expect(workflow.rounds[0].steps[0]).toMatchObject({ detail: 'Conflicts checked again after r813: 1 conflict left' })
      const person = action({ ...waiting, conflictSet: { ...waiting.conflictSet!, entries: [{ ...conflict, kind: 'property' as const }] } })
      const personRow = landedRow(person, [], [])
      expect(SvnActionWorkflow.of(personRow, FinishProjection.action(personRow)!, runs({})).actions[0]).toMatchObject({ id: 'update-main', label: 'Update' })
    })

    it('names the root an update left conflicts in, and draws the updates of several roots in the order they ran (UA1-J13-7)', () => {
      const resolving = action({ kind: 'update-main', actionId: 'm1', root: 'Q:/Work/App', stage: 'resolving', runId: 'cl', startedAt: 100, stageAt: 340,
        passes: [pass('updating', 300, 340, { runId: 'u-ea', facts: { conflicts: 1 } })] })
      const row = landedRow(resolving, [
        { stepId: 'm1-update-g-0', kind: 'update', attempt: 1, startedAt: 305, endedAt: 310, outcome: 'ok', runId: 'u-root' },
        { stepId: 'm1-update-g-1', kind: 'update', attempt: 1, startedAt: 312, endedAt: 320, outcome: 'conflict', runId: 'u-ea' },
      ], [scriptRun('u-root', 'Update . to r5', 305, 310), scriptRun('u-ea', 'Update lib/ea to r7', 312, 320)])
      const drawn = SvnActionWorkflow.of(row, FinishProjection.action(row)!, runs({})).rounds.flatMap((round) => round.steps)
        .filter((step) => step.title === 'svn update').map((step) => step.detail)
      expect(drawn).toEqual(['Update . to r5', 'Update lib/ea to r7 left 1 conflict'])
    })

    it('never counts the wait for the next press as the duration of the update, of its conflicts or of the offer', () => {
      const pressed = action({ kind: 'update-main', actionId: 'm1', root: 'Q:/Work/App', stage: 'updating', runId: 'u2', startedAt: 100, stageAt: 500,
        passes: [pass('main-update', 100, 290, { runId: undefined }), pass('updating', 300, 500, { runId: 'u1', result: 'waited', facts: { conflicts: 1 } })] })
      const row = landedRow(pressed, [{ stepId: 'm1-update-.', kind: 'update', attempt: 1, startedAt: 310, endedAt: 312, outcome: 'ok', runId: 'u1' },
        { stepId: 'm1-update-.', kind: 'update', attempt: 2, startedAt: 505, runId: 'u2' }], [scriptRun('u1', 'Update . to r4', 310, 312)])
      const workflow = SvnActionWorkflow.of(row, FinishProjection.action(row)!, runs({}))
      expect(steps(workflow)).toEqual([['UPDATE', 'Update main copy: done', 'svn update: done', 'Conflicts: waits'], ['Update 2', 'svn update: running']])
      const [offer, update, waited] = workflow.rounds[0].steps
      expect(offer).toMatchObject({ startedAt: 290, endedAt: 290 })
      expect(update).toMatchObject({ startedAt: 310, endedAt: 312 })
      expect(waited).toMatchObject({ startedAt: 312, endedAt: 312 })
    })
  })

  it('projects the frozen checks still ahead, and a review per root left', () => {
    const check = (name: string) => ({ key: name, scriptId: 'checks' as const, name, commands: [] })
    const checking = action({ stage: 'checks', runId: 'c1', checks: [check('lint'), check('tests')] })
    expect(steps(SvnActionWorkflow.of(record(checking), checking, runs({}))))
      .toEqual([['Finish', 'Check lint: running', 'Check tests: pending', 'Commit: pending', 'Remove the worktree: pending']])
    const reviewing = action({ stage: 'reviewing', runId: 'r1', roots: [{ path: `${worktreeConst}/lib`, own: 'lib', changed: ['lib/a'] },
      { path: worktreeConst, own: '', changed: ['a'] }] })
    const workflow = SvnActionWorkflow.of(record(reviewing), reviewing, runs({}))
    expect(steps(workflow)).toEqual([['Finish', 'Review (lib): running', 'Review: pending', 'Remove the worktree: pending']])
    expect(workflow.rounds[0].steps[0].target).toEqual({ kind: 'none' })
    expect(workflow.summary).toBe('Reviewing 1 of 2')
  })

  it('shows a lock relaunch and a cleanup as their own steps in the same round', () => {
    const current = action({ passes: [pass('evidence', 100, 200), pass('updating', 200, 210, { runId: 'u0', result: 'failed' }),
      pass('cleaning', 210, 220, { runId: 'c0' })], runId: 'u1' })
    const workflow = SvnActionWorkflow.of(record(current), current, runs({}))
    expect(steps(workflow)).toEqual([['Finish', 'Read what the worktree committed: done', 'svn update: failed', 'svn cleanup: done',
      'svn update: running', 'Commit: pending', 'Remove the worktree: pending']])
    expect(workflow.rounds[0].steps.map((step) => step.key))
      .toEqual(['1:evidence', '1:updating', '1:cleaning', '1:updating#2', '1:committing', '1:removing'])
  })

  it('starts round 2 at a second update after incoming commits ran the checks again', () => {
    const current = action({ checks: [{ key: 'lint', scriptId: 'checks', name: 'lint', commands: [] }], stage: 'checks', runId: 'c2',
      passes: [pass('evidence', 100, 200), pass('checks', 200, 250, { runId: 'c1' }), pass('updating', 250, 300, { runId: 'u1' })] })
    // The run of the first check is gone; its history entry on the parent names it.
    const history = record(current, { scriptRuns: [{ runId: 'c1', phase: 'after', scriptId: 'checks', name: 'lint', title: 'lint 014',
      commands: [], startedAt: 200, endedAt: 250, exitCode: 0, outcome: 'succeeded', log: { state: 'saved', bytes: 1, truncated: false } }] })
    const workflow = SvnActionWorkflow.of(history, current, runs({}))
    expect(steps(workflow)).toEqual([
      ['Finish', 'Read what the worktree committed: done', 'Check lint: done', 'svn update: done', 'Check lint: running', 'Commit: pending', 'Remove the worktree: pending'],
    ])
    expect(workflow.rounds[0].steps.at(-2)?.key).toBe('1:committing')
  })

  it('shows a waiting action with its need, and admits Finish again and Solve with agent under the step, Keep worktree and Discard', () => {
    const current = action({ needs: { kind: 'conflict', reason: 'tree or property conflicts after the update: .aidocs/engines', at: 400 } })
    const workflow = SvnActionWorkflow.of(record(current), current, runs({}))
    expect(workflow).toMatchObject({ badge: 'conflicts need you', open: true,
      summary: 'Waits for you: tree or property conflicts after the update: .aidocs/engines' })
    expect(workflow.rounds[0].steps[0]).toMatchObject({ title: 'svn update', state: 'waits', detail: current.needs?.reason,
      startedAt: 300, endedAt: 400, target: { kind: 'run', runId: 'u1' } })
    expect(workflow.actions).toEqual([
      { id: 'finish-again', label: 'Finish again', primary: true, place: 'step' },
      { id: 'solve-with-agent', label: 'Solve with agent', primary: false, place: 'step' },
      { id: 'keep', label: 'Keep worktree', primary: false },
      { id: 'discard', label: 'Discard', primary: false, confirm: 'Discard this worktree and its uncommitted changes?' },
      { id: 'open-in-vscode', label: 'Open in VS Code', primary: false },
    ])
    const incoming = action({ needs: { kind: 'incoming', reason: 'other commits changed this project: a.txt', at: 400 } })
    expect(SvnActionWorkflow.of(record(incoming), incoming, runs({})).actions[0]).toEqual({ id: 'finish-again', label: 'Continue to review', primary: true, place: 'step' })
    const discard = action({ kind: 'discard', stage: 'stopping', needs: { kind: 'not-stopped', reason: 'x', at: 2 } })
    expect(SvnActionWorkflow.of(record(discard), discard, runs({})).actions.map((entry) => entry.id)).toEqual(['discard', 'solve-with-agent', 'keep', 'open-in-vscode'])
    const update = action({ kind: 'update-main', root: 'Q:/Work/App', needs: { kind: 'locked', reason: 'x', at: 2 } })
    expect(SvnActionWorkflow.of(record(update), update, runs({}))).toMatchObject({ title: 'UPDATE of App', actions: [
      { id: 'update-main', confirmLive: [] }, { id: 'later' },
    ] })
  })

  it('admits Stop agent, Keep worktree and Discard while the resolver works, and nothing during any other running stage', () => {
    const current = action({ stage: 'resolving', runId: 'cl', passes: [pass('updating', 200, 300, { runId: 'u1' })] })
    const workflow = SvnActionWorkflow.of(record(current), current, runs({ cl: 'Resolve conflicts 014' }))
    expect(workflow.summary).toBe('Claude resolves the conflicts')
    expect(workflow.rounds.flatMap((round) => round.steps).find((step) => step.state === 'running'))
      .toMatchObject({ title: 'Claude resolves the conflicts', target: { kind: 'agent', runId: 'cl' } })
    expect(workflow.actions).toEqual([
      { id: 'stop-agent', label: 'Stop agent', primary: false, runId: 'cl', place: 'step' },
      { id: 'keep', label: 'Keep worktree', primary: false },
      { id: 'discard', label: 'Discard', primary: false, confirm: 'Discard this worktree and its uncommitted changes?' },
    ])
    const update = action({ kind: 'update-main', stage: 'resolving', runId: 'cl' })
    expect(SvnActionWorkflow.of(record(update), update, runs({})).actions).toEqual([])
    const reviewing = action({ stage: 'reviewing', runId: 'r1', roots: [{ path: worktreeConst, own: '', changed: ['a'] }] })
    expect(SvnActionWorkflow.of(record(reviewing), reviewing, runs({})).actions).toEqual([])
  })

  it('shows the merger as a running agent step that admits Stop agent, and the update after it as a round after the merger', () => {
    const current = action({ stage: 'merging', runId: 'm1', merger: { runId: 'm1', setAt: 300, startedAt: 400 }, stageAt: 400,
      passes: [pass('updating', 200, 300, { runId: 'u1', facts: { conflicts: 3 } }), pass('fixing', 300, 400, { facts: { conflicts: 3, fixed: 1, left: 2 } })] })
    const workflow = SvnActionWorkflow.of(record(current), current, runs({ m1: 'Merge conflicts 014-fix-login' }))
    expect(steps(workflow)).toEqual([
      ['Finish', 'svn update: done', 'Check the conflicts: done', 'Merger: running'],
      ['Update 2, after the merger', 'svn update: pending', 'Commit: pending', 'Remove the worktree: pending'],
    ])
    expect(workflow.rounds[0].steps[2]).toMatchObject({ detail: 'Merge conflicts 014-fix-login', target: { kind: 'agent', runId: 'm1' } })
    expect(workflow).toMatchObject({ badge: 'merging', summary: 'The merger settles the conflicts the rules left' })
    expect(workflow.actions).toEqual([
      { id: 'finish-again', label: 'Check again', primary: true, place: 'step' },
      { id: 'open-merger', label: 'Open merger', primary: false, runId: 'm1', place: 'step' },
      { id: 'stop-agent', label: 'Stop agent', primary: false, runId: 'm1', place: 'step' },
      { id: 'open-in-vscode', label: 'Open in VS Code', primary: false },
      { id: 'keep', label: 'Keep worktree', primary: false },
      { id: 'discard', label: 'Discard', primary: false, confirm: 'Discard this worktree and its uncommitted changes?' },
    ])

    const updated = action({ stage: 'updating', runId: 'u2', stageAt: 600, passes: [...current.passes ?? [],
      pass('merging', 400, 500, { runId: 'm1' }), pass('fixing', 500, 600, { facts: { conflicts: 3, fixed: 1, left: 0 } })] })
    expect(steps(SvnActionWorkflow.of(record(updated), updated, runs({})))).toEqual([
      ['Finish', 'svn update: done', 'Check the conflicts: done', 'Merger: done', 'Check the conflicts: done'],
      ['Update 2, after the merger', 'svn update: running', 'Commit: pending', 'Remove the worktree: pending'],
    ])
  })

  it('admits on a conflict wait Check again, Resolve with agent while a path an agent may settle is open, else Solve with agent, VS Code, Keep and Discard', () => {
    const entry = { path: 'a.txt', kind: 'text' as const, shape: 'text-overlap' as const, state: 'person' as const, options: ['merged' as const], facts: {} }
    const set = { readAt: 1, baseRevision: 1, revision: 2, entries: [entry], more: 0, waited: true as const }
    const waiting = action({ stage: 'fixing', needs: { kind: 'conflict', reason: '1 conflict needs you', at: 5 }, conflictSet: set })
    expect(SvnActionWorkflow.of(record(waiting), waiting, runs({})).actions.map(({ id, label, primary }) => `${id} ${label} ${primary}`)).toEqual([
      'finish-again Check again true', 'resolve-with-agent Resolve with agent false', 'open-in-vscode Open in VS Code false',
      'keep Keep worktree false', 'discard Discard false',
    ])
    const personOnly = { ...waiting, conflictSet: { ...set, entries: [{ ...entry, shape: 'binary' as const, options: ['take-incoming' as const] }] } }
    expect(SvnActionWorkflow.of(record(personOnly), personOnly, runs({})).actions.map((item) => item.id))
      .toEqual(['finish-again', 'solve-with-agent', 'open-in-vscode', 'keep', 'discard'])
  })

  it('shows Check the conflicts running after Check again, with the checks, the update, the review and the removal ahead', () => {
    const current = action({ stage: 'fixing', runId: 'u1', passes: [pass('updating', 200, 300, { runId: 'u1', result: 'waited', facts: { conflicts: 3 } })] })
    const workflow = SvnActionWorkflow.of(record(current), current, runs({}))
    expect(steps(workflow)).toEqual([
      ['Finish', 'svn update: done', 'Conflicts: waits', 'Check the conflicts: running'],
      ['Update 2', 'svn update: pending', 'Commit: pending', 'Remove the worktree: pending'],
    ])
    expect(workflow.rounds[0].steps[2]).toMatchObject({ key: '1:fixing', target: { kind: 'none' } })
    expect(workflow).toMatchObject({ badge: 'checking conflicts', summary: 'Checking the conflicts', actions: [] })
  })

  it('shows the revision a review committed on its done step, and the resolver as an agent step', () => {
    const current = action({ stage: 'removing', runId: 'r1',
      passes: [pass('resolving', 1, 2, { runId: 'cl' }), pass('reviewing', 2, 3, { runId: 'r1', facts: { revision: 51 } })] })
    const workflow = SvnActionWorkflow.of(record(current), current, runs({}))
    expect(workflow.rounds[0].steps.slice(0, 2)).toMatchObject([
      { title: 'Claude resolves the conflicts', target: { kind: 'agent', runId: 'cl' } },
      { title: 'Review', detail: 'committed r51', target: { kind: 'commit', runId: 'r1' } },
    ])
    expect(workflow.rounds[0].steps[2]).toMatchObject({ title: 'Remove the worktree', state: 'running', target: { kind: 'none' } })
  })

  it('names the target of a failed update pass, and says it was interrupted when the client stopped (UA1-J09-7)', () => {
    const run = (runId: string, outcome: 'lost' | 'failed') => ({ runId, phase: 'after' as const, scriptId: 'svn' as const, name: 'Update lib/ea to r3',
      title: 'Update lib/ea to r3', commands: [], startedAt: 200, endedAt: 200, outcome, log: { state: 'saved' as const, bytes: 0, truncated: false } })
    const current = action({ kind: 'update-main', root: 'Q:/Work/App', stage: 'updating', runId: undefined,
      passes: [pass('updating', 200, 260, { runId: 'ea-1', result: 'failed' }), pass('updating', 260, 261, { runId: 'ea-2', result: 'failed' })] })
    const workflow = SvnActionWorkflow.of(record(current, { scriptRuns: [run('ea-1', 'lost'), { ...run('ea-2', 'failed'), startedAt: 260, endedAt: 261 }] }), current, runs({}))
    expect(workflow.rounds[0].steps.slice(0, 2)).toMatchObject([
      { title: 'svn update', state: 'failed', detail: 'Update lib/ea to r3 was interrupted when the client stopped, and ran again', startedAt: null, endedAt: null },
      { title: 'svn update', state: 'failed', detail: 'Update lib/ea to r3 failed, and ran again', startedAt: 260, endedAt: 261 },
    ])
  })

  it('shows a resolver that ended without success as ended, since the verification after it decides (UA1-J09-11)', () => {
    const current = action({ kind: 'update-main', root: 'Q:/Work/App', stage: 'recording', runId: undefined,
      passes: [pass('updating', 1, 2, { runId: 'u1' }), pass('resolving', 2, 3, { runId: 'cl', result: 'failed' }), pass('verifying', 3, 4),
        pass('diffing', 4, 5, { runId: 'd1' })] })
    const resolver = { runId: 'cl', phase: 'after' as const, scriptId: 'svn-resolve' as const, name: 'resolver', title: 'Resolve conflicts App',
      commands: [], startedAt: 2, endedAt: 3, exitCode: 1, outcome: 'failed' as const, log: { state: 'saved' as const, bytes: 0, truncated: false } }
    const steps = SvnActionWorkflow.of(record(current, { scriptRuns: [resolver] }), current, runs({})).rounds[0].steps
    expect(steps.find((step) => step.title === 'Claude resolves the conflicts'))
      .toMatchObject({ state: 'skipped', detail: 'ended with exit code 1; Verify the resolution decides' })
    expect(steps.find((step) => step.title === 'Verify the resolution')).toMatchObject({ state: 'done' })
  })

  it('names the main copy, not a session, as the local side of the conflicts of an UPDATE (UA1-J09-11)', () => {
    const conflictSet = { readAt: 340, baseRevision: 3, revision: 5, more: 0, waited: true as const,
      entries: [{ path: 'src/config.json', kind: 'text' as const, shape: 'text-overlap' as const, state: 'person' as const, options: ['merged' as const, 'keep-mine' as const],
        facts: { incomingRevision: 5 } }] }
    const update = action({ kind: 'update-main', root: 'Q:/Work/App', stage: 'updating', runId: 'u1', conflictSet,
      needs: { kind: 'conflict', reason: '1 conflict needs you', at: 345 } })
    const body = SvnActionWorkflow.of(record(update), update, runs({})).rounds[0].steps.find((step) => step.body?.kind === 'conflicts')?.body
    expect(body).toMatchObject({ conflicts: { entries: [{ description: 'Your main copy and r5 changed the same lines of this file.',
      options: [{ id: 'merged' }, { id: 'keep-mine', note: 'keeps your version; what r5 brought is dropped' }] }] } })
    const finish = action({ conflictSet, needs: { kind: 'conflict', reason: '1 conflict needs you', at: 345 } })
    const own = SvnActionWorkflow.of(record(finish), finish, runs({})).rounds[0].steps.find((step) => step.body?.kind === 'conflicts')?.body
    expect(own).toMatchObject({ conflicts: { entries: [{ description: 'Your session and r5 changed the same lines of this file.' }] } })
  })

  it('lists the open conflicts with their options on the wait a failed resolver left (UA1-J13-4)', () => {
    const conflictSet = { readAt: 340, baseRevision: 3, revision: 4, more: 0, waited: true as const,
      entries: [{ path: 'src/limit.txt', kind: 'text' as const, shape: 'text-overlap' as const, state: 'person' as const,
        options: ['merged' as const, 'take-incoming' as const, 'keep-mine' as const], facts: { incomingRevision: 4 } }] }
    const update = action({ kind: 'update-main', root: 'Q:/Work/App', stage: 'verifying', runId: undefined, conflictSet,
      conflicts: { paths: ['src/limit.txt'], before: [], at: 345 },
      passes: [pass('updating', 300, 340, { runId: 'u1', facts: { conflicts: 1 } }), pass('resolving', 340, 400, { runId: 'cl', result: 'failed' })],
      needs: { kind: 'resolver-failed', reason: 'the resolver left conflicts in: src/limit.txt', at: 410 } })
    const listed = SvnActionWorkflow.of(record(update), update, runs({})).rounds.flatMap((round) => round.steps)
      .filter((step) => step.body?.kind === 'conflicts')
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ title: 'Verify the resolution', state: 'waits', body: { kind: 'conflicts', conflicts: { entries: [{ path: 'src/limit.txt',
      description: 'Your main copy and r4 changed the same lines of this file.', options: [{ id: 'merged' }, { id: 'take-incoming' }, { id: 'keep-mine' }] }] } } })
  })

  it('shows the ended view of the last outcome, its lines verbatim and not open', () => {
    const ended = record(undefined, { worktreeOutcome: { result: 'not-committed', revisions: [], main: 'none', worktree: 'kept',
      lines: ['KEPT: conflicts; Q:/w stays'], at: 900 } })
    expect(SessionWorkflows.of(ended, runs({}))).toEqual({
      kind: 'finish', workflowId: 'ended:900', title: 'Finish of 014 - fix login', badge: 'not committed', startedAt: 900,
      summary: 'KEPT: conflicts; Q:/w stays', open: false, actions: [],
      rounds: [{ title: 'Outcome', steps: [{ key: 'outcome:0', title: 'KEPT: conflicts; Q:/w stays', detail: '', state: 'done',
        startedAt: null, endedAt: 900, target: { kind: 'none' } }] }],
    })
    expect(SessionWorkflows.of(record(), runs({}))).toBeNull()
  })

  it('composes the same workflow twice from a record that did not change', () => {
    const current = action({ passes: [pass('evidence', 100, 300)] })
    const of = () => JSON.stringify(SessionWorkflows.of(record(current), runs({ u1: 'svn update' })))
    expect(of()).toBe(of())
  })

  it('shows a check that ended with a failed verdict as failed, open and closed, with its reason on the summary', () => {
    const checking = action({ stage: 'checks', runId: 'c1', checks: [{ key: 'tests', scriptId: 'checks', name: 'tests', commands: [] }],
      verdict: { kind: 'failed', reason: 'the check ended with 3', exitCode: 3 } })
    const open = SvnActionWorkflow.of(record(checking), checking, runs({ c1: 'tests' }))
    expect(open.rounds[0].steps.find((step) => step.title === 'Check tests')).toMatchObject({ state: 'failed', detail: 'the check ended with 3' })
    expect(open.summary).toBe('Check tests failed: the check ended with 3')
    const ended = record(undefined, { actionHistory: [{ key: 'a1', startedAt: 100, endedAt: 500, source: { svnAction: checking } }] })
    const closed = SessionWorkflows.sectionsOf(ended, runs({ c1: 'tests' }))[0]
    expect(closed).toMatchObject({ open: false, badge: 'failed', summary: 'Check tests failed: the check ended with 3' })
    expect(closed.rounds[0].steps.find((step) => step.title === 'Check tests')).toMatchObject({ state: 'failed', detail: 'the check ended with 3' })
  })

  it('names the published revisions in the Discard confirm of a partly committed action', () => {
    const partial = action({ needs: { kind: 'partial', reason: 'shared committed, App failed', at: 400 },
      evidence: [{ repository: 'http://svn.local/svn/shared/', revision: 45, label: 'receipt' }] })
    const confirms = SvnActionWorkflow.of(record(partial), partial, runs({})).actions.filter((entry) => entry.id === 'discard').map((entry) => entry.confirm)
    expect(confirms).toEqual(['Already published: shared r45. The rest is not published and will be discarded with this worktree. Discard it?'])
  })

  describe('a publication to several repositories (UA1-J07)', () => {
    const ea = `${worktreeConst}/lib/ea`
    const eb = `${worktreeConst}/lib/eb`
    const bounds = (name: string) => ({ repository: `file:///Q:/repos/${name}`, base: '/', rootBase: 1, since: 1 })
    const roots = [
      { path: ea, own: 'lib/ea', changed: ['lib/ea/notes.txt'], bounds: bounds('j07ea') },
      { path: eb, own: 'lib/eb', changed: ['lib/eb/notes.txt'], bounds: bounds('j07eb') },
      { path: worktreeConst, own: '', changed: ['src/config.json'], bounds: bounds('j07app') },
    ]
    const refused = record(undefined, {
      worktreeLifecycle: {
        version: 9, actionId: 'a1', phase: 'waiting', step: 'committing', outOfDate: 0, approvedAt: 300,
        facts: { worker: { liveness: 'alive', resumeFailures: 0 } },
        execution: { root: worktreeConst, checks: [], checkCursor: 0, rootCursor: 1, evidence: [], requestedBy: 'window', startedAt: 100, roots },
        journal: [
          { stepId: 'a1-commit-lib/ea', kind: 'commit', attempt: 1, cwd: ea, startedAt: 400, endedAt: 450, outcome: 'ok', runId: 'commit-ea', revision: 2 },
          { stepId: 'a1-commit-lib/eb', kind: 'commit', attempt: 1, cwd: eb, startedAt: 480, endedAt: 490, outcome: 'other', runId: 'commit-eb' },
        ],
        verified: [{ root: ea, revision: 2, repository: 'file:///Q:/repos/j07ea', base: '/', paths: ['notes.txt'], at: 470 }],
        wait: { kind: 'partially-landed', reason: 'Commit blocked by pre-commit hook', at: 495 },
      },
    })
    const named = (workflow: SessionWorkflowInfo) => workflow.rounds.flatMap((round) => round.steps)
      .filter((step) => step.title !== 'Changes').map((step) => `${step.title}: ${step.state}: ${step.detail}`)

    it('keeps the current Keep choices on its saved history after restart without enabling older actions', () => {
      const waiting: SessionRecord = { ...refused, worktree: { kind: 'svn', worktreePath: worktreeConst,
        repositoryRoot: 'Q:/Work/App', branch: 'file:///Q:/repos/j07app', baseCommit: 'r1' },
        worktreeLifecycle: { ...refused.worktreeLifecycle!, execution: { ...refused.worktreeLifecycle!.execution!,
          evidence: [{ repository: 'file:///Q:/repos/j07ea', revision: 2, label: 'receipt' }] } } }
      const kept = SessionActionHistory.preserve(waiting, { ...waiting,
        worktreeLifecycle: { ...waiting.worktreeLifecycle!, phase: 'kept', step: undefined, wait: undefined },
        worktreeOutcome: { result: 'partial', revisions: ['file:///Q:/repos/j07ea:r2'], main: 'none', worktree: 'kept',
          lines: ['Worktree kept. Partly published: j07ea r2'], at: 600 },
      }, 600)
      const previous = { ...kept.actionHistory![0], key: 'previous', startedAt: 20, endedAt: 80,
        outcome: { ...kept.worktreeOutcome!, at: 80 } }
      const restored: SessionRecord = JSON.parse(JSON.stringify({ ...kept, actionHistory: [previous, ...kept.actionHistory!] }))
      const sections = SessionWorkflows.sectionsOf(restored, runs({}))
      expect(sections.map((section) => section.workflowId)).toEqual(['previous', 'a1'])
      expect(sections[0].actions).toEqual([])
      expect(sections[1].actions.map((action) => action.id)).toEqual(['prepare-worktree', 'discard'])
      expect(sections[1].actions.find((action) => action.id === 'discard')?.confirm).toContain('j07ea r2')
      expect(sections[1].rounds.flatMap((round) => round.steps).some((step) => step.body?.kind === 'commit')).toBe(false)
      const resumed = { ...restored, worktreeLifecycle: { ...restored.worktreeLifecycle!, phase: 'active' as const } }
      expect(SessionWorkflows.sectionsOf(resumed, runs({})).flatMap((section) => section.actions)).toEqual([])
      expect(SessionWorkflows.sectionsOf({ ...restored, worktree: undefined }, runs({})).flatMap((section) => section.actions)).toEqual([])
    })

    it('names the mount and the repository of each commit and of its verification, open and closed', () => {
      const open = SvnActionWorkflow.of(refused, FinishProjection.action(refused)!, runs({}))
      const expected = [
        'Commit (lib/ea): done: committed j07ea r2',
        'Verify the publication: done: verified j07ea r2',
        'Commit (lib/eb): failed: commit to j07eb failed',
      ]
      expect(named(open)).toEqual([...expected, 'Commit (lib/eb): waits: Commit blocked by pre-commit hook', 'Remove the worktree: pending: '])
      const kept: SessionRecord = { ...refused, worktreeLifecycle: { ...refused.worktreeLifecycle!, phase: 'kept', step: undefined, wait: undefined } }
      const closed = SessionWorkflows.sectionsOf(SessionActionHistory.preserve(refused, kept, 600), runs({})).find((section) => section.workflowId === 'a1')!
      expect(named(closed).slice(0, 3)).toEqual(expected)
    })

    it('names the mount of each commit when two repositories have one name (UA1-J12-7)', () => {
      const same = (dir: string) => ({ repository: `file:///Q:/repos/${dir}/j12`, base: '/', rootBase: 1, since: 1 })
      const twins = [{ path: ea, own: 'lib/ea', changed: ['lib/ea/notes.txt'], bounds: same('ea') }, { path: worktreeConst, own: '', changed: ['src/config.json'], bounds: same('app') }]
      const published = record(undefined, { worktreeLifecycle: { ...refused.worktreeLifecycle!, phase: 'finishing', step: 'disposing', wait: undefined,
        execution: { ...refused.worktreeLifecycle!.execution!, roots: twins, rootCursor: 2 },
        journal: [
          { stepId: 'a1-commit-lib/ea', kind: 'commit', attempt: 1, cwd: ea, startedAt: 400, endedAt: 450, outcome: 'ok', runId: 'commit-ea', revision: 2 },
          { stepId: 'a1-commit-.', kind: 'commit', attempt: 1, cwd: worktreeConst, startedAt: 480, endedAt: 490, outcome: 'ok', runId: 'commit-app', revision: 4 },
        ],
        verified: [{ root: ea, revision: 2, repository: 'file:///Q:/repos/ea/j12', base: '/', paths: ['notes.txt'], at: 470 },
          { root: worktreeConst, revision: 4, repository: 'file:///Q:/repos/app/j12', base: '/', paths: ['src/config.json'], at: 495 }] } })
      expect(named(SvnActionWorkflow.of(published, FinishProjection.action(published)!, runs({}))).filter((line) => line.includes('j12'))).toEqual([
        'Commit (lib/ea): done: committed j12 (lib/ea) r2',
        'Verify the publication: done: verified j12 (lib/ea) r2',
        'Commit: done: committed j12 (.) r4',
        'Verify the publication: done: verified j12 (.) r4',
      ])
    })

    it('keeps the mount in the finished steps, and names it for a lone repository whose name another root has (UA1-J13-5)', () => {
      const same = (dir: string) => ({ repository: `file:///Q:/repos/${dir}/j13`, base: '/', rootBase: 1, since: 1 })
      const mounts = [{ own: 'lib/ea', repository: 'file:///Q:/repos/ea/j13' }, { own: '', repository: 'file:///Q:/repos/app/j13' }]
      const lone = record(undefined, { worktreeLifecycle: { ...refused.worktreeLifecycle!, phase: 'finishing', step: 'disposing', wait: undefined,
        execution: { ...refused.worktreeLifecycle!.execution!, roots: [{ path: ea, own: 'lib/ea', changed: ['lib/ea/api.txt'], bounds: same('ea') }], mounts, rootCursor: 1 },
        journal: [{ stepId: 'a1-commit-lib/ea', kind: 'commit', attempt: 1, cwd: ea, startedAt: 400, endedAt: 450, outcome: 'ok', runId: 'commit-ea', revision: 7 }],
        verified: [{ root: ea, revision: 7, repository: 'file:///Q:/repos/ea/j13', base: '/', paths: ['api.txt'], at: 470 }] } })
      const expected = ['Commit (lib/ea): done: committed j13 (lib/ea) r7', 'Verify the publication: done: verified j13 (lib/ea) r7']
      expect(named(SvnActionWorkflow.of(lone, FinishProjection.action(lone)!, runs({}))).filter((line) => line.includes('j13'))).toEqual(expected)
      const landed: SessionRecord = { ...lone, worktreeLifecycle: { ...lone.worktreeLifecycle!, phase: 'kept', step: undefined } }
      const closed = SessionWorkflows.sectionsOf(SessionActionHistory.preserve(lone, landed, 600), runs({})).find((section) => section.workflowId === 'a1')!
      expect(named(closed).filter((line) => line.includes('j13'))).toEqual(expected)
      const kept = { ...landed.worktreeLifecycle!, execution: { ...landed.worktreeLifecycle!.execution!, evidence: [{ repository: 'file:///Q:/repos/ea/j13', revision: 7, label: 'receipt' as const }] } }
      expect(WorktreeWords.actions(kept).find((entry) => entry.id === 'discard')?.confirm).toContain('Already published: j13 (lib/ea) r7.')
    })

    it('names the repository each commit still ahead goes to', () => {
      const verifying: SessionRecord = { ...refused, commitReceipts: [{ scopeRoot: ea, revision: 2, paths: ['notes.txt'], at: 450 }],
        worktreeLifecycle: { ...refused.worktreeLifecycle!, phase: 'finishing', step: 'verifying', wait: undefined, verified: [],
          execution: { ...refused.worktreeLifecycle!.execution!, rootCursor: 0 }, journal: refused.worktreeLifecycle!.journal.slice(0, 1) } }
      expect(named(SvnActionWorkflow.of(verifying, FinishProjection.action(verifying)!, runs({}))).slice(1))
        .toEqual(['Verify the publication: running: Checking r2 in the repository and the worktree', 'Commit (lib/eb): pending: ', 'Commit: pending: ', 'Remove the worktree: pending: '])
    })
  })

  it('starts the removal of a Discard at its permit, after the steps the action did before it (UA1-J07-6)', () => {
    const discarded = record(undefined, {
      scriptRuns: [{ runId: 'check', phase: 'after', scriptId: 'checks', name: 'tests', title: 'tests', commands: [], startedAt: 200, endedAt: 250,
        outcome: 'succeeded', log: { state: 'saved', bytes: 1, truncated: false } }],
      retiredWorktree: { kind: 'svn', worktreePath: worktreeConst, revisions: [], removedAt: 410, ownerDir: 'Q:/Work/App' },
      worktreeLifecycle: {
        version: 9, actionId: 'a1', phase: 'finishing', step: 'recording', outOfDate: 0, purpose: 'discard',
        removalPermit: { kind: 'discard', by: 'person', at: 400 },
        facts: { worker: { liveness: 'stopped', resumeFailures: 0 } },
        execution: { root: worktreeConst, checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 100, removal: 'removed' },
        journal: [{ stepId: 'a1-update-.', kind: 'update', attempt: 1, startedAt: 110, endedAt: 120, outcome: 'ok', runId: 'u1' }],
      },
    })
    const workflow = SvnActionWorkflow.of(discarded, FinishProjection.action(discarded)!, runs({}))
    expect(steps(workflow)).toEqual([['Discard', 'svn update: done', 'Check tests: done', 'Remove the worktree: done', 'Record the result: running']])
    expect(workflow.rounds[0].steps.find((step) => step.title === 'Remove the worktree')).toMatchObject({ startedAt: 400, endedAt: 410 })
  })

  it('keeps an outcome recorded during an action, and a later Keep of that action, in its own section (UA1-J07-6)', () => {
    const outcome = (lines: string[], at: number, worktree: 'in-use' | 'kept') =>
      ({ result: 'partial' as const, revisions: ['file:///Q:/repos/j07ea:r2'], main: 'none' as const, worktree, lines, at })
    const waiting = record(action({ stage: 'committing', needs: { kind: 'partial', reason: 'hook refused', at: 400 } }),
      { worktreeOutcome: outcome(['Partly published: j07ea r2'], 300, 'in-use') })
    const closed = SessionActionHistory.preserve(waiting, { ...waiting, svnAction: undefined }, 500)
    const kept = SessionActionHistory.preserve(closed, { ...closed, worktreeOutcome: outcome(['Worktree kept. Partly published: j07ea r2'], 510, 'kept') }, 510)
    const sections = SessionWorkflows.sectionsOf(kept, runs({}))
    expect(sections.map((section) => [section.workflowId, section.summary])).toEqual([['a1', 'Worktree kept. Partly published: j07ea r2']])
  })

  it('names where an UPDATE saved the local changes that overlap what lands, before its svn update (UA1-J08-4)', () => {
    const saved = 'L:/results/m1/saved/overlap-jBczDa'
    const protectedAction = action({ kind: 'update-main', actionId: 'm1', root: 'Q:/Work/App', stage: 'updating', runId: 'u1',
      updateProtection: { before: [], overlaps: ['Q:/Work/App/src/limit.txt', 'Q:/Work/App/docs/gone.txt'], saved: [saved] },
      conflictSet: { readAt: 340, baseRevision: 3, revision: 4, entries: [{ path: 'src/limit.txt', kind: 'text', shape: 'text-overlap', state: 'person', options: ['merged'], facts: {} }], more: 0, waited: true },
      needs: { kind: 'conflict', reason: '1 conflict needs you', at: 345 } })
    const workflow = SvnActionWorkflow.of(record(protectedAction), protectedAction, runs({}))
    expect(steps(workflow)[0].slice(0, 3)).toEqual(['UPDATE', 'Save your changes: done', 'svn update: done'])
    expect(workflow.rounds[0].steps[0]).toMatchObject({ detail: `2 of your changes overlap what lands; saved before the update in ${saved}`, startedAt: null, endedAt: null })
    const unprotected = action({ kind: 'update-main', root: 'Q:/Work/App', stage: 'updating', runId: 'u1', updateProtection: { before: [], overlaps: [], saved: [] } })
    expect(steps(SvnActionWorkflow.of(record(unprotected), unprotected, runs({})))).toEqual([['UPDATE', 'svn update: running']])
  })
})
