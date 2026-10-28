import { describe, expect, it } from 'vitest'
import type { SessionRecord, SessionRecordSvnAction } from '../sessionManager/worktreeSessionRecords'
import { WorktreeLifecycleMigration } from './worktreeLifecycleMigration'
import { WorktreeStateValidation } from './worktreeStateValidation'
import { WorktreeWords } from './view/worktreeWords'
import { WorktreeDue } from './worktreeDue'
import { FinishStepPolicy } from './finish/finishStepPolicy'

const record = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: 'worker', kind: 'agent', title: 'worker', directory: { mode: 'default' }, binding: null,
  life: 'live', createdAt: 1, agent: { agentId: 'claude', launchMode: 'new' },
  worktree: { kind: 'svn', worktreePath: 'C:/tree', repositoryRoot: 'C:/main', branch: 'url', baseCommit: 'r1' }, ...overrides,
})
const action = (overrides: Partial<SessionRecordSvnAction> = {}): SessionRecordSvnAction => ({
  kind: 'finish', actionId: 'action', flowVersion: 1, stage: 'changes', root: 'C:/tree', checks: [],
  checkCursor: 0, rootCursor: 0, rounds: { incoming: 0, outOfDate: 0, lock: 0 }, evidence: [], requestedBy: 'window', startedAt: 1, ...overrides,
})

describe('WorktreeLifecycleMigration', () => {
  it('offers an action, a scheduled continuation or a terminal/active state for every accepted phase/step/wait combination', () => {
    let accepted = 0
    const waits = ['review', 'waiting-for-review', 'conflict-person', 'checks-failed', 'repository-busy', 'published-with-differences',
      'worker-lost', 'changed-outside', 'removal-blocked', 'host-unhealthy', 'svn-failed', 'locked', 'auth', 'pinned-external',
      'partially-landed', 'never-started', 'worker-busy']
    for (const phase of ['active', 'finishing', 'waiting', 'landed', 'kept', 'removed'])
      for (const step of [undefined, ...Object.keys(FinishStepPolicy.steps)])
        for (const kind of [undefined, ...waits])
          for (const execution of [undefined, action()]) {
            const state = WorktreeStateValidation.parse({ ...WorktreeLifecycleMigration.fromOld(record()), actionId: 'action', phase, step, execution,
              wait: kind === undefined ? undefined : { kind, reason: 'test', at: 1 } })
            if (state === undefined) continue
            accepted++
            const terminal = ['active', 'landed', 'kept', 'removed'].includes(state.phase)
            const exits = (WorktreeWords.presentation(state).actions?.length ?? 0) > 0
              || WorktreeDue.of([record({ worktreeLifecycle: state })], 100_000, 0, new Set()).length > 0
            expect(terminal || exits, JSON.stringify({ phase, step, kind, execution: execution !== undefined })).toBe(true)
          }
    expect(accepted).toBeGreaterThan(300)
  })
  it('reads an older refused Stop flag as a refusal of the run it held', () => {
    const base = { ...WorktreeLifecycleMigration.fromOld(record())!, actionId: 'action', phase: 'finishing', step: 'worker-resolving' }
    const execution = { root: 'C:/tree', checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 1, stopRefused: true }
    expect(WorktreeStateValidation.parse({ ...base, execution: { ...execution, runId: 'merger' } })?.execution).toEqual({ ...execution, stopRefused: undefined, runId: 'merger', stopRefusedRunId: 'merger' })
    expect(WorktreeStateValidation.parse({ ...base, execution })?.execution).toEqual({ ...execution, stopRefused: undefined })
  })
  it('rejects publication without execution or a checked preparation while retaining explicit legacy recovery states', () => {
    const base = WorktreeLifecycleMigration.fromOld(record())!
    const publishing = { ...base, actionId: 'new', phase: 'finishing', step: 'committing' }
    expect(WorktreeStateValidation.parse(publishing)).toBeUndefined()
    const execution = { root: 'C:/tree', checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 1 }
    const review = { version: 1, selection: [], hashes: {}, message: '[App] Change', source: 'person-local', acknowledged: [], headMovedBy: 0 }
    expect(WorktreeStateValidation.parse({ ...publishing, execution, review, approvedAt: 1 })).toBeUndefined()
    expect(WorktreeStateValidation.parse(WorktreeLifecycleMigration.fromOld(record({ svnAction: action({ stage: 'committing' }) })))).toBeDefined()
  })
  it('keeps all 22 conflict memories after Keep', () => {
    const current = record()
    current.worktree!.conflictMemory = { actionId: 'previous', readAt: 1,
      paths: Array.from({ length: 22 }, (_, index) => ({ path: `file-${index}`, saved: `C:/saved/${index}`, sidecars: [`file-${index}.mine`] })) }
    current.worktreeOutcome = { result: 'interrupted', revisions: [], main: 'none', worktree: 'kept', lines: [], at: 2 }
    const state = WorktreeLifecycleMigration.fromOld(current)
    expect(state?.phase).toBe('kept')
    expect(state?.conflictMemory?.paths).toHaveLength(22)
    expect(state?.conflictMemory).toEqual(current.worktree!.conflictMemory)
    expect(state?.conflictMemory).not.toBe(current.worktree!.conflictMemory)
  })

  it('maps a changes review without creating approval and keeps landed rows', () => {
    expect(WorktreeLifecycleMigration.fromOld(record({ svnAction: action({ commit: { selection: ['a'], message: '[app] old', hashes: { a: 'hash' } } }) })))
      .toMatchObject({ phase: 'finishing', step: 'reviewing' })
    expect(WorktreeLifecycleMigration.fromOld(record({ svnAction: action() }))?.review).toBeUndefined()
    expect(WorktreeLifecycleMigration.fromOld(record({ worktree: undefined, retiredWorktree: { kind: 'svn', worktreePath: 'C:/tree', revisions: ['r2'], removedAt: 2, ownerDir: 'C:/main', landed: [] } }))?.phase).toBe('landed')
  })

  it('maps a newer unknown stage to a non-committing wait', () => {
    const current = record({ svnAction: { ...action(), stage: 'future-stage' } as unknown as SessionRecordSvnAction })
    expect(WorktreeLifecycleMigration.fromOld(current)).toMatchObject({ phase: 'waiting', wait: { kind: 'svn-failed', reason: 'Unknown state after upgrade' } })
    expect(WorktreeLifecycleMigration.fromOld(current)?.step).toBeUndefined()
  })

  it('maps cleanup and terminal records and leaves unrelated sessions alone', () => {
    expect(WorktreeLifecycleMigration.fromOld(record({ worktreeCleanup: { phase: 'pending', trigger: 'requested', requestedAt: 1, attempts: 0 } }))).toMatchObject({ phase: 'waiting', step: 'removing' })
    expect(WorktreeLifecycleMigration.fromOld(record({ worktree: undefined, retiredWorktree: { kind: 'svn', worktreePath: 'C:/tree', revisions: [], removedAt: 2 } }))?.phase).toBe('removed')
    expect(WorktreeLifecycleMigration.fromOld(record({ worktree: undefined }))).toBeNull()
  })

  it('validates every nested persisted field and refuses inconsistent phases', () => {
    const state = WorktreeLifecycleMigration.fromOld(record())!
    expect(WorktreeStateValidation.parse(state)).toEqual(state)
    for (const patch of [{ version: -1 }, { phase: 'future' }, { phase: 'finishing' }, { phase: 'waiting' },
      { facts: { worker: { liveness: 'alive', resumeFailures: -1 } } }, { journal: [{ kind: 'commit' }] },
      { conflictMemory: { actionId: 'a', readAt: 1, paths: [{ path: '../outside', saved: 'x', sidecars: [] }] } }])
      expect(WorktreeStateValidation.parse({ ...state, ...patch })).toBeUndefined()
  })
  it.each([
    ['stopping', 'stopping-worker'], ['evidence', 'syncing'], ['checks', 'checking'], ['updating', 'syncing'],
    ['cleaning', 'syncing'], ['resolving', 'worker-resolving'], ['merging', 'worker-resolving'], ['verifying', 'verifying'],
    ['fixing', 'worker-resolving'], ['diffing', 'syncing'], ['changes', 'reviewing'], ['committing', 'committing'],
    ['main-update', undefined], ['reviewing', 'reviewing'], ['removing', 'removing'], ['recording', 'recording'],
  ] as const)('shadows %s with its lifecycle step and preserves journal and facts', (stage, step) => {
    const previous = record({ svnAction: action() })
    const state = WorktreeLifecycleMigration.fromOld(previous)!
    state.version = 12
    state.journal = [{ stepId: 'commit-1', kind: 'commit', attempt: 1, startedAt: 3, runId: 'run' }]
    state.facts.worker.resumeFailures = 1
    state.facts.worker.ready = { at: 1, hashes: { a: 'hash' } }
    state.facts.syncedAt = { revision: 17, at: 2 }
    state.facts.fingerprint = 'proof'
    state.review = { version: 12, selection: ['a'], hashes: { a: 'hash' }, message: '[App] Change', source: 'person-local', acknowledged: [], headMovedBy: 0 }
    previous.worktreeLifecycle = state
    const shadow = WorktreeLifecycleMigration.shadow({ ...previous, svnAction: action({ stage }) }, previous).worktreeLifecycle!
    expect(shadow).toMatchObject({ version: 13, phase: stage === 'main-update' ? 'landed' : 'finishing', journal: state.journal, facts: state.facts, review: state.review })
    expect(shadow.step).toBe(step)
    expect(WorktreeStateValidation.parse(shadow)).toBeDefined()
    expect(state.version).toBe(12)
  })

  it('clears obsolete wait, conflict memory and action-specific approval on a new action', () => {
    const previous = record({ svnAction: action({ needs: { kind: 'conflict', reason: 'a', at: 1 } }) })
    previous.worktree!.conflictMemory = { actionId: 'action', readAt: 1, paths: [{ path: 'a', saved: 'saved', sidecars: [] }] }
    previous.worktreeLifecycle = { ...WorktreeLifecycleMigration.fromOld(previous)!,
      review: { version: 0, selection: ['a'], hashes: {}, message: '[App] Old', source: 'person-local', acknowledged: [], headMovedBy: 0 } }
    const next = WorktreeLifecycleMigration.shadow({ ...previous, worktree: { ...previous.worktree!, conflictMemory: undefined },
      svnAction: action({ actionId: 'new', stage: 'committing' }) }, previous)
    expect(next.worktreeLifecycle).toMatchObject({ version: 1, phase: 'finishing', step: 'committing' })
    expect(next.worktreeLifecycle?.wait).toBeUndefined()
    expect(next.worktreeLifecycle?.review).toBeUndefined()
    expect(next.worktreeLifecycle?.conflictMemory).toBeUndefined()
  })

})
