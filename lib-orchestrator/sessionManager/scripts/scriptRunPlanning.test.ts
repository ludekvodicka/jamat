import { describe, expect, it } from 'vitest'

import type { SessionRecord, SessionRecordScriptRun } from '../records/sessionRecord.types'
import { ScriptRunPlanning } from './scriptRunPlanning'

describe('lib-orchestrator/sessionManager/scripts/scriptRunPlanning', () => {
  /** The changes over `records` with a Host that lists `runtimes`. */
  function plan(records: readonly SessionRecord[], runtimes: readonly string[] = []): ReturnType<typeof ScriptRunPlanning.changes> {
    return ScriptRunPlanning.changes(records, new Set(runtimes))
  }

  function record(sessionId: string, overrides?: Partial<SessionRecord>): SessionRecord {
    return {
      sessionId,
      kind: 'shell',
      title: sessionId,
      directory: { mode: 'default' },
      binding: null,
      life: 'live',
      createdAt: 1,
      ...overrides,
    }
  }

  function install(sessionId: string, overrides?: Partial<SessionRecord>): SessionRecord {
    return record(sessionId, {
      life: 'ended',
      exitCode: 0,
      endedAt: 2,
      binding: { hostInstanceId: 'h', generation: 1 },
      commands: [{ command: 'pnpm install', cwd: 'C:\\w' }],
      scriptOf: { sessionId: 'p', phase: 'before', scriptId: 'setup', name: 'setup' },
      ...overrides,
    })
  }

  function entry(runId: string, outcome: SessionRecordScriptRun['outcome']): SessionRecordScriptRun {
    return {
      runId,
      phase: 'before',
      scriptId: 'setup',
      name: 'setup',
      title: runId,
      commands: [],
      startedAt: 1,
      endedAt: 2,
      outcome,
      log: { state: 'unavailable', reason: 'test' },
    }
  }

  /** The waiting parent: its launch waits on `s` under the before gate. */
  function waiting(overrides?: Partial<SessionRecord>): SessionRecord {
    return record('p', {
      life: 'starting',
      pendingOperationId: 'op',
      pendingOperationKind: 'create',
      pendingSetup: { setupSessionId: 's' },
      ...overrides,
    })
  }

  it('settles a run that is over and not yet in its parent history, and nothing still running', () => {
    expect(plan([record('p'), install('s')]))
      .toEqual([{ kind: 'settle-script-run', runId: 's' }])
    expect(plan([record('p'), install('s', { life: 'lost', binding: null })]))
      .toEqual([{ kind: 'settle-script-run', runId: 's' }])
    expect(plan([record('p'), install('s', { life: 'live' })])).toEqual([])
    expect(plan([waiting(), install('s', { life: 'starting', binding: null })])).toEqual([])
  })

  it('plans at most four settles in one pass', () => {
    const runs = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => install(id))
    expect(plan([record('p'), ...runs]).map((change) => change.runId))
      .toEqual(['a', 'b', 'c', 'd'])
  })

  it('collapses a settled run its gate no longer names', () => {
    const parent = record('p', { scriptRuns: [entry('s', 'failed')] })
    expect(plan([parent, install('s', { exitCode: 1 })]))
      .toEqual([{ kind: 'collapse-script-run', runId: 's' }])
  })

  it('keeps a failed run its gate still names, whatever the gate judges', () => {
    const failed = waiting({ life: 'ended', pendingOperationId: undefined, pendingOperationKind: undefined })
    expect(plan([
      { ...failed, scriptRuns: [entry('s', 'failed')] },
      install('s', { exitCode: 1 }),
    ])).toEqual([])
  })

  it('keeps a successful run while its gate still judges, and collapses it once the gate moved on', () => {
    expect(plan([waiting({ scriptRuns: [entry('s', 'succeeded')] }), install('s')])).toEqual([])
    // The resolver's pointer stays after the merge moved past `resolving`; the success is history then.
    const merged = record('p', {
      life: 'ended',
      worktreeMerge: { phase: 'main-merging', resolveSessionId: 'r', startedAt: 1 },
      scriptRuns: [entry('r', 'succeeded')],
    })
    const resolver = install('r', {
      kind: 'agent',
      agent: { agentId: 'claude', launchMode: 'fork', oneShot: true },
      scriptOf: { sessionId: 'p', phase: 'after', scriptId: 'merge-resolve', name: 'resolver' },
    })
    expect(plan([merged, resolver])).toEqual([{ kind: 'collapse-script-run', runId: 'r' }])
  })

  it('collapses a run whose parent is gone once it holds no process, without settling it', () => {
    expect(plan([install('s')])).toEqual([{ kind: 'collapse-script-run', runId: 's' }])
    expect(plan([install('s', { life: 'lost', binding: null })]))
      .toEqual([{ kind: 'collapse-script-run', runId: 's' }])
    // Still starting without an answer: the orphan rule loses it first.
    expect(plan([install('s', { life: 'starting', binding: null })])).toEqual([])
  })

  // A cascade stop the Host refused must not leave a process running for nobody, whatever its kind.
  it('stops a run of every kind whose parent is gone while a process may stand behind it', () => {
    const stop = (runId: string) => [{ kind: 'stop-script-run', runId }]
    expect(plan([install('s', { life: 'live' })])).toEqual(stop('s'))
    expect(plan([install('s', { life: 'starting' })])).toEqual(stop('s'))
    expect(plan([install('s', { life: 'live', stopRequested: true })])).toEqual(stop('s'))
    expect(plan([requested('r', { life: 'live' })])).toEqual(stop('r'))
    expect(plan([install('c', {
      life: 'live',
      scriptOf: { sessionId: 'p', phase: 'after', scriptId: 'declared', name: 'tests' },
    })])).toEqual(stop('c'))
  })

  // The record was written and the gate's pointer write after it did not land: nothing was launched.
  it('collapses without a history entry a gated run its gate never named and the Host never ran', () => {
    const unnamed = install('n', { life: 'starting', binding: null, exitCode: undefined, endedAt: undefined,
      pendingOperationId: 'op-n', pendingOperationKind: 'create' })
    expect(plan([waiting(), unnamed])).toEqual([{ kind: 'collapse-script-run', runId: 'n' }])
    expect(plan([record('p'), unnamed])).toEqual([{ kind: 'collapse-script-run', runId: 'n' }])
    // The Host lists it, or the gate names it, or it is bound: something did run, or may yet.
    expect(plan([waiting(), unnamed], ['n'])).toEqual([])
    expect(plan([waiting({ pendingSetup: { setupSessionId: 'n' } }), unnamed])).toEqual([])
    // A requested run has no gate: the orphan rule loses it and its entry says so.
    expect(plan([record('p'), requested('q', { life: 'starting', binding: null, pendingOperationId: 'op-q',
      pendingOperationKind: 'create' })])).toEqual([])
  })

  /** A run the live parent `p` asked for, over and judged unless the overrides say otherwise. */
  function requested(sessionId: string, overrides?: Partial<SessionRecord>): SessionRecord {
    return install(sessionId, {
      commands: [{ command: 'pnpm test', cwd: 'C:\w' }],
      scriptOf: { sessionId: 'p', phase: 'inner', scriptId: 'requested', name: 'tests' },
      ...overrides,
    })
  }

  function requestedEntry(runId: string, outcome: SessionRecordScriptRun['outcome'], startedAt = 1): SessionRecordScriptRun {
    return { ...entry(runId, outcome), phase: 'inner', scriptId: 'requested', name: 'tests', startedAt }
  }

  it('stops a running requested run once its parent no longer runs, on every pass until it ends', () => {
    const live = requested('r', { life: 'live', exitCode: undefined, endedAt: undefined })
    for (const life of ['ended', 'lost', 'starting'] as const)
      expect(plan([record('p', { life }), live])).toEqual([{ kind: 'stop-script-run', runId: 'r' }])
    // Starting over a binding the Host answered has a process behind it as well.
    expect(plan([record('p', { life: 'ended' }), { ...live, life: 'starting' }]))
      .toEqual([{ kind: 'stop-script-run', runId: 'r' }])
    // A refused stop is marked too; the manager paces the next ask and skips one already confirmed.
    expect(plan([record('p', { life: 'ended' }), { ...live, stopRequested: true }]))
      .toEqual([{ kind: 'stop-script-run', runId: 'r' }])
    expect(plan([record('p'), live])).toEqual([])
    // A starting run without a binding has nothing to stop: the orphan rule loses it.
    expect(plan([record('p', { life: 'ended' }), { ...live, life: 'starting', binding: null }])).toEqual([])
    // A setup does not stop with its parent: the parent is starting BECAUSE it waits for it.
    expect(plan([waiting(), install('s', { life: 'live' })])).toEqual([])
  })

  it('collapses a requested run that succeeded at once', () => {
    expect(plan([record('p', { scriptRuns: [requestedEntry('r', 'succeeded')] }), requested('r')]))
      .toEqual([{ kind: 'collapse-script-run', runId: 'r' }])
  })

  it('keeps a failed requested run while its parent runs and asks for nothing newer', () => {
    const failed = requested('r', { exitCode: 1, createdAt: 3 })
    expect(plan([record('p', { scriptRuns: [requestedEntry('r', 'failed', 3)] }), failed])).toEqual([])
    // A newer run of another kind does not supersede it.
    expect(plan([
      record('p', { scriptRuns: [requestedEntry('r', 'failed', 3), { ...entry('s', 'succeeded'), startedAt: 9 }] }),
      failed,
    ])).toEqual([])
  })

  it('collapses a failed requested run once its parent asks for a newer one, or no longer runs', () => {
    const failed = requested('r', { exitCode: 1, createdAt: 3 })
    const parent = record('p', { scriptRuns: [requestedEntry('r', 'failed', 3)] })
    const collapse = [{ kind: 'collapse-script-run', runId: 'r' }]
    expect(plan([parent, failed, requested('n', { life: 'live', createdAt: 4 })])).toEqual(collapse)
    // The newer one already succeeded and went: its history entry still counts.
    expect(plan([
      { ...parent, scriptRuns: [requestedEntry('r', 'failed', 3), requestedEntry('n', 'succeeded', 4)] },
      failed,
    ])).toEqual(collapse)
    expect(plan([{ ...parent, life: 'ended' }, failed])).toEqual(collapse)
  })

  it('leaves every session that is not a run alone', () => {
    expect(plan([record('a', { life: 'ended' }), record('b', { life: 'lost' })])).toEqual([])
  })
})
