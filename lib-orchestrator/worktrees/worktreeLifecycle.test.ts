import { describe, expect, it, vi } from 'vitest'
import type { SessionRecord, SvnActionConflictSet } from '../sessionManager/worktreeSessionRecords'
import type { WorktreeFinisher } from './finish/worktreeFinish.types'
import type { WorktreeLifecycleDeps } from './worktreeLifecycle.types'
import { WorktreeLifecycle } from './worktreeLifecycle'
import { WorktreeLifecycleMigration } from './worktreeLifecycleMigration'

const record = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: 'worker', kind: 'shell', title: 'worker', directory: { mode: 'default' }, binding: null,
  life: 'ended', createdAt: 1, endedAt: 2, exitReason: 'stopped',
  worktree: { kind: 'svn', worktreePath: 'C:/tree', repositoryRoot: 'C:/main', branch: 'url', baseCommit: 'r1' },
  ...overrides,
})

function harness(current: SessionRecord) {
  const finish = vi.fn<WorktreeFinisher['finish']>(async () => ({ ok: true as const, value: { actionId: 'action' } }))
  const finisher: WorktreeFinisher = { ownsChecks: current.worktree?.kind === 'svn', finish,
    discard: vi.fn(async () => ({ ok: true as const, value: undefined })),
    keep: vi.fn(async () => ({ ok: true as const, value: undefined })),
    choicesOf: () => ['keep', 'discard'],
  }
  const unavailable = () => Promise.resolve({ ok: false as const, code: 'not-found' as const, detail: 'unused' })
  const deps: WorktreeLifecycleDeps = {
    records: () => ({ get: () => current, list: () => [current] }),
    finishers: new Map([['git', { session: { setupPaths: async () => ({ ok: true as const, value: [] }), removeWithSession: async () => ({ ok: true as const, value: undefined }) }, load: async () => finisher, choices: finisher.choicesOf }], ['svn', { session: { setupPaths: async () => ({ ok: true as const, value: [] }), removeWithSession: async () => ({ ok: true as const, value: undefined }) }, load: async () => finisher, choices: finisher.choicesOf }]]),
    actions: async () => ({ resolveConflict: unavailable, helperOf: unavailable, backToWork: unavailable, startUpdate: unavailable, noteVerdict: async () => true }),
    provision: { place: unavailable, create: unavailable, purgeReserved: unavailable },
    changed: vi.fn(), create: unavailable, stop: vi.fn(async () => ({ ok: true as const, value: undefined })),
    awaitExit: async () => true, refresh: async () => {}, activityOf: () => null,
    checks: vi.fn(async () => ({ ok: true as const, value: { kind: 'none' as const } })),
    whileFinishing: (_id, work) => work(), requestCleanup: unavailable, remove: unavailable,
    mainCopyOf: unavailable, onQueue: (work) => work(), stepOf: () => null,
    workflowOf: () => null, actionsOf: () => ({ sections: [] }),
  }
  return { facade: new WorktreeLifecycle(deps), finisher, finish, deps }
}

describe('WorktreeLifecycle', () => {
  it('prefers lifecycle Finish conflicts, then a later UPDATE over retained Finish evidence', async () => {
    const set = (path: string): SvnActionConflictSet => ({ readAt: 1, revision: 2, baseRevision: 1, more: 0,
      entries: [{ path, kind: 'text', shape: 'text-overlap', state: 'person', options: ['merged'], facts: {} }] })
    const current = record({ worktreeLifecycle: { version: 1, actionId: 'finish', phase: 'landed', outOfDate: 0, journal: [],
      syncConflictSet: set('current'), facts: { worker: { liveness: 'stopped', resumeFailures: 0 } } },
      svnAction: { actionId: 'stale', kind: 'finish', stage: 'fixing', root: 'C:/tree', requestedBy: 'window', startedAt: 1,
        checks: [], checkCursor: 0, rootCursor: 0, rounds: { incoming: 0, lock: 0, outOfDate: 0 }, evidence: [], conflictSet: set('stale') } })
    const h = harness(current)
    expect(await h.facade.conflictsOf('worker')).toMatchObject({ ok: true, value: { actionId: 'finish', entries: [{ path: 'current' }] } })
    current.svnAction = { ...current.svnAction!, kind: 'update-main', actionId: 'update', conflictSet: set('new-update') }
    expect(await h.facade.conflictsOf('worker')).toMatchObject({ ok: true, value: { actionId: 'update', entries: [{ path: 'new-update' }] } })
  })

  it('places the conflict paths of a main-copy UPDATE in its main copy, of anything else in the worktree, and refuses a session with neither (UA1-J08-2)', () => {
    const current = record()
    const h = harness(current)
    expect(h.facade.conflictRootOf('worker')).toEqual({ ok: true, value: { root: 'C:/tree', place: 'worktree' } })
    current.svnAction = { actionId: 'update', kind: 'update-main', stage: 'updating', root: 'C:/main', requestedBy: 'window', startedAt: 1,
      checks: [], checkCursor: 0, rootCursor: 0, rounds: { incoming: 0, lock: 0, outOfDate: 0 }, evidence: [] }
    delete current.worktree
    expect(h.facade.conflictRootOf('worker')).toEqual({ ok: true, value: { root: 'C:/main', place: 'main copy' } })
    delete current.svnAction
    expect(h.facade.conflictRootOf('worker')).toEqual({ ok: false, code: 'invalid-spec', detail: 'Session worker has no worktree' })
  })

  it.each(['window', 'cli', 'peer'] as const)('attributes %s conflict settlement to its trusted caller, and a run of the session to the merger', async (requestedBy) => {
    const current = record()
    const h = harness(current)
    const actions = await h.deps.actions()
    const resolveConflict = vi.fn<typeof actions.resolveConflict>(async () => ({ ok: false, code: 'not-found', detail: 'test' }))
    h.deps.actions = async () => ({ ...actions, resolveConflict })
    const facade = new WorktreeLifecycle(h.deps)
    await facade.resolveConflict('worker', { path: 'a', option: 'merged', confirm: false, requestedBy })
    expect(resolveConflict).toHaveBeenLastCalledWith('worker', expect.objectContaining({ by: requestedBy === 'window' ? 'person' : 'agent' }))
    current.scriptOf = { sessionId: 'parent', phase: 'after', scriptId: 'svn-merge', name: 'merger' }
    await facade.resolveConflict('helper', { path: 'a', option: 'merged', confirm: false, requestedBy })
    expect(resolveConflict).toHaveBeenLastCalledWith('parent', expect.objectContaining({ by: 'merger' }))
  })

  it.each(['keep', 'discard'] as const)('routes migrated Git %s once without SVN control reads', async (choice) => {
    const current = record()
    current.worktree!.kind = 'git'
    current.worktreeLifecycle = WorktreeLifecycleMigration.fromOld(current)!
    const h = harness(current)
    h.deps.dirty = vi.fn(async () => { throw new Error('SVN read on Git') })
    h.deps.withControl = vi.fn(async () => { throw new Error('SVN lease on Git') })
    const facade = new WorktreeLifecycle(h.deps)
    expect((await facade.press('worker', { choice, requestedBy: 'window' })).ok).toBe(true)
    expect(h.finisher[choice]).toHaveBeenCalledOnce()
    expect(h.deps.dirty).not.toHaveBeenCalled()
    expect(h.deps.withControl).not.toHaveBeenCalled()
  })
  it.each([false, true])('requires a fresh clean proof for agent Discard (dirty=%s)', async (dirty) => {
    const current = record({ worktreeLifecycle: { version: 1, actionId: null, phase: 'active', outOfDate: 0,
      journal: [], facts: { worker: { liveness: 'alive', resumeFailures: 0 } } } })
    const h = harness(current)
    h.deps.dirty = async () => dirty
    h.deps.withControl = async (_record, work) => work()
    const result = await new WorktreeLifecycle(h.deps).press('worker', { choice: 'discard', requestedBy: 'cli' })
    expect(result.ok).toBe(!dirty)
    expect(h.finish).toHaveBeenCalledTimes(dirty ? 0 : 1)
  })

  it.each(['cli', 'peer'] as const)('refuses %s agent Keep and Discard while the person owns a dirty Finish', async (requestedBy) => {
    const current = record({ worktreeLifecycle: { version: 1, actionId: 'action', phase: 'finishing', step: 'worker-resolving', owner: 'person', ownerSince: 1,
      outOfDate: 0, journal: [], facts: { worker: { liveness: 'alive', resumeFailures: 0 } } } })
    const h = harness(current)
    h.deps.dirty = async () => true
    expect(await new WorktreeLifecycle(h.deps).press('worker', { choice: 'keep', requestedBy }))
      .toMatchObject({ ok: false, code: 'person-only', detail: expect.stringContaining('The person holds this Finish since') })
    expect(await new WorktreeLifecycle(h.deps).press('worker', { choice: 'discard', requestedBy }))
      .toMatchObject({ ok: false, code: 'person-only', detail: expect.stringContaining('The person holds this Finish since') })
    expect(h.finish).not.toHaveBeenCalled()
  })
  it.each(['svn', 'git'] as const)('routes a %s press through its registered finisher', async (kind) => {
    const current = record(); current.worktree!.kind = kind
    const h = harness(current)
    expect((await h.facade.press('worker', { choice: 'commit', requestedBy: 'window' })).ok).toBe(true)
    expect(h.finish).toHaveBeenCalledWith('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.deps.checks).toHaveBeenCalledTimes(kind === 'git' ? 1 : 0)
  })

  it('keeps a Git worktree through its registered contract', async () => {
    const current = record(); current.worktree!.kind = 'git'; const h = harness(current)
    await h.facade.press('worker', { choice: 'keep', requestedBy: 'window' })
    expect(h.finisher.keep).toHaveBeenCalledWith('worker')
    expect(h.finish).not.toHaveBeenCalled()
  })

  it('retains the old cleanup pacing and held-action decisions', () => {
    const clean = record({ worktreeCleanup: { phase: 'pending', trigger: 'requested', requestedAt: 1, attempts: 0 } })
    const action = record({ sessionId: 'action', svnAction: { actionId: 'a', kind: 'finish', stage: 'evidence', root: 'C:/tree', startedAt: 1, stageAt: 1, checks: [], checkCursor: 0, rootCursor: 0, rounds: { incoming: 0, lock: 0, outOfDate: 0 }, evidence: [], requestedBy: 'window' } })
    expect(WorktreeLifecycle.due([clean, action], 60_000, 0, new Set())).toEqual([
      { kind: 'clean-worktree', sessionId: 'worker' }, { kind: 'svn-action-due', sessionId: 'action' },
    ])
    expect(WorktreeLifecycle.due([clean, action], 10, 0, new Set(['action']))).toEqual([])
  })

  it('composes the existing CLI worktree state', async () => {
    const current = record({ worktreeLifecycle: { version: 12, actionId: 'a', phase: 'finishing', step: 'committing', outOfDate: 0,
      journal: [], facts: { worker: { liveness: 'alive', resumeFailures: 0 } } } })
    const h = harness(current)
    const result = await h.facade.infoOf('worker')
    expect(result).toMatchObject({ ok: true as const, value: { worktreeView: { summary: 'finishing/committing v12', version: 12 }, sessionId: 'worker', worktree: { kind: 'svn', url: 'url', baseRevision: 1 }, action: null, cleanup: null, workflow: null } })
  })
})
