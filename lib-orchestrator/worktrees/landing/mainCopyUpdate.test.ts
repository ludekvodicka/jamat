import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { finishTestRecords, emptyUpdateTargets } from '../finish/finishTestRecords'
import type { SvnActionFlowDeps } from '../finish/svnActionFlow'
import { ScriptLogStore } from '../../sessionManager/worktreeSessionScripts'
import { WorktreeResultsStore } from '../results/worktreeResultsStore'
import { WorktreeLease, WorktreeLeaseHeld } from '../worktreeLease'
import type { WorktreeSvnCommands } from '../worktreeSvnCommands'
import { MainCopyUpdate } from './mainCopyUpdate'
import { LandedRows } from './landedRows'
import { WorktreeRecovery } from '../worktreeRecovery'
import { WorktreeDue } from '../worktreeDue'

async function harness() {
  const h = await finishTestRecords({ phase: 'waiting', step: 'removing', wait: { kind: 'removal-blocked', reason: 'editor holds file', at: 1 } })
  const root = h.records.get('worker')!.worktree!.worktreePath
  await mkdir(root, { recursive: true })
  await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!,
    removalPermit: { kind: 'clean', provedAt: 1, allowed: [] },
    verified: [{ root, revision: 2, paths: ['a'], at: 1 }],
    execution: { root, requestedBy: 'window', startedAt: 1, checks: [], checkCursor: 0, rootCursor: 0,
      roots: [{ path: root, own: '', changed: ['a'], bounds: { repository: 'url', base: '/trunk', rootBase: 1, since: 1 } }],
      evidence: [{ repository: 'url', revision: 2, label: 'receipt', paths: ['/trunk/a'] }] } } }))
  const logs = new ScriptLogStore(join(h.root, 'logs'))
  const results = new WorktreeResultsStore(join(h.root, 'results'), { logs, now: () => 10, report: () => {} })
  await results.put(WorktreeResultsStore.recordOf({ actionId: 'finish', action: 'finish', result: 'committed', sessionId: 'worker', title: 'worker',
    worktreePath: root, mainCopy: h.root, directoryId: null, removal: 'pending', revisions: h.records.get('worker')!.worktreeLifecycle!.execution!.evidence,
    lines: [], logs: [], at: 1, caller: undefined }))
  let conflicts: string[] = []
  let after: string[] = []
  let kinds: Record<string, 'property'> = {}
  let id = 0
  const events: string[] = []
  const detached: Promise<unknown>[] = []
  const deps = {
    records: h.records, logs, results, lease: new WorktreeLease('update-test', () => []),
    commands: { accept: vi.fn(async () => { events.push('accepted'); expect(deps.lease.heldRoot(h.root)).toBeDefined() }) },
    svn: {
      updateTargets: emptyUpdateTargets,
      status: async () => ({ ok: true, value: { textConflicts: conflicts, otherConflicts: [], changed: ['a'] } }),
      revisionOf: async () => ({ ok: true, value: 2 }), headRevisionOf: async () => ({ ok: true, value: 2 }),
      landingProof: async () => ({ ok: true, value: { holds: true } }),
      changes: async () => ({ ok: true, value: [{ path: 'a', kind: 'item', conflict: false }] }),
      landingPaths: async () => ({ ok: true, value: [{ root: h.root, path: 'a', repository: 'url', repositoryPath: '/trunk/a', revision: 2, action: 'M' }] }),
      saveLocalPaths: vi.fn(async () => { events.push('saved'); return { ok: true, value: join(h.root, 'saved') } }),
      conflictSet: async () => ({ ok: true, value: { revision: 2, rows: [], facts: conflicts.map((path) => ({ path, kind: kinds[path] ?? 'text', takesArgument: true,
        tree: null, sidecars: [], properties: [], content: kinds[path] === undefined ? { binary: false, unreadable: false, equal: 'differs' } : null })) } }),
      resolveWorking: async () => ({ ok: true, value: undefined }),
    },
    runner: { run: vi.fn(async () => { events.push('update'); conflicts = after; return { ok: true, runId: 'run', exitCode: 0, output: after.length > 0 ? 'Summary of conflicts:\n  Text conflicts: 1\n' : 'Updated', failure: null } }) },
    resolver: { briefs: logs, unavailable: () => null, withMarkers: async () => [], cli: () => ({ ok: true as const, command: 'node "C:/Jamat/skills/claude/appjamat-v3/scripts/jamat-v3.mjs"' }), instance: { configIdentity: 'cfg-test', channel: 'development' as const } }, resolutions: { recoverLocked: async () => ({ ok: true, value: undefined }) },
    createResolver: vi.fn(async () => ({ ok: true, value: { sessionId: 'resolver' } })),
    stopRun: async () => true, ended: () => {}, landedDue: () => {}, changed: () => {},
    steps: { at: () => {}, clear: () => false }, report: () => {}, now: () => 10, newId: () => `update-${++id}`,
    detach: (work: Promise<unknown>) => detached.push(work),
  } as unknown as SvnActionFlowDeps & { lease: WorktreeLease; commands: Pick<WorktreeSvnCommands, 'accept'> }
  const update = new MainCopyUpdate(deps)
  return { ...h, treeRoot: root, deps, update, results, logs, events, setConflicts: (before: string[], created: string[], kind: Record<string, 'property'> = {}) => { conflicts = before; after = created; kinds = kind },
    settled: async () => { while (detached.length > 0) await Promise.all(detached.splice(0)) } }
}

describe('MainCopyUpdate', () => {
  it('refuses a busy root immediately instead of making admission wait in the session queue', async () => {
    const h = await harness()
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>((done) => { release = done }), ready = new Promise<void>((done) => { entered = done })
    const holding = h.deps.lease.within(h.root, 'commit', async () => { entered(); await gate })
    await ready
    try {
      expect(await h.update.startUpdate('worker', h.root, 'window', true)).toMatchObject({ ok: false, code: 'merge-pending', detail: expect.stringContaining('Another SVN operation is still running') })
      expect(h.records.get('worker')?.svnAction).toBeUndefined()
    } finally { release(); await holding }
    expect(await h.update.startUpdate('worker', h.root, 'window', true)).toMatchObject({ ok: true })
  })
  it('retains an interrupted conflict choice for inspection without replaying a destructive main-copy command', async () => {
    const h = await harness()
    await h.update.startUpdate('worker', h.root, 'window', true)
    const actionId = h.records.get('worker')!.svnAction!.actionId
    const entry = { stepId: `${actionId}-conflict-option`, kind: 'revert' as const, attempt: 1, cwd: h.root,
      args: ['revert', '-R', 'a'], paths: ['a'], startedAt: 1, runId: 'lost-choice' }
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, journal: [entry] } }))
    expect(await h.update.recoverStep('worker', entry)).toBe(false)
    expect(h.deps.runner.run).not.toHaveBeenCalled()
    expect(h.records.get('worker')!.svnAction?.needs).toMatchObject({ kind: 'conflict', reason: expect.stringContaining('inspection') })
    expect(h.records.get('worker')!.worktreeLifecycle!.journal[0]).toMatchObject({ endedAt: 10, outcome: 'other' })
    expect(WorktreeRecovery.pending(h.records.get('worker')!)).toEqual([])
  })
  it('recovers a legacy fixed-target main update without an automatic cleanup', async () => {
    const h = await harness()
    await h.update.startUpdate('worker', h.root, 'window', true)
    const entry = { stepId: `${h.records.get('worker')!.svnAction!.actionId}-update`, kind: 'update' as const,
      attempt: 1, cwd: h.root, args: ['update'], startedAt: 1, runId: 'interrupted', targetRevision: 2 }
    await h.records.update('worker', (record) => ({ ...record, svnAction: { ...record.svnAction!, stage: 'updating' },
      worktreeLifecycle: { ...record.worktreeLifecycle!, journal: [entry] } }))
    expect(await h.update.recoverStep('worker', entry)).toBe(true)
    expect(h.deps.runner.run).toHaveBeenCalledOnce()
    expect(vi.mocked(h.deps.runner.run).mock.calls[0].slice(1, 4)).toEqual(['update', h.root, ['update', '-r', '2', '--accept', 'postpone', '--', '.']])
  })

  it('keeps a failed baseline read as a visible action refusal without running UPDATE', async () => {
    const h = await harness()
    h.deps.commands.accept = async () => { throw new Error('Cannot read SVN state') }
    expect(await h.update.startUpdate('worker', h.root, 'window')).toMatchObject({ ok: true })
    await h.settled()
    expect(h.records.get('worker')!.svnAction?.needs).toMatchObject({ kind: 'svn-failed', reason: 'Cannot read SVN state' })
    expect(h.deps.runner.run).not.toHaveBeenCalled()
  })

  it('gives an explicit retry a new action identity while retaining prior failure evidence', async () => {
    const h = await harness()
    await h.update.startUpdate('worker', h.root, 'window', true)
    const prior = h.records.get('worker')!.svnAction!.actionId
    await h.records.update('worker', (record) => ({ ...record,
      svnAction: { ...record.svnAction!, stage: 'updating', needs: { kind: 'locked', reason: 'locked twice', at: 1 } },
      worktreeLifecycle: { ...record.worktreeLifecycle!, stoppedFailure: 'locked twice', journal: [
        { stepId: `${prior}-update`, kind: 'update', attempt: 2, startedAt: 1, endedAt: 2, outcome: 'locked', runId: 'old' },
      ] } }))
    expect(await h.update.startUpdate('worker', h.root, 'window', true)).toMatchObject({ ok: true })
    expect(h.records.get('worker')!.svnAction!.actionId).not.toBe(prior)
    expect(h.records.get('worker')!.worktreeLifecycle!.stoppedFailure).toBeUndefined()
    expect(h.records.get('worker')!.worktreeLifecycle!.journal).toHaveLength(1)
  })

  it('offers UPDATE for verified publication while removal is blocked, saves overlap first and records the person', async () => {
    const h = await harness()
    expect(LandedRows.landingOf(h.records.get('worker')!)).toMatchObject({ mainCopy: h.root, landed: [{ revision: 2 }] })
    expect(await h.update.startUpdate('worker', h.root, 'window')).toMatchObject({ ok: true })
    await h.settled()
    expect(h.events).toEqual(['accepted', 'saved', 'update'])
    expect(h.results.list({})[0].main).toEqual({ revision: 2, by: 'person', at: 10 })
    expect(h.records.get('worker')!.worktree).toBeDefined()
    expect(h.records.get('worker')!.worktreeLifecycle!.wait?.kind).toBe('removal-blocked')
  })

  /** The landed row of a Finish that waits on the offer, with its own sync run kept from before the offer. */
  async function landedRow(h: Awaited<ReturnType<typeof harness>>, clock: { now: number }) {
    await h.records.update('worker', (record) => {
      const { worktree: _worktree, ...rest } = record
      return { ...rest, life: 'ended' as const,
        retiredWorktree: { worktreePath: h.treeRoot, kind: 'svn' as const, revisions: [], removedAt: 1, ownerDir: h.root, landed: [...record.worktreeLifecycle!.execution!.evidence] },
        svnAction: { kind: 'finish' as const, actionId: 'finish', stage: 'main-update' as const, root: h.treeRoot, checks: [], checkCursor: 0, rootCursor: 0,
          rounds: { incoming: 0, outOfDate: 0, lock: 0 }, evidence: [], requestedBy: 'window' as const, startedAt: 1, stageAt: 20 },
        worktreeLifecycle: { ...record.worktreeLifecycle!, journal: [{ stepId: 'finish-update', kind: 'update' as const, attempt: 1, cwd: h.treeRoot,
          args: ['update'], startedAt: 5, endedAt: 6, outcome: 'ok' as const, runId: 'finish-sync' }] } }
    })
    await h.logs.write('worker', 'finish-sync', 'the Finish sync')
    h.deps.runner.run = vi.fn(async (sessionId: string, kind: string, cwd: string, args: string[]) => {
      await h.logs.write(sessionId, 'main-run', 'Updated to revision 2.')
      await h.records.update(sessionId, (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, journal: [...record.worktreeLifecycle!.journal,
        { stepId: 'main-update', kind: kind as 'update', attempt: 1, cwd, args, startedAt: clock.now, endedAt: clock.now, outcome: 'ok' as const, runId: 'main-run' }] } }))
      return { ok: true, runId: 'main-run', exitCode: 0, output: 'Updated', failure: null }
    }) as unknown as typeof h.deps.runner.run
  }

  it('keeps the UPDATE run log with the result it lands and tells a landed row its revision and log once', async () => {
    const h = await harness()
    const clock = { now: 30 }
    await landedRow(h, clock)
    const told: unknown[] = []
    const update = new MainCopyUpdate({ ...h.deps, now: () => clock.now, mainCopyUpdated: (notice) => { told.push(notice) } })
    expect(await update.startUpdate('worker', h.root, 'window')).toMatchObject({ ok: true })
    await h.settled()
    const result = h.results.list({ sessionId: 'worker' })[0]
    expect(result.main).toEqual({ revision: 2, by: 'person', at: 30 })
    expect(result.logs.map((log) => [log.runId, log.title])).toEqual([['main-run', 'Update main copy: svn update']])
    expect(readFileSync(result.logs[0].path, 'utf8')).toBe('Updated to revision 2.')
    expect(told).toEqual([{ sessionId: 'worker', title: 'Worker', mainCopy: h.root, revision: 2, by: 'person', log: result.logs[0].path }])
  })

  it('records an UPDATE whose landing the main copy cannot prove with its log, marked unproven with the reason', async () => {
    const h = await harness()
    const clock = { now: 30 }
    await landedRow(h, clock)
    h.deps.svn.landingProof = async () => ({ ok: true, value: { holds: false, reason: 'a is locally deleted', local: { path: 'a', item: 'deleted' } } })
    const told: unknown[] = []
    const update = new MainCopyUpdate({ ...h.deps, now: () => clock.now, mainCopyUpdated: (notice) => { told.push(notice) } })
    expect(await update.startUpdate('worker', h.root, 'window')).toMatchObject({ ok: true })
    await h.settled()
    const result = h.results.list({ sessionId: 'worker' })[0]
    expect(result.main).toBeUndefined()
    expect(result.mainUnproven).toEqual({ revision: 2, by: 'person', at: 30, reason: 'a is locally deleted' })
    expect(result.logs.map((log) => [log.runId, log.title])).toEqual([['main-run', 'Update main copy: svn update']])
    expect(told).toEqual([{ sessionId: 'worker', title: 'Worker', mainCopy: h.root, revision: 2, by: 'person', log: result.logs[0].path }])
  })

  it('tells nothing for a row that keeps its worktree, and still keeps the UPDATE log with the result', async () => {
    const h = await harness()
    const clock = { now: 30 }
    await landedRow(h, clock)
    await h.records.update('worker', (record) => ({ ...record, life: 'live', worktree: { kind: 'svn', repositoryRoot: h.root, worktreePath: h.treeRoot, branch: 'url', baseCommit: 'r1' },
      retiredWorktree: undefined }))
    const told: unknown[] = []
    const update = new MainCopyUpdate({ ...h.deps, now: () => clock.now, mainCopyUpdated: (notice) => { told.push(notice) } })
    expect(await update.startUpdate('worker', h.root, 'window')).toMatchObject({ ok: true })
    await h.settled()
    expect(h.results.list({ sessionId: 'worker' })[0].logs.map((log) => log.runId)).toEqual(['main-run'])
    expect(told).toEqual([])
  })

  it('gives only newly created conflicts to the resolver and leaves old conflicts for the person', async () => {
    const h = await harness()
    h.setConflicts(['older'], ['older', 'a'])
    await h.update.startUpdate('worker', h.root, 'window')
    await h.settled()
    expect(h.records.get('worker')!.svnAction?.conflicts?.paths).toEqual(['a'])
    expect(h.records.get('worker')!.svnAction?.updateProtection?.before).toEqual(['older'])
    expect(h.deps.createResolver).toHaveBeenCalledTimes(1)
    const older = await harness()
    older.setConflicts(['older'], ['older'])
    await older.update.startUpdate('worker', older.root, 'cli')
    await older.settled()
    expect(older.deps.createResolver).not.toHaveBeenCalled()
    expect(older.records.get('worker')!.svnAction).toBeUndefined()
    expect(older.results.list({})[0].main).toEqual({ revision: 2, by: 'agent', at: 10 })
  })

  it('keeps an older conflict out of the UPDATE conflict list and names it apart in the reason', async () => {
    const h = await harness()
    h.setConflicts(['older'], ['older', 'a'], { a: 'property' })
    await h.update.startUpdate('worker', h.root, 'window')
    await h.settled()
    const action = h.records.get('worker')!.svnAction!
    expect(action.conflictSet?.entries.map((entry) => entry.path)).toEqual(['a'])
    expect(action.needs?.reason).toBe('1 conflict needs you: a (property); settle them, then press UPDATE again; '
      + 'conflicts from before this UPDATE are not part of it and stay yours as svn left them: older')
    expect(h.deps.createResolver).not.toHaveBeenCalled()
  })

  it('resumes the same UPDATE on the next press of its session, so a conflict it left stays listed and waited on', async () => {
    const h = await harness()
    h.setConflicts(['older'], ['older', 'a'], { a: 'property' })
    await h.update.startUpdate('worker', h.root, 'window')
    await h.settled()
    const first = h.records.get('worker')!.svnAction!
    expect(first.needs?.kind).toBe('conflict')
    h.setConflicts(['older', 'a'], ['older', 'a'], { a: 'property' })
    expect(await h.update.startUpdate('worker', h.root, 'window')).toMatchObject({ ok: true })
    await h.settled()
    const second = h.records.get('worker')!.svnAction!
    expect(second.actionId).toBe(first.actionId)
    expect(second.updateProtection?.before).toEqual(['older'])
    expect(second.conflictSet?.entries.map((entry) => entry.path)).toEqual(['a'])
    expect(second.needs?.reason).toBe('1 conflict needs you: a (property); settle them, then press UPDATE again; '
      + 'conflicts from before this UPDATE are not part of it and stay yours as svn left them: older')
    expect(h.results.list({})[0].main).toBeUndefined()
  })

  it('keeps a conflict an UPDATE of another session left open in the list of the next press and waits on it, not as an older one', async () => {
    const h = await harness()
    const record = h.records.get('worker')!
    await h.records.put({ ...record, sessionId: 'other' })
    h.setConflicts(['older'], ['older', 'a'], { a: 'property' })
    await h.update.startUpdate('worker', h.root, 'window')
    await h.settled()
    expect(h.records.get('worker')!.svnAction?.needs?.kind).toBe('conflict')
    h.setConflicts(['older', 'a'], ['older', 'a'], { a: 'property' })
    expect(await h.update.startUpdate('other', h.root, 'window')).toMatchObject({ ok: true })
    await h.settled()
    const other = h.records.get('other')!.svnAction!
    expect(other.updateProtection?.before).toEqual(['older'])
    expect(other.conflictSet?.entries.map((entry) => entry.path)).toEqual(['a'])
    expect(other.needs?.reason).toBe('1 conflict needs you: a (property); settle them, then press UPDATE again; '
      + 'conflicts from before this UPDATE are not part of it and stay yours as svn left them: older')
    expect(h.results.list({})[0].main).toBeUndefined()
  })

  it('names in the result it lands where the UPDATE saved the local changes that overlap it (UA1-J08-4)', async () => {
    const h = await harness()
    expect(await h.update.startUpdate('worker', h.root, 'window')).toMatchObject({ ok: true })
    await h.settled()
    expect(h.results.list({})[0].lines).toEqual([`   main copy update: 1 of your changes overlaps what lands; saved before the update in ${join(h.root, 'saved')}`])
  })

  it('lets the person settle a conflict of the waiting UPDATE in the main copy, saved beside the UPDATE (UA1-J08-2)', async () => {
    const h = await harness()
    h.setConflicts([], ['a'], { a: 'property' })
    await h.update.startUpdate('worker', h.root, 'window')
    await h.settled()
    expect(h.records.get('worker')!.svnAction?.needs?.kind).toBe('conflict')
    const applied: unknown[] = []
    Object.assign(h.deps.resolutions, { apply: async (input: { root: string; savedDir: string; path: string; option: string; mainCopy?: true; onStep: (journal: unknown, diverged: string[]) => Promise<void> }) => {
      applied.push({ root: input.root, path: input.path, option: input.option, mainCopy: input.mainCopy, saved: input.savedDir.startsWith(h.results.savedDirectoryOf(h.records.get('worker')!.svnAction!.actionId)) })
      await input.onStep({ option: input.option, done: 1 }, [])
      h.setConflicts([], [])
      return { ok: true, value: undefined }
    } })
    expect(await h.update.resolveConflict('worker', { path: 'a', option: 'take-incoming', confirm: false, requestedBy: 'window', by: 'person' }))
      .toEqual({ ok: true, value: { sessionId: 'worker', path: 'a', state: 'settled', left: 0 } })
    expect(applied).toEqual([{ root: h.root, path: 'a', option: 'take-incoming', mainCopy: true, saved: true }])
    const action = h.records.get('worker')!.svnAction!
    expect(action.conflictSet?.entries[0]).toMatchObject({ path: 'a', state: 'settled', by: 'person', settledWith: 'take-incoming' })
    expect(action.needs).toMatchObject({ kind: 'conflict', reason: '1 conflict: you fixed 1; all are settled, press Update to go on' })
  })

  it('starts no resolver for an UPDATE nobody pressed, then one per press, again after a failed one (Finish 072)', async () => {
    const h = await harness()
    h.setConflicts([], ['a'])
    expect(await h.update.startUpdate('worker', h.root, 'window', false, false)).toMatchObject({ ok: true })
    await h.settled()
    expect(h.records.get('worker')!.svnAction?.needs).toMatchObject({ kind: 'conflict', reason: expect.stringContaining(': a; Resolve with agent merges them and checks them again') })
    expect(h.deps.createResolver).not.toHaveBeenCalled()
    h.setConflicts(['a'], ['a'])
    expect(await h.update.startUpdate('worker', h.root, 'window')).toMatchObject({ ok: true })
    await h.settled()
    expect(h.records.get('worker')!.svnAction).toMatchObject({ stage: 'resolving', conflicts: { paths: ['a'] } })
    expect(h.deps.createResolver).toHaveBeenCalledTimes(1)
    await h.records.update('worker', (record) => ({ ...record, svnAction: { ...record.svnAction!, verdict: { kind: 'failed', reason: 'the resolver stopped' } } }))
    h.update.due('worker')
    await h.settled()
    expect(h.records.get('worker')!.svnAction?.needs?.kind).toBeDefined()
    expect(await h.update.startUpdate('worker', h.root, 'window')).toMatchObject({ ok: true })
    await h.settled()
    expect(h.deps.createResolver).toHaveBeenCalledTimes(2)
  })

  it('settles a conflict that merges cleanly once line ends are ignored by its rule, with no resolver (Finish 072)', async () => {
    const h = await harness()
    h.setConflicts([], ['a'])
    const read = h.deps.svn.conflictSet
    h.deps.svn.conflictSet = async (...args) => {
      const set = await read(...args)
      return set.ok ? { ok: true, value: { ...set.value, facts: set.value.facts.map((fact) => ({ ...fact, content: { ...fact.content!, merge: 'clean' as const } })) } } : set
    }
    const apply = vi.fn(async () => { h.setConflicts([], []); return { ok: true as const, value: undefined } })
    Object.assign(h.deps.resolutions, { apply })
    await h.update.startUpdate('worker', h.root, 'window', false, false)
    await h.settled()
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ path: 'a', kind: 'text', option: 'merged', rebuild: true, mainCopy: true }))
    expect(h.deps.createResolver).not.toHaveBeenCalled()
    expect(h.records.get('worker')!.svnAction).toBeUndefined()
    expect(h.results.list({})[0].main).toMatchObject({ revision: 2 })
  })

  it('records the UPDATE after its resolver while an older conflict stays marked', async () => {
    const h = await harness()
    h.setConflicts(['older'], ['older', 'a'])
    await h.update.startUpdate('worker', h.root, 'window')
    await h.settled()
    expect(h.records.get('worker')!.svnAction).toMatchObject({ stage: 'resolving', conflicts: { paths: ['a'] } })
    h.setConflicts(['older'], ['older'])
    await h.records.update('worker', (record) => ({ ...record, svnAction: { ...record.svnAction!, verdict: { kind: 'succeeded' } } }))
    h.update.due('worker')
    await h.settled()
    expect(h.records.get('worker')!.svnAction).toBeUndefined()
    expect(h.results.list({})[0].main).toEqual({ revision: 2, by: 'person', at: 10 })
  })

  it('refuses another UPDATE row immediately and accepts its retry after the root finishes', async () => {
    const h = await harness()
    const record = h.records.get('worker')!
    await h.records.put({ ...record, sessionId: 'other' })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const run = h.deps.runner.run
    h.deps.runner.run = async (...args) => { await blocked; return run(...args) }
    await h.update.startUpdate('worker', h.root, 'window')
    try { expect(await h.update.startUpdate('other', h.root, 'window')).toMatchObject({ ok: false, code: 'merge-pending' }) }
    finally { release(); await h.settled() }
    expect(await h.update.startUpdate('other', h.root, 'window')).toMatchObject({ ok: true })
    await h.settled()
    expect(h.events).toEqual(['accepted', 'saved', 'update', 'accepted', 'saved', 'update'])
  })

  it('launches again an UPDATE the client stopped in before its svn update started (Mirabia 118)', async () => {
    const h = await harness()
    await h.update.startUpdate('worker', h.root, 'window', true)
    await h.records.update('worker', (record) => ({ ...record, svnAction: { ...record.svnAction!, stage: 'updating',
      runId: undefined, verdict: undefined, retryAt: undefined, baseRevision: 1, updateProtection: { before: [], overlaps: [], saved: [] } } }))
    const stranded = h.records.get('worker')!
    expect(WorktreeDue.of([stranded], 60_000, 1, new Set())).toContainEqual({ kind: 'svn-action-due', sessionId: 'worker' })
    expect(WorktreeDue.of([stranded], 60_000, 1, new Set(['worker']))).not.toContainEqual({ kind: 'svn-action-due', sessionId: 'worker' })
    await h.update.drive('worker')
    expect(h.deps.runner.run).toHaveBeenCalledOnce()
    expect(h.records.get('worker')!.svnAction).toBeUndefined()
    expect(h.results.list({})[0].main).toMatchObject({ revision: 2 })
  })

  it('waits as locked with a press when the root lease refuses its drive, and the press goes on', async () => {
    const h = await harness()
    await h.update.startUpdate('worker', h.root, 'window', true)
    await h.records.update('worker', (record) => ({ ...record, svnAction: { ...record.svnAction!, stage: 'updating', retryAt: 1 } }))
    const within = h.deps.lease.within.bind(h.deps.lease)
    h.deps.lease.within = async () => { throw new WorktreeLeaseHeld('The worktree SVN lease is held by other (update)') }
    await h.update.drive('worker')
    expect(h.records.get('worker')!.svnAction!.needs).toMatchObject({ kind: 'locked',
      reason: `${h.root} could not be taken for this UPDATE: The worktree SVN lease is held by other (update) Press UPDATE again once it is free.` })
    expect(h.deps.runner.run).not.toHaveBeenCalled()
    h.deps.lease.within = within
    expect(await h.update.startUpdate('worker', h.root, 'window')).toMatchObject({ ok: true })
    await h.settled()
    expect(h.deps.runner.run).toHaveBeenCalledOnce()
    expect(h.records.get('worker')!.svnAction).toBeUndefined()
  })

  it('does not hide an UPDATE closed journal behind retained Finish execution', async () => {
    const h = await harness()
    await h.update.startUpdate('worker', h.root, 'window', true)
    await h.records.update('worker', (record) => ({ ...record, svnAction: { ...record.svnAction!, stage: 'updating' },
      worktreeLifecycle: { ...record.worktreeLifecycle!, journal: [{ stepId: `${record.svnAction!.actionId}-update`, kind: 'update', attempt: 1,
        cwd: h.root, args: ['update'], runId: 'closed', startedAt: 1, endedAt: 2, outcome: 'ok', targetRevision: 2 }] } }))
    expect(WorktreeRecovery.pending(h.records.get('worker')!).map((row) => row.runId)).toEqual(['closed'])
  })

  describe('a lock its own interrupted svn update left (UA1-J09-7)', () => {
    const run = (runId: string, outcome: 'lost' | 'failed', title = 'Update lib/ea to r3') => ({ runId, phase: 'after' as const, scriptId: 'svn' as const,
      name: title, title, commands: [], startedAt: 1, endedAt: 1, outcome, log: { state: 'saved' as const, bytes: 0, truncated: false } })

    async function lockedAfter(interrupted: boolean) {
      const h = await harness()
      await h.update.startUpdate('worker', h.root, 'window', true)
      const actionId = h.records.get('worker')!.svnAction!.actionId
      const ea = join(h.root, 'lib', 'ea')
      const entry = (runId: string, attempt: number, outcome: 'other' | 'locked') => ({ stepId: `${actionId}-update-g-1`, kind: 'update' as const, attempt,
        cwd: ea, args: ['update'], paths: ['lib/ea'], targetRevision: 3, startedAt: attempt, endedAt: attempt + 1, outcome, runId })
      await h.records.update('worker', (record) => ({ ...record,
        svnAction: { ...record.svnAction!, stage: 'updating', runId: 'ea-3', rounds: { incoming: 0, outOfDate: 0, lock: 9 },
          verdict: { kind: 'failed', exitCode: 1, reason: 'svn: E155004: Working copy is locked' } },
        scriptRuns: [run('ea-1', interrupted ? 'lost' : 'failed'), run('ea-3', 'failed')],
        worktreeLifecycle: { ...record.worktreeLifecycle!, journal: [entry('ea-1', 1, interrupted ? 'other' : 'locked'), entry('ea-3', 3, 'locked')] } }))
      ;(h.deps.svn as unknown as { locked: () => Promise<boolean> }).locked = async () => true
      await h.update.drive('worker')
      return { h, ea }
    }

    it('names the external and says Jamat\'s own update was interrupted, and runs no cleanup in the main copy', async () => {
      const { h, ea } = await lockedAfter(true)
      const needs = h.records.get('worker')!.svnAction!.needs!
      expect(needs.kind).toBe('locked')
      expect(needs.reason).toContain(`lib/ea in ${h.root} is still locked by Jamat's own svn update, which was interrupted when the client stopped`)
      expect(needs.reason).toContain(`run svn cleanup in ${ea} yourself`)
      expect(needs.reason).not.toContain('another svn client')
      expect(h.deps.runner.run).not.toHaveBeenCalled()
    })

    it('names the locked external, not the main copy root, when another client holds the lock', async () => {
      const { h, ea } = await lockedAfter(false)
      expect(h.records.get('worker')!.svnAction!.needs!.reason)
        .toBe(`${ea} is locked by another svn client; let it finish, or run svn cleanup there yourself, then press UPDATE again`)
    })
  })

  it('keeps an svn update the client stop interrupted as a failed pass of its own (UA1-J09-7)', async () => {
    const h = await harness()
    await h.update.startUpdate('worker', h.root, 'window', true)
    const actionId = h.records.get('worker')!.svnAction!.actionId
    const ea = join(h.root, 'lib', 'ea')
    const target = (path: string) => ({ path, url: 'https://svn.test/app', repository: 'https://svn.test', revision: 3, kind: 'dir' as const, pinned: false })
    const entry = { stepId: `${actionId}-update-g-1`, kind: 'update' as const, attempt: 1, cwd: ea, args: ['update'], paths: ['lib/ea'],
      targetRevision: 3, startedAt: 5, runId: 'ea-1' }
    await h.records.update('worker', (record) => ({ ...record, svnAction: { ...record.svnAction!, stage: 'updating' },
      worktreeLifecycle: { ...record.worktreeLifecycle!, journal: [entry],
        update: { actionId, generation: 'g', root: h.root, revision: 3, cursor: 1, completed: false,
          units: [{ target: target(h.root), phase: 'done' }, { target: target(ea), phase: 'pending', parent: 0 }] } } }))
    expect(await h.update.recoverStep('worker', entry)).toBe(true)
    expect(h.records.get('worker')!.svnAction!.passes?.at(-1)).toMatchObject({ stage: 'updating', runId: 'ea-1', result: 'failed' })
    expect(h.records.get('worker')!.svnAction).toMatchObject({ stage: 'updating', runId: undefined, verdict: undefined })
  })

  it('allows explicitly requested cleanup after settled Keep while an open Finish keeps it gated', async () => {
    const h = await harness()
    const record = { ...h.records.get('worker')!, life: 'ended' as const, exitReason: 'stopped' as const, endedAt: 1,
      worktreeCleanup: { phase: 'pending' as const, trigger: 'requested' as const, requestedAt: 1, attempts: 0 } }
    expect(WorktreeDue.of([record], 60_000, 1, new Set()).some((row) => row.kind === 'clean-worktree')).toBe(false)
    const kept = { ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'kept' as const, step: undefined, wait: undefined } }
    expect(WorktreeDue.of([kept], 60_000, 1, new Set())).toContainEqual({ kind: 'clean-worktree', sessionId: 'worker' })
  })
})
