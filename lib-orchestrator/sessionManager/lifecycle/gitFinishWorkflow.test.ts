import { describe, expect, it } from 'vitest'

import type { SessionRecord, SessionRecordScriptRun, SessionRecordScriptStep } from '../records/sessionRecord.types'
import type { SessionWorkflowInfo } from '../sessionManagerApi.types'
import { SessionWorkflows } from './sessionWorkflows'

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

  it('shows the resolver as an agent step that opens its tab', () => {
    const workflow = SessionWorkflows.of(record({ worktreeMerge: { phase: 'resolving', resolveSessionId: 'resolver-1', startedAt: 13 } }), runs({}))
    expect(steps(workflow)).toEqual(['Merge the base into the branch: done', 'Claude resolves the conflicts: running',
      'Merge into the base: pending', 'Remove the worktree: pending'])
    expect(workflow?.rounds[0]?.steps[1]?.target).toEqual({ kind: 'agent', runId: 'resolver-1' })
    expect(workflow?.badge).toBe('resolving')
  })

  it('shows a merge failure as failed with its words, says to press Finish, and admits no action', () => {
    const failure = 'Q:/Work/App holds uncommitted changes to tracked files; commit or stash them first'
    const workflow = SessionWorkflows.of(record({ worktreeMerge: { phase: 'main-merging', startedAt: 13, failure } }), runs({}))
    expect(steps(workflow)).toEqual(['Merge the base into the branch: done', 'Merge into the base: failed', 'Remove the worktree: pending'])
    expect(workflow?.rounds[0]?.steps[1]?.detail).toBe(failure)
    expect(workflow).toMatchObject({ badge: 'merge failed', summary: `${failure}; press Finish to continue`, open: false, actions: [] })

    const checkFailed = SessionWorkflows.of(record({ finishChecks: { runId: 'r-lint', steps: [lint], cursor: 0, startedAt: 5,
      result: { kind: 'failed', reason: 'the lint check exited with 1', at: 8 } } }), runs({}))
    expect(steps(checkFailed)).toEqual(['Check lint: failed', 'Merge the base into the branch: skipped', 'Merge into the base: skipped',
      'Remove the worktree: skipped'])
    expect(checkFailed).toMatchObject({ badge: 'check failed', summary: 'the lint check exited with 1; press Finish to continue' })
  })

  it('has no Git workflow for passed checks with no merge, nor for an SVN record', () => {
    const passed = { runId: 'r-lint', steps: [lint], cursor: 0, startedAt: 5, result: { kind: 'passed' as const, at: 8 } }
    expect(SessionWorkflows.of(record({ finishChecks: passed }), runs({}))).toBeNull()
    expect(SessionWorkflows.of(record({ finishChecks: { runId: 'r', steps: [lint], cursor: 0, startedAt: 5 },
      worktree: { worktreePath: worktreeConst, branch: 'u', baseCommit: 'r1', repositoryRoot: 'Q:/Work/App', kind: 'svn' } }), runs({}))).toBeNull()
  })
})
