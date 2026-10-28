import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import { WorktreeLease } from '../worktreeLease'
import { WorkerIdle, WorkerReady } from './workerIdle'

describe('WorkerIdle', () => {
  it('requires fresh idle evidence without any pending deliveries', () => {
    expect(WorkerIdle.of('waiting', 999, 0, 1000)).toBe(true)
    expect(WorkerIdle.of('idle', 0, 0, 30_000)).toBe(false)
    expect(WorkerIdle.of('waiting', 0, 0, 10_000)).toBe(false)
    expect(WorkerIdle.of('waiting', 999, 1, 1000)).toBe(false)
    expect(WorkerIdle.of('unknown', 999, 0, 1000)).toBe(false)
    expect(WorkerIdle.of('working', 999, 0, 1000)).toBe(false)
  })

  it('names why the worker does not count as idle', () => {
    expect(WorkerIdle.busyOf('idle', 999, 0, 1000)).toBeNull()
    expect(WorkerIdle.busyOf('working', 999, 0, 1000)).toBe('the worker is working')
    expect(WorkerIdle.busyOf('unknown', 999, 0, 1000)).toBe('the activity of the worker is unknown')
    expect(WorkerIdle.busyOf('idle', 0, 0, 30_000)).toBe('the activity of the worker was not read in the last 10 seconds')
    expect(WorkerIdle.busyOf('idle', 999, 2, 1000)).toBe('input typed for the worker has not reached it yet')
  })

  it('records ready after proposal and clears it after any changed-path hash changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jamat-ready-'))
    try {
      const records = await SessionRecordsStore.load(join(root, 'records.json'), { snapshotsDirectory: join(root, 'snapshots'), report: () => {} })
      await records.put({ sessionId: 'worker', kind: 'agent', title: 'Worker', life: 'live', binding: null, directory: { mode: 'default' }, createdAt: 1,
        agent: { agentId: 'claude', launchMode: 'new' },
        worktree: { kind: 'svn', repositoryRoot: root, worktreePath: join(root, '.worktrees', 'tree'), branch: 'url', baseCommit: 'r1' },
        worktreeLifecycle: { version: 0, actionId: null, phase: 'active', outOfDate: 0, journal: [], facts: { worker: { liveness: 'alive', resumeFailures: 0 } } } })
      let hash = 'first'
      let waitForHash: Promise<void> | undefined
      let accepted = 0
      const ready = new WorkerReady(records, { changes: async () => ({ ok: true, value: [{ path: 'a', kind: 'modified', conflict: false }] as never }),
        commitHashes: async () => {
          const value = hash
          const waiting = waitForHash
          waitForHash = undefined
          await waiting
          return { ok: true, value: { a: value } }
        } }, {
        lease: new WorktreeLease('self', () => []), accept: async () => { accepted++ },
      })
      await ready.propose('worker')
      expect(accepted).toBe(1)
      expect(await ready.current('worker')).toBe(true)
      hash = 'second'
      expect(await ready.current('worker')).toBe(false)
      expect(records.get('worker')?.worktreeLifecycle?.facts.worker.ready).toBeUndefined()
      await ready.propose('worker')
      hash = 'third'
      let release!: () => void
      waitForHash = new Promise<void>((done) => { release = done })
      const staleCheck = ready.current('worker')
      // Let the older freshness read capture its hash before proposing newer work.
      await Promise.resolve()
      await Promise.resolve()
      hash = 'fourth'
      await ready.propose('worker')
      release()
      expect(await staleCheck).toBe(false)
      expect(records.get('worker')?.worktreeLifecycle?.facts.worker.ready?.hashes).toEqual({ a: 'fourth' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('leaves an open review of the same content alone, so a later proposal does not prepare it again (UA1-J12-5)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jamat-ready-'))
    try {
      const records = await SessionRecordsStore.load(join(root, 'records.json'), { snapshotsDirectory: join(root, 'snapshots'), report: () => {} })
      await records.put({ sessionId: 'worker', kind: 'agent', title: 'Worker', life: 'live', binding: null, directory: { mode: 'default' }, createdAt: 1,
        agent: { agentId: 'claude', launchMode: 'new' },
        worktree: { kind: 'svn', repositoryRoot: root, worktreePath: join(root, '.worktrees', 'tree'), branch: 'url', baseCommit: 'r1' },
        worktreeLifecycle: { version: 4, actionId: 'finish', phase: 'finishing', step: 'reviewing', outOfDate: 0, journal: [], facts: { worker: { liveness: 'alive', resumeFailures: 0 } },
          review: { version: 4, selection: ['a'], hashes: { a: 'reviewed' }, message: '[j12] A', source: 'agent-proposal', acknowledged: [], headMovedBy: 0 } } })
      let hash = 'reviewed'
      const ready = new WorkerReady(records, { changes: async () => ({ ok: true, value: [{ path: 'a', kind: 'modified', conflict: false }] as never }),
        commitHashes: async () => ({ ok: true, value: { a: hash } }) }, { lease: new WorktreeLease('self', () => []), accept: async () => {} })
      await ready.propose('worker')
      expect(records.get('worker')?.worktreeLifecycle).toMatchObject({ version: 4, step: 'reviewing' })
      expect(records.get('worker')?.worktreeLifecycle?.facts.worker.ready).toBeUndefined()
      hash = 'edited after review'
      await ready.propose('worker')
      expect(records.get('worker')?.worktreeLifecycle).toMatchObject({ version: 5, facts: { worker: { ready: { hashes: { a: 'edited after review' } } } } })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
