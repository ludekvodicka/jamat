import { describe, expect, it } from 'vitest'

import type { RuntimeListResult, RuntimeSessionInfo } from '../../../app-host/app/wire/hostWire.js'
import type { SessionRecord } from '../records/sessionRecord.types'
import { Reconciler, type ReconcileChange } from './reconciler'

describe('lib-orchestrator/sessionManager/lifecycle/reconciler', () => {
  function record(sessionId: string, overrides?: Partial<SessionRecord>): SessionRecord {
    return {
      sessionId,
      kind: 'shell',
      title: sessionId,
      directory: { mode: 'default' },
      binding: { hostInstanceId: 'host-1', generation: 1 },
      life: 'live',
      createdAt: 1,
      ...overrides,
    }
  }

  function runtime(id: string, overrides?: Partial<RuntimeSessionInfo>): RuntimeSessionInfo {
    return {
      runtimeSessionId: id,
      generation: 1,
      alive: true,
      cols: 120,
      rows: 30,
      outputSeq: 0,
      outputEpoch: 1,
      lastOutputAt: null,
      startedAt: 1_000,
      ...overrides,
    }
  }

  function listing(sessions: RuntimeSessionInfo[], hostInstanceId = 'host-1'): RuntimeListResult {
    return { sessions, throughRevision: 7, hostInstanceId }
  }

  /**
   * A session whose merge stopped on conflicts. It is `ended` on purpose: it was stopped before the
   * merge could start, which is exactly the shape the general loop below skips.
   */
  function merging(overrides?: Partial<SessionRecord>): SessionRecord {
    return record('m', {
      life: 'ended',
      binding: null,
      worktree: {
        worktreePath: 'C:\\worktrees\\015',
        branch: 'jamat/015',
        baseCommit: 'abc',
        repositoryRoot: 'C:\\repo',
      },
      worktreeMerge: { phase: 'resolving', resolveSessionId: 'r', startedAt: 1 },
      ...overrides,
    })
  }

  /** The resolver: an ordinary agent record, judged by how it exited and by nothing else. */
  function resolver(overrides?: Partial<SessionRecord>): SessionRecord {
    return record('r', {
      kind: 'agent',
      life: 'starting',
      binding: null,
      pendingOperationId: 'op-r',
      pendingOperationKind: 'create',
      agent: { agentId: 'claude', launchMode: 'fork', oneShot: true },
      resolveFor: 'm',
      ...overrides,
    })
  }

  /** The session waiting for a setup: its launch is written, and nothing has run it. */
  function waiting(overrides?: Partial<SessionRecord>): SessionRecord {
    return record('p', {
      life: 'starting',
      binding: null,
      pendingOperationId: 'op-p',
      pendingOperationKind: 'create',
      pendingSetup: { setupSessionId: 's' },
      ...overrides,
    })
  }

  /** The setup itself is an ordinary shell record, judged by the general rules like any other. */
  function setup(overrides?: Partial<SessionRecord>): SessionRecord {
    return record('s', {
      life: 'starting',
      binding: null,
      pendingOperationId: 'op-s',
      pendingOperationKind: 'create',
      commands: [{ command: 'pnpm install', cwd: 'C:\\worktrees\\fix' }],
      setupFor: 'p',
      ...overrides,
    })
  }

  /** Everything the plan says about one session, so a case can assert the OTHER record is untouched. */
  function forSession(changes: readonly ReconcileChange[], sessionId: string): ReconcileChange[] {
    return changes.filter((change) => change.kind !== 'orphan' && change.sessionId === sessionId)
  }

  // The whole point of the distinction: a client that cannot see the Host has learnt nothing.
  it('changes nothing at all when the Host could not be reached', () => {
    const records = [
      record('a'),
      record('b', {
        life: 'starting',
        pendingOperationId: 'op-1',
        pendingOperationKind: 'create',
        binding: null,
      }),
    ]
    expect(Reconciler.plan(records, null)).toEqual([])
  })

  it('marks a live record lost when the Host answers without its runtime', () => {
    expect(Reconciler.plan([record('a')], listing([])))
      .toEqual([{ kind: 'mark-lost', sessionId: 'a' }])
  })

  it('binds a live runtime to the generation and instance the Host reports', () => {
    const changes = Reconciler.plan(
      [record('a', { binding: { hostInstanceId: 'host-0', generation: 1 } })],
      listing([runtime('a', { generation: 4 })], 'host-2'),
    )
    expect(changes).toEqual([{
      kind: 'bind-live',
      sessionId: 'a',
      binding: { hostInstanceId: 'host-2', generation: 4 },
    }])
  })

  it('ends a record whose runtime the Host reports dead, with its exit', () => {
    const changes = Reconciler.plan(
      [record('a')],
      listing([runtime('a', { alive: false, exitCode: 3, exitedAt: 9_000 })]),
    )
    expect(changes).toEqual([{ kind: 'mark-ended', sessionId: 'a', exitCode: 3, endedAt: 9_000 }])
  })

  it("carries the Host's own word for the ending through to the record", () => {
    const changes = Reconciler.plan(
      [record('a')],
      listing([runtime('a', { alive: false, exitCode: -1073741510, exitReason: 'stopped' })]),
    )
    expect(changes).toEqual([{
      kind: 'mark-ended',
      sessionId: 'a',
      exitCode: -1073741510,
      exitReason: 'stopped',
      endedAt: expect.any(Number),
    }])
  })

  it('dates an exit the Host did not date', () => {
    const changes = Reconciler.plan([record('a')], listing([runtime('a', { alive: false })]))
    expect(changes[0].kind).toBe('mark-ended')
    if (changes[0].kind !== 'mark-ended') throw new Error('expected mark-ended')
    expect(changes[0].exitCode).toBeUndefined()
    expect(changes[0].endedAt).toBeGreaterThan(0)
  })

  // A launch that crashed between the record write and the answer. Both branches are one replay.
  it('replays a pending launch under the same operationId when the Host has no runtime', () => {
    const records = [record('a', {
      life: 'starting',
      binding: null,
      pendingOperationId: 'op-9',
      pendingOperationKind: 'create',
    })]
    expect(Reconciler.plan(records, listing([])))
      .toEqual([{
        kind: 'retry-launch',
        sessionId: 'a',
        operationId: 'op-9',
        operation: 'create',
      }])
  })

  /**
   * The pass is skipped, not the record: a refusal that stands is paced, and the launch goes out
   * again the moment its wait is up. Replaying on the pass's own two-second cadence is what turned
   * four sessions the Host was refusing into 885 rejected creates in nine minutes, none of which
   * anybody waiting for those sessions could see.
   */
  it('holds a replay back while the last refusal is still being waited out', () => {
    const refused = record('a', {
      life: 'starting',
      binding: null,
      pendingOperationId: 'op-9',
      pendingOperationKind: 'create',
      launchWait: { attempts: 4, lastAttemptAt: 10_000, reason: '64 live runtimes is the limit' },
    })
    expect(Reconciler.plan([refused], listing([]), 20_000)).toEqual([])
    expect(Reconciler.plan([refused], listing([]), 25_000)).toEqual([{
      kind: 'retry-launch',
      sessionId: 'a',
      operationId: 'op-9',
      operation: 'create',
    }])
  })

  // The kind is carried through, because it is what decides the command line the replay is built
  // with: a reopen replayed as a create would start a second process under an id already in use.
  it('carries the kind of the pending operation into the replay', () => {
    const records = [record('a', {
      life: 'starting',
      binding: null,
      pendingOperationId: 'op-9',
      pendingOperationKind: 'reopen',
    })]
    expect(Reconciler.plan(records, listing([])))
      .toEqual([{
        kind: 'retry-launch',
        sessionId: 'a',
        operationId: 'op-9',
        operation: 'reopen',
      }])
  })

  describe('a merge being resolved', () => {
    /*
     * The gate in front of the whole judgement. A conflict a PERSON is resolving has the phase and
     * no pointer, and `worktreeMergeFlow` has four ways to land there. Dropping half this condition
     * judges every manual conflict failed on every pass, in red, on a record nobody asked anything of.
     */
    it('says nothing about a conflict that has no resolver', () => {
      const records = [merging({
        worktreeMerge: { phase: 'resolving', startedAt: 1 },
      })]

      expect(forSession(Reconciler.plan(records, listing([])), 'm')).toEqual([])
    })

    /** A failure already written is a judgement already made; judging again rewrites it for ever. */
    it('says nothing more about a conflict whose failure is already recorded', () => {
      const records = [merging({
        worktreeMerge: {
          phase: 'resolving',
          resolveSessionId: 'r',
          startedAt: 1,
          failure: 'the resolver ended with 1',
        },
      }), resolver({ life: 'ended', exitCode: 1 })]

      expect(forSession(Reconciler.plan(records, listing([])), 'm')).toEqual([])
    })

    it('fails the merge when its resolver is gone in any of the ways it can be', () => {
      for (const [life, reason] of [
        ['live', 'not on the Host any more'],
        ['lost', 'was lost'],
      ] as const) {
        const records = [merging(), resolver({ life })]
        const [judged] = forSession(Reconciler.plan(records, listing([])), 'm')

        expect(judged?.kind, life).toBe('merge-resolve-failed')
        expect(judged !== undefined && 'reason' in judged && judged.reason, life)
          .toContain(reason)
      }
    })

    // A resolver still `starting` with a launch to replay is being started as this pass runs, so
    // judging it now would end a merge over a launch that is being repeated.
    it('waits while its resolver still names a launch to replay', () => {
      const records = [merging(), resolver({ life: 'starting', binding: null })]

      expect(forSession(Reconciler.plan(records, listing([])), 'm')).toEqual([])
    })

    it('fails the merge when its resolver is starting and names no launch at all', () => {
      const records = [merging(), resolver({
        life: 'starting',
        binding: null,
        pendingOperationId: undefined,
        pendingOperationKind: undefined,
      })]
      const [judged] = forSession(Reconciler.plan(records, listing([])), 'm')

      expect(judged?.kind).toBe('merge-resolve-failed')
      expect(judged !== undefined && 'reason' in judged && judged.reason)
        .toContain('names no launch to replay')
    })

    it('fails the merge when the resolver was stopped, whatever it exited with', () => {
      const records = [merging(), resolver({ life: 'ended', exitCode: 0, stopRequested: true })]
      const [judged] = forSession(Reconciler.plan(records, listing([])), 'm')

      expect(judged?.kind).toBe('merge-resolve-failed')
      expect(judged !== undefined && 'reason' in judged && judged.reason).toContain('was stopped')
    })
  })

  describe('an install nobody waits for', () => {
    // `mintSetup` and `rearmSetup` write the install first and arm the waiting record second, so a
    // crash between the two leaves an install `starting` under its own pending pair with no owner
    // holding it. Replaying that runs `pnpm install` in a worktree nothing is waiting on, and
    // nothing will ever judge its exit code: `setupJudgement` is asked by the owner, and there is
    // no owner.
    it('is marked lost rather than replayed when its owner is gone', () => {
      expect(Reconciler.plan([setup()], listing([])))
        .toEqual([{ kind: 'mark-lost', sessionId: 's' }])
    })

    it('is marked lost when its owner stopped waiting for any setup', () => {
      const records = [waiting({ pendingSetup: undefined, life: 'live' }), setup()]
      expect(forSession(Reconciler.plan(records, listing([runtime('p')])), 's'))
        .toEqual([{ kind: 'mark-lost', sessionId: 's' }])
    })

    // The exact shape the half-written retry leaves: the owner is still armed, and still names the
    // install that was replaced rather than this one.
    it('is marked lost when its owner is waiting for a different install', () => {
      const records = [waiting({ pendingSetup: { setupSessionId: 'older' } }), setup()]
      expect(forSession(Reconciler.plan(records, listing([])), 's'))
        .toEqual([{ kind: 'mark-lost', sessionId: 's' }])
    })

    it('is replayed as before while its owner is still waiting for it', () => {
      expect(forSession(Reconciler.plan([waiting(), setup()], listing([])), 's'))
        .toEqual([{
          kind: 'retry-launch',
          sessionId: 's',
          operationId: 'op-s',
          operation: 'create',
        }])
    })

    // The guard asks about `setupFor` and nothing else: an ordinary session has none, and a replay
    // of one must not depend on any other record existing.
    it('leaves a session that is no install alone', () => {
      const records = [record('a', {
        life: 'starting',
        binding: null,
        pendingOperationId: 'op-9',
        pendingOperationKind: 'create',
      })]
      expect(Reconciler.plan(records, listing([])))
        .toEqual([{
          kind: 'retry-launch',
          sessionId: 'a',
          operationId: 'op-9',
          operation: 'create',
        }])
    })
  })

  it('binds a pending create whose answer was lost after the Host had already run it', () => {
    const records = [record('a', {
      life: 'starting',
      binding: null,
      pendingOperationId: 'op-9',
      pendingOperationKind: 'create',
    })]
    expect(Reconciler.plan(records, listing([runtime('a', { generation: 1 })])))
      .toEqual([{
        kind: 'bind-live',
        sessionId: 'a',
        binding: { hostInstanceId: 'host-1', generation: 1 },
      }])
  })

  it('loses a starting record that names no operation to replay', () => {
    const records = [record('a', { life: 'starting', binding: null })]
    expect(Reconciler.plan(records, listing([])))
      .toEqual([{ kind: 'mark-lost', sessionId: 'a' }])
  })

  // An id with no kind cannot say which launch it was asking for, and guessing is exactly the bug
  // the kind exists to stop. Such a record is lost, which the user can reopen deliberately.
  it('loses a starting record whose pending operation has no kind', () => {
    const records = [record('a', { life: 'starting', binding: null, pendingOperationId: 'op-9' })]
    expect(Reconciler.plan(records, listing([])))
      .toEqual([{ kind: 'mark-lost', sessionId: 'a' }])
  })

  it('leaves an ended or lost record alone', () => {
    const records = [
      record('a', { life: 'ended', endedAt: 5 }),
      record('b', { life: 'lost', binding: null }),
    ]
    expect(Reconciler.plan(records, listing([]))).toEqual([])
  })

  it('reports a live runtime nobody records, and only a live one', () => {
    const changes = Reconciler.plan(
      [record('a')],
      listing([runtime('a'), runtime('orphan-1'), runtime('orphan-2', { alive: false })]),
    )
    expect(changes.filter((change) => change.kind === 'orphan'))
      .toEqual([{ kind: 'orphan', runtimeSessionId: 'orphan-1' }])
  })

  it('does not call a runtime an orphan while any record still names it', () => {
    const records = [record('a', { life: 'ended' })]
    expect(Reconciler.plan(records, listing([runtime('a')]))).toEqual([])
  })

  /*
   * The gate. Without it this record is a `starting` one the Host has no runtime for, which is the
   * shape of an interrupted launch - and replaying it would start the session in a worktree whose
   * dependencies are still being installed.
   */
  it('says nothing about a session whose setup is still running', () => {
    const changes = Reconciler.plan([waiting(), setup()], listing([runtime('s')]))
    expect(forSession(changes, 'p')).toEqual([])
    // And the setup session itself is bound like any other live runtime: it is a session too.
    expect(changes).toEqual([{
      kind: 'bind-live',
      sessionId: 's',
      binding: { hostInstanceId: 'host-1', generation: 1 },
    }])
  })

  it('launches the waiting session when the setup runtime exited cleanly', () => {
    const changes = Reconciler.plan(
      [waiting(), setup()],
      listing([runtime('s', { alive: false, exitCode: 0, exitedAt: 9_000 })]),
    )
    expect(forSession(changes, 'p')).toEqual([{ kind: 'setup-succeeded', sessionId: 'p' }])
  })

  /*
   * The exit code of a killed process is the platform's answer, not the install's: node-pty reports
   * whatever the process ended with, and on POSIX a signalled process reports 0. Judging a stopped
   * install by that number reads it as a clean one and starts the session in a worktree whose
   * dependencies are half installed - which is the single outcome this whole path exists to prevent.
   */
  it('ends the waiting session when its setup was stopped, whatever it exited with', () => {
    const changes = Reconciler.plan(
      [waiting(), setup({ stopRequested: true })],
      listing([runtime('s', { alive: false, exitCode: 0, exitedAt: 9_000 })]),
    )
    expect(forSession(changes, 'p'))
      .toEqual([{ kind: 'setup-failed', sessionId: 'p', reason: 'its setup was stopped' }])
  })

  // Which record the store happens to list first must not change the verdict: the setup's own
  // mark-ended and the primary's judgement are read off the same listing either way.
  it('judges the setup the same whichever record comes first', () => {
    const answer = listing([runtime('s', { alive: false, exitCode: 0, exitedAt: 9_000 })])
    expect(forSession(Reconciler.plan([setup(), waiting()], answer), 'p'))
      .toEqual([{ kind: 'setup-succeeded', sessionId: 'p' }])
  })

  it('ends the waiting session when the setup runtime exited non-zero', () => {
    const changes = Reconciler.plan(
      [waiting(), setup()],
      listing([runtime('s', { alive: false, exitCode: 7, exitedAt: 9_000 })]),
    )
    expect(forSession(changes, 'p')).toEqual([{
      kind: 'setup-failed',
      sessionId: 'p',
      reason: expect.stringContaining('7'),
    }])
  })

  // Only exit 0 is an install that finished. A runtime that died saying nothing at all is not one.
  it('ends the waiting session when the setup runtime died without an exit code', () => {
    const changes = Reconciler.plan([waiting(), setup()], listing([runtime('s', { alive: false })]))
    expect(forSession(changes, 'p')).toEqual([{
      kind: 'setup-failed',
      sessionId: 'p',
      reason: expect.stringContaining('no exit code'),
    }])
  })

  /*
   * The Host has neither runtime, which is a client that died before either launch was answered.
   * The setup's own replay is what this pass is for, and ending the session over a launch that is
   * being repeated in the very same pass would lose a session to a restart.
   */
  it('waits while the setup session is replaying its own launch', () => {
    const changes = Reconciler.plan([waiting(), setup()], listing([]))
    expect(forSession(changes, 'p')).toEqual([])
    expect(forSession(changes, 's')).toEqual([{
      kind: 'retry-launch',
      sessionId: 's',
      operationId: 'op-s',
      operation: 'create',
    }])
  })

  it('ends the waiting session when the setup names no launch to replay', () => {
    const changes = Reconciler.plan(
      [waiting(), setup({ pendingOperationId: undefined, pendingOperationKind: undefined })],
      listing([]),
    )
    expect(forSession(changes, 'p')).toEqual([{
      kind: 'setup-failed',
      sessionId: 'p',
      reason: expect.stringContaining('no launch'),
    }])
  })

  // The Host restarted after the install had finished: its record is the only witness left of it.
  it('launches the waiting session from an ended setup record the Host no longer has', () => {
    const changes = Reconciler.plan(
      [waiting(), setup({ life: 'ended', exitCode: 0, endedAt: 9_000 })],
      listing([]),
    )
    expect(forSession(changes, 'p')).toEqual([{ kind: 'setup-succeeded', sessionId: 'p' }])
  })

  it('ends the waiting session for a setup record that ended badly or said nothing', () => {
    const cases: { ended: Partial<SessionRecord>; reason: string }[] = [
      { ended: { life: 'ended', exitCode: 3, endedAt: 9_000 }, reason: '3' },
      { ended: { life: 'ended', endedAt: 9_000 }, reason: 'no exit code' },
    ]
    for (const { ended, reason } of cases) {
      const changes = Reconciler.plan([waiting(), setup(ended)], listing([]))
      expect(forSession(changes, 'p')).toEqual([{
        kind: 'setup-failed',
        sessionId: 'p',
        reason: expect.stringContaining(reason),
      }])
    }
  })

  // Both are a setup record naming a runtime the Host does not have, and neither will ever be able
  // to say the install finished. The general rules lose the setup in this same pass.
  it('ends the waiting session when the setup record is live or lost with nothing behind it', () => {
    for (const life of ['live', 'lost'] as const) {
      const changes = Reconciler.plan([waiting(), setup({ life })], listing([]))
      expect(forSession(changes, 'p')).toEqual([{
        kind: 'setup-failed',
        sessionId: 'p',
        reason: expect.stringContaining('setup session'),
      }])
    }
  })

  /*
   * The gate wants the pending pair as much as the general rule below it does. A record that waits
   * for a setup and names no launch cannot be started by any verdict, so judging its setup for ever
   * would be a session frozen in silence - invisible in the snapshot and in the log alike. It falls
   * through instead, to a rule that reads it for exactly what it is: starting, no runtime, no launch
   * it can name. Nothing writes that shape here; the file it is read from can hold it anyway.
   */
  it('loses a waiting record that names no launch of its own, however the setup went', () => {
    const changes = Reconciler.plan(
      [
        waiting({ pendingOperationId: undefined, pendingOperationKind: undefined }),
        setup({ life: 'ended', exitCode: 0, endedAt: 9_000 }),
      ],
      listing([]),
    )
    expect(changes).toEqual([{ kind: 'mark-lost', sessionId: 'p' }])
  })

  it('ends the waiting session when its setup record is gone entirely', () => {
    expect(Reconciler.plan([waiting()], listing([]))).toEqual([{
      kind: 'setup-failed',
      sessionId: 'p',
      reason: expect.stringContaining('gone'),
    }])
  })

  /*
   * Reality against the record: the Host has a runtime under the waiting session's OWN id, so the
   * general rules run and no setup is judged at all - even one that ended badly. It is the only way
   * out of a `pendingSetup` the world disagrees with, and the applier clears it as it goes.
   */
  it('runs the general rules when the waiting session has a runtime of its own', () => {
    const failed = setup({ life: 'ended', exitCode: 9, endedAt: 9_000 })
    expect(Reconciler.plan([waiting(), failed], listing([runtime('p')]))).toEqual([{
      kind: 'bind-live',
      sessionId: 'p',
      binding: { hostInstanceId: 'host-1', generation: 1 },
    }])
    expect(Reconciler.plan(
      [waiting(), failed],
      listing([runtime('p', { alive: false, exitCode: 0, exitedAt: 9_000 })]),
    )).toEqual([{ kind: 'mark-ended', sessionId: 'p', exitCode: 0, endedAt: 9_000 }])
  })

  it('changes nothing about a waiting session when the Host could not be reached', () => {
    expect(Reconciler.plan([waiting(), setup()], null)).toEqual([])
  })

  // Where a failed setup leaves its record: `pendingSetup` stays on it as the link a retry needs,
  // and it is inert there because every pass skips a record that has ended.
  it('never judges the setup of a record that has already ended or been lost', () => {
    const finished = setup({ life: 'ended', exitCode: 1, endedAt: 5 })
    for (const life of ['ended', 'lost'] as const)
      expect(Reconciler.plan([waiting({ life, endedAt: 5 }), finished], listing([]))).toEqual([])
  })

  describe('the merge resolver', () => {
    /** The rest of a pass is about other records; these tests are about the merge judgement alone. */
    function mergeChanges(changes: readonly ReconcileChange[]): readonly ReconcileChange[] {
      return changes.filter((change) => change.kind.startsWith('merge-resolve-'))
    }

    /** The record being merged is `ended`, which the general loop skips - hence a pass of its own. */
    it('judges a resolver even though the session it belongs to is ended', () => {
      const changes = Reconciler.plan(
        [merging(), resolver({ life: 'ended', exitCode: 0, pendingOperationId: undefined,
          pendingOperationKind: undefined })],
        listing([]),
      )

      expect(changes).toContainEqual({ kind: 'merge-resolve-succeeded', sessionId: 'm' })
    })

    it('says nothing about the merge while the resolver is still running', () => {
      expect(mergeChanges(Reconciler.plan([merging(), resolver()], listing([runtime('r')]))))
        .toEqual([])
    })

    it('reads a clean exit as resolved and any other as not', () => {
      expect(Reconciler.plan([merging(), resolver()], listing([runtime('r', { alive: false, exitCode: 0 })])))
        .toContainEqual({ kind: 'merge-resolve-succeeded', sessionId: 'm' })

      const failed = Reconciler.plan(
        [merging(), resolver()],
        listing([runtime('r', { alive: false, exitCode: 1 })]),
      )
      expect(failed).toContainEqual({
        kind: 'merge-resolve-failed',
        sessionId: 'm',
        reason: 'the resolver exited with 1',
      })
    })

    /** A stopped process is not a verdict on what it was doing; on POSIX it even reports 0. */
    it('reads a stopped resolver as a failure whatever it exited with', () => {
      const changes = Reconciler.plan(
        [merging(), resolver({ stopRequested: true })],
        listing([runtime('r', { alive: false, exitCode: 0 })]),
      )

      expect(changes).toContainEqual({
        kind: 'merge-resolve-failed',
        sessionId: 'm',
        reason: 'its resolver was stopped',
      })
    })

    /** The crash window between the pointer write and the launch. */
    it('reads a resolver whose record is gone as a failure, leaving the manual path', () => {
      expect(Reconciler.plan([merging()], listing([]))).toContainEqual({
        kind: 'merge-resolve-failed',
        sessionId: 'm',
        reason: 'its resolve session record is gone',
      })
    })

    /**
     * The resolver is `starting` with a pending pair and no runtime, so this pass is about replaying
     * ITS launch. Judging the merge now would end it over a launch being repeated as we speak.
     */
    it('waits while the resolver own launch is still being replayed', () => {
      const changes = Reconciler.plan([merging(), resolver()], listing([]))

      expect(mergeChanges(changes)).toEqual([])
      expect(changes).toContainEqual({
        kind: 'retry-launch',
        sessionId: 'r',
        operationId: 'op-r',
        operation: 'create',
      })
    })

    /** Judging again every two seconds would rewrite the same record for ever. */
    it('judges nothing once a failure is already written', () => {
      const decided = merging({
        worktreeMerge: {
          phase: 'resolving',
          resolveSessionId: 'r',
          startedAt: 1,
          failure: 'the resolver exited with 1',
        },
      })

      expect(mergeChanges(Reconciler.plan([decided], listing([])))).toEqual([])
    })

    it('judges nothing for a merge in any other phase', () => {
      for (const phase of ['base-merging', 'main-merging', 'tearing-down'] as const) {
        const other = merging({
          worktreeMerge: { phase, resolveSessionId: 'r', startedAt: 1 },
        })
        expect(mergeChanges(Reconciler.plan([other], listing([])))).toEqual([])
      }
    })
  })

  /**
   * Codex takes no id before it starts, so a `new` session only learns which conversation it is
   * having from the rollout it wrote. This decides when it is worth looking, and the whole of the
   * bound is data: the record's own fields and how old it is.
   */
  describe('naming a Codex conversation', () => {
    /** A live Codex session started fresh, young, with no id: the one shape worth looking for. */
    function codex(overrides?: Partial<SessionRecord>): SessionRecord {
      return record('c', {
        kind: 'agent',
        createdAt: Date.now() - 5_000,
        agent: { agentId: 'codex', launchMode: 'new' },
        ...overrides,
      })
    }

    function asks(records: readonly SessionRecord[]): ReconcileChange[] {
      return Reconciler.plan(records, listing([runtime('c')]))
        .filter((change) => change.kind === 'name-codex-conversation')
    }

    it('asks for a live Codex session that has never named its conversation', () => {
      expect(asks([codex()])).toEqual([{ kind: 'name-codex-conversation', sessionId: 'c' }])
    })

    it('stops asking once the record carries an id', () => {
      expect(asks([codex({
        agent: { agentId: 'codex', launchMode: 'new', nativeSessionId: 'conv-1' },
      })])).toEqual([])
    })

    /** Claude was given `--session-id` at launch, so there is nothing here to find out. */
    it('never asks for Claude', () => {
      expect(asks([codex({ agent: { agentId: 'claude', launchMode: 'new' } })]))
        .toEqual([])
    })

    it('never asks for a launch mode an id would not serve', () => {
      for (const launchMode of ['continue', 'resume'] as const)
        expect(asks([codex({ agent: { agentId: 'codex', launchMode } })]), launchMode)
          .toEqual([])
    })

    /** A fork starts a conversation of its own, and Codex names it in the rollout it writes. */
    it('asks for a live Codex fork that has not named its conversation', () => {
      expect(asks([codex({
        agent: { agentId: 'codex', launchMode: 'fork', forkParentId: 'conv-0' },
      })])).toEqual([{ kind: 'name-codex-conversation', sessionId: 'c' }])
    })

    it('stops asking once a fork carries an id, and once it is older than the window', () => {
      expect(asks([codex({
        agent: { agentId: 'codex', launchMode: 'fork', forkParentId: 'conv-0', nativeSessionId: 'conv-2' },
      })])).toEqual([])
      expect(asks([codex({
        createdAt: Date.now() - 400_000,
        agent: { agentId: 'codex', launchMode: 'fork', forkParentId: 'conv-0' },
      })])).toEqual([])
    })

    it('never asks for a shell session', () => {
      expect(asks([record('c')])).toEqual([])
    })

    /** The regular pass stops retrying after five minutes; startup recovery is a separate pass. */
    it('stops asking for a session older than the window', () => {
      expect(asks([codex({ createdAt: Date.now() - 400_000 })])).toEqual([])
    })

    /** The Host is the authority: what it does not have is not live, whatever the record says. */
    it('never asks for a record the Host has no runtime for', () => {
      expect(Reconciler.plan([codex()], listing([]))
        .filter((change) => change.kind === 'name-codex-conversation')).toEqual([])
    })
  })
})
