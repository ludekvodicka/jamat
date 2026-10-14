import { describe, expect, it } from 'vitest'

import type { SessionRecord, SessionRecordSvnAction, SvnActionPass } from '../records/sessionRecord.types'
import type { SessionWorkflowInfo } from '../sessionManagerApi.types'
import { SessionWorkflows } from './sessionWorkflows'
import { SvnActionWorkflow } from './svnActionWorkflow'

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

  it('gives a Finish one done step per pass, the update running on its run, and the review and the removal pending', () => {
    const current = action({ passes: [pass('stopping', 100, 200), pass('evidence', 200, 300)] })
    const workflow = SvnActionWorkflow.of(record(current), current, runs({ u1: 'svn update 014-fix-login' }))
    expect(workflow).toMatchObject({ kind: 'finish', workflowId: 'a1', title: 'Finish of 014 - fix login', badge: 'updating',
      summary: 'Running svn update', open: true, actions: [] })
    expect(steps(workflow)).toEqual([['Finish', 'Stop the session: done', 'Read what the worktree committed: done',
      'svn update: running', 'Review: pending', 'Remove the worktree: pending']])
    expect(workflow.rounds[0].steps[2]).toEqual({ key: '1:updating', title: 'svn update', detail: 'svn update 014-fix-login', state: 'running',
      startedAt: 300, endedAt: null, target: { kind: 'run', runId: 'u1' } })
    expect(workflow.rounds[0].steps[0]).toMatchObject({ startedAt: 100, endedAt: 200, target: { kind: 'none' } })
  })

  it('projects the frozen checks still ahead, and a review per root left', () => {
    const check = (name: string) => ({ key: name, scriptId: 'checks' as const, name, commands: [] })
    const checking = action({ stage: 'checks', runId: 'c1', checks: [check('lint'), check('tests')] })
    expect(steps(SvnActionWorkflow.of(record(checking), checking, runs({}))))
      .toEqual([['Finish', 'Check lint: running', 'Check tests: pending', 'svn update: pending', 'Review: pending', 'Remove the worktree: pending']])
    const reviewing = action({ stage: 'reviewing', runId: 'r1', roots: [{ path: `${worktreeConst}/lib`, own: 'lib', changed: ['lib/a'] },
      { path: worktreeConst, own: '', changed: ['a'] }] })
    const workflow = SvnActionWorkflow.of(record(reviewing), reviewing, runs({}))
    expect(steps(workflow)).toEqual([['Finish', 'Review (lib): running', 'Review: pending', 'Remove the worktree: pending']])
    expect(workflow.rounds[0].steps[0].target).toEqual({ kind: 'commit', runId: 'r1' })
    expect(workflow.summary).toBe('Reviewing 1 of 2')
  })

  it('shows a lock relaunch and a cleanup as their own steps in the same round', () => {
    const current = action({ passes: [pass('evidence', 100, 200), pass('updating', 200, 210, { runId: 'u0', result: 'failed' }),
      pass('cleaning', 210, 220, { runId: 'c0' })], runId: 'u1' })
    const workflow = SvnActionWorkflow.of(record(current), current, runs({}))
    expect(steps(workflow)).toEqual([['Finish', 'Read what the worktree committed: done', 'svn update: failed', 'svn cleanup: done',
      'svn update: running', 'Review: pending', 'Remove the worktree: pending']])
    expect(workflow.rounds[0].steps.map((step) => step.key))
      .toEqual(['1:evidence', '1:updating', '1:cleaning', '1:updating#2', '1:review:.', '1:removing'])
  })

  it('starts round 2 at a second update after incoming commits ran the checks again', () => {
    const current = action({ checks: [{ key: 'lint', scriptId: 'checks', name: 'lint', commands: [] }], stage: 'checks', runId: 'c2',
      passes: [pass('evidence', 100, 200), pass('checks', 200, 250, { runId: 'c1' }), pass('updating', 250, 300, { runId: 'u1' })] })
    // The run of the first check is gone; its history entry on the parent names it.
    const history = record(current, { scriptRuns: [{ runId: 'c1', phase: 'after', scriptId: 'checks', name: 'lint', title: 'lint 014',
      commands: [], startedAt: 200, endedAt: 250, exitCode: 0, outcome: 'succeeded', log: { state: 'saved', bytes: 1, truncated: false } }] })
    const workflow = SvnActionWorkflow.of(history, current, runs({}))
    expect(steps(workflow)).toEqual([
      ['Finish', 'Read what the worktree committed: done', 'Check lint: done', 'svn update: done', 'Check lint: running'],
      ['Update 2', 'svn update: pending', 'Review: pending', 'Remove the worktree: pending'],
    ])
    expect(workflow.rounds[1].steps[0].key).toBe('2:updating')
  })

  it('shows a waiting action with its need, and admits Finish again, Keep worktree and Discard', () => {
    const current = action({ needs: { kind: 'conflict', reason: 'tree or property conflicts after the update: .aidocs/engines', at: 400 } })
    const workflow = SvnActionWorkflow.of(record(current), current, runs({}))
    expect(workflow).toMatchObject({ badge: 'conflicts need you', open: true,
      summary: 'Waits for you: tree or property conflicts after the update: .aidocs/engines' })
    expect(workflow.rounds[0].steps[0]).toMatchObject({ title: 'svn update', state: 'waits', detail: current.needs?.reason,
      startedAt: 300, endedAt: 400, target: { kind: 'run', runId: 'u1' } })
    expect(workflow.actions).toEqual([
      { id: 'finish-again', label: 'Finish again', primary: true },
      { id: 'keep', label: 'Keep worktree', primary: false },
      { id: 'discard', label: 'Discard', primary: false },
      { id: 'open-in-vscode', label: 'Open in VS Code', primary: false },
    ])
    const discard = action({ kind: 'discard', stage: 'stopping', needs: { kind: 'not-stopped', reason: 'x', at: 2 } })
    expect(SvnActionWorkflow.of(record(discard), discard, runs({})).actions.map((entry) => entry.id)).toEqual(['discard', 'keep', 'open-in-vscode'])
    const update = action({ kind: 'update-main', root: 'Q:/Work/App', needs: { kind: 'locked', reason: 'x', at: 2 } })
    expect(SvnActionWorkflow.of(record(update), update, runs({}))).toMatchObject({ title: 'UPDATE of App', actions: [] })
  })

  it('admits Stop agent, Keep worktree and Discard while the resolver works, and nothing during any other running stage', () => {
    const current = action({ stage: 'resolving', runId: 'cl', passes: [pass('updating', 200, 300, { runId: 'u1' })] })
    const workflow = SvnActionWorkflow.of(record(current), current, runs({ cl: 'Resolve conflicts 014' }))
    expect(workflow.summary).toBe('Claude resolves the conflicts')
    expect(workflow.rounds.flatMap((round) => round.steps).find((step) => step.state === 'running'))
      .toMatchObject({ title: 'Claude resolves the conflicts', target: { kind: 'agent', runId: 'cl' } })
    expect(workflow.actions).toEqual([
      { id: 'stop-agent', label: 'Stop agent', primary: false, runId: 'cl' },
      { id: 'keep', label: 'Keep worktree', primary: false },
      { id: 'discard', label: 'Discard', primary: false },
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
      ['Update 2, after the merger', 'svn update: pending', 'Review: pending', 'Remove the worktree: pending'],
    ])
    expect(workflow.rounds[0].steps[2]).toMatchObject({ detail: 'Merge conflicts 014-fix-login', target: { kind: 'agent', runId: 'm1' } })
    expect(workflow).toMatchObject({ badge: 'merging', summary: 'The merger settles the conflicts the rules left' })
    expect(workflow.actions).toEqual([
      { id: 'finish-again', label: 'Check again', primary: true },
      { id: 'open-merger', label: 'Open merger', primary: false, runId: 'm1' },
      { id: 'stop-agent', label: 'Stop agent', primary: false, runId: 'm1' },
      { id: 'open-in-vscode', label: 'Open in VS Code', primary: false },
      { id: 'keep', label: 'Keep worktree', primary: false },
      { id: 'discard', label: 'Discard', primary: false },
    ])

    const updated = action({ stage: 'updating', runId: 'u2', stageAt: 600, passes: [...current.passes ?? [],
      pass('merging', 400, 500, { runId: 'm1' }), pass('fixing', 500, 600, { facts: { conflicts: 3, fixed: 1, left: 0 } })] })
    expect(steps(SvnActionWorkflow.of(record(updated), updated, runs({})))).toEqual([
      ['Finish', 'svn update: done', 'Check the conflicts: done', 'Merger: done', 'Check the conflicts: done'],
      ['Update 2, after the merger', 'svn update: running', 'Review: pending', 'Remove the worktree: pending'],
    ])
  })

  it('admits on a conflict wait Check again, Resolve with agent while a path an agent may settle is open, VS Code, Keep and Discard', () => {
    const entry = { path: 'a.txt', kind: 'text' as const, shape: 'text-overlap' as const, state: 'person' as const, options: ['merged' as const], facts: {} }
    const set = { readAt: 1, baseRevision: 1, revision: 2, entries: [entry], more: 0, waited: true as const }
    const waiting = action({ stage: 'fixing', needs: { kind: 'conflict', reason: '1 conflict needs you', at: 5 }, conflictSet: set })
    expect(SvnActionWorkflow.of(record(waiting), waiting, runs({})).actions.map(({ id, label, primary }) => `${id} ${label} ${primary}`)).toEqual([
      'finish-again Check again true', 'resolve-with-agent Resolve with agent false', 'open-in-vscode Open in VS Code false',
      'keep Keep worktree false', 'discard Discard false',
    ])
    const personOnly = { ...waiting, conflictSet: { ...set, entries: [{ ...entry, shape: 'binary' as const, options: ['take-incoming' as const] }] } }
    expect(SvnActionWorkflow.of(record(personOnly), personOnly, runs({})).actions.map((item) => item.id))
      .toEqual(['finish-again', 'open-in-vscode', 'keep', 'discard'])
  })

  it('shows Check the conflicts running after Check again, with the checks, the update, the review and the removal ahead', () => {
    const current = action({ stage: 'fixing', runId: 'u1', passes: [pass('updating', 200, 300, { runId: 'u1', result: 'waited', facts: { conflicts: 3 } })] })
    const workflow = SvnActionWorkflow.of(record(current), current, runs({}))
    expect(steps(workflow)).toEqual([
      ['Finish', 'svn update: done', 'Conflicts: waits', 'Check the conflicts: running'],
      ['Update 2', 'svn update: pending', 'Review: pending', 'Remove the worktree: pending'],
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

  it('shows the ended view of the last outcome, its lines verbatim and not open', () => {
    const ended = record(undefined, { worktreeOutcome: { result: 'not-committed', revisions: [], main: 'none', worktree: 'kept',
      lines: ['KEPT: conflicts; Q:/w stays'], at: 900 } })
    expect(SessionWorkflows.of(ended, runs({}))).toEqual({
      kind: 'finish', workflowId: 'ended:900', title: 'Finish of 014 - fix login', badge: 'not committed',
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
})
