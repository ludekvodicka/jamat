import { describe, expect, it } from 'vitest'
import { WorkerHandoffs } from '../../sessionManager/worktreeSessionRuntime'
import { finishTestRecords } from './finishTestRecords'
import { ChecksStep } from './checksStep'

describe('ChecksStep', () => {
  it('retains failure evidence and hands the log to the worker while returning to working', async () => {
    const h = await finishTestRecords({ step: 'checking' })
    const handoffs = new WorkerHandoffs(() => h.records, () => '')
    const step = new ChecksStep(h.records, handoffs)
    await step.complete('worker', { passed: false, at: 10, logPath: '/logs/full.log' })
    expect(h.records.get('worker')?.worktreeLifecycle).toMatchObject({ phase: 'active', checks: { passed: false, overridden: false } })
    expect(handoffs.pending()[0].text).toContain('/logs/full.log')
    expect(await step.override('worker', 'agent')).toBe(false)
    expect(await step.override('worker', 'person')).toBe(true)
    expect(handoffs.pending()).toEqual([])
    expect((await h.reload()).get('worker')?.worktreeLifecycle).toMatchObject({ step: 'reviewing', checks: { passed: false, overridden: true } })
  })

  it('records check outputs without replacing prior worker changes with setup proof', async () => {
    const h = await finishTestRecords({ step: 'checking', checkBaseline: { setup: 'old' } })
    await new ChecksStep(h.records, { checksFailed: async () => {} }).recordChanges('worker',
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
})
