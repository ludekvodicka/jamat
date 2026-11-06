import { describe, expect, it } from 'vitest'

import type { SessionRecord } from '../../sessionManager/worktreeSessionRecords'
import type { WorktreeLifecycle } from '../worktreeState'
import { WorktreeDue } from '../worktreeDue'
import { BlockedRemovalRetry } from './blockedRemovalRetry'

describe('BlockedRemovalRetry (I67, Jamat#50)', () => {
  const minute = 60_000
  const root = 'Q:/app/.worktrees/098-x'

  function blocked(patch: Partial<WorktreeLifecycle> = {}, record: Partial<SessionRecord> = {}): SessionRecord {
    return {
      sessionId: 'worker', kind: 'agent', title: 'Worker', directory: { mode: 'default' }, binding: null, life: 'ended', createdAt: 0,
      worktree: { kind: 'svn', repositoryRoot: 'Q:/app', worktreePath: root, branch: 'url', baseCommit: 'r1', directoryId: '1:2:3' },
      worktreeLifecycle: { version: 9, actionId: 'finish', phase: 'waiting', step: 'removing', outOfDate: 0, journal: [],
        wait: { kind: 'removal-blocked', reason: 'REMOVAL BLOCKED (EPERM)', at: 10_000 },
        removalPermit: { kind: 'clean', provedAt: 1, allowed: [] }, purpose: 'finish',
        execution: { root, checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 1, removalAt: 9_000 },
        facts: { worker: { liveness: 'stopped', resumeFailures: 0 } }, ...patch },
      ...record,
    }
  }

  it('tries again after 30 s, then every 2 min, and settles on every 10 min', () => {
    expect(BlockedRemovalRetry.delayOf(0)).toBe(30_000)
    expect(BlockedRemovalRetry.delayOf(2 * minute - 1)).toBe(30_000)
    expect(BlockedRemovalRetry.delayOf(2 * minute)).toBe(2 * minute)
    expect(BlockedRemovalRetry.delayOf(30 * minute)).toBe(10 * minute)
    expect(BlockedRemovalRetry.delayOf(3 * 24 * 60 * minute)).toBe(10 * minute)
    const record = blocked()
    expect(BlockedRemovalRetry.due(record, [record], 9_000 + 29_999, 0)).toBe(false)
    expect(BlockedRemovalRetry.due(record, [record], 9_000 + 30_000, 0)).toBe(true)
    const long = blocked({ execution: { ...record.worktreeLifecycle!.execution!, removalAt: 60 * minute } })
    expect(BlockedRemovalRetry.due(long, [long], 69 * minute, 0)).toBe(false)
    expect(BlockedRemovalRetry.due(long, [long], 70 * minute, 0)).toBe(true)
  })

  it('is due at once after a client start, and after a clock that went backwards', () => {
    const record = blocked()
    expect(BlockedRemovalRetry.due(record, [record], 9_001, 9_500)).toBe(true)
    expect(BlockedRemovalRetry.due(record, [record], 8_000, 0)).toBe(true)
  })

  it('also finishes a Discard after a commit whose removal Windows refused (run 098)', () => {
    const record = blocked({ purpose: 'discard', removalPermit: { kind: 'discard', by: 'person', at: 5 } })
    expect(BlockedRemovalRetry.due(record, [record], 10 * minute, 0)).toBe(true)
  })

  it('leaves every other wait, a removal without permit and a worktree something still runs in to the person', () => {
    const base = blocked()
    const cases: SessionRecord[] = [
      blocked({ step: 'stopping-worker' }),
      blocked({ wait: { kind: 'svn-failed', reason: 'x', at: 10_000 } }),
      blocked({ phase: 'finishing', wait: undefined }),
      blocked({ removalPermit: undefined }),
      blocked({}, { life: 'live' }),
      blocked({}, { pendingOperationId: 'reopen' }),
    ]
    for (const record of cases) expect(BlockedRemovalRetry.due(record, [record], 10 * minute, 0)).toBe(false)
    const helper: SessionRecord = { sessionId: 'solve', kind: 'agent', title: 'Solve', binding: null, life: 'live', createdAt: 2,
      directory: { mode: 'adHoc', path: `${root}/lib-orchestrator` } }
    expect(BlockedRemovalRetry.due(base, [base, helper], 10 * minute, 0)).toBe(false)
    const elsewhere = { ...helper, directory: { mode: 'adHoc' as const, path: 'Q:/app' } }
    expect(BlockedRemovalRetry.due(base, [base, elsewhere], 10 * minute, 0)).toBe(true)
  })

  it('reaches the reconciler as its own change, never while a drive of this process holds the session', () => {
    const record = blocked()
    expect(WorktreeDue.of([record], 10 * minute, 0, new Set())).toEqual([{ kind: 'retry-removal', sessionId: 'worker' }])
    expect(WorktreeDue.of([record], 10 * minute, 0, new Set(['worker']))).toEqual([])
  })
})
