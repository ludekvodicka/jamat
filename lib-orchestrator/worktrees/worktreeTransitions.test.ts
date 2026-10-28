import { describe, expect, it } from 'vitest'
import type { FinishStep, WorktreeActor, WorktreeEvent, WorktreeLifecycle, WorktreePhase, WorktreeReviewSnapshot } from './worktreeState'
import { WorktreeTransitions } from './worktreeTransitions'

const review: WorktreeReviewSnapshot = { version: 4, selection: ['a'], hashes: { a: 'hash' }, message: '[app] Change', source: 'person-local', acknowledged: [], headMovedBy: 0 }
const initial = (): WorktreeLifecycle => ({ version: 4, actionId: 'action', phase: 'active', outOfDate: 0, journal: [],
  owner: 'person', purpose: 'finish', hasWindow: true, review,
  preparation: { format: 1, manifest: 'manifest', content: 'hash', metadata: 'hash', commands: 'hash', checks: 'none', checkedAt: 1, attempt: 0 },
  removalPermit: { kind: 'clean', provedAt: 1, allowed: [] }, facts: { worker: { liveness: 'alive', resumeFailures: 0 } } })
const events: Record<WorktreeEvent['kind'], WorktreeEvent> = {
  finish: { kind: 'finish', actionId: 'action', at: 2, ready: true, hasWindow: true },
  ready: { kind: 'ready', at: 2, hashes: { a: 'hash' } }, synced: { kind: 'synced', at: 2, revision: 2, conflicts: 0 },
  resolved: { kind: 'resolved' }, 'checks-passed': { kind: 'checks-passed', review }, 'review-opened': { kind: 'review-opened' },
  approve: { kind: 'approve', reviewVersion: 4 }, correct: { kind: 'correct', brief: 'Fix the test' }, idle: { kind: 'idle' },
  'confirm-busy': { kind: 'confirm-busy' }, committed: { kind: 'committed' }, 'out-of-date': { kind: 'out-of-date', at: 2 },
  verified: { kind: 'verified' }, disposed: { kind: 'disposed', permit: { kind: 'clean', provedAt: 2, allowed: [] } },
  'worker-stopped': { kind: 'worker-stopped' }, removed: { kind: 'removed' }, recorded: { kind: 'recorded' },
  keep: { kind: 'keep', dirty: true }, discard: { kind: 'discard', dirty: true, permit: { kind: 'discard', by: 'person', at: 2 } },
  wait: { kind: 'wait', wait: { kind: 'svn-failed', reason: 'retry', at: 2 } }, retry: { kind: 'retry' },
  'worker-died': { kind: 'worker-died', at: 2 }, 'worker-resumed': { kind: 'worker-resumed', at: 2 }, 'resume-failed': { kind: 'resume-failed', at: 2 },
  'back-to-work': { kind: 'back-to-work' },
}
const phases: readonly string[] = ['active', 'kept', 'waiting', 'landed', 'removed']
function at(key: string, event: WorktreeEvent): WorktreeLifecycle {
  const state = initial()
  if (phases.includes(key)) state.phase = key as WorktreePhase
  else { state.phase = 'finishing'; state.step = key as FinishStep }
  if (key === 'waiting') {
    state.step = 'syncing'
    state.wait = { kind: event.kind === 'review-opened' ? 'waiting-for-review' : event.kind === 'worker-resumed' || event.kind === 'resume-failed' ? 'worker-lost' : 'svn-failed', reason: 'wait', at: 1 }
  }
  return state
}
const destinations: Partial<Record<WorktreeEvent['kind'], string>> = {
  finish: 'syncing', synced: 'checking', resolved: 'checking', 'checks-passed': 'reviewing', 'review-opened': 'reviewing',
  approve: 'awaiting-idle', correct: 'worker-resolving', idle: 'committing', 'confirm-busy': 'committing',
  committed: 'verifying', 'out-of-date': 'waiting', verified: 'disposing', disposed: 'stopping-worker',
  'worker-stopped': 'removing', removed: 'recording', recorded: 'landed', keep: 'kept', discard: 'stopping-worker',
  wait: 'waiting', retry: 'syncing', 'worker-resumed': 'syncing', 'resume-failed': 'waiting', 'back-to-work': 'active',
}
const actors: WorktreeActor[] = ['person', 'remote-person', 'worker', 'agent', 'jamat']

describe('WorktreeTransitions', () => {
  for (const [key, rows] of Object.entries(WorktreeTransitions.table))
    for (const [kind, allowed] of Object.entries(rows))
      it(`${key} / ${kind}: transitions once, preserves input and refuses unauthorized actors`, () => {
        const event = events[kind as WorktreeEvent['kind']]
        const state = at(key, event)
        const before = structuredClone(state)
        const result = WorktreeTransitions.next(state, event, allowed[0]!)
        expect(result.ok).toBe(true)
        if (!result.ok) throw new Error(result.refusal)
        expect(result.state.version).toBe(state.version + 1)
        expect(result.state.phase === 'waiting' ? 'waiting' : result.state.step ?? result.state.phase).toBe(destinations[event.kind] ?? key)
        expect(state).toEqual(before)
        for (const actor of actors.filter((value) => !allowed.includes(value)))
          expect(WorktreeTransitions.next(state, event, actor)).toMatchObject({ ok: false })
      })

  // A worker lost outside a Finish waits with no step; its resume goes back to work (UA1-J14R-1).
  it('takes a resumed worker out of worker-lost: to work outside a Finish, to its step inside one, starting its count again', () => {
    const lost = { kind: 'worker-lost' as const, reason: 'lost', at: 1 }
    const dead = { worker: { liveness: 'dead' as const, resumeFailures: 2, diedAt: 1, resumeMode: 'resume-quiet' as const } }
    const outside: WorktreeLifecycle = { ...initial(), actionId: null, phase: 'waiting', wait: lost, facts: dead }
    expect(WorktreeTransitions.next(outside, { kind: 'worker-resumed', at: 9 }, 'jamat')).toMatchObject({ ok: true,
      state: { phase: 'active', wait: undefined, facts: { worker: { liveness: 'alive', resumeFailures: 0, resumedAt: 9, resumeMode: undefined } } } })
    const reviewing: WorktreeLifecycle = { ...outside, actionId: 'action', step: 'reviewing', hasWindow: undefined }
    expect(WorktreeTransitions.next(reviewing, { kind: 'worker-resumed', at: 9 }, 'jamat')).toMatchObject({ ok: true,
      state: { phase: 'waiting', step: 'reviewing', wait: { kind: 'waiting-for-review' } } })
    expect(WorktreeTransitions.next({ ...reviewing, hasWindow: true }, { kind: 'worker-resumed', at: 9 }, 'jamat'))
      .toMatchObject({ ok: true, state: { phase: 'finishing', step: 'reviewing', wait: undefined } })
    expect(WorktreeTransitions.next({ ...outside, wait: { ...lost, kind: 'svn-failed' } }, { kind: 'worker-resumed', at: 9 }, 'jamat')).toMatchObject({ ok: false })
  })

  it('refuses every unlisted state/event pair', () => {
    const keys = [...new Set([...Object.keys(WorktreeTransitions.table), 'landed', 'removed'])]
    for (const key of keys)
      for (const event of Object.values(events))
        if (!Object.hasOwn(WorktreeTransitions.table[key as keyof typeof WorktreeTransitions.table] ?? {}, event.kind))
          expect(WorktreeTransitions.next(at(key, event), event, 'person').ok).toBe(false)
  })

  it('refuses agent Keep and Discard during a dirty person review with conflicts', () => {
    const state = at('reviewing', events.keep)
    state.conflictMemory = { actionId: 'a', readAt: 1, paths: [{ path: 'a', saved: 'saved/a', sidecars: [] }] }
    expect(WorktreeTransitions.next(state, events.keep, 'agent').ok).toBe(false)
    expect(WorktreeTransitions.next(state, events.discard, 'agent').ok).toBe(false)
    const kept = WorktreeTransitions.next(state, events.keep, 'person')
    expect(kept).toMatchObject({ ok: true, state: { phase: 'kept', conflictMemory: state.conflictMemory } })
  })

  it('takes a Finish back to work only before its commit, and only the holder of it', () => {
    const waiting = at('waiting', events['back-to-work'])
    waiting.wait = { kind: 'worker-busy', reason: 'Sync waits for an idle worker or your confirmation', at: 1 }
    const back = WorktreeTransitions.next(waiting, events['back-to-work'], 'person')
    expect(back).toMatchObject({ ok: true, effects: [], state: { phase: 'active' } })
    if (!back.ok) throw new Error(back.refusal)
    expect([back.state.step, back.state.wait, back.state.review, back.state.owner, back.state.purpose, back.state.execution]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined])
    expect(WorktreeTransitions.next(waiting, events['back-to-work'], 'agent')).toMatchObject({ ok: false })
    expect(WorktreeTransitions.next({ ...waiting, owner: 'agent' }, events['back-to-work'], 'agent').ok).toBe(true)
    expect(WorktreeTransitions.next({ ...waiting, step: 'committing' }, events['back-to-work'], 'person').ok).toBe(false)
    expect(WorktreeTransitions.next({ ...waiting, verified: [{ root: 'r', revision: 2, paths: ['a'], at: 2 }] }, events['back-to-work'], 'person').ok).toBe(true)
    expect(WorktreeTransitions.next({ ...waiting, purpose: 'discard' }, events['back-to-work'], 'person').ok).toBe(false)
  })

  it('guards the svn state only once a Finish holds a review or publishes', () => {
    const base = { ...initial(), review: undefined }
    expect(WorktreeTransitions.guardsSvnState(base)).toBe(false)
    expect(WorktreeTransitions.guardsSvnState({ ...base, phase: 'waiting', step: 'syncing', wait: { kind: 'changed-outside', reason: 'x', at: 1 } })).toBe(false)
    expect(WorktreeTransitions.guardsSvnState({ ...base, phase: 'finishing', step: 'reviewing', review })).toBe(true)
    expect(WorktreeTransitions.guardsSvnState({ ...base, phase: 'finishing', step: 'committing' })).toBe(true)
  })

  it('requires a clean proof for an agent Discard', () => {
    expect(WorktreeTransitions.next(initial(), { ...events.discard, kind: 'discard', dirty: false, permit: { kind: 'discard', by: 'person', at: 2 } }, 'agent').ok).toBe(false)
    expect(WorktreeTransitions.next(initial(), { kind: 'discard', dirty: false, permit: { kind: 'clean', provedAt: 2, allowed: [] } }, 'agent').ok).toBe(true)
  })

  it('waits for a window and refuses stale or absent approval', () => {
    const checking = { ...at('checking', events['checks-passed']), hasWindow: false }
    expect(WorktreeTransitions.next(checking, events['checks-passed'], 'jamat')).toMatchObject({ ok: true, state: { phase: 'waiting', wait: { kind: 'waiting-for-review' } } })
    expect(WorktreeTransitions.next(at('reviewing', events.approve), { kind: 'approve', reviewVersion: 3 }, 'person').ok).toBe(false)
    expect(WorktreeTransitions.next({ ...at('reviewing', events.approve), review: undefined }, events.approve, 'person').ok).toBe(false)
  })

  it('waits repository-busy on every out-of-date event', () => {
    let state = at('committing', events['out-of-date'])
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = WorktreeTransitions.next({ ...state, phase: 'finishing', step: 'committing' }, events['out-of-date'], 'jamat')
      if (!result.ok) throw new Error(result.refusal)
      state = result.state
      expect(state.outOfDate).toBe(attempt)
      expect(state.version).toBe(4 + attempt)
    }
    expect(state).toMatchObject({ phase: 'waiting', wait: { kind: 'repository-busy' } })
  })

  it('requires confirmation before ready and a permit before removal', () => {
    expect(WorktreeTransitions.next(initial(), { kind: 'finish', actionId: 'a', at: 2, ready: false, hasWindow: false }, 'agent').ok).toBe(false)
    expect(WorktreeTransitions.next(initial(), { kind: 'finish', actionId: 'a', at: 2, ready: false, confirmed: true, hasWindow: true }, 'person').ok).toBe(true)
    expect(WorktreeTransitions.next({ ...at('stopping-worker', events['worker-stopped']), removalPermit: undefined }, events['worker-stopped'], 'jamat').ok).toBe(false)
  })
})
