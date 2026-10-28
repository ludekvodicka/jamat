import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo, WorktreeResultDto } from '../../sessionManager/sessionManagerApi.types'
import { PassInbox, type PassEvent } from './passInbox'
import { SnapinTestRig } from './snapinTestFixtures'
import type { AttemptRecord } from './snapinContract'

describe('pass settlement', () => {
  let rig: SnapinTestRig
  const event = async (a: AttemptRecord, value: PassEvent) => (await PassInbox.open(rig.pass(a))).append(value)
  const result = (a: AttemptRecord, actionId: string, kind: WorktreeResultDto['result'] = 'committed'): WorktreeResultDto =>
    ({ tag: a.attemptId, actionId, result: kind, acknowledgedAt: null }) as WorktreeResultDto
  const worker = (a: AttemptRecord, phase: NonNullable<SessionInfo['worktreeView']>['phase'] = 'active') => {
    const session = SnapinTestRig.session('worker', a.attemptId)
    session.worktreeView = { phase } as SessionInfo['worktreeView']
    rig.snapshot.sessions.push(session)
    return session
  }
  beforeEach(async () => { rig = await SnapinTestRig.create() })
  afterEach(async () => { await rig.close(); vi.restoreAllMocks() })

  it('applies started and done ready once in one atomic cursor/phase write', async () => {
    const a = await rig.attempt({ phase: 'pending' }); worker(a)
    await event(a, { kind: 'started', at: rig.now, trail: 'trail' })
    await event(a, { kind: 'done', at: rig.now, outcome: 'ready', detail: 'review' })
    await rig.tick()
    expect(rig.store().current.attempts[0]).toMatchObject({ phase: 'review', appliedThrough: 2, trail: 'trail' })
    const writes = vi.spyOn(rig.store(), 'update')
    await rig.tick()
    expect(writes).not.toHaveBeenCalled()
  })

  it('maps analysis waiting reasons and resumes working', async () => {
    const a = await rig.attempt(); worker(a)
    await event(a, { kind: 'done', at: rig.now, outcome: 'analysis', waiting: 'blocked', detail: 'question' })
    await rig.tick(); expect(rig.store().current.attempts[0]?.phase).toBe('blocked')
    await event(a, { kind: 'done', at: rig.now, outcome: 'analysis', waiting: 'deploy', detail: 'deploy' })
    await rig.tick(); expect(rig.store().current.attempts[0]?.phase).toBe('waiting')
    await event(a, { kind: 'working', at: rig.now })
    await rig.tick(); expect(rig.store().current.attempts[0]?.phase).toBe('working')
  })

  it('completes only from evidence, releases WC and waits for later WT results, retrying failed acknowledges', async () => {
    const a = await rig.attempt({ mode: 'wt', leaseHeld: false }); const session = worker(a)
    vi.mocked(rig.definitions[0]!.evidence).mockResolvedValue({ published: true, detail: '900-complete-p1-scratch.md' })
    await rig.tick()
    expect(rig.store().current.attempts[0]).toMatchObject({ phase: 'completed', resultsSettled: false, leaseHeld: false })
    vi.mocked(rig.sessions.worktreeResults).mockResolvedValue({ ok: true, value: { results: [result(a, 'late'), { ...result(a, 'foreign'), tag: 'other' }] } })
    vi.mocked(rig.sessions.acknowledgeWorktreeResult).mockResolvedValueOnce({ ok: false, code: 'op-rejected', detail: 'retry' })
    session.worktreeView!.phase = 'landed'
    rig.now += 30_000; await rig.tick()
    expect(rig.store().current.attempts[0]?.resultsSettled).toBe(false)
    rig.now += 30_000; await rig.tick()
    expect(rig.store().current.attempts[0]?.resultsSettled).toBe(true)
    expect(rig.sessions.acknowledgeWorktreeResult).toHaveBeenCalledTimes(2)
    expect(rig.sessions.acknowledgeWorktreeResult).not.toHaveBeenCalledWith('foreign')
  })

  it('keeps result settlement open through verification, Keep and resumed Finish until landed', async () => {
    const a = await rig.attempt({ mode: 'wt', leaseHeld: false }); const session = worker(a, 'finishing')
    vi.mocked(rig.definitions[0]!.evidence).mockResolvedValue({ published: true, detail: 'published' })
    const results = [result(a, 'first')]
    vi.mocked(rig.sessions.worktreeResults).mockImplementation(async () => ({ ok: true, value: { results } }))
    vi.mocked(rig.sessions.acknowledgeWorktreeResult).mockImplementation(async (id) => {
      results.find((r) => r.actionId === id)!.acknowledgedAt = rig.now
      return { ok: true, value: { actionId: id } }
    })
    await rig.tick(); expect(rig.store().current.attempts[0]?.resultsSettled).toBe(false)
    session.worktreeView!.phase = 'kept'; results.push(result(a, 'keep', 'kept'))
    rig.now += 30_000; await rig.tick(); expect(rig.store().current.attempts[0]?.resultsSettled).toBe(false)
    session.worktreeView!.phase = 'finishing'; results.push(result(a, 'resumed'))
    rig.now += 30_000; await rig.tick(); expect(rig.store().current.attempts[0]?.resultsSettled).toBe(false)
    session.worktreeView!.phase = 'landed'
    rig.now += 30_000; await rig.tick(); expect(rig.store().current.attempts[0]?.resultsSettled).toBe(true)
    expect(rig.sessions.acknowledgeWorktreeResult).toHaveBeenCalledTimes(3)
  })

  it('settles after a missing completed WT record for 120s and logs once, but an ended kept record stays open', async () => {
    const a = await rig.attempt({ phase: 'completed', completedAt: rig.now, mode: 'wt', leaseHeld: false, resultsSettled: false })
    vi.mocked(rig.sessions.worktreeResults).mockResolvedValue({ ok: true, value: { results: [result(a, 'one')] } })
    await rig.tick(); rig.now += 120_000; await rig.tick(); await rig.tick()
    expect(rig.store().current.attempts[0]?.resultsSettled).toBe(true)
    const lines = await rig.manager['kinds'].get('test')!.log.read()
    expect(lines.filter((line) => line.text.includes('worktree ending not observed'))).toHaveLength(1)
    const b = await rig.attempt({ itemKey: 'two', phase: 'completed', completedAt: rig.now, mode: 'wt', leaseHeld: false, resultsSettled: false })
    worker(b, 'kept').life = 'ended'
    await rig.tick(); rig.now += 120_000; await rig.tick()
    expect(rig.store().current.attempts[1]?.resultsSettled).toBe(false)
  })

  it.each(['pending', 'working', 'review'] as const)('ends discarded evidence from %s and releases its lease', async (phase) => {
    const a = await rig.attempt({ phase }); worker(a, 'removed')
    vi.mocked(rig.definitions[0]!.evidence).mockResolvedValue({ discarded: true })
    await rig.tick()
    expect(rig.store().current.attempts[0]).toMatchObject({ phase: 'ended', endedReason: 'discarded', leaseHeld: false })
  })

  it('does no presentation or acknowledge after a refused settlement write', async () => {
    const a = await rig.attempt({ mode: 'wt', leaseHeld: false }); worker(a, 'landed')
    vi.mocked(rig.definitions[0]!.evidence).mockResolvedValue({ published: true, detail: 'done' })
    vi.spyOn(rig.store(), 'update').mockResolvedValueOnce(false)
    await rig.tick()
    expect(rig.sessions.acknowledgeWorktreeResult).not.toHaveBeenCalled()
    expect(rig.presentation.setNote).not.toHaveBeenCalled()
    expect(rig.store().current.attempts[0]?.phase).toBe('working')
  })

  it('keeps unpublished WC review, then supersedes it on Restart with the held lease', async () => {
    const item = await rig.item('one')
    const a = await rig.attempt({ phase: 'review', projectDirectory: item.projectDirectory }); worker(a).life = 'ended'
    await rig.list()
    expect(rig.store().current.attempts[0]).toMatchObject({ phase: 'review', attention: 'not-published' })
    rig.settings.workerPrompts = {}
    await rig.press('restart', ['one'])
    expect(rig.store().current.attempts[0]).toMatchObject({ phase: 'ended', endedReason: 'superseded', leaseHeld: true })
    expect(rig.store().current.queue[0]?.inheritsLeaseFrom).toBe(a.attemptId)
  })

  it('sets and clears the missing-session grace, then keeps the lease until Release', async () => {
    const a = await rig.attempt()
    await rig.tick(); expect(rig.store().current.attempts[0]?.goneObservedAt).toBe(rig.now)
    rig.now += 100_000; worker(a); await rig.tick()
    expect(rig.store().current.attempts[0]?.goneObservedAt).toBeUndefined()
    rig.snapshot.sessions = []; await rig.tick(); rig.now += 120_000; await rig.tick()
    expect(rig.store().current.attempts[0]).toMatchObject({ phase: 'ended', endedReason: 'ended-without-result', leaseHeld: true })
    await rig.press('release', ['one'])
    expect(rig.store().current.attempts[0]?.leaseHeld).toBe(false)
  })

  it('flags a late started event at 120 seconds and clears attention when it arrives', async () => {
    const a = await rig.attempt({ phase: 'pending' }); worker(a)
    await rig.tick(); rig.now += 120_000; await rig.tick()
    expect(rig.store().current.attempts[0]?.attention).toBe('start')
    await event(a, { kind: 'started', at: rig.now }); await rig.tick()
    expect(rig.store().current.attempts[0]).toMatchObject({ phase: 'working', appliedThrough: 1 })
    expect(rig.store().current.attempts[0]?.attention).toBeUndefined()
  })

  it('drains a done event arriving during the evidence read before ending a vanished worker', async () => {
    const a = await rig.attempt({ goneObservedAt: rig.now - 120_000 })
    let finish!: () => void
    vi.mocked(rig.definitions[0]!.evidence).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finish = resolve })
      return { published: false }
    })
    const ticking = rig.tick()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await event(a, { kind: 'done', at: rig.now, outcome: 'ready', detail: 'review' })
    finish(); await ticking
    expect(rig.store().current.attempts[0]).toMatchObject({ phase: 'review', appliedThrough: 1 })
  })

  it('logs an ended attempt event without reopening it', async () => {
    const a = await rig.attempt({ phase: 'ended', endedReason: 'released', leaseHeld: false })
    await event(a, { kind: 'working', at: rig.now }); await rig.tick()
    expect(rig.store().current.attempts[0]).toMatchObject({ phase: 'ended', appliedThrough: 1 })
    expect((await rig.manager['kinds'].get('test')!.log.read()).some((line) => line.text.endsWith(': working'))).toBe(true)
  })
})
