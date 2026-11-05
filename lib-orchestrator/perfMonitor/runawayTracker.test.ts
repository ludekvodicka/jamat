import { describe, expect, it, vi } from 'vitest'
import { RunawayTracker, type RunawayObservation } from './runawayTracker'

const process: RunawayObservation = { pid: 2, startedAt: 10, image: 'node.exe', cores: 0.9,
  sessionId: 'session', session: '093', sessionKind: 'agent', idle: true }

describe('runaway descendants', () => {
  it('opens the named session on notice click without any process-control action', async () => {
    const open = vi.fn(async (_sessionId: string) => {})
    const notice = RunawayTracker.notice({ ...process, minutes: 10 }, open)
    expect(notice.title).toBe('Runaway process in session 093')
    expect(notice.body).toContain('node.exe under session 093 keeps 0.9 core busy for 10 min while the session is idle')
    expect(notice.body).toContain('stop the child from its shell or Windows Task Manager')
    expect(open).not.toHaveBeenCalled()
    await notice.click()
    expect(open).toHaveBeenCalledExactlyOnceWith('session')
  })

  it('allows a restarted process with the same pid and a new start time to notify again', () => {
    const notify = vi.fn(), tracker = new RunawayTracker(notify)
    for (let minute = 1; minute <= 10; minute++) tracker.update([process], minute * 60_000, new Set(['2:10']))
    const restarted = { ...process, startedAt: 20 }
    for (let minute = 11; minute <= 20; minute++) tracker.update([restarted], minute * 60_000, new Set(['2:20']))
    expect(notify.mock.calls.map(([row]) => [row.pid, row.startedAt, row.minutes])).toEqual([[2, 10, 10], [2, 20, 10]])
  })
  it('records and notifies once after ten consecutive idle samples, not an eleventh', () => {
    const notify = vi.fn(), tracker = new RunawayTracker(notify)
    const records = []
    for (let minute = 1; minute <= 11; minute++) records.push(...tracker.update([process], minute * 60_000, new Set(['2:10'])))
    expect(records).toEqual([{ ...process, minutes: 10 }])
    expect(notify).toHaveBeenCalledExactlyOnceWith({ ...process, minutes: 10 })
  })

  it('breaks the streak for work, low usage and missing samples without repeating a prior notice', () => {
    const notify = vi.fn(), tracker = new RunawayTracker(notify)
    for (let minute = 1; minute <= 9; minute++) tracker.update([process], minute * 60_000, new Set(['2:10']))
    tracker.update([{ ...process, idle: false }], 600_000, new Set(['2:10']))
    for (let minute = 11; minute <= 19; minute++) tracker.update([process], minute * 60_000, new Set(['2:10']))
    tracker.reset()
    tracker.update([{ ...process, cores: 0.5 }], 1_200_000, new Set(['2:10']))
    expect(notify).not.toHaveBeenCalled()
    for (let minute = 21; minute <= 30; minute++) tracker.update([process], minute * 60_000, new Set(['2:10']))
    tracker.update([], 1_860_000, new Set(['2:10']))
    for (let minute = 32; minute <= 42; minute++) tracker.update([process], minute * 60_000, new Set(['2:10']))
    expect(notify).toHaveBeenCalledTimes(1)
  })
})
