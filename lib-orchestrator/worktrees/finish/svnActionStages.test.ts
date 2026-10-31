import { describe, expect, it } from 'vitest'

import type { SessionRecordSvnAction } from '../../sessionManager/worktreeSessionRecords'
import type { SvnActionStage } from '../../sessionManager/sessionManagerApi.types'
import { SvnActionStages } from './svnActionStages'

describe('lib-orchestrator/sessionManager/lifecycle/svnActionStages', () => {
  const stages: readonly SvnActionStage[] = ['stopping', 'evidence', 'checks', 'updating', 'cleaning', 'resolving', 'merging', 'verifying',
    'fixing', 'reviewing', 'removing', 'recording']

  function action(overrides?: Partial<SessionRecordSvnAction>): SessionRecordSvnAction {
    return {
      kind: 'finish', actionId: 'a', stage: 'checks', runId: 'run', root: 'C:/w',
      checks: [{ key: 'k', scriptId: 'checks', name: 'tests', commands: [{ command: 'pnpm test', cwd: 'C:/w' }] }],
      checkCursor: 0, roots: [{ path: 'C:/w/lib', own: 'lib', changed: ['lib/x'] }, { path: 'C:/w', own: '', changed: ['a'] }],
      rootCursor: 0, rounds: { incoming: 0, outOfDate: 0, lock: 0 }, evidence: [], requestedBy: 'window', startedAt: 1,
      ...overrides,
    }
  }

  it('maps every stage onto one of the four finish phases a 3.10 peer accepts', () => {
    expect(stages.map((stage) => SvnActionStages.legacyPhaseOf(stage))).toEqual([
      'updating', 'updating', 'updating', 'updating', 'updating', 'updating', 'updating', 'updating', 'updating', 'reviewing', 'removing', 'removing',
    ])
    expect(() => SvnActionStages.legacyPhaseOf('landing' as SvnActionStage)).toThrow(/Unknown SVN action stage/)
  })

  it('names the run of each run stage, and none of a client stage', () => {
    expect(stages.filter((stage) => SvnActionStages.isRun(stage))).toEqual(['checks', 'updating', 'cleaning', 'resolving', 'merging'])
    expect(SvnActionStages.linkOf(action({ stage: 'merging' }))).toEqual({ phase: 'after', scriptId: 'svn-merge', name: 'merger' })
    expect(SvnActionStages.linkOf(action())).toEqual({ phase: 'after', scriptId: 'checks', name: 'tests' })
    expect(SvnActionStages.linkOf(action({ stage: 'updating' }))).toEqual({ phase: 'after', scriptId: 'svn', name: 'update' })
    expect(SvnActionStages.linkOf(action({ stage: 'cleaning' }))).toEqual({ phase: 'after', scriptId: 'svn', name: 'cleanup' })
    expect(SvnActionStages.linkOf(action({ stage: 'resolving' }))).toEqual({ phase: 'after', scriptId: 'svn-resolve', name: 'resolver' })
    expect(() => SvnActionStages.linkOf(action({ stage: 'verifying' }))).toThrow(/waits on no run/)
    expect(() => SvnActionStages.linkOf(action({ stage: 'reviewing' }))).toThrow(/waits on no run/)
    expect(() => SvnActionStages.linkOf(action({ stage: 'reviewing', rootCursor: 1 }))).toThrow(/waits on no run/)
    expect(() => SvnActionStages.linkOf(action({ stage: 'removing' }))).toThrow(/waits on no run/)
  })

  it('names the agent run of an agent stage only, which Keep and Discard stop first', () => {
    expect(SvnActionStages.agentRunOf(action({ stage: 'resolving', runId: 'resolver' }))).toBe('resolver')
    expect(SvnActionStages.agentRunOf(action({ stage: 'resolving', runId: undefined }))).toBeNull()
    expect(stages.filter((stage) => SvnActionStages.agentRunOf(action({ stage })) !== null)).toEqual(['resolving', 'merging'])
    expect(SvnActionStages.agentRunOf(action({ stage: 'merging', runId: 'm1', merger: { runId: 'm1', setAt: 1, startedAt: 2 } }))).toBe('m1')
    expect(() => SvnActionStages.agentRunOf(action({ stage: 'landing' as SvnActionStage }))).toThrow(/Unknown SVN action stage/)
  })

  it('goes back to the conflicts only from a Finish that waits on them, or on a failed resolver, with a path open', () => {
    const entry = { path: 'a.txt', kind: 'text' as const, shape: 'text-overlap' as const, state: 'person' as const, options: [], facts: {} }
    const set = { readAt: 1, baseRevision: 1, revision: 2, entries: [entry], more: 0 }
    const waits = (kind: 'conflict' | 'resolver-failed' | 'check-failed') => ({ kind, reason: 'x', at: 2 })
    expect(SvnActionStages.resumesAtFixing(action({ stage: 'changes', conflictSet: set }))).toBe(true)
    expect(SvnActionStages.resumesAtFixing(action({ stage: 'changes' }))).toBe(false)
    expect(SvnActionStages.resumesAtFixing(action({ stage: 'updating', needs: waits('conflict'), conflictSet: set }))).toBe(true)
    expect(SvnActionStages.resumesAtFixing(action({ stage: 'verifying', needs: waits('resolver-failed'), conflictSet: set }))).toBe(true)
    expect(SvnActionStages.resumesAtFixing(action({ stage: 'checks', needs: waits('check-failed'), conflictSet: set }))).toBe(false)
    // Every path settled: Check again still reads the set and goes on from it.
    expect(SvnActionStages.resumesAtFixing(action({ stage: 'fixing', needs: waits('conflict'),
      conflictSet: { ...set, entries: [{ ...entry, state: 'settled' as const }] } }))).toBe(true)
    expect(SvnActionStages.resumesAtFixing(action({ stage: 'verifying', needs: waits('resolver-failed'),
      conflictSet: { ...set, entries: [{ ...entry, state: 'settled' as const }] } }))).toBe(false)
    expect(SvnActionStages.resumesAtFixing(action({ kind: 'update-main', stage: 'updating', needs: waits('conflict'), conflictSet: set }))).toBe(false)
    expect(SvnActionStages.isRun('fixing')).toBe(false)
  })

  it('names the merger run on the snapshot while it merges, and writes its pass done whatever its exit code', () => {
    const entry = { path: 'a.txt', kind: 'text' as const, shape: 'text-overlap' as const, state: 'agent' as const, options: [], facts: {} }
    const merging = action({ stage: 'merging', runId: 'm1', merger: { runId: 'm1', setAt: 1, startedAt: 2 }, mergeBrief: 'L:/m.md',
      conflictSet: { readAt: 1, baseRevision: 1, revision: 2, entries: [entry], more: 0 }, stageAt: 5 })
    expect(SvnActionStages.infoOf(merging)).toMatchObject({ stage: 'merging', mergerRunId: 'm1', mergeBrief: 'L:/m.md', summary: '1 conflict: merger on 1' })
    expect(SvnActionStages.infoOf({ ...merging, stage: 'fixing' }).mergerRunId).toBeUndefined()
    const passed = SvnActionStages.passedOf({ ...merging, verdict: { kind: 'failed', reason: 'stopped', exitCode: 1 } }, { ...merging, stage: 'fixing' }, 9)
    expect(passed.passes?.at(-1)).toEqual({ stage: 'merging', runId: 'm1', startedAt: 5, endedAt: 9, result: 'done' })
  })

  it('says a client step is due for a client stage, a written verdict or a relaunch whose wait is over', () => {
    expect(SvnActionStages.clientDue(action({ stage: 'evidence' }))).toBe(true)
    expect(SvnActionStages.clientDue(action())).toBe(false)
    expect(SvnActionStages.clientDue(action({ verdict: { kind: 'succeeded' } }))).toBe(true)
    expect(SvnActionStages.clientDue(action({ stage: 'updating', retryAt: 10 }), 9)).toBe(false)
    expect(SvnActionStages.clientDue(action({ stage: 'updating', retryAt: 10 }), 10)).toBe(true)
    expect(SvnActionStages.clientDue(action({ stage: 'evidence', needs: { kind: 'locked', reason: 'x', at: 2 } }))).toBe(false)
  })

  it('says a run stage that names neither its run nor a retry is a lost launch, and due', () => {
    const lost = action({ kind: 'update-main', stage: 'updating', runId: undefined })
    expect(SvnActionStages.launchLost(lost)).toBe(true)
    expect(SvnActionStages.clientDue(lost, 0)).toBe(true)
    expect(SvnActionStages.launchLost(action({ stage: 'updating' }))).toBe(false)
    expect(SvnActionStages.launchLost({ ...lost, retryAt: 10 })).toBe(false)
    expect(SvnActionStages.launchLost({ ...lost, needs: { kind: 'locked', reason: 'x', at: 2 } })).toBe(false)
    expect(SvnActionStages.launchLost({ ...lost, stage: 'recording' })).toBe(false)
  })

  it('tells the snapshot the stage, why it waits and which review is open', () => {
    expect(SvnActionStages.infoOf(action({ stage: 'reviewing', rootCursor: 1 }))).toEqual({
      kind: 'finish', stage: 'reviewing', needs: null, needsKind: null, review: { index: 2, count: 2, scopeRoot: 'C:/w' },
    })
    expect(SvnActionStages.infoOf(action({ needs: { kind: 'check-failed', reason: 'tests failed', at: 2 } }))).toEqual({
      kind: 'finish', stage: 'checks', needs: 'tests failed', needsKind: 'check-failed', review: null,
    })
    expect(SvnActionStages.scopeRootOf(action({ stage: 'reviewing' }))).toBe('C:/w/lib')
    expect(SvnActionStages.scopeRootOf(action())).toBeUndefined()
  })
  it('writes a pass when the action leaves a stage, a run or a wait, and none for a write that stays', () => {
    const previous = action({ stage: 'checks', runId: 'r1', stageAt: 5, verdict: { kind: 'succeeded' } })
    const moved = SvnActionStages.passedOf(previous, action({ stage: 'updating', runId: 'r2', passes: [] }), 9)
    expect(moved.passes).toEqual([{ stage: 'checks', runId: 'r1', startedAt: 5, endedAt: 9, result: 'done' }])
    expect(moved.stageAt).toBe(9)
    const stayed = SvnActionStages.passedOf(moved, { ...moved, needs: { kind: 'locked', reason: 'x', at: 10 }, passes: [] }, 10)
    expect(stayed.passes).toEqual(moved.passes)
    expect(stayed.stageAt).toBe(9)
    const relaunched = SvnActionStages.passedOf({ ...moved, retryAt: 12 }, { ...moved, runId: 'r3' }, 12)
    expect(relaunched.passes?.at(-1)).toEqual({ stage: 'updating', runId: 'r2', startedAt: 9, endedAt: 12, result: 'failed' })
    const pressed = SvnActionStages.passedOf(stayed, { ...stayed, stage: 'evidence', needs: undefined, runId: 'r2' }, 20)
    expect(pressed.passes?.at(-1)).toEqual({ stage: 'updating', runId: 'r2', startedAt: 9, endedAt: 20, result: 'waited' })
    const client = SvnActionStages.passedOf(action({ stage: 'evidence', runId: 'r0' }), action({ stage: 'updating', runId: 'r1' }), 3)
    expect(client.passes).toEqual([{ stage: 'evidence', startedAt: 1, endedAt: 3, result: 'done' }])
  })

  it('names the newest revision a review committed on its pass', () => {
    const previous = action({ stage: 'reviewing', evidence: [{ repository: 'u', revision: 3, label: 'receipt' }] })
    const next = action({ stage: 'removing', evidence: [{ repository: 'u', revision: 3, label: 'receipt' },
      { repository: 'u', revision: 7, label: 'receipt' }, { repository: 'u', revision: 5, label: 'inferred' }] })
    expect(SvnActionStages.passedOf(previous, next, 4).passes?.[0]?.facts).toEqual({ revision: 7 })
    expect(SvnActionStages.passedOf(previous, { ...next, evidence: previous.evidence }, 4).passes?.[0]?.facts).toBeUndefined()
  })

  it('keeps the newest 40 passes over 45 stage moves', () => {
    let current = action({ stage: 'evidence' })
    for (let move = 0; move < 45; move += 1)
      current = SvnActionStages.passedOf(current, { ...current, stage: move % 2 === 0 ? 'updating' : 'evidence' }, move)
    expect(current.passes).toHaveLength(SvnActionStages.passesMaxConst)
    expect(current.passes?.[0]?.endedAt).toBe(5)
    expect(current.passes?.at(-1)?.endedAt).toBe(44)
  })
})
