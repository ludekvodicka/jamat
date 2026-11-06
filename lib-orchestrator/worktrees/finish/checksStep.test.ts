import { describe, expect, it } from 'vitest'
import { WorkerHandoffs } from '../../sessionManager/worktreeSessionRuntime'
import { finishTestRecords } from './finishTestRecords'
import { ChecksStep } from './checksStep'

describe('ChecksStep', () => {
  it('retains failure evidence and hands the log to the worker of an agent Finish while returning to working', async () => {
    const h = await finishTestRecords({ step: 'checking', owner: 'agent' })
    const handoffs = new WorkerHandoffs(() => h.records, () => '')
    const step = new ChecksStep(h.records, handoffs)
    expect(await step.complete('worker', { passed: false, at: 10, logPath: '/logs/full.log' }, { check: 'tests', reason: 'the tests check exited with 1', stopped: false })).toBe(false)
    expect(h.records.get('worker')?.worktreeLifecycle).toMatchObject({ phase: 'active', checks: { passed: false, overridden: false } })
    expect(handoffs.pending()[0].text).toContain('/logs/full.log')
    expect(await step.override('worker', 'agent')).toBe(false)
    expect(await step.override('worker', 'person')).toBe(true)
    expect(handoffs.pending()).toEqual([])
    expect((await h.reload()).get('worker')?.worktreeLifecycle).toMatchObject({ step: 'reviewing', checks: { passed: false, overridden: true } })
  })

  // Worktree 103 (J17): the person stopped a hanging check and the Finish ended with no Retry or Solve with agent.
  it.each([
    ['a Finish the person holds', 'person' as const, false],
    ['a Finish a remote person holds', 'remote-person' as const, false],
    ['a stopped check of an agent Finish', 'agent' as const, true],
  ])('keeps %s at the failed check for the person, with nothing handed to the worker', async (_name, owner, stopped) => {
    const h = await finishTestRecords({ step: 'checking', owner, execution: { root: 'Q:/wt', checks: [{ key: 'tests', scriptId: 'checks', name: 'tests', commands: [] }],
      checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 1, runId: 'r1', verdict: { kind: 'failed', reason: 'its tests check was stopped' }, checkBefore: {} } })
    const handoffs = new WorkerHandoffs(() => h.records, () => '')
    expect(await new ChecksStep(h.records, handoffs).complete('worker', { passed: false, at: 10, logPath: '/logs/full.log' },
      { check: 'tests', reason: 'its tests check was stopped', stopped })).toBe(true)
    // One write: a restart after it lands in the wait, never in a check that runs again (review 8).
    const saved = (await h.reload()).get('worker')?.worktreeLifecycle
    expect(saved).toMatchObject({ phase: 'waiting', step: 'checking', checks: { passed: false, overridden: false, logPath: '/logs/full.log' },
      wait: { kind: 'checks-failed', at: 10, reason: ChecksStep.failedReasonOf('tests', 'its tests check was stopped', '/logs/full.log') },
      execution: { checkCursor: 0 } })
    expect(saved?.execution).not.toHaveProperty('runId')
    expect(saved?.execution?.verdict).toBeUndefined()
    expect(handoffs.pending()).toEqual([])
  })

  it('names the check, its reason, its log and the answers in the wait it leaves', () => {
    expect(ChecksStep.failedReasonOf('typecheck', 'its check was stopped', '/logs/full.log')).toBe('The check typecheck did not pass: its check was stopped.'
      + ' Log: /logs/full.log. Retry checks, accept the failure, solve it with an agent, or go back to work to send the log to the worker.')
  })

  it('records check outputs without replacing prior worker changes with setup proof', async () => {
    const h = await finishTestRecords({ step: 'checking', checkBaseline: { setup: 'old' } })
    await new ChecksStep(h.records, { checksFailed: async () => {}, notifyCaller: async () => {} }).recordChanges('worker',
      { setup: 'old', worker: 'worker-before' }, { setup: 'new', worker: 'check-after', created: 'new' })
    expect(h.records.get('worker')?.worktreeLifecycle?.checkBaseline).toEqual({ setup: 'new', created: 'new' })
  })

  it('passed checks advance to review without delivering a failure', async () => {
    const h = await finishTestRecords({ step: 'checking' })
    const handoffs = new WorkerHandoffs(() => h.records, () => '')
    await new ChecksStep(h.records, handoffs).complete('worker', { passed: true, at: 10, logPath: '/logs/pass.log' })
    expect(h.records.get('worker')?.worktreeLifecycle?.step).toBe('reviewing')
    expect(handoffs.pending()).toEqual([])
  })

  it('records a Finish without declared checks as passed and not configured, so nothing names a check (D15)', async () => {
    const h = await finishTestRecords({ step: 'checking' })
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!,
      execution: { root: record.worktree!.worktreePath, requestedBy: 'window', startedAt: 1, checks: [], checkCursor: 0, rootCursor: 0, evidence: [] } } }))
    await new ChecksStep(h.records, { checksFailed: async () => {}, notifyCaller: async () => {} }).complete('worker', { passed: true, at: 10, logPath: '' })
    expect(h.records.get('worker')?.worktreeLifecycle).toMatchObject({ step: 'reviewing', checks: { passed: true, configured: false, logPath: '' } })
  })
})
