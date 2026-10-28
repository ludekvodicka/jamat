import { describe, expect, it, vi } from 'vitest'
import { FinishFlow, type FinishStepExecutors } from './finishFlow'
import { finishTestRecords } from './finishTestRecords'

function steps(overrides: Partial<FinishStepExecutors>): FinishStepExecutors {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected step') }
  return { syncing: unexpected, 'worker-resolving': unexpected, checking: unexpected, reviewing: unexpected,
    'awaiting-idle': unexpected, committing: unexpected, verifying: unexpected, disposing: unexpected,
    'stopping-worker': unexpected, removing: unexpected, recording: unexpected, ...overrides }
}

describe('FinishFlow', () => {
  it('yields a long repository sequence and resumes persisted progress without publishing twice', async () => {
    const h = await finishTestRecords({ step: 'committing' })
    let records = h.records
    const published: number[] = []
    const executors = steps({
      committing: async (id, state) => {
        const revision = (state.verified?.length ?? 0) + 1
        published.push(revision)
        await records.update(id, (record) => ({ ...record, worktreeLifecycle: { ...state, version: state.version + 1,
          step: 'verifying', journal: [...state.journal, { stepId: `mount-${revision}`, kind: 'commit', attempt: 1,
            runId: `run-${revision}`, startedAt: 1, endedAt: 2, outcome: 'ok', revision }] } }))
        return true
      },
      verifying: async (id, state) => {
        const revision = state.journal.at(-1)!.revision!
        await records.update(id, (record) => ({ ...record, worktreeLifecycle: { ...state, version: state.version + 1,
          step: revision === 40 ? undefined : 'committing', phase: revision === 40 ? 'landed' : 'finishing',
          verified: [...state.verified ?? [], { root: `mount-${revision}`, revision, paths: ['file'], at: 2 }] } }))
        return true
      },
    })
    const flow = () => new FinishFlow((id) => records.get(id)?.worktreeLifecycle, executors, async () => {})
    expect(await flow().advance('worker')).toBe('yield')
    expect(published).toHaveLength(16)
    records = await h.reload()
    expect(await flow().advance('worker')).toBe('yield')
    records = await h.reload()
    expect(await flow().advance('worker')).toBe('waiting')
    expect(published).toEqual(Array.from({ length: 40 }, (_, index) => index + 1))
    expect(records.get('worker')?.worktreeLifecycle).toMatchObject({ phase: 'landed', step: undefined })
  })

  it('leaves a retained verification step after an exception and never returns to commit on restart', async () => {
    const h = await finishTestRecords({ step: 'committing' })
    let records = h.records
    const commit = vi.fn(async (id: string) => {
      await records.update(id, (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!,
        version: record.worktreeLifecycle!.version + 1, step: 'verifying' } }))
      return true
    })
    const flow = new FinishFlow((id) => records.get(id)?.worktreeLifecycle,
      steps({ committing: commit, verifying: async () => { throw new Error('Verification unavailable') } }), async () => {})
    await expect(flow.advance('worker')).rejects.toThrow('Verification unavailable')
    records = await h.reload()
    const verification = vi.fn(async () => false)
    await new FinishFlow((id) => records.get(id)?.worktreeLifecycle,
      steps({ committing: commit, verifying: verification }), async () => {}).advance('worker')
    expect(commit).toHaveBeenCalledTimes(1)
    expect(verification).toHaveBeenCalledTimes(1)
  })

  it('does not execute a waiting review and re-reads a state changed by log recovery', async () => {
    const h = await finishTestRecords({ phase: 'waiting', step: 'reviewing', wait: { kind: 'review', reason: 'Approve', at: 1 } })
    const review = vi.fn(async () => false)
    const verify = vi.fn(async () => false)
    const before = vi.fn(async (id: string) => {
      await h.records.update(id, (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!,
        version: record.worktreeLifecycle!.version + 1, step: 'verifying' } }))
    })
    const flow = new FinishFlow((id) => h.records.get(id)?.worktreeLifecycle, steps({ reviewing: review, verifying: verify }), before)
    expect(await flow.advance('worker')).toBe('waiting')
    expect(before).not.toHaveBeenCalled()
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'finishing', wait: undefined } }))
    await flow.advance('worker')
    expect(review).not.toHaveBeenCalled()
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('stops an executor that claims progress without persisting it', async () => {
    const h = await finishTestRecords({ step: 'committing' })
    const commit = vi.fn(async () => true)
    const flow = new FinishFlow((id) => h.records.get(id)?.worktreeLifecycle, steps({ committing: commit }), async () => {})
    await expect(flow.advance('worker')).rejects.toThrow('committing continued without saving progress')
    expect(commit).toHaveBeenCalledTimes(1)
  })
})
