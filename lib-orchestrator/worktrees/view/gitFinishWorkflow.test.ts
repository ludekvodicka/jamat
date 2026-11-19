import { describe, expect, it } from 'vitest'

import type { SessionRecord, SessionRecordScriptRun, SessionRecordScriptStep } from '../../sessionManager/worktreeSessionRecords'
import type { SessionWorkflowInfo } from '../../sessionManager/sessionManagerApi.types'
import { SessionWorkflows } from '../../sessionManager/worktreeSessionRuntime'

describe('lib-orchestrator/sessionManager/lifecycle/gitFinishWorkflow', () => {
  const worktreeConst = 'Q:/Work/App/.worktrees/014-fix'
  const lint: SessionRecordScriptStep = { key: 'k-lint', scriptId: 'declared', name: 'lint', commands: [{ command: 'pnpm lint', cwd: worktreeConst }] }
  const tests: SessionRecordScriptStep = { key: 'k-tests', scriptId: 'declared', name: 'tests', commands: [{ command: 'pnpm test', cwd: worktreeConst }] }

  function record(overrides: Partial<SessionRecord>): SessionRecord {
    return {
      sessionId: 's1', kind: 'agent', title: '014 - fix', createdAt: 0, life: 'ended', binding: null,
      directory: { mode: 'adHoc', path: 'Q:/Work/App' },
      worktree: { worktreePath: worktreeConst, branch: 'jamat/014-fix', baseCommit: 'abc', repositoryRoot: 'Q:/Work/App', kind: 'git' },
      ...overrides,
    }
  }

  const history = (runId: string, step: SessionRecordScriptStep, startedAt: number, endedAt: number): SessionRecordScriptRun => ({
    runId, phase: 'after', scriptId: 'declared', name: step.name, title: `${step.name} 014-fix`, stepKey: step.key, commands: [],
    startedAt, endedAt, outcome: 'succeeded', log: { state: 'saved', bytes: 1, truncated: false },
  })
  const runs = (records: Record<string, Partial<SessionRecord>>) => (runId: string): SessionRecord | null =>
    records[runId] === undefined ? null : record({ sessionId: runId, ...records[runId] })
  const steps = (workflow: SessionWorkflowInfo | null) => workflow?.rounds.flatMap((round) => round.steps.map((step) => `${step.title}: ${step.state}`))

  it('shows the embedded Git review only on the current Changes step', () => {
    const waiting = SessionWorkflows.of(record({ worktreeMerge: { phase: 'base-merging', startedAt: 1, changes: true } }), runs({}))
    expect(waiting?.rounds[0]?.steps[0]).toMatchObject({ title: 'Changes', state: 'waits',
      body: { kind: 'commit', vcs: 'git', scopeRoot: worktreeConst } })
    expect(waiting?.actions).toEqual([
      { id: 'finish-again', label: 'Commit & merge', primary: true, place: 'step', requiresCommit: true },
      { id: 'discard', label: 'Discard', primary: false, place: 'step', confirm: expect.any(String) },
      { id: 'keep', label: 'Keep worktree', primary: false, place: 'step' },
    ])
    const ended = SessionWorkflows.of(record({ worktree: undefined, worktreeMerge: { phase: 'tearing-down', startedAt: 1, endedAt: 9,
      runs: [{ phase: 'commit', runId: 'commit-1', startedAt: 1, endedAt: 2 },
        { phase: 'base-merging', runId: 'base-1', startedAt: 2, endedAt: 3 },
        { phase: 'main-merging', runId: 'main-1', startedAt: 3, endedAt: 4 },
        { phase: 'tearing-down', runId: 'remove-1', startedAt: 4, endedAt: 9 }] } }), runs({}))
    expect(ended).toMatchObject({ open: false, actions: [] })
    expect(ended?.rounds[0]?.steps.map((step) => step.body)).toEqual(
      ['commit-1', 'base-1', 'main-1', 'remove-1'].map((runId) => ({ kind: 'log', runId })))
  })

  it('runs the checks first with the merge steps and the removal pending, then the merge phases in order', () => {
    const checking = record({ finishChecks: { runId: 'r-tests', steps: [lint, tests], cursor: 1, startedAt: 5 },
      scriptRuns: [history('r-lint', lint, 5, 9)] })
    const workflow = SessionWorkflows.of(checking, runs({ 'r-tests': { title: 'tests 014-fix', createdAt: 9 } }))
    expect(workflow).toMatchObject({ kind: 'git-finish', workflowId: 'git-finish:s1:5', title: 'Finish of 014 - fix', badge: 'checking',
      summary: 'Running the check tests', open: true, actions: [] })
    expect(steps(workflow)).toEqual(['Check lint: done', 'Check tests: running', 'Merge the base into the branch: pending',
      'Merge into the base: pending', 'Remove the worktree: pending'])
    expect(workflow?.rounds[0]?.steps[1]).toMatchObject({ detail: 'tests 014-fix', startedAt: 9, target: { kind: 'run', runId: 'r-tests' } })

    const passed = { runId: 'r-tests', steps: [lint, tests], cursor: 1, startedAt: 5, result: { kind: 'passed' as const, at: 12 } }
    const merging = SessionWorkflows.of(record({ finishChecks: passed, worktreeMerge: { phase: 'main-merging', startedAt: 13 } }), runs({}))
    expect(steps(merging)).toEqual(['Check lint: done', 'Check tests: done', 'Merge the base into the branch: done',
      'Merge into the base: running', 'Remove the worktree: pending'])
    expect(merging).toMatchObject({ badge: 'merging', summary: 'Merging into the base', open: true })
    expect(steps(SessionWorkflows.of(record({ worktreeMerge: { phase: 'tearing-down', startedAt: 13 } }), runs({}))))
      .toEqual(['Merge the base into the branch: done', 'Merge into the base: done', 'Remove the worktree: running'])
  })

  it('offers Stop agent while the resolver runs, and names a manual resolution without one', () => {
    const resolving = SessionWorkflows.of(record({ worktreeMerge: { phase: 'resolving', resolveSessionId: 'resolver-1', startedAt: 13 } }), runs({ 'resolver-1': { life: 'live' } }))
    expect(resolving?.actions).toEqual([{ id: 'stop-agent', label: 'Stop agent', primary: false, place: 'step', runId: 'resolver-1' }])
    expect(resolving?.summary).toBe('Claude resolves the conflicts; Jamat stops it after 20 minutes')
    const manual = SessionWorkflows.of(record({ worktreeMerge: { phase: 'resolving', startedAt: 13, failure: 'main conflicts with this session' } }), runs({}))
    expect(steps(manual)).toContain('Resolve the conflicts: failed')
    expect(manual?.actions.map((action) => action.id)).toEqual(['finish-again', 'keep', 'discard'])
  })

  it('shows the resolver as an agent step that opens its tab', () => {
    const workflow = SessionWorkflows.of(record({ worktreeMerge: { phase: 'resolving', resolveSessionId: 'resolver-1', startedAt: 13 } }), runs({}))
    expect(steps(workflow)).toEqual(['Merge the base into the branch: done', 'Claude resolves the conflicts: running',
      'Merge into the base: pending', 'Remove the worktree: pending'])
    expect(workflow?.rounds[0]?.steps[1]?.target).toEqual({ kind: 'agent', runId: 'resolver-1' })
    expect(workflow?.badge).toBe('resolving')
  })

  it('shows a merge failure as failed with its words and offers Try again, Keep worktree and Discard', () => {
    const failure = 'Q:/Work/App holds uncommitted changes to tracked files; commit or stash them first'
    const workflow = SessionWorkflows.of(record({ worktreeMerge: { phase: 'main-merging', startedAt: 13, failure } }), runs({}))
    expect(steps(workflow)).toEqual(['Merge the base into the branch: done', 'Merge into the base: failed', 'Remove the worktree: pending'])
    expect(workflow?.rounds[0]?.steps[1]?.detail).toBe(failure)
    expect(workflow).toMatchObject({ badge: 'merge failed', summary: failure, open: true, actions: [{ id: 'finish-again', label: 'Try again', primary: true },
      { id: 'keep', label: 'Keep worktree', primary: false }, { id: 'discard', label: 'Discard', primary: false }] })

    const checkFailed = SessionWorkflows.of(record({ finishChecks: { runId: 'r-lint', steps: [lint], cursor: 0, startedAt: 5,
      result: { kind: 'failed', reason: 'the lint check exited with 1', at: 8 } } }), runs({}))
    expect(steps(checkFailed)).toEqual(['Check lint: failed', 'Merge the base into the branch: skipped', 'Merge into the base: skipped',
      'Remove the worktree: skipped'])
    expect(checkFailed).toMatchObject({ badge: 'check failed', summary: 'the lint check exited with 1; fix it, then press Try again' })
  })

  it('has no Git workflow for passed checks with no merge, nor for an SVN record', () => {
    const passed = { runId: 'r-lint', steps: [lint], cursor: 0, startedAt: 5, result: { kind: 'passed' as const, at: 8 } }
    expect(SessionWorkflows.of(record({ finishChecks: passed }), runs({}))).toBeNull()
    expect(SessionWorkflows.of(record({ finishChecks: { runId: 'r', steps: [lint], cursor: 0, startedAt: 5 },
      worktree: { worktreePath: worktreeConst, branch: 'u', baseCommit: 'r1', repositoryRoot: 'Q:/Work/App', kind: 'svn' } }), runs({}))).toBeNull()
  })
})
