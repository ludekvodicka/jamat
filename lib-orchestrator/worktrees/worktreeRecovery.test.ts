import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionRecord, SessionRecordSvnAction } from '../sessionManager/worktreeSessionRecords'
import { SessionRecordsStore } from '../sessionManager/worktreeSessionRecords'
import { WorktreeLeaseHeld } from './worktreeLease'
import { WorktreeLifecycleMigration } from './worktreeLifecycleMigration'
import { WorktreeRecovery } from './worktreeRecovery'
import type { SvnStepJournalEntry } from './worktreeState'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
const intent = (kind: SvnStepJournalEntry['kind'], extra: Partial<SvnStepJournalEntry> = {}): SvnStepJournalEntry => ({
  kind, stepId: `action-${kind}${kind === 'commit' ? '-0' : ''}`, runId: kind, attempt: 1, startedAt: 10, cwd: 'C:/tree',
  ...extra,
})

async function harness(entries: SvnStepJournalEntry[], extra: Partial<SessionRecord> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jamat-recovery-'))
  directories.push(directory)
  const records = await SessionRecordsStore.load(join(directory, 'records.json'), { snapshotsDirectory: join(directory, 'snapshots'), report: () => {} })
  const action: SessionRecordSvnAction = { actionId: 'action', kind: 'finish', flowVersion: 1, stage: 'committing', root: 'C:/tree', checks: [],
    rootCursor: 0, checkCursor: 0, rounds: { incoming: 0, outOfDate: 0, lock: 0 }, evidence: [], requestedBy: 'window', startedAt: 1 }
  const record: SessionRecord = { sessionId: 'parent', kind: 'shell', title: '043', directory: { mode: 'default' }, life: 'ended', binding: null, createdAt: 1,
    worktree: { kind: 'svn', worktreePath: 'C:/tree', repositoryRoot: 'C:/main', branch: 'url', baseCommit: 'r42' }, svnAction: action, ...extra }
  await records.put({ ...record, worktreeLifecycle: { ...WorktreeLifecycleMigration.fromOld(record)!, journal: entries } })
  const calls: string[] = []
  const deps = { records, now: () => 100,
    commit: async (_id: string, _entry: SvnStepJournalEntry) => { calls.push('commit'); return true },
    step: async (_id: string, entry: SvnStepJournalEntry) => { calls.push(`step:${entry.kind}:${entry.targetRevision}`); return true },
    before: async (_id: string) => { calls.push('before'); return true },
    resume: (_id: string) => { calls.push('resume') }, report: (message: string) => { calls.push(message) } }
  return { records, calls, deps, record }
}

describe('WorktreeRecovery', () => {
  it('does not retry a held command after a person replaces its action', async () => {
    const h = await harness([intent('update')])
    let attempts = 0
    h.deps.step = async () => { attempts++; throw new WorktreeLeaseHeld('Writer still runs') }
    const recovery = new WorktreeRecovery(h.deps)
    await recovery.run()
    await h.records.update('parent', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!,
      journal: [intent('update', { runId: 'new-command' })] } }))
    h.deps.now = () => 10_000
    await recovery.retry()
    expect(attempts).toBe(1)
  })
  it('retries only held startup recovery on a later poll and stops once the command is recovered', async () => {
    const h = await harness([intent('update', { targetRevision: 6 })])
    await h.records.update('parent', (record) => ({ ...record, svnAction: { ...record.svnAction!, kind: 'update-main', stage: 'updating' },
      worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'landed', step: undefined } }))
    let now = 100, attempts = 0, held = true
    h.deps.now = () => now
    h.deps.step = async () => {
      attempts++
      if (held) throw new WorktreeLeaseHeld('The interrupted SVN writer still runs')
      await h.records.update('parent', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, journal: [] } }))
      return true
    }
    const recovery = new WorktreeRecovery(h.deps)
    await recovery.run()
    await recovery.retry()
    expect(attempts).toBe(1)
    now += 5_000
    await recovery.retry()
    expect(attempts).toBe(2)
    held = false
    now += 5_000
    await Promise.all([recovery.retry(), recovery.retry()])
    expect(attempts).toBe(3)
    expect(h.calls.filter((call) => call === 'resume')).toEqual(['resume'])
    now += 5_000
    await recovery.retry()
    expect(attempts).toBe(3)
  })
  it('leaves a settled UPDATE refusal for explicit retry but recovers an unfinished command in the same wait', async () => {
    const closed = intent('update', { endedAt: 11, outcome: 'locked' })
    const h = await harness([closed])
    await h.records.update('parent', (record) => ({ ...record, svnAction: { ...record.svnAction!, kind: 'update-main', stage: 'updating',
      needs: { kind: 'locked', reason: 'two failed attempts', at: 12 } } }))
    expect(WorktreeRecovery.pending(h.records.get('parent')!)).toEqual([])
    await h.records.update('parent', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, journal: [intent('update')] } }))
    expect(WorktreeRecovery.pending(h.records.get('parent')!)).toEqual([intent('update')])
  })

  it('does not confuse equal revisions in different repositories after receipt-before-evidence crash', async () => {
    const entry = intent('commit', { stepId: 'action-commit-.', endedAt: 11, outcome: 'ok', revision: 2, paths: ['/trunk/a'] })
    const h = await harness([entry])
    await h.records.update('parent', (record) => ({ ...record, svnAction: undefined,
      commitReceipts: [{ scopeRoot: 'C:/tree', revision: 2, paths: ['a'], at: 12 }],
      worktreeLifecycle: { ...record.worktreeLifecycle!, step: 'verifying', execution: { ...record.svnAction!,
        roots: [{ path: 'C:/tree', own: '', changed: ['a'], bounds: { repository: 'repo-main', base: '/trunk', rootBase: 1, since: 1 } }],
        evidence: [{ repository: 'repo-mount', revision: 2, label: 'receipt', paths: ['/trunk/a'] }] } } }))
    expect(WorktreeRecovery.pending(h.records.get('parent')!)).toEqual([entry])
    await h.records.update('parent', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, execution: {
      ...record.worktreeLifecycle!.execution!, evidence: [{ repository: 'repo-main', revision: 2, label: 'receipt', paths: ['/trunk/other'] }] } } }))
    expect(WorktreeRecovery.pending(h.records.get('parent')!)).toEqual([entry])
    await h.records.update('parent', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, execution: {
      ...record.worktreeLifecycle!.execution!, evidence: [{ repository: 'repo-main', revision: 2, label: 'receipt', paths: ['/trunk/a'] }] } } }))
    expect(WorktreeRecovery.pending(h.records.get('parent')!)).toEqual([])
  })

  it('resolves commit publication before any older update or cleanup intent', async () => {
    const h = await harness([intent('update'), intent('cleanup'), intent('commit')])
    await new WorktreeRecovery(h.deps).run()
    expect(h.calls).toEqual(['commit', 'resume'])
  })

  it('recognizes the closed-command/pre-verdict crash window', async () => {
    const h = await harness([intent('commit', { endedAt: 11, outcome: 'ok' })])
    await new WorktreeRecovery(h.deps).run()
    expect(h.calls).toEqual(['commit', 'resume'])
    await h.records.update('parent', (record) => ({ ...record, svnAction: { ...record.svnAction!, runId: 'commit', verdict: { kind: 'succeeded' } } }))
    expect(WorktreeRecovery.pending(h.records.get('parent')!)).toEqual([])
  })

  it('stops on unresolved commit evidence without replaying another step', async () => {
    const h = await harness([intent('update'), intent('commit')])
    h.deps.commit = async () => { h.calls.push('ambiguous'); return false }
    await new WorktreeRecovery(h.deps).run()
    expect(h.calls).toEqual(['ambiguous'])
    expect(h.records.get('parent')?.worktreeLifecycle?.journal.every((entry) => entry.endedAt === undefined)).toBe(true)
  })

  it('delegates interrupted checkout before releasing setup, including the pre-intent window', async () => {
    const h = await harness([], { svnAction: undefined, life: 'starting', pendingOperationId: 'create', pendingOperationKind: 'create',
      pendingSetup: { local: true, setupSessionId: 'checkout' } })
    await new WorktreeRecovery(h.deps).run()
    expect(h.calls).toEqual(['before'])
  })

  it('keeps a settled failed checkout waiting for Retry setup, even with an older open intent', async () => {
    const h = await harness([intent('checkout')], { svnAction: undefined, life: 'ended', endedReason: 'setup failed: conflict',
      pendingSetup: { local: true, setupSessionId: 'checkout' } })
    await new WorktreeRecovery(h.deps).run()
    expect(h.calls).toEqual([])
    expect(h.records.get('parent')?.endedReason).toBe('setup failed: conflict')
  })

  it('passes the saved update target to recovery and leaves an existing wait untouched without intents', async () => {
    const h = await harness([intent('update', { targetRevision: 47, args: ['update', '-r', '47', '--', '.'] })])
    await new WorktreeRecovery(h.deps).run()
    expect(h.calls).toEqual(['step:update:47', 'resume'])
    await h.records.update('parent', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, journal: [] },
      svnAction: { ...record.svnAction!, stage: 'changes', needs: { kind: 'review-interrupted', reason: 'Press Finish', at: 1 } } }))
    h.calls.length = 0
    await new WorktreeRecovery(h.deps).run()
    expect(h.calls).toEqual([])
  })

  it('turns a held writer into a wait the person can press again, and keeps the step for that press (UA1-J13-2)', async () => {
    const h = await harness([intent('update', { targetRevision: 6, args: ['update', '-r', '6', '--', '.'] })])
    await h.records.update('parent', (record) => ({ ...record, svnAction: { ...record.svnAction!, kind: 'update-main', stage: 'updating' },
      worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'landed', step: undefined } }))
    h.deps.step = async () => { throw new WorktreeLeaseHeld('The interrupted SVN writer still runs (process 19108); wait for it to end, then try again') }
    await new WorktreeRecovery(h.deps).run()
    const record = h.records.get('parent')!
    expect(record.svnAction?.needs).toEqual({ kind: 'locked', at: 100, reason: expect.stringContaining('19108') })
    expect(record.worktreeLifecycle?.phase).toBe('landed')
    expect(record.worktreeLifecycle?.wait).toBeUndefined()
    expect(WorktreeRecovery.pending(record)).toHaveLength(1)
  })

  it('preserves evidence and records a visible wait when recovery throws', async () => {
    const h = await harness([intent('commit')])
    h.deps.commit = async () => { throw new Error('repository unavailable') }
    await new WorktreeRecovery(h.deps).run()
    expect(h.records.get('parent')?.worktreeLifecycle).toMatchObject({ phase: 'waiting', journal: [intent('commit')],
      wait: { kind: 'svn-failed', reason: expect.stringContaining('repository unavailable') } })
    expect(h.calls.join(' ')).toContain('repository unavailable')
  })
})
