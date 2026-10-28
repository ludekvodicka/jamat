import { describe, expect, it } from 'vitest'
import type { SessionRecord } from '../../sessionManager/worktreeSessionRecords'
import type { WorktreeLifecycle } from '../worktreeState'
import { FinishProjection } from './finishProjection'
import { SessionActionHistory } from '../../sessionManager/records/sessionActionHistory'
import { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const recordOf = (journal: WorktreeLifecycle['journal'], extra: Partial<WorktreeLifecycle> = {}, scriptRuns: SessionRecord['scriptRuns'] = []): SessionRecord => ({
  scriptRuns,
  worktreeLifecycle: {
    version: 3, actionId: 'action', phase: 'finishing', step: 'committing', outOfDate: 0, journal,
    facts: { worker: { liveness: 'alive', resumeFailures: 0 } },
    execution: { root: 'C:/tree', checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'cli', startedAt: 5 },
    ...extra,
  },
} as SessionRecord)

describe('FinishProjection', () => {
  it('shows each main-copy external attempt and the current run without duplicating recorded passes', () => {
    const record = recordOf([
      { stepId: 'main-update-a-0', kind: 'update', attempt: 1, startedAt: 10, endedAt: 11, outcome: 'ok', runId: 'owner' },
      { stepId: 'main-update-a-1', kind: 'update', attempt: 1, startedAt: 12, endedAt: 13, outcome: 'network', runId: 'external-failed' },
      { stepId: 'main-update-a-1', kind: 'update', attempt: 2, startedAt: 14, runId: 'external-retry' },
    ])
    const action = { ...record.worktreeLifecycle!.execution!, actionId: 'main', kind: 'update-main' as const,
      stage: 'updating' as const, rounds: { lock: 0, incoming: 0, outOfDate: 0 },
      passes: [{ stage: 'updating' as const, runId: 'owner', startedAt: 10, endedAt: 11, result: 'done' as const }] }
    record.svnAction = action
    expect(FinishProjection.shownPasses(record, action)?.map((pass) => [pass.runId, pass.result])).toEqual([
      ['owner', 'done'], ['external-failed', 'failed'],
    ])
    expect(FinishProjection.openRunOf(record)?.runId).toBe('external-retry')
  })

  it('archives completed checks with a valid legacy cursor while retaining the driver completion cursor', async () => {
    const record: SessionRecord = { ...recordOf([], { step: 'reviewing' }), sessionId: 's', kind: 'shell', title: 'checks',
      directory: { mode: 'default' }, binding: null, life: 'ended', createdAt: 1 }
    const execution = record.worktreeLifecycle!.execution!
    execution.checks = [{ key: 'check', scriptId: 'checks', name: 'test',
      commands: [{ command: 'node --version', cwd: 'C:/tree' }] }]
    execution.checkCursor = 1
    const history = SessionActionHistory.currentOf(record)!
    expect(history.source.svnAction?.checkCursor).toBe(0)
    expect(execution.checkCursor).toBe(1)
    const directory = await mkdtemp(join(tmpdir(), 'jamat-check-history-'))
    try {
      const store = await SessionRecordsStore.load(join(directory, 'records.json'), { snapshotsDirectory: join(directory, 'snapshots') })
      expect(await store.put({ ...record, worktreeLifecycle: undefined,
        life: 'live', actionHistory: [{ ...history, endedAt: 20 }] })).toBe(true)
      const reloaded = await SessionRecordsStore.load(join(directory, 'records.json'), { snapshotsDirectory: join(directory, 'snapshots') })
      expect(reloaded.get('s')?.actionHistory?.[0].source.svnAction?.checkCursor).toBe(0)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('lists what this Finish already did, in order, for Session actions alone', () => {
    const record = recordOf([
      { stepId: 'checkout-1', kind: 'checkout', attempt: 1, startedAt: 1, endedAt: 2, outcome: 'ok', runId: 'checkout' },
      { stepId: 'older-sync', kind: 'update', attempt: 1, startedAt: 2, endedAt: 3, outcome: 'ok', runId: 'older' },
      { stepId: 'action-sync', kind: 'update', attempt: 1, startedAt: 10, endedAt: 12, outcome: 'ok', runId: 'sync' },
      { stepId: 'action-sync', kind: 'update', attempt: 2, startedAt: 13, endedAt: 14, outcome: 'locked', runId: 'retry' },
      { stepId: 'action-commit-.', kind: 'commit', attempt: 1, startedAt: 40, runId: 'commit' },
    ], { approvedAt: 30 }, [
      { runId: 'old-check', phase: 'after', scriptId: 'checks', name: 'tests', title: 'tests', commands: [], startedAt: 1, endedAt: 2, outcome: 'succeeded', log: { state: 'saved', bytes: 1, truncated: false } },
      { runId: 'check', phase: 'after', scriptId: 'checks', name: 'tests', title: 'tests', commands: [], startedAt: 20, endedAt: 25, outcome: 'succeeded', log: { state: 'saved', bytes: 1, truncated: false } },
    ])
    expect(FinishProjection.donePasses(record).map((pass) => [pass.stage, pass.runId, pass.result])).toEqual([
      ['updating', 'sync', 'done'], ['updating', 'retry', 'failed'], ['checks', 'check', 'done'], ['changes', undefined, 'done'],
    ])
    expect(FinishProjection.openRunOf(record)?.runId).toBe('commit')
    expect(FinishProjection.action(record)?.passes).toBeUndefined()
  })

  /** UA1-J09-6: four refused recovery cleanups stayed in the list as failed steps after the fifth one succeeded. */
  it('drops failed cleanups of a step once a later cleanup of that step succeeded', () => {
    const cleanup = (attempt: number, startedAt: number, outcome: 'ok' | 'other', stepId = 'action-commit-lib/ea-recovery-cleanup') =>
      ({ stepId, kind: 'cleanup' as const, attempt, startedAt, endedAt: startedAt + 1, outcome, runId: `cleanup-${startedAt}` })
    const pending = recordOf([cleanup(1, 10, 'other'), cleanup(2, 20, 'other')])
    expect(FinishProjection.donePasses(pending).map((pass) => [pass.runId, pass.result])).toEqual([['cleanup-10', 'failed'], ['cleanup-20', 'failed']])
    const recovered = recordOf([cleanup(1, 10, 'other'), cleanup(2, 20, 'other'), cleanup(1, 30, 'ok'), cleanup(1, 40, 'other', 'action-other-cleanup')])
    expect(FinishProjection.donePasses(recovered).map((pass) => [pass.runId, pass.result])).toEqual([['cleanup-30', 'done'], ['cleanup-40', 'failed']])
  })
})
