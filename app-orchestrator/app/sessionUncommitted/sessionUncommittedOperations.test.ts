import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionUncommittedCandidate } from '../../../lib-orchestrator/sessionManager/sessionUncommittedView'
import type { SessionActivity } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SessionUncommittedEntry } from '../../../lib-orchestrator/sessionUncommitted/sessionUncommitted.types'
import { SessionUncommittedOperations } from './sessionUncommittedOperations'
import type { SessionUncommittedScanReason } from './sessionUncommittedWorker.types'

const candidate = (sessionId: string, cwd: string): SessionUncommittedCandidate =>
  ({ sessionId, agentId: 'claude', nativeSessionId: `native-${sessionId}`, cwd, transcriptCwd: cwd, life: 'live' })
const entry: SessionUncommittedEntry = { files: 1, sample: ['a.ts'] }

interface Scan { reason: SessionUncommittedScanReason; roots: readonly string[] | undefined; answer(sessions: Record<string, SessionUncommittedEntry>): void; fail(detail: string): void }

function operationsUnderTest() {
  const scans: Scan[] = []
  const observed: { root: string; paths: string[] }[] = []
  const stampValues = new Map<string, string>([['Q:/wc-a', 'a1'], ['Q:/wc-b', 'b1']])
  const stampCalls: string[][] = []
  const activities: { sessionId: string; activity: SessionActivity | null }[] = []
  const changed = vi.fn()
  const log = vi.fn()
  const worker = {
    scan: vi.fn((_sessions: readonly SessionUncommittedCandidate[], reason: SessionUncommittedScanReason, roots?: readonly string[]) =>
      new Promise<Record<string, SessionUncommittedEntry>>((resolve, reject) => {
        scans.push({ reason, roots, answer: resolve, fail: (detail) => reject(new Error(detail)) })
      })),
    observeStatus: vi.fn(async (root: string, entries: readonly { absolutePath: string }[]) => {
      observed.push({ root, paths: entries.map((item) => item.absolutePath) })
    }),
  }
  const operations = new SessionUncommittedOperations({
    worker,
    activities: () => activities,
    candidates: () => [candidate('s1', 'Q:/wc-a/app'), candidate('s2', 'Q:/wc-b')],
    changed,
    log,
    stamps: {
      rootOf: async (directory: string) => directory.startsWith('Q:/wc-a') ? 'Q:/wc-a' : directory.startsWith('Q:/wc-b') ? 'Q:/wc-b' : null,
      of: async (roots: readonly string[]) => {
        stampCalls.push([...roots])
        return roots.map((root) => stampValues.get(root) ?? '-').join('\n')
      },
    },
  })
  return { operations, worker, scans, observed, stampValues, stampCalls, activities, changed, log }
}

describe('app/sessionUncommitted/sessionUncommittedOperations', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('runs no timer while no window is visible, and one scan once one is', async () => {
    const { operations, scans, stampCalls } = operationsUnderTest()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(scans).toHaveLength(0)
    expect(stampCalls).toHaveLength(0)

    operations.setVisible(true)
    operations.setVisible(true)
    expect(scans.map((scan) => scan.reason)).toEqual(['visible'])
    operations.setVisible(false)
    scans[0]!.answer({})
    await vi.advanceTimersByTimeAsync(60_000)
    expect(scans).toHaveLength(1)
    expect(stampCalls).toHaveLength(0)
  })

  it('scans once 2 s after a session went from working to idle, once for three such changes', async () => {
    const { operations, scans, activities } = operationsUnderTest()
    operations.setVisible(true)
    scans[0]!.answer({})
    await vi.advanceTimersByTimeAsync(0)
    activities.push({ sessionId: 's1', activity: 'working' }, { sessionId: 's2', activity: 'working' })
    operations.sessionsChanged()
    activities[0] = { sessionId: 's1', activity: 'idle' }
    operations.sessionsChanged()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(scans).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(scans.map((scan) => scan.reason)).toEqual(['visible', 'idle'])
    scans[1]!.answer({})
    await vi.advanceTimersByTimeAsync(0)

    activities[0] = { sessionId: 's1', activity: 'working' }
    operations.sessionsChanged()
    activities[0] = { sessionId: 's1', activity: 'idle' }
    operations.sessionsChanged()
    await vi.advanceTimersByTimeAsync(500)
    activities[1] = { sessionId: 's2', activity: 'waiting' }
    operations.sessionsChanged()
    await vi.advanceTimersByTimeAsync(500)
    activities[0] = { sessionId: 's1', activity: 'working' }
    operations.sessionsChanged()
    activities[0] = { sessionId: 's1', activity: 'idle' }
    operations.sessionsChanged()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(scans.map((scan) => scan.reason)).toEqual(['visible', 'idle', 'idle'])
  })

  it('scans only the root whose wc.db stamp moved, and nothing for an unchanged stamp', async () => {
    const { operations, scans, stampValues } = operationsUnderTest()
    operations.setVisible(true)
    scans[0]!.answer({})
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(scans).toHaveLength(1)

    stampValues.set('Q:/wc-b', 'b2')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(scans.map((scan) => [scan.reason, scan.roots])).toEqual([['visible', undefined], ['stamp', ['Q:/wc-b']]])
  })

  it('scans the working copy of a commit with paths, and none for an empty one', async () => {
    const { operations, scans } = operationsUnderTest()
    operations.setVisible(true)
    scans[0]!.answer({})
    await vi.advanceTimersByTimeAsync(0)
    operations.committed({ sessionId: 's1', scopes: [{ scopeRoot: 'Q:/wc-a/app', revision: 12 }], paths: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(scans).toHaveLength(1)
    operations.committed({ sessionId: 's1', scopes: [{ scopeRoot: 'Q:/wc-a/app', revision: 12 }], paths: ['Q:/wc-a/app/a.ts'] })
    await vi.advanceTimersByTimeAsync(0)
    expect(scans.map((scan) => [scan.reason, scan.roots])).toEqual([['visible', undefined], ['commit', ['Q:/wc-a']]])
  })

  it('keeps one trailing scan for the requests that arrive while one runs', async () => {
    const { operations, scans } = operationsUnderTest()
    operations.setVisible(true)
    operations.committed({ sessionId: 's1', scopes: [{ scopeRoot: 'Q:/wc-a', revision: 1 }], paths: ['Q:/wc-a/a.ts'] })
    operations.committed({ sessionId: 's2', scopes: [{ scopeRoot: 'Q:/wc-b', revision: 2 }], paths: ['Q:/wc-b/b.ts'] })
    await vi.advanceTimersByTimeAsync(0)
    expect(scans).toHaveLength(1)
    scans[0]!.answer({})
    await vi.advanceTimersByTimeAsync(0)
    expect(scans.map((scan) => [scan.reason, scan.roots])).toEqual([['visible', undefined], ['commit', ['Q:/wc-a', 'Q:/wc-b']]])
    scans[1]!.answer({})
    await vi.advanceTimersByTimeAsync(0)
    expect(scans).toHaveLength(2)
  })

  it('moves the revision only when an entry changed', async () => {
    const { operations, scans, changed } = operationsUnderTest()
    operations.setVisible(true)
    scans[0]!.answer({ s1: entry })
    await vi.advanceTimersByTimeAsync(0)
    expect(operations.snapshot()).toEqual({ revision: 1, sessions: { s1: entry } })
    await vi.advanceTimersByTimeAsync(30_000)
    scans[1]!.answer({ s1: { files: 1, sample: ['a.ts'] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(operations.snapshot().revision).toBe(1)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('keeps the last snapshot on a worker failure, logs one line and retries on the next tick', async () => {
    const { operations, scans, changed, log } = operationsUnderTest()
    operations.setVisible(true)
    scans[0]!.answer({ s1: entry })
    await vi.advanceTimersByTimeAsync(30_000)
    scans[1]!.fail('The session uncommitted worker failed: exited with code 1')
    await vi.advanceTimersByTimeAsync(30_000)
    scans[2]!.fail('The session uncommitted worker failed: exited with code 1')
    await vi.advanceTimersByTimeAsync(0)
    expect(operations.snapshot()).toEqual({ revision: 1, sessions: { s1: entry } })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('The uncommitted mark of every working copy could not be computed: The session uncommitted worker failed: exited with code 1')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(scans.map((scan) => scan.reason)).toEqual(['visible', 'tick', 'tick', 'tick'])
    scans[3]!.answer({})
    await vi.advanceTimersByTimeAsync(0)
    expect(operations.snapshot()).toEqual({ revision: 2, sessions: {} })
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('forwards a status observation once to the worker and then decides that root again', async () => {
    const { operations, scans, observed, worker } = operationsUnderTest()
    operations.setVisible(true)
    scans[0]!.answer({})
    await vi.advanceTimersByTimeAsync(0)
    operations.observeStatus('Q:/wc-b', [{ absolutePath: 'Q:/wc-b/gen/out.ts', nodeKind: 'file' }])
    await vi.advanceTimersByTimeAsync(0)
    expect(worker.observeStatus).toHaveBeenCalledTimes(1)
    expect(observed).toEqual([{ root: 'Q:/wc-b', paths: ['Q:/wc-b/gen/out.ts'] }])
    expect(scans.map((scan) => [scan.reason, scan.roots])).toEqual([['visible', undefined], ['status', ['Q:/wc-b']]])
  })

  it('requests nothing after stop', async () => {
    const { operations, scans, worker } = operationsUnderTest()
    operations.setVisible(true)
    operations.stop()
    scans[0]!.answer({})
    await vi.advanceTimersByTimeAsync(60_000)
    operations.setVisible(true)
    operations.observeStatus('Q:/wc-a', [])
    expect(scans).toHaveLength(1)
    expect(worker.observeStatus).not.toHaveBeenCalled()
  })
})
