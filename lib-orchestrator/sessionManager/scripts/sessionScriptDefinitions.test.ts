import { describe, expect, it } from 'vitest'

import type { SessionRecord } from '../records/sessionRecord.types'
import { SessionScriptDefinitions } from './sessionScriptDefinitions'

describe('lib-orchestrator/sessionManager/scripts/sessionScriptDefinitions', () => {
  function record(overrides?: Partial<SessionRecord>): SessionRecord {
    return {
      sessionId: 'p',
      kind: 'shell',
      title: 'p',
      directory: { mode: 'default' },
      binding: null,
      life: 'starting',
      createdAt: 1,
      ...overrides,
    }
  }

  const waiting = record({
    pendingOperationId: 'op-p',
    pendingOperationKind: 'create',
    pendingSetup: { setupSessionId: 's' },
  })
  const resolving = record({
    life: 'ended',
    worktreeMerge: { phase: 'resolving', resolveSessionId: 'r', startedAt: 1 },
  })

  it('answers the setup and the resolver with their gate and their words', () => {
    expect(SessionScriptDefinitions.of({ phase: 'before', scriptId: 'setup' })).toEqual(expect.objectContaining({
      gate: 'before',
      words: { session: 'setup', actor: 'setup' },
      handoff: 'parent-tab',
    }))
    expect(SessionScriptDefinitions.of({ phase: 'after', scriptId: 'merge-resolve' })).toEqual(expect.objectContaining({
      gate: 'merge',
      words: { session: 'resolve', actor: 'resolver' },
      handoff: 'close',
    }))
  })

  it('answers a requested run with no gate, no replay and a stop with its parent', () => {
    expect(SessionScriptDefinitions.of({ phase: 'inner', scriptId: 'requested' })).toEqual(expect.objectContaining({
      gate: null,
      words: { session: 'run', actor: 'run' },
      replayable: false,
      stopsWithParent: true,
      handoff: 'close',
    }))
    expect(SessionScriptDefinitions.linkOf('p', 'inner', 'requested', 'tests'))
      .toEqual({ sessionId: 'p', phase: 'inner', scriptId: 'requested', name: 'tests' })
    expect(SessionScriptDefinitions.wordsOf({ phase: 'inner', scriptId: 'requested', name: 'tests' }))
      .toEqual({ session: 'run', actor: 'run' })
    // No parent field names a requested run, so no gate of any parent yields one.
    expect(SessionScriptDefinitions.gatesOf(record({ life: 'live' }))).toEqual([])
  })

  it('draws a live line for the seven scripted kinds and never for the resolvers or the review', () => {
    const live = [
      ['before', 'setup'], ['before', 'declared'], ['before', 'svn'], ['after', 'declared'],
      ['after', 'checks'], ['after', 'svn'], ['inner', 'requested'],
    ] as const
    const silent = [['after', 'merge-resolve'], ['after', 'svn-resolve'], ['after', 'svn-merge'], ['after', 'review']] as const
    for (const [phase, scriptId] of live) expect(SessionScriptDefinitions.of({ phase, scriptId }).liveLine).toBe(true)
    for (const [phase, scriptId] of silent) expect(SessionScriptDefinitions.of({ phase, scriptId }).liveLine).toBe(false)
  })

  it('knows the SVN merger as a replayable run of the action gate whose tab closes, named merge and merger', () => {
    expect(SessionScriptDefinitions.of({ phase: 'after', scriptId: 'svn-merge' })).toEqual(expect.objectContaining({
      gate: 'action', replayable: true, stopsWithParent: false, handoff: 'close', liveLine: false,
    }))
    expect(SessionScriptDefinitions.wordsOf({ phase: 'after', scriptId: 'svn-merge', name: 'merger' })).toEqual({ session: 'merge', actor: 'merger' })
    expect(SessionScriptDefinitions.linkOf('p', 'after', 'svn-merge', 'merger')).toEqual({ sessionId: 'p', phase: 'after', scriptId: 'svn-merge', name: 'merger' })
  })

  it('throws on a pair no definition answers, and says it does not know it', () => {
    for (const link of [
      { phase: 'after', scriptId: 'setup' },
      { phase: 'before', scriptId: 'merge-resolve' },
      { phase: 'before', scriptId: 'requested' },
      { phase: 'inner', scriptId: 'setup' },
    ] as const) {
      expect(() => SessionScriptDefinitions.of(link)).toThrow(`Unknown script: "${link.phase}/${link.scriptId}"`)
      expect(SessionScriptDefinitions.known(link)).toBe(false)
    }
    expect(SessionScriptDefinitions.known({ phase: 'before', scriptId: 'setup' })).toBe(true)
  })

  it('builds the link a flow writes, and refuses one for a pair no definition answers', () => {
    expect(SessionScriptDefinitions.linkOf('p', 'after', 'merge-resolve', 'resolver'))
      .toEqual({ sessionId: 'p', phase: 'after', scriptId: 'merge-resolve', name: 'resolver' })
    expect(() => SessionScriptDefinitions.linkOf('p', 'before', 'merge-resolve', 'resolver'))
      .toThrow('Unknown script: "before/merge-resolve"')
  })

  it('reads the run each gate names off the parent, and nothing where it names none', () => {
    expect(SessionScriptDefinitions.gatesOf(waiting).map(({ gate, runId }) => ({ gate, runId })))
      .toEqual([{ gate: 'before', runId: 's' }])
    expect(SessionScriptDefinitions.gatesOf(resolving).map(({ gate, runId }) => ({ gate, runId })))
      .toEqual([{ gate: 'merge', runId: 'r' }])
    expect(SessionScriptDefinitions.gatesOf(record())).toEqual([])
    // A manual conflict has the phase and no pointer.
    expect(SessionScriptDefinitions.gatesOf(record({ worktreeMerge: { phase: 'resolving', startedAt: 1 } })))
      .toEqual([])
  })

  it('yields the before gate once for a chain, with the definition and words of the step its cursor names', () => {
    const commands = [{ command: 'pnpm codegen', cwd: '/w' }]
    const chain = record({
      ...waiting,
      pendingSetup: {
        setupSessionId: 'c',
        steps: [
          { key: 'k1', scriptId: 'setup', name: 'setup', commands },
          { key: 'k2', scriptId: 'declared', name: 'codegen', commands },
        ],
        cursor: 1,
      },
    })
    const gates = SessionScriptDefinitions.gatesOf(chain)
    expect(gates).toHaveLength(1)
    expect(gates[0]).toMatchObject({
      gate: 'before',
      runId: 'c',
      definition: { phase: 'before', scriptId: 'declared' },
      words: { session: 'codegen script', actor: 'codegen script' },
    })
    // A wait written before chains existed is one setup step.
    expect(SessionScriptDefinitions.gatesOf(waiting)[0])
      .toMatchObject({ definition: { scriptId: 'setup' }, words: { session: 'setup', actor: 'setup' } })
  })

  it('names a declared step by its entry, and carries a chain step key on the link', () => {
    expect(SessionScriptDefinitions.wordsOf({ phase: 'before', scriptId: 'declared', name: 'lint' }))
      .toEqual({ session: 'lint script', actor: 'lint script' })
    expect(SessionScriptDefinitions.wordsOf({ phase: 'before', scriptId: 'setup', name: 'setup' }))
      .toEqual({ session: 'setup', actor: 'setup' })
    expect(SessionScriptDefinitions.linkOf('p', 'before', 'declared', 'lint', 'k2'))
      .toEqual({ sessionId: 'p', phase: 'before', scriptId: 'declared', name: 'lint', stepKey: 'k2' })
  })

  it('judges the before gate only for a starting record with its whole pending pair', () => {
    expect(SessionScriptDefinitions.judging('before', waiting)).toBe(true)
    expect(SessionScriptDefinitions.judging('before', { ...waiting, pendingOperationKind: undefined })).toBe(false)
    expect(SessionScriptDefinitions.judging('before', { ...waiting, pendingOperationId: undefined })).toBe(false)
    expect(SessionScriptDefinitions.judging('before', { ...waiting, pendingSetup: undefined })).toBe(false)
    for (const life of ['live', 'ended', 'lost'] as const)
      expect(SessionScriptDefinitions.judging('before', { ...waiting, life }), life).toBe(false)
  })

  it('reads the after chain of a Finish as the finish gate, in the words of the check its cursor names', () => {
    const commands = [{ command: 'pnpm test', cwd: '/w' }]
    const steps = [
      { key: 'k1', scriptId: 'declared' as const, name: 'lint', commands },
      { key: 'k2', scriptId: 'declared' as const, name: 'tests', commands },
    ]
    const finishing = record({ life: 'ended', finishChecks: { runId: 't', steps, cursor: 1, startedAt: 1 } })
    expect(SessionScriptDefinitions.of({ phase: 'after', scriptId: 'declared' }))
      .toEqual(expect.objectContaining({ gate: 'finish', words: { session: 'check', actor: 'check' }, handoff: 'close' }))
    expect(SessionScriptDefinitions.gatesOf(finishing)).toEqual([expect.objectContaining({
      gate: 'finish',
      runId: 't',
      definition: expect.objectContaining({ phase: 'after', scriptId: 'declared' }),
      words: { session: 'tests check', actor: 'tests check' },
    })])
    expect(SessionScriptDefinitions.judging('finish', finishing)).toBe(true)
    expect(SessionScriptDefinitions.judging('finish', record({
      life: 'ended',
      finishChecks: { runId: 't', steps, cursor: 1, startedAt: 1, result: { kind: 'passed', at: 2 } },
    }))).toBe(false)
    expect(SessionScriptDefinitions.judging('finish', record({ life: 'ended' }))).toBe(false)
  })

  it('judges the merge gate while resolving with a pointer and no failure written', () => {
    expect(SessionScriptDefinitions.judging('merge', resolving)).toBe(true)
    expect(SessionScriptDefinitions.judging('merge', record({
      worktreeMerge: { phase: 'resolving', resolveSessionId: 'r', startedAt: 1, failure: 'the resolver ended with 1' },
    }))).toBe(false)
    expect(SessionScriptDefinitions.judging('merge', record({
      worktreeMerge: { phase: 'resolving', startedAt: 1 },
    }))).toBe(false)
    for (const phase of ['base-merging', 'main-merging', 'tearing-down'] as const)
      expect(SessionScriptDefinitions.judging('merge', record({
        worktreeMerge: { phase, resolveSessionId: 'r', startedAt: 1 },
      })), phase).toBe(false)
  })

  describe('the runs of an SVN action', () => {
    const check = { key: 'k', scriptId: 'checks' as const, name: 'tests', commands: [{ command: 'pnpm test', cwd: 'C:/w' }] }
    const acting = (overrides?: Partial<NonNullable<SessionRecord['svnAction']>>): SessionRecord => record({
      life: 'ended',
      svnAction: {
        kind: 'finish', actionId: 'a', stage: 'checks', runId: 'c', root: 'C:/w', checks: [check], checkCursor: 0,
        roots: [{ path: 'C:/w/lib', own: 'lib', changed: ['lib/x'] }], rootCursor: 0,
        rounds: { incoming: 0, outOfDate: 0, lock: 0 }, evidence: [], requestedBy: 'window', startedAt: 1, ...overrides,
      },
    })

    it('waits on the run of a run stage through one action gate, named by its step', () => {
      expect(SessionScriptDefinitions.gatesOf(acting())).toEqual([expect.objectContaining({
        gate: 'action', runId: 'c', words: { session: 'tests check', actor: 'tests check' },
        definition: expect.objectContaining({ phase: 'after', scriptId: 'checks', replayable: true, handoff: 'close' }),
      })])
      expect(SessionScriptDefinitions.gatesOf(acting({ stage: 'updating' }))[0]?.words).toEqual({ session: 'svn update', actor: 'svn update' })
      expect(SessionScriptDefinitions.gatesOf(acting({ stage: 'cleaning' }))[0]?.words).toEqual({ session: 'svn cleanup', actor: 'svn cleanup' })
      expect(SessionScriptDefinitions.gatesOf(acting({ stage: 'reviewing' }))[0]?.words).toEqual({ session: 'review', actor: 'review' })
      expect(SessionScriptDefinitions.gatesOf(acting({ stage: 'resolving' }))[0]).toEqual(expect.objectContaining({
        runId: 'c', words: { session: 'resolve', actor: 'resolver' },
        definition: expect.objectContaining({ phase: 'after', scriptId: 'svn-resolve', gate: 'action', replayable: true, handoff: 'close' }),
      }))
      expect(SessionScriptDefinitions.judging('action', acting())).toBe(true)
      // The merger judges through the same gate and its run nests under the parent.
      const merging = acting({ stage: 'merging', runId: 'm', merger: { runId: 'm', setAt: 1, startedAt: 1 } })
      expect(SessionScriptDefinitions.gatesOf(merging)).toEqual([expect.objectContaining({
        gate: 'action', runId: 'm', words: { session: 'merge', actor: 'merger' },
        definition: expect.objectContaining({ phase: 'after', scriptId: 'svn-merge', replayable: true, handoff: 'close' }),
      })])
      expect(SessionScriptDefinitions.judging('action', merging)).toBe(true)
      expect(SessionScriptDefinitions.awaitsVerdictOf('m', { sessionId: 's', phase: 'after', scriptId: 'svn-merge', name: 'merger' }, merging)).toBe(true)
    })

    it('names no run in a client stage and judges none once a verdict, a wait or a relaunch is written', () => {
      for (const stage of ['stopping', 'evidence', 'verifying', 'removing', 'recording'] as const)
        expect(SessionScriptDefinitions.gatesOf(acting({ stage })), stage).toEqual([])
      expect(SessionScriptDefinitions.judging('action', acting({ verdict: { kind: 'succeeded' } }))).toBe(false)
      expect(SessionScriptDefinitions.judging('action', acting({ needs: { kind: 'check-failed', reason: 'x', at: 2 } }))).toBe(false)
      expect(SessionScriptDefinitions.judging('action', acting({ stage: 'updating', retryAt: 9 }))).toBe(false)
      expect(SessionScriptDefinitions.judging('action', record({ life: 'ended' }))).toBe(false)
      // A failed run its action still names is what the session waits on, so Remove is not offered.
      const failed = acting({ needs: { kind: 'check-failed', reason: 'x', at: 2 } })
      expect(SessionScriptDefinitions.awaitsVerdictOf('c', { sessionId: 'p', phase: 'after', scriptId: 'checks', name: 'tests' }, acting())).toBe(true)
      expect(SessionScriptDefinitions.awaitsVerdictOf('c', { sessionId: 'p', phase: 'after', scriptId: 'checks', name: 'tests' }, failed)).toBe(false)
    })
  })
})
