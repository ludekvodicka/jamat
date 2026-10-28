import { describe, expect, it, vi } from 'vitest'
import { AgentPresets } from '../../sessionManager/worktreeSessionRuntime'
import { finishTestRecords } from './finishTestRecords'
import { WorkerLiveness } from './workerLiveness'
import type { FinishStep } from '../worktreeState'
import { WorkerResumePolicy } from '../worktreeState'

describe('WorkerLiveness', () => {
  it.each(['checks-failed', 'worker-busy', 'waiting-for-review'] as const)('replaces an older %s wait after two failed resumes and retains it across reload', async (kind) => {
    const h = await fixture('checking')
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!,
      phase: 'waiting', wait: { kind, reason: 'Previous wait', at: 1 } } }))
    h.resume.mockImplementation(async () => ({ ok: false, code: 'invalid-spec', detail: 'Conversation missing' }) as never)
    await h.die()
    await h.worker.run('worker')
    await h.worker.run('worker')
    expect(h.records.get('worker')?.worktreeLifecycle?.wait?.kind).toBe('worker-lost')
    expect((await h.reload()).get('worker')?.worktreeLifecycle?.wait?.kind).toBe('worker-lost')
  })
  it.each<[FinishStep | undefined, string]>([
    [undefined, 'resume-and-redeliver'], ['syncing', 'resume-and-redeliver'], ['checking', 'resume-and-redeliver'], ['worker-resolving', 'resume-and-redeliver'],
    ['reviewing', 'resume-quiet'], ['awaiting-idle', 'resume-quiet'], ['committing', 'resume-after-step'], ['verifying', 'resume-after-step'], ['disposing', 'resume-after-step'],
    ['stopping-worker', 'none'], ['removing', 'none'], ['recording', 'none'],
  ])('applies the resume policy for %s', (step, expected) => { expect(WorkerResumePolicy.onDeath(step)).toBe(expected) })

  async function fixture(step: FinishStep = 'worker-resolving') {
    const h = await finishTestRecords({ step })
    const clock = { now: 42 }
    // A resume starts a runtime again, as the real one does: the record is live after it.
    const resume = vi.fn(async () => {
      await h.records.update('worker', (record) => ({ ...record, life: 'live', endedAt: undefined }))
      return { ok: true as const, value: undefined }
    })
    const redeliver = vi.fn(async () => {})
    const notify = vi.fn(async () => {})
    const worker = new WorkerLiveness({ records: h.records, resume, redeliver, notify, now: () => clock.now })
    const die = async (reason = 'process-exit') => {
      await h.records.update('worker', (record) => ({ ...record, life: 'lost', endedAt: clock.now }))
      await worker.died('worker', reason)
    }
    return { ...h, worker, resume, redeliver, notify, die, clock }
  }

  it('ignores a removed session during death and resume callbacks', async () => {
    const h = await fixture()
    await h.worker.died('removed', 'Host restart')
    await h.worker.run('removed')
    expect(h.resume).not.toHaveBeenCalled()
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('resumes the interrupted conversation and redelivers only the worker step brief', async () => {
    const h = await fixture()
    await h.die()
    await Promise.all([h.worker.run('worker'), h.worker.run('worker')])
    expect(h.resume).toHaveBeenCalledOnce()
    expect(h.redeliver).toHaveBeenCalledOnce()
    expect((await h.reload()).get('worker')?.worktreeLifecycle).toMatchObject({ step: 'worker-resolving', facts: { worker: { liveness: 'alive', resumedAt: 42 } } })
  })

  it.each<FinishStep>(['committing', 'verifying', 'disposing'])('does not interrupt %s and resumes after its completion', async (step) => {
    const h = await fixture(step)
    await h.die()
    await h.worker.run('worker')
    expect(h.resume).not.toHaveBeenCalled()
    expect(h.records.get('worker')?.worktreeLifecycle).toMatchObject({ phase: 'finishing', step })
    await h.worker.run('worker', step)
    expect(h.resume).toHaveBeenCalledOnce()
    expect(h.redeliver).not.toHaveBeenCalled()
  })

  it('uses launch eligibility to refuse unconfirmed Codex identity and stops after two failures', async () => {
    const h = await fixture()
    const problem = AgentPresets.reopenProblem({ agentId: 'codex', launchMode: 'new' })!
    h.resume.mockImplementation(async () => ({ ok: false, code: 'invalid-spec', detail: problem }) as never)
    await h.die()
    await h.worker.run('worker')
    await h.worker.run('worker')
    await h.worker.run('worker')
    expect(h.resume).toHaveBeenCalledTimes(2)
    expect(h.records.get('worker')?.worktreeLifecycle).toMatchObject({ wait: { kind: 'worker-lost' }, facts: { worker: { resumeFailures: 2 } } })
  })

  // A resume of a conversation that does not exist starts a runtime that ends half a second later;
  // counting that as a success resumed the worker 26 times in 69 seconds (UA1-J14-2).
  it('counts a resumed worker that ends at once as a failed resume, waits before the next and gives worker-lost after two', async () => {
    const h = await fixture()
    await h.die()
    await h.worker.run('worker')
    expect(h.resume).toHaveBeenCalledTimes(1)
    h.clock.now += 500
    await h.die()
    expect(h.records.get('worker')?.worktreeLifecycle?.facts.worker).toMatchObject({ liveness: 'dead', resumeFailures: 1 })
    expect(h.notify).toHaveBeenLastCalledWith('worker', expect.stringMatching(/ended 0\.5 s after its resume.*resume 2 of 2/))
    await h.worker.run('worker')
    expect(h.resume).toHaveBeenCalledTimes(1)
    h.clock.now += WorkerLiveness.retryDelayMilliseconds
    await h.worker.run('worker')
    expect(h.resume).toHaveBeenCalledTimes(2)
    h.clock.now += 500
    await h.die()
    await h.worker.run('worker')
    expect(h.resume).toHaveBeenCalledTimes(2)
    const state = h.records.get('worker')?.worktreeLifecycle
    expect(state).toMatchObject({ phase: 'waiting', wait: { kind: 'worker-lost' }, facts: { worker: { liveness: 'dead', resumeFailures: 2 } } })
    expect(state?.wait?.reason).toMatch(/could not resume twice: the resumed worker ended 0\.5 s after its resume \(process-exit\)/)
    expect(state?.wait?.reason).toMatch(/Press Resume worker to continue its conversation, or Keep worktree or Discard to decide the worktree without it\./)
    expect(h.notify).toHaveBeenLastCalledWith('worker', expect.stringMatching(/^Worker lost: /))
  })

  it('names an id the running agent never confirmed in the worker-lost wait', async () => {
    const h = await fixture()
    await h.records.update('worker', (record) => ({ ...record, agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'launched-id' } }))
    await h.die()
    await h.worker.run('worker')
    for (let attempt = 0; attempt < 2; attempt++) {
      h.clock.now += 500
      await h.die()
      h.clock.now += WorkerLiveness.retryDelayMilliseconds
      await h.worker.run('worker')
    }
    expect(h.records.get('worker')?.worktreeLifecycle?.wait?.reason).toMatch(/never confirmed conversation launched-id/)
  })

  it('starts the next death from zero once the resumed worker stayed alive past the proving time', async () => {
    const h = await fixture()
    await h.die()
    await h.worker.run('worker')
    h.clock.now += 500
    await h.die()
    h.clock.now += WorkerLiveness.retryDelayMilliseconds
    await h.worker.run('worker')
    h.clock.now += WorkerLiveness.provingMilliseconds
    await h.die()
    expect(h.records.get('worker')?.worktreeLifecycle?.facts.worker).toMatchObject({ liveness: 'dead', resumeFailures: 0 })
    await h.worker.run('worker')
    expect(h.resume).toHaveBeenCalledTimes(3)
  })

  it('does not count a Host interruption right after a resume against the worker', async () => {
    const h = await fixture()
    await h.die()
    await h.worker.run('worker')
    h.clock.now += 500
    await h.die('host-stopped')
    expect(h.records.get('worker')?.worktreeLifecycle?.facts.worker).toMatchObject({ liveness: 'dead', resumeFailures: 0 })
    await h.worker.run('worker')
    expect(h.resume).toHaveBeenCalledTimes(2)
  })

  // Outside a Finish the wait had no step, the store refused the record and every poll threw (UA1-J14R-1).
  it('gives worker-lost to a worker outside a Finish, with the person\'s choices', async () => {
    const h = await finishTestRecords({ phase: 'active', step: undefined, actionId: null })
    const clock = { now: 42 }
    const resume = vi.fn(async () => {
      await h.records.update('worker', (record) => ({ ...record, life: 'live', endedAt: undefined }))
      return { ok: true as const, value: undefined }
    })
    const worker = new WorkerLiveness({ records: h.records, resume, redeliver: vi.fn(async () => {}), notify: vi.fn(async () => {}), now: () => clock.now })
    const die = async () => {
      await h.records.update('worker', (record) => ({ ...record, life: 'lost', endedAt: clock.now }))
      await worker.died('worker', 'process-exit')
    }
    await die()
    await worker.run('worker')
    clock.now += 500
    await die()
    clock.now += WorkerLiveness.retryDelayMilliseconds
    await worker.run('worker')
    clock.now += 500
    await die()
    const state = (await h.reload()).get('worker')?.worktreeLifecycle
    expect(state).toMatchObject({ phase: 'waiting', wait: { kind: 'worker-lost' }, facts: { worker: { liveness: 'dead', resumeFailures: 2 } } })
    expect(state?.step).toBeUndefined()
    expect(state?.wait?.reason).toMatch(/Press Resume worker to continue its conversation, or Keep worktree or Discard/)
  })

  it('takes a person\'s resume out of the worker-lost wait: back to work outside a Finish, back to its step inside one', async () => {
    const lost = { kind: 'worker-lost' as const, reason: 'lost', at: 1 }
    const dead = { worker: { liveness: 'dead' as const, resumeFailures: 2, diedAt: 1, resumeMode: 'resume-and-redeliver' as const } }
    const outside = await finishTestRecords({ phase: 'waiting', step: undefined, actionId: null, wait: lost, facts: dead })
    const notify = vi.fn(async () => {})
    const worker = new WorkerLiveness({ records: outside.records, resume: vi.fn(), redeliver: vi.fn(async () => {}), notify, now: () => 77 })
    await worker.reopened('worker')
    expect(outside.records.get('worker')?.worktreeLifecycle).toMatchObject({ phase: 'active', step: undefined, wait: undefined,
      facts: { worker: { liveness: 'alive', resumeFailures: 0, resumedAt: 77, resumeMode: undefined } } })
    const inside = await finishTestRecords({ phase: 'waiting', step: 'checking', wait: lost, facts: dead })
    await new WorkerLiveness({ records: inside.records, resume: vi.fn(), redeliver: vi.fn(async () => {}), notify, now: () => 77 }).reopened('worker')
    expect(inside.records.get('worker')?.worktreeLifecycle).toMatchObject({ phase: 'finishing', step: 'checking', wait: undefined,
      facts: { worker: { liveness: 'alive', resumeFailures: 0 } } })
  })

  it('leaves a lifecycle with no lost worker as it is after a person\'s resume', async () => {
    const h = await finishTestRecords({ phase: 'active', step: undefined, actionId: null })
    const before = h.records.get('worker')?.worktreeLifecycle
    await new WorkerLiveness({ records: h.records, resume: vi.fn(), redeliver: vi.fn(async () => {}), notify: vi.fn(async () => {}), now: () => 77 }).reopened('worker')
    expect(h.records.get('worker')?.worktreeLifecycle).toEqual(before)
  })

  // One refused record write stopped the whole reconcile pass, and every other session with it (UA1-J14R-1).
  it('observes every ended worker on its own: a refused write of one is reported and the others go on', async () => {
    const h = await finishTestRecords()
    await h.records.put({ ...h.records.get('worker')!, sessionId: 'other', title: 'Other' })
    for (const id of ['worker', 'other']) await h.records.update(id, (record) => ({ ...record, life: 'lost', endedAt: 1 }))
    const update = h.records.update.bind(h.records)
    vi.spyOn(h.records, 'update').mockImplementation(async (id, change) => {
      if (id === 'worker') throw new Error('Refusing to store an invalid session record: test')
      return update(id, change)
    })
    const resume = vi.fn(async () => ({ ok: true as const, value: undefined }))
    const report = vi.fn()
    const worker = new WorkerLiveness({ records: h.records, resume, redeliver: vi.fn(async () => {}), notify: vi.fn(async () => {}), now: () => 42 })
    await worker.observe(h.records.list(), report)
    expect(report).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith(expect.stringMatching(/^Session worker: the worker liveness check failed: Refusing to store/))
    expect(resume).toHaveBeenCalledWith('other')
    expect(h.records.get('other')?.worktreeLifecycle?.facts.worker).toMatchObject({ liveness: 'alive', resumedAt: 42 })
  })

  it.each<FinishStep>(['stopping-worker', 'removing', 'recording'])('does not resume deferred death after reaching %s', async (step) => {
    const h = await fixture('disposing')
    await h.die()
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, step } }))
    await h.worker.run('worker', 'disposing')
    expect(h.resume).not.toHaveBeenCalled()
  })
})
