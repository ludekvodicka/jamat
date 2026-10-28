import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttemptRecord } from './snapinContract'
import type { WorktreeResultDto } from '../../sessionManager/sessionManagerApi.types'
import { PassInbox } from './passInbox'
import { Presentation } from './presentation'
import { SnapinTestRig } from './snapinTestFixtures'

describe('phase presentation', () => {
  let rig: SnapinTestRig
  beforeEach(async () => { rig = await SnapinTestRig.create() })
  afterEach(async () => { await rig.close(); vi.restoreAllMocks(); vi.useRealTimers() })

  it.each([
    ['pending', 'automation', 'Starting'], ['working', 'automation', 'Working'],
    ['waiting', 'waiting', 'Waits for your answer'], ['review', 'waiting', 'Waits for your review: Finish or commit'],
    ['blocked', 'blocked', 'Blocked: '], ['completed', 'completed', 'Done'],
  ] as const)('maps %s to its group and note', (phase, group, note) => {
    expect(Presentation.of({ phase } as AttemptRecord)).toEqual({ group, note })
  })

  it('leaves ended unchanged, caps blocked detail and distinguishes deploy waits', () => {
    expect(Presentation.of({ phase: 'ended' } as AttemptRecord)).toBeNull()
    expect(Presentation.of({ phase: 'blocked', outcome: { detail: 'x'.repeat(65_536) } } as AttemptRecord)?.note.length).toBeLessThanOrEqual(209)
    for (const waiting of ['deploy', 'foreign-deploy'] as const)
      expect(Presentation.of({ phase: 'waiting', outcome: { waiting } } as AttemptRecord)?.note).toBe('Waits for deploy')
  })

  it('preserves a person-edited note until the next phase and ensures groups only once per tick', async () => {
    const a = await rig.attempt({ sessionId: 'worker' })
    rig.snapshot.sessions.push(SnapinTestRig.session('worker', a.attemptId))
    await rig.tick()
    expect(rig.presentation.setNote).toHaveBeenCalledWith('worker', 'Working')
    rig.snapshot.sessions[0]!.note = 'Person note'
    vi.mocked(rig.presentation.setNote).mockClear(); vi.mocked(rig.presentation.assign).mockClear()
    await rig.tick()
    expect(rig.presentation.setNote).not.toHaveBeenCalled()
    expect(rig.presentation.assign).not.toHaveBeenCalled()
    await (await PassInbox.open(rig.pass(a))).append({ kind: 'done', at: rig.now, outcome: 'ready', detail: '' })
    await rig.tick()
    expect(rig.presentation.setNote).toHaveBeenCalledWith('worker', 'Waits for your review: Finish or commit')
    expect(rig.presentation.ensureGroups).toHaveBeenCalledTimes(2)
  })

  it('applies the note and records the phase when a missing group cannot be restored', async () => {
    const a = await rig.attempt({ sessionId: 'worker' }); rig.snapshot.sessions.push(SnapinTestRig.session('worker', a.attemptId))
    vi.mocked(rig.presentation.ensureGroups).mockResolvedValue(false)
    vi.mocked(rig.presentation.assign).mockReturnValue('missing-group')
    await rig.tick(); await rig.tick()
    expect(rig.presentation.setNote).toHaveBeenCalledOnce()
    expect(rig.store().current.attempts[0]?.presentedPhase).toBe('working')
    expect((await rig.manager['kinds'].get('test')!.log.read()).filter((line) => line.text.includes('presentation group missing'))).toHaveLength(1)
  })

  it('retries a failed note after sixty seconds and records a missing session without retry', async () => {
    const a = await rig.attempt({ sessionId: 'worker' }); rig.snapshot.sessions.push(SnapinTestRig.session('worker', a.attemptId))
    vi.mocked(rig.presentation.setNote).mockResolvedValueOnce('failed')
    await rig.tick()
    expect(rig.store().current.attempts[0]?.presentedPhase).toBeUndefined()
    expect(rig.store().current.attempts[0]?.presentationRetryAt).toBe(rig.now + 60_000)
    rig.now += 59_999; await rig.tick(); expect(rig.presentation.setNote).toHaveBeenCalledOnce()
    rig.now++; await rig.tick(); expect(rig.presentation.setNote).toHaveBeenCalledTimes(2)
    expect(rig.store().current.attempts[0]?.presentationRetryAt).toBeUndefined()
    const b = await rig.attempt({ itemKey: 'two', sessionId: 'gone', leaseHeld: false, phase: 'review' })
    vi.mocked(rig.presentation.assign).mockReturnValueOnce('missing-session')
    await rig.tick()
    expect(rig.store().current.attempts.find((attempt) => attempt.attemptId === b.attemptId)?.presentedPhase).toBe('review')
  })

  it('keeps the timer alive for a lone completed attempt whose Done note failed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const a = await rig.attempt({ phase: 'completed', resultsSettled: true, leaseHeld: false, sessionId: 'worker' })
    rig.snapshot.sessions.push(SnapinTestRig.session('worker', a.attemptId))
    vi.mocked(rig.presentation.setNote).mockResolvedValueOnce('failed')
    await rig.tick()
    expect(rig.manager['timer']).not.toBeNull()
    rig.now += 60_000
    await vi.advanceTimersByTimeAsync(10_000)
    while (rig.manager['ticking']) await rig.manager['ticking']
    expect(rig.presentation.setNote).toHaveBeenLastCalledWith('worker', 'Done')
    expect(rig.presentation.setNote).toHaveBeenCalledTimes(2)
    expect(rig.manager['timer']).toBeNull()
  })

  it('repairs a partial phase change even when phase returns to the last presented phase', async () => {
    const a = await rig.attempt({ sessionId: 'worker' })
    rig.snapshot.sessions.push(SnapinTestRig.session('worker', a.attemptId))
    await rig.tick()
    const inbox = await PassInbox.open(rig.pass(a))
    vi.mocked(rig.presentation.setNote).mockResolvedValueOnce('failed')
    await inbox.append({ kind: 'done', at: rig.now, outcome: 'ready', detail: 'review' }); await rig.tick()
    await inbox.append({ kind: 'working', at: rig.now }); await rig.tick()
    expect(rig.store().current.attempts[0]).toMatchObject({ phase: 'working', presentedPhase: 'working', presentationRetryAt: rig.now + 60_000 })
    rig.now += 60_000; await rig.tick()
    expect(rig.presentation.assign).toHaveBeenLastCalledWith('worker', 'automation')
    expect(rig.presentation.setNote).toHaveBeenLastCalledWith('worker', 'Working')
    expect(rig.store().current.attempts[0]?.presentationRetryAt).toBeUndefined()
  })

  it('does not acknowledge after a refused presentedPhase write and retries both next tick', async () => {
    const a = await rig.attempt({ phase: 'completed', resultsSettled: false, leaseHeld: false, mode: 'wt', sessionId: 'worker' })
    const session = SnapinTestRig.session('worker', a.attemptId)
    session.worktreeView = { phase: 'landed' } as typeof session.worktreeView
    rig.snapshot.sessions.push(session)
    vi.mocked(rig.sessions.worktreeResults).mockResolvedValue({ ok: true, value: { results: [
      { tag: a.attemptId, actionId: 'result', acknowledgedAt: null } as WorktreeResultDto,
    ] } })
    const write = vi.spyOn(rig.store(), 'update').mockResolvedValueOnce(false)
    await rig.tick()
    expect(write).toHaveBeenCalledOnce()
    expect(rig.sessions.acknowledgeWorktreeResult).not.toHaveBeenCalled()
    await rig.tick()
    expect(rig.sessions.acknowledgeWorktreeResult).toHaveBeenCalledOnce()
    expect(rig.store().current.attempts[0]).toMatchObject({ presentedPhase: 'completed', resultsSettled: true })
  })
})
