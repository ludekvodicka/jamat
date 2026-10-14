import { describe, expect, it } from 'vitest'

import type { SessionRecord, SessionRecordScriptRun, SessionRecordScriptStep } from '../records/sessionRecord.types'
import type { SessionWorkflowInfo } from '../sessionManagerApi.types'
import { SessionWorkflows } from './sessionWorkflows'

describe('lib-orchestrator/sessionManager/lifecycle/setupWorkflow', () => {
  const worktreeConst = 'D:/Temp/jamat-conflicts/main/.worktrees/t2'

  const checkout: SessionRecordScriptStep = { key: 'k-checkout', scriptId: 'svn', name: 'checkout', commands: [],
    process: { tool: 'svn', args: ['checkout'], cwd: worktreeConst } }
  const setup: SessionRecordScriptStep = { key: 'k-setup', scriptId: 'setup', name: 'setup', commands: [{ command: 'pnpm i', cwd: worktreeConst }] }
  const codegen: SessionRecordScriptStep = { key: 'k-codegen', scriptId: 'declared', name: 'codegen', commands: [{ command: 'pnpm gen', cwd: worktreeConst }] }

  function record(overrides: Partial<SessionRecord>): SessionRecord {
    return {
      sessionId: 's1', kind: 'agent', title: '014 - t2', createdAt: 0, life: 'starting', binding: null,
      directory: { mode: 'adHoc', path: 'D:/Temp/jamat-conflicts/main' },
      worktree: { worktreePath: worktreeConst, branch: 'file:///repo', baseCommit: 'r1', repositoryRoot: 'D:/Temp/jamat-conflicts/main', kind: 'svn' },
      ...overrides,
    }
  }

  const history = (runId: string, step: SessionRecordScriptStep, outcome: SessionRecordScriptRun['outcome'], startedAt: number, endedAt: number,
    reason?: string): SessionRecordScriptRun => ({
    runId, phase: 'before', scriptId: step.scriptId === 'checks' ? 'declared' : step.scriptId, name: step.name, title: `${step.name} t2`,
    stepKey: step.key, commands: [], startedAt, endedAt, outcome, ...reason === undefined ? {} : { reason },
    log: { state: 'saved', bytes: 1, truncated: false },
  })
  const runs = (records: Record<string, Partial<SessionRecord>>) => (runId: string): SessionRecord | null =>
    records[runId] === undefined ? null : record({ sessionId: runId, ...records[runId] })
  const steps = (workflow: SessionWorkflowInfo | null) => workflow?.rounds.flatMap((round) => round.steps.map((step) => `${step.title}: ${step.state}`))

  it('runs the checkout of a chain at its first step, with the setup and the declared steps pending', () => {
    const starting = record({ pendingSetup: { setupSessionId: 'r-checkout', steps: [checkout, setup, codegen], cursor: 0 } })
    const workflow = SessionWorkflows.of(starting, runs({ 'r-checkout': { title: 'svn checkout t2', createdAt: 50 } }))

    expect(workflow).toMatchObject({ kind: 'before', workflowId: 'setup:s1', title: 'Setup of 014 - t2', badge: 'checkout runs',
      summary: 'Running Checkout t2', open: true, actions: [] })
    expect(steps(workflow)).toEqual(['Checkout t2: running', 'Setup: pending', 'Script codegen: pending'])
    expect(workflow?.rounds[0]?.steps[0]).toMatchObject({ detail: 'svn checkout t2', startedAt: 50, endedAt: null,
      target: { kind: 'run', runId: 'r-checkout' } })
  })

  it('shows a skipped setup after the checkout when the project declares none', () => {
    const starting = record({ pendingSetup: { setupSessionId: 'r-checkout', steps: [checkout], cursor: 0 },
      setupSkipped: { reason: 'the project declares an empty setup in .worktree.json' } })
    const workflow = SessionWorkflows.of(starting, runs({}))
    expect(steps(workflow)).toEqual(['Checkout t2: running', 'Setup: skipped'])
    expect(workflow?.rounds[0]?.steps[1]).toMatchObject({ detail: 'the project declares an empty setup in .worktree.json', target: { kind: 'none' } })
  })

  it('shows the earlier steps done and the failed step with its reason, and admits Retry setup', () => {
    const failed = record({
      life: 'ended',
      pendingSetup: { setupSessionId: 'r-codegen', steps: [checkout, setup, codegen], cursor: 2 },
      scriptRuns: [
        history('r-checkout', checkout, 'succeeded', 10, 20),
        history('r-setup-1', setup, 'failed', 20, 25, 'the setup exited with 1'),
        history('r-setup-2', setup, 'succeeded', 30, 40),
        history('r-codegen', codegen, 'failed', 40, 45, 'the codegen script exited with 2'),
      ],
    })
    const workflow = SessionWorkflows.of(failed, runs({}))

    expect(steps(workflow)).toEqual(['Checkout t2: done', 'Setup: done', 'Script codegen: failed'])
    expect(workflow?.rounds[0]?.steps[1]).toMatchObject({ startedAt: 30, endedAt: 40, target: { kind: 'run', runId: 'r-setup-2' } })
    expect(workflow?.rounds[0]?.steps[2]).toMatchObject({ detail: 'the codegen script exited with 2', startedAt: 40, endedAt: 45,
      target: { kind: 'run', runId: 'r-codegen' } })
    expect(workflow).toMatchObject({ badge: 'codegen script failed', open: false,
      summary: 'Script codegen failed: the codegen script exited with 2; press Retry setup',
      actions: [{ id: 'retry-setup', label: 'Retry setup', primary: true }] })
  })

  it('has no before workflow once the chain finished or the session runs', () => {
    expect(SessionWorkflows.of(record({ life: 'live', scriptRuns: [history('r-checkout', checkout, 'succeeded', 1, 2)] }), runs({}))).toBeNull()
    expect(SessionWorkflows.of(record({ life: 'live', pendingSetup: { setupSessionId: 'r', steps: [checkout], cursor: 0 } }), runs({}))).toBeNull()
  })

  it('reads a wait written before chains as one setup step', () => {
    expect(steps(SessionWorkflows.of(record({ worktree: undefined, pendingSetup: { setupSessionId: 'r-setup' } }), runs({}))))
      .toEqual(['Setup: running'])
  })
})
