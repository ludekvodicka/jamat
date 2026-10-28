import { describe, expect, it } from 'vitest'

import type { SessionRecord, SessionRecordSvnAction } from '../records/sessionRecord.types'
import { SessionSteps } from './sessionSteps'
import { type SessionStepFacts, type SessionStepRead, SessionStepWords } from './sessionStepWords'

describe('lib-orchestrator/sessionManager/lifecycle/sessionSteps', () => {
  function harness(): { steps: SessionSteps; clock: { now: number }; pushes: number[] } {
    const clock = { now: 10_000 }
    const pushes: number[] = []
    const steps = new SessionSteps({ changed: () => { pushes.push(clock.now) }, now: () => clock.now })
    return { steps, clock, pushes }
  }

  function actionOf(overrides: Partial<SessionRecordSvnAction> = {}): SessionRecordSvnAction {
    return {
      kind: 'finish',
      actionId: 'a1',
      stage: 'evidence',
      root: 'Q:/Work/App/.worktrees/014-fix',
      checks: [],
      checkCursor: 0,
      rootCursor: 0,
      rounds: { incoming: 0, outOfDate: 0, lock: 0 },
      evidence: [],
      requestedBy: 'window',
      startedAt: 4_000,
      ...overrides,
    }
  }

  function recordOf(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      sessionId: 's1',
      kind: 'agent',
      title: '014 - fix',
      createdAt: 0,
      life: 'ended',
      directory: { mode: 'project', categoryId: 'work', projectPath: 'Q:/Work/App' },
      binding: null,
      ...overrides,
    }
  }

  const removing: SessionStepFacts = { kind: 'removal', phase: 'delete', path: 'Q:/Work/App/.worktrees/014-fix' }

  it('pushes a new text at once with its start, and a moved count at most once a second', () => {
    const { steps, clock, pushes } = harness()
    steps.at('s1', { kind: 'read', read: 'conflicts' })
    expect(pushes).toEqual([10_000])
    expect(steps.infoOf(recordOf())).toEqual({
      text: 'Reading conflicts after the update', detail: 'svn status --xml', progress: null, startedAt: 10_000,
    })

    clock.now += 100
    steps.at('s1', removing, { done: 0, total: 48_000 })
    expect(pushes).toEqual([10_000, 10_100])
    for (const done of [1_000, 2_000, 3_000]) {
      clock.now += 300
      steps.at('s1', removing, { done, total: 48_000 })
    }
    expect(pushes).toEqual([10_000, 10_100])
    // Not pushed, yet the next composition takes the latest count, and the start stays.
    expect(steps.infoOf(recordOf())).toMatchObject({ detail: '3,000 of 48,000 files', progress: { done: 3_000, total: 48_000 }, startedAt: 10_100 })
    clock.now += 100
    steps.at('s1', removing, { done: 12_000, total: 48_000 })
    expect(pushes).toEqual([10_000, 10_100, 11_100])
    expect(steps.infoOf(recordOf())?.detail).toBe('12,000 of 48,000 files')

    expect(steps.clear('s1')).toBe(true)
    expect(steps.clear('s1')).toBe(false)
    expect(pushes).toHaveLength(3)
    expect(steps.infoOf(recordOf())).toBeNull()
  })

  it('composes without a clock: two calls around a moved clock answer the same', () => {
    const { steps, clock } = harness()
    const record = recordOf({ life: 'live', svnAction: actionOf({ stage: 'stopping' }) })
    steps.at('s2', { kind: 'read', read: 'incoming', revision: 4_513 })
    const live = recordOf({ sessionId: 's2' })
    const before = [steps.infoOf(record), steps.infoOf(live)]
    clock.now += 60_000
    expect([steps.infoOf(record), steps.infoOf(live)]).toEqual(before)
    expect(before[1]).toMatchObject({ text: 'Reading what the update brought in', detail: 'svn log -v --xml -r4513:HEAD' })
  })

  it('composes a resting step from the record while no producer holds one', () => {
    const { steps } = harness()
    expect(steps.infoOf(recordOf({ life: 'live', svnAction: actionOf({ stage: 'stopping' }) }))).toEqual({
      text: 'Stopping the session', detail: 'the action waits up to 60 s for its end', progress: null, startedAt: 4_000,
    })
    expect(steps.infoOf(recordOf({ svnAction: actionOf({ stage: 'updating', retryAt: 9_000, rounds: { incoming: 0, outOfDate: 0, lock: 2 } }) })))
      .toEqual({ text: 'Waiting for the svn lock', detail: 'relaunch 2 of 3', progress: null, startedAt: null })
    expect(steps.infoOf(recordOf({ svnAction: actionOf({ stage: 'updating', runId: 'r1' }) }))).toBeNull()
    expect(steps.infoOf(recordOf({ svnAction: actionOf({ needs: { kind: 'conflict', reason: 'a.txt', at: 5_000 } }) }))).toBeNull()
    expect(steps.infoOf(recordOf({ svnAction: actionOf({ stage: 'removing' }) }))).toEqual({
      text: 'Removing the worktree', detail: 'waiting to start', progress: null, startedAt: null,
    })
    expect(steps.infoOf(recordOf({ svnAction: actionOf({ stage: 'stopping' }) }))?.startedAt).toBeNull()
    expect(steps.infoOf(recordOf())).toBeNull()

    // A step in memory wins over what the record says.
    steps.at('s1', { kind: 'recording' })
    expect(steps.infoOf(recordOf({ svnAction: actionOf({ stage: 'recording' }) }))?.detail).toBe('run logs, durable result, session record')
  })

  it('names the publication a Finish verifies, and keeps the resolver words for an UPDATE of the main copy', () => {
    const { steps } = harness()
    const verifying = recordOf({
      commitReceipts: [{ scopeRoot: 'Q:/Work/App/.worktrees/014-fix', revision: 1481, paths: ['a.txt'], at: 450 }],
      worktreeLifecycle: {
        version: 9, actionId: 'a1', phase: 'finishing', step: 'verifying', outOfDate: 0, approvedAt: 300,
        facts: { worker: { liveness: 'alive', resumeFailures: 0 } }, journal: [],
        execution: { root: 'Q:/Work/App/.worktrees/014-fix', checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 100 },
      },
    })
    expect(steps.infoOf(verifying)).toMatchObject({ text: 'Verifying the publication r1481', startedAt: null })
    expect(steps.infoOf(recordOf({ svnAction: actionOf({ kind: 'update-main', stage: 'verifying' }) })))
      .toMatchObject({ text: 'Checking what the resolver left', detail: 'waiting to start' })
  })

  it('has words for every fact and every read', () => {
    const reads = {
      'owner': true, 'own-commits': true, 'receipts': true, 'fingerprint': true, 'schedule-missing': true, 'base-revision': true,
      'lock': true, 'conflicts': true, 'incoming': true, 'review-roots': true, 'review-bounds': true, 'review-labels': true,
      'markers': true, 'changes': true, 'resolve': true, 'leftovers': true, 'assembly': true,
    } satisfies Record<SessionStepRead, true>
    const facts = {
      'stopping': { kind: 'stopping', limitSeconds: 60 },
      'lock-wait': { kind: 'lock-wait', relaunch: 1, relaunches: 3 },
      'pending': { kind: 'pending', stage: 'evidence' },
      'read': { kind: 'read', read: 'owner' },
      'removal': removing,
      'recording': { kind: 'recording' },
      'publication': { kind: 'publication', revision: 1481 },
      'fixing': { kind: 'fixing', path: 'src/catalog.ts', option: 'merged', index: 1, count: 3 },
    } satisfies Record<SessionStepFacts['kind'], SessionStepFacts>
    const all: SessionStepFacts[] = [
      ...Object.values(facts),
      ...(Object.keys(reads) as SessionStepRead[]).map((read): SessionStepFacts => ({ kind: 'read', read, revision: 7, count: 2, mount: 'lib' })),
      ...(['stopping', 'evidence', 'verifying', 'fixing', 'removing', 'recording'] as const).map((stage): SessionStepFacts => ({ kind: 'pending', stage })),
    ]
    for (const entry of all) {
      const words = SessionStepWords.of(entry, null)
      expect(words.text.length, JSON.stringify(entry)).toBeGreaterThan(0)
      expect(words.detail === null || words.detail.length > 0, JSON.stringify(entry)).toBe(true)
    }
    expect(() => SessionStepWords.of({ kind: 'pending', stage: 'updating' }, null)).toThrow(/never a pending client step/)

    expect(SessionStepWords.of(removing, { done: 12_000, total: 48_000 }).detail).toBe('12,000 of 48,000 files')
    expect(SessionStepWords.of(removing, { done: 0, total: 1 }).detail).toBe('0 of 1 file')
    expect(SessionStepWords.of(removing, { done: 5, total: null }).detail).toBe('Q:/Work/App/.worktrees/014-fix')
    expect(SessionStepWords.of({ kind: 'read', read: 'own-commits', revision: 4_512, mount: 'shared/clients' }, { done: 3, total: 7 }).detail)
      .toBe('svn log -v -r4512 (3 of 7 revisions) in shared/clients')
    expect(SessionStepWords.of({ kind: 'read', read: 'own-commits', revision: 4_512, mount: '' }, { done: 1, total: 1 }).detail)
      .toBe('svn log -v -r4512 (1 of 1 revision)')
    expect(SessionStepWords.of({ kind: 'read', read: 'own-commits', mount: 'shared/clients' }, null).detail)
      .toBe('svn status -v --xml in shared/clients')
    expect(SessionStepWords.of({ kind: 'read', read: 'receipts', revision: 4_513, mount: 'shared/clients' }, null))
      .toEqual({ text: 'Confirming the commits from the session\'s split', detail: 'svn log -v -r4513 in shared/clients' })
    expect(SessionStepWords.of({ kind: 'read', read: 'resolve', count: 1_200 }, null).detail).toBe('svn resolve --accept working (1,200 files)')
    expect(SessionStepWords.of(facts.fixing, null).text).toBe('Fixing src/catalog.ts (merged), 1 of 3')
  })
})
