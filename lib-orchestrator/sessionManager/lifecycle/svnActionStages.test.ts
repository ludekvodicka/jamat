import { describe, expect, it } from 'vitest'

import type { SessionRecordSvnAction } from '../records/sessionRecord.types'
import type { SvnActionStage } from '../sessionManagerApi.types'
import { SvnActionStages } from './svnActionStages'

describe('lib-orchestrator/sessionManager/lifecycle/svnActionStages', () => {
  const stages: readonly SvnActionStage[] = ['stopping', 'evidence', 'checks', 'updating', 'cleaning', 'resolving', 'verifying',
    'reviewing', 'removing', 'recording']

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
      'updating', 'updating', 'updating', 'updating', 'updating', 'updating', 'updating', 'reviewing', 'removing', 'removing',
    ])
    expect(() => SvnActionStages.legacyPhaseOf('landing' as SvnActionStage)).toThrow(/Unknown SVN action stage/)
  })

  it('names the run of each run stage, and none of a client stage', () => {
    expect(stages.filter((stage) => SvnActionStages.isRun(stage))).toEqual(['checks', 'updating', 'cleaning', 'resolving', 'reviewing'])
    expect(SvnActionStages.linkOf(action())).toEqual({ phase: 'after', scriptId: 'checks', name: 'tests' })
    expect(SvnActionStages.linkOf(action({ stage: 'updating' }))).toEqual({ phase: 'after', scriptId: 'svn', name: 'update' })
    expect(SvnActionStages.linkOf(action({ stage: 'cleaning' }))).toEqual({ phase: 'after', scriptId: 'svn', name: 'cleanup' })
    expect(SvnActionStages.linkOf(action({ stage: 'resolving' }))).toEqual({ phase: 'after', scriptId: 'svn-resolve', name: 'resolver' })
    expect(() => SvnActionStages.linkOf(action({ stage: 'verifying' }))).toThrow(/waits on no run/)
    expect(SvnActionStages.linkOf(action({ stage: 'reviewing' }))).toEqual({ phase: 'after', scriptId: 'review', name: 'lib' })
    expect(SvnActionStages.linkOf(action({ stage: 'reviewing', rootCursor: 1 }))).toEqual({ phase: 'after', scriptId: 'review', name: '.' })
    expect(() => SvnActionStages.linkOf(action({ stage: 'removing' }))).toThrow(/waits on no run/)
  })

  it('says a client step is due for a client stage, a written verdict or a relaunch whose wait is over', () => {
    expect(SvnActionStages.clientDue(action({ stage: 'evidence' }))).toBe(true)
    expect(SvnActionStages.clientDue(action())).toBe(false)
    expect(SvnActionStages.clientDue(action({ verdict: { kind: 'succeeded' } }))).toBe(true)
    expect(SvnActionStages.clientDue(action({ stage: 'updating', retryAt: 10 }), 9)).toBe(false)
    expect(SvnActionStages.clientDue(action({ stage: 'updating', retryAt: 10 }), 10)).toBe(true)
    expect(SvnActionStages.clientDue(action({ stage: 'evidence', needs: { kind: 'locked', reason: 'x', at: 2 } }))).toBe(false)
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
})
