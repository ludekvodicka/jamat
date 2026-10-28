import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PassInbox } from './passInbox'
import { SnapinTestRig } from './snapinTestFixtures'
import type { WorktreeResultDto } from '../../sessionManager/sessionManagerApi.types'

describe('restart reconciliation', () => {
  let rig: SnapinTestRig
  beforeEach(async () => { rig = await SnapinTestRig.create(['test', 'other']) })
  afterEach(async () => { await rig.close(); vi.restoreAllMocks() })

  it('waits for session reconciliation, then reconciles once before admitting', async () => {
    await rig.item('next', 'wt'); const a = await rig.attempt({ itemKey: 'previous' })
    rig.snapshot.sessions.push(SnapinTestRig.session('previous', a.attemptId))
    rig.snapshot.reconciled = false
    await rig.store().update((doc) => ({ ...doc, queue: [{ itemKey: 'next', addedAt: rig.now }] }))
    await rig.tick()
    expect(rig.definitions[0]!.evidence).not.toHaveBeenCalled()
    expect(rig.sessions.createSession).not.toHaveBeenCalled()
    expect(rig.manager.list().kinds[0]?.state).toBe('reconciling')
    rig.snapshot.reconciled = true; await rig.tick()
    expect(rig.definitions[0]!.evidence).toHaveBeenCalledOnce()
    expect(rig.sessions.createSession).toHaveBeenCalledOnce()
    await rig.tick()
    expect(vi.mocked(rig.definitions[0]!.evidence).mock.calls.filter((call) => call[1].attemptId === a.attemptId)).toHaveLength(1)
  })

  it('settles other kinds while one kind is latched and admits none', async () => {
    await mkdir(join(rig.directory, 'test'), { recursive: true })
    await writeFile(join(rig.directory, 'test', 'state.json'), '{')
    const a = await rig.attempt({ itemKey: 'previous' }, 'other')
    await (await PassInbox.open(rig.pass(a, 'other'))).append({ kind: 'done', at: rig.now, outcome: 'ready', detail: 'review' })
    await rig.item('next', 'wc', 'other')
    await rig.store('other').update((doc) => ({ ...doc, queue: [{ itemKey: 'next', addedAt: rig.now }] }))
    await rig.tick()
    expect(rig.store('other').current.attempts[0]?.phase).toBe('review')
    expect(rig.sessions.createSession).not.toHaveBeenCalled()
    expect(rig.manager.list().kinds[0]?.state).toBe('unavailable')
  })

  it('adopts a pending session by callerOperationId without creating another', async () => {
    const a = await rig.attempt({ phase: 'pending' })
    rig.snapshot.sessions.push(SnapinTestRig.session('found', a.attemptId))
    await rig.tick()
    expect(rig.store().current.attempts[0]).toMatchObject({ phase: 'pending', sessionId: 'found' })
    expect(rig.sessions.createSession).not.toHaveBeenCalled()
  })

  it.each([true, false])('judges a sessionless pending attempt only after evidence, published=%s', async (published) => {
    await rig.attempt({ phase: 'pending' })
    if (published) vi.mocked(rig.definitions[0]!.evidence).mockResolvedValue({ published: true, detail: '900-complete-p1-scratch.md' })
    await rig.tick()
    expect(rig.store().current.attempts[0]).toMatchObject(published
      ? { phase: 'completed', leaseHeld: false, resultsSettled: true }
      : { phase: 'ended', endedReason: 'never-created', leaseHeld: false })
    expect(rig.store().current.queue).toEqual([])
  })

  it('replays offline done ready from a missing working session and preserves review', async () => {
    const a = await rig.attempt()
    await (await PassInbox.open(rig.pass(a))).append({ kind: 'done', at: rig.now, outcome: 'ready', detail: 'review' })
    await rig.tick(); rig.now += 120_000; await rig.tick()
    expect(rig.store().current.attempts[0]).toMatchObject({ phase: 'review', appliedThrough: 1 })
    expect(rig.sessions.createSession).not.toHaveBeenCalled()
  })

  it('completes a missing review from HEAD evidence', async () => {
    await rig.attempt({ phase: 'review' })
    vi.mocked(rig.definitions[0]!.evidence).mockResolvedValue({ published: true, detail: '900-wont_fix-p1-scratch.md' })
    await rig.tick()
    expect(rig.store().current.attempts[0]).toMatchObject({ phase: 'completed', leaseHeld: false })
  })

  it('starts a fresh 120-second grace for a missing worker at reconcile', async () => {
    await rig.attempt({ goneObservedAt: rig.now - 500_000 })
    await rig.tick()
    expect(rig.store().current.attempts[0]).toMatchObject({ phase: 'working', goneObservedAt: rig.now })
    rig.now += 119_999; await rig.tick(); expect(rig.store().current.attempts[0]?.phase).toBe('working')
    rig.now++; await rig.tick()
    expect(rig.store().current.attempts[0]).toMatchObject({ phase: 'ended', endedReason: 'ended-without-result', leaseHeld: true })
  })

  it('retries a refused kind reconcile, while other kinds settle and all admission waits', async () => {
    await rig.attempt()
    const other = await rig.attempt({ itemKey: 'old' }, 'other')
    await (await PassInbox.open(rig.pass(other, 'other'))).append({ kind: 'done', at: rig.now, outcome: 'ready', detail: 'review' })
    await rig.item('next', 'wc', 'other')
    await rig.store('other').update((doc) => ({ ...doc, queue: [{ itemKey: 'next', addedAt: rig.now }] }))
    vi.spyOn(rig.store(), 'update').mockResolvedValueOnce(false)
    await rig.tick()
    expect(rig.manager.list().kinds[0]?.state).toBe('reconciling')
    expect(rig.store('other').current.attempts[0]?.phase).toBe('review')
    expect(rig.sessions.createSession).not.toHaveBeenCalled()
    await rig.tick()
    expect(rig.manager.list().kinds[0]?.state).not.toBe('reconciling')
    // The old review holds its parent project lease, so use an independent WT grant.
    rig.items.get('other')![0]!.mode = 'wt'; rig.now += 10_000; await rig.list('other')
    expect(rig.sessions.createSession).toHaveBeenCalledOnce()
  })

  it('returns a crash-interrupted pending lease transfer to its predecessor', async () => {
    const a = await rig.attempt({ phase: 'ended', leaseHeld: false })
    await rig.attempt({ phase: 'pending', leaseFrom: a.attemptId, leaseHeld: true })
    await rig.tick()
    expect(rig.store().current.attempts[0]?.leaseHeld).toBe(true)
    expect(rig.store().current.attempts[1]).toMatchObject({ phase: 'ended', endedReason: 'never-created', leaseHeld: false })
  })

  it('checks a queued Release after adopting a worker that was absent before reconcile', async () => {
    const a = await rig.attempt({ phase: 'pending' })
    rig.snapshot.reconciled = false
    expect(await rig.press('release', ['one'])).toMatchObject({ ok: true })
    rig.snapshot.sessions.push(SnapinTestRig.session('worker', a.attemptId))
    rig.snapshot.reconciled = true; await rig.tick()
    expect(rig.store().current.attempts[0]).toMatchObject({ phase: 'pending', leaseHeld: true, sessionId: 'worker' })
    expect((await rig.manager['kinds'].get('test')!.log.read()).some((line) => line.text.includes('Close the worker session'))).toBe(true)
  })

  it('continues completed presentation and results after a fresh manager loads the persisted state', async () => {
    const a = await rig.attempt({ phase: 'completed', mode: 'wt', leaseHeld: false, resultsSettled: false,
      sessionId: 'worker', presentationRetryAt: rig.now })
    const session = SnapinTestRig.session('worker', a.attemptId)
    session.worktreeView = { phase: 'landed' } as typeof session.worktreeView
    rig.snapshot.sessions.push(session)
    vi.mocked(rig.sessions.worktreeResults).mockResolvedValue({ ok: true, value: { results: [
      { tag: a.attemptId, actionId: 'result', acknowledgedAt: null } as WorktreeResultDto,
    ] } })
    await rig.manager.stop(); rig.manager = rig.newManager()
    await rig.tick()
    expect(rig.store().current.attempts[0]).toMatchObject({ presentedPhase: 'completed', resultsSettled: true })
    expect(rig.store().current.attempts[0]?.presentationRetryAt).toBeUndefined()
    expect(rig.presentation.setNote).toHaveBeenCalledWith('worker', 'Done')
    expect(rig.sessions.acknowledgeWorktreeResult).toHaveBeenCalledWith('result')
  })

  it('never returns a released lease after Restart then Release and a never-created replacement', async () => {
    const item = await rig.item('one')
    await rig.attempt({ phase: 'ended', projectDirectory: item.projectDirectory })
    await rig.list()
    vi.mocked(rig.sessions.createSession).mockRejectedValueOnce(new Error('transport'))
    await Promise.all([rig.manager.press('test', 'shared.restart', ['one']), rig.manager.press('test', 'shared.release', ['one'])])
    await rig.tick(); await rig.manager.stop(); rig.manager = rig.newManager(); await rig.tick()
    expect(rig.store().current.attempts[1]).toMatchObject({ phase: 'ended', endedReason: 'never-created', leaseHeld: false })
    expect(rig.store().current.attempts[1]?.leaseFrom).toBeUndefined()
    expect(rig.store().current.attempts.some((a) => a.leaseHeld)).toBe(false)
  })

  it('returns a second failed replacement lease after reload and then releases the original holder', async () => {
    const item = await rig.item('one')
    const a = await rig.attempt({ phase: 'ended', projectDirectory: item.projectDirectory })
    await rig.list()
    vi.mocked(rig.sessions.createSession).mockResolvedValueOnce({ ok: false, code: 'invalid-spec', detail: 'x' })
      .mockRejectedValueOnce(new Error('transport'))
    await rig.press('restart', ['one']); await rig.press('restart', ['one'])
    expect(rig.store().current.attempts[2]).toMatchObject({ phase: 'pending', leaseHeld: true, leaseFrom: a.attemptId })
    await rig.manager.stop(); rig.manager = rig.newManager(); await rig.tick()
    expect(rig.store().current.attempts[2]).toMatchObject({ phase: 'ended', endedReason: 'never-created', leaseHeld: false })
    expect(rig.store().current.attempts[0]?.leaseHeld).toBe(true)
    await rig.press('release', ['one'])
    expect(rig.store().current.attempts.some((attempt) => attempt.leaseHeld)).toBe(false)
  })

  it('skips attempts pruned by a preceding reconcile write without losing readiness', async () => {
    rig.now = 30 * 86_400_000
    const first = await rig.attempt({ phase: 'working', leaseHeld: false })
    const expired = { ...first, attemptId: randomUUID(), itemKey: 'expired', phase: 'ended' as const, createdAt: 1, endedAt: 1, presentedPhase: 'ended' as const }
    const kept = Array.from({ length: 200 }, (_, i) => ({ ...expired, attemptId: randomUUID(), itemKey: `kept-${i}`, endedAt: 100 + i }))
    await Promise.all(kept.map((attempt) => PassInbox.create(rig.pass(attempt), { schema: 1, attemptId: attempt.attemptId,
      kind: 'test', mode: 'wc', projectDirectory: rig.root, priorAttemptId: null, work: { kind: 'fixture' } })))
    await rig.manager.stop()
    await writeFile(join(rig.directory, 'test', 'state.json'), JSON.stringify({ schemaVersion: 1, kind: 'test', paused: false,
      queue: [], attempts: [first, expired, ...kept] }))
    rig.manager = rig.newManager(); await rig.tick()
    expect(rig.manager.list().kinds[0]?.state).not.toBe('reconciling')
    expect(rig.store().current.attempts.some((a) => a.attemptId === expired.attemptId)).toBe(false)
    expect(rig.report).not.toHaveBeenCalled()
  })
})
