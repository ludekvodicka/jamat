import { describe, expect, it } from 'vitest'

import type { SessionRecord, SessionRecordScriptRun } from '../records/sessionRecord.types'
import { ScriptBadges } from './scriptBadges'

describe('lib-orchestrator/sessionManager/scripts/scriptBadges', () => {
  function record(sessionId: string, overrides?: Partial<SessionRecord>): SessionRecord {
    return {
      sessionId,
      kind: 'agent',
      title: `Session ${sessionId}`,
      directory: { mode: 'default' },
      binding: null,
      life: 'starting',
      createdAt: 1,
      ...overrides,
    }
  }

  function entry(runId: string, overrides?: Partial<SessionRecordScriptRun>): SessionRecordScriptRun {
    return {
      runId,
      phase: 'before',
      scriptId: 'setup',
      name: 'setup',
      title: `Setup ${runId}`,
      commands: ['pnpm install'],
      startedAt: 10_000,
      endedAt: 33_600,
      exitCode: 0,
      outcome: 'succeeded',
      log: { state: 'saved', bytes: 10, truncated: false },
      ...overrides,
    }
  }

  const install = record('s', {
    kind: 'shell',
    commands: [{ command: 'pnpm install', cwd: 'C:\\w' }],
    scriptOf: { sessionId: 'p', phase: 'before', scriptId: 'setup', name: 'setup' },
  })

  describe('words', () => {
    it('says what the before chain is doing, step by step', () => {
      const setup = { kind: 'setup' } as const
      const codegen = { kind: 'declared', name: 'codegen' } as const
      expect(ScriptBadges.of({ phase: 'before', state: 'running', step: setup, runId: 'r', commands: ['pnpm install'] }))
        .toEqual({
          phase: 'before',
          state: 'running',
          text: 'installing dependencies',
          title: 'Installing dependencies:\npnpm install',
          runId: 'r',
        })
      expect(ScriptBadges.of({ phase: 'before', state: 'running', step: codegen, runId: 'r', commands: [] }))
        .toMatchObject({ text: 'setup: codegen', title: 'Setup: codegen' })
      expect(ScriptBadges.of({ phase: 'before', state: 'failed', step: setup, runId: 'r', reason: null }))
        .toEqual({ phase: 'before', state: 'failed', text: 'setup failed', title: 'Setup failed', runId: 'r' })
      expect(ScriptBadges.of({ phase: 'before', state: 'failed', step: codegen, runId: 'r', reason: 'the script exited with 2' }))
        .toMatchObject({ text: 'setup failed: codegen', title: 'The script exited with 2' })
      expect(ScriptBadges.of({ phase: 'before', state: 'skipped', reason: 'the project declares an empty setup' }))
        .toEqual({
          phase: 'before',
          state: 'skipped',
          text: 'setup skipped',
          title: 'Setup skipped: the project declares an empty setup',
        })
      expect(ScriptBadges.of({ phase: 'before', state: 'succeeded', runId: 'h', durationMs: 23_600 }))
        .toEqual({ phase: 'before', state: 'succeeded', text: 'setup ✓ 23.6 s', title: 'Setup succeeded in 23.6 s', runId: 'h' })
    })

    it('says what the after chain is doing, and never names the install there', () => {
      const tests = { kind: 'declared', name: 'tests' } as const
      expect(ScriptBadges.of({ phase: 'after', state: 'running', step: tests, runId: 'r', commands: ['pnpm test'] }))
        .toMatchObject({ phase: 'after', state: 'running', text: 'checks: tests', runId: 'r' })
      expect(ScriptBadges.of({ phase: 'after', state: 'failed', step: tests, runId: 'r', reason: null }))
        .toMatchObject({ phase: 'after', state: 'failed', text: 'checks failed: tests', runId: 'r' })
      expect(ScriptBadges.of({ phase: 'after', state: 'succeeded', runId: 'h', durationMs: 72_000 }))
        .toMatchObject({ phase: 'after', state: 'succeeded', text: 'checks ✓ 1 min 12 s', runId: 'h' })
      expect(() => ScriptBadges.of({ phase: 'after', state: 'running', step: { kind: 'setup' }, runId: 'r', commands: [] }))
        .toThrow('never runs after')
    })

    it('composes the menu line without elapsed time while a run runs', () => {
      expect(ScriptBadges.summaryOf({ title: 'Setup i12-x', state: 'failed', exitCode: 1, durationText: '24.0 s' }))
        .toBe('Setup i12-x · failed · exit 1 · 24.0 s')
      expect(ScriptBadges.summaryOf({ title: 'Setup i12-x', state: 'running' })).toBe('Setup i12-x · running')
      expect(ScriptBadges.summaryOf({ title: 'Setup i12-x', state: 'succeeded', exitCode: 0, durationText: '3.0 s' }))
        .toBe('Setup i12-x · succeeded · 3.0 s')
      // A stopped run's code is whatever a kill reports.
      expect(ScriptBadges.summaryOf({ title: 'Setup i12-x', state: 'stopped', exitCode: 1, durationText: '3.0 s' }))
        .toBe('Setup i12-x · stopped · 3.0 s')
    })
  })

  describe('the before chain of a parent', () => {
    it('is running while the parent starts behind its gate', () => {
      const parent = record('p', { pendingSetup: { setupSessionId: 's' } })
      expect(ScriptBadges.beforeOf(parent, install)).toEqual({
        phase: 'before',
        state: 'running',
        step: { kind: 'setup' },
        runId: 's',
        commands: ['pnpm install'],
      })
    })

    it('has failed once the parent ended with its gate, in the words of the settled entry when there is one', () => {
      const parent = record('p', {
        life: 'ended',
        pendingSetup: { setupSessionId: 's' },
        endedReason: 'setup failed: the setup exited with 7',
      })
      expect(ScriptBadges.beforeOf(parent, install)).toMatchObject({ state: 'failed', runId: 's', reason: 'setup failed: the setup exited with 7' })
      const settled = { ...parent, scriptRuns: [entry('s', { outcome: 'failed', exitCode: 7, reason: 'the setup exited with 7' })] }
      expect(ScriptBadges.beforeOf(settled, install)).toMatchObject({ state: 'failed', reason: 'the setup exited with 7' })
      expect(ScriptBadges.beforeOf({ ...parent, life: 'lost', endedReason: undefined }, null))
        .toMatchObject({ state: 'failed', step: { kind: 'setup' }, reason: null })
    })

    it('names the declared step the gate waits on, running and failed', () => {
      const codegen = record('c', {
        kind: 'shell',
        commands: [{ command: 'pnpm codegen', cwd: 'C:\\w' }],
        scriptOf: { sessionId: 'p', phase: 'before', scriptId: 'declared', name: 'codegen', stepKey: 'k2' },
      })
      const parent = record('p', { pendingSetup: { setupSessionId: 'c' } })
      expect(ScriptBadges.of(ScriptBadges.beforeOf(parent, codegen) ?? fail()))
        .toMatchObject({ state: 'running', text: 'setup: codegen', runId: 'c' })
      const failed = { ...parent, life: 'ended' as const, endedReason: 'setup failed: the codegen script exited with 2' }
      expect(ScriptBadges.of(ScriptBadges.beforeOf(failed, codegen) ?? fail()))
        .toMatchObject({ state: 'failed', text: 'setup failed: codegen', title: 'Setup failed: the codegen script exited with 2' })
    })

    it('says nothing for a live parent that still carries the gate', () => {
      expect(ScriptBadges.beforeOf(record('p', { life: 'live', pendingSetup: { setupSessionId: 's' } }), install)).toBeNull()
    })

    it('has succeeded with the chain duration and the newest entry, summed over the steps of every attempt', () => {
      const parent = record('p', {
        life: 'live',
        scriptRuns: [
          entry('a', { startedAt: 0, endedAt: 20_000, stepKey: 'k-setup' }),
          entry('b', { scriptId: 'setup', name: 'codegen', stepKey: 'k-codegen', startedAt: 20_000, endedAt: 21_000, outcome: 'failed', exitCode: 1 }),
          entry('c', { scriptId: 'setup', name: 'codegen', stepKey: 'k-codegen', startedAt: 30_000, endedAt: 33_600 }),
          entry('r', { phase: 'after', scriptId: 'merge-resolve', name: 'resolver', startedAt: 40_000, endedAt: 50_000 }),
        ],
      })
      expect(ScriptBadges.beforeOf(parent, null)).toEqual({ phase: 'before', state: 'succeeded', runId: 'c', durationMs: 23_600 })
      expect(ScriptBadges.of(ScriptBadges.beforeOf(parent, null) ?? fail())).toMatchObject({ text: 'setup ✓ 23.6 s', runId: 'c' })
    })

    it('was skipped when nothing ran, and when the last attempt failed before a retry skipped it', () => {
      const skipped = { reason: 'nobody knows how to install this project' }
      expect(ScriptBadges.beforeOf(record('p', { life: 'live', setupSkipped: skipped }), null))
        .toEqual({ phase: 'before', state: 'skipped', reason: skipped.reason })
      const retried = record('p', {
        life: 'live',
        setupSkipped: skipped,
        scriptRuns: [entry('a', { outcome: 'failed', exitCode: 1 })],
      })
      expect(ScriptBadges.beforeOf(retried, null)).toMatchObject({ state: 'skipped' })
    })

    it('has nothing to say about a session that never had a before chain', () => {
      expect(ScriptBadges.beforeOf(record('p', { life: 'live' }), null)).toBeNull()
    })
  })

  describe('the after chain of a parent', () => {
    const steps = [
      { key: 'k1', scriptId: 'declared' as const, name: 'lint', commands: [{ command: 'pnpm lint', cwd: 'C:\\w' }] },
      { key: 'k2', scriptId: 'declared' as const, name: 'tests', commands: [{ command: 'pnpm test', cwd: 'C:\\w' }] },
    ]
    const finishing = (overrides?: Partial<NonNullable<SessionRecord['finishChecks']>>, history?: SessionRecordScriptRun[]) =>
      record('p', { life: 'ended', scriptRuns: history, finishChecks: { runId: 't', steps, cursor: 1, startedAt: 20_000, ...overrides } })

    it('runs, fails and passes in the words of the check its cursor names', () => {
      expect(ScriptBadges.of(ScriptBadges.afterOf(finishing(), null)!))
        .toEqual({ phase: 'after', state: 'running', text: 'checks: tests', title: 'Checks: tests:\npnpm test', runId: 't' })
      expect(ScriptBadges.of(ScriptBadges.afterOf(finishing({ result: { kind: 'failed', reason: 'the tests check exited with 1', at: 30_000 } }), null)!))
        .toEqual({ phase: 'after', state: 'failed', text: 'checks failed: tests', title: 'The tests check exited with 1', runId: 't' })
      const history = [
        entry('old', { phase: 'after', scriptId: 'declared', name: 'tests', stepKey: 'k2', startedAt: 1_000, endedAt: 9_000 }),
        entry('l', { phase: 'after', scriptId: 'declared', name: 'lint', stepKey: 'k1', startedAt: 20_000, endedAt: 21_000 }),
        entry('t', { phase: 'after', scriptId: 'declared', name: 'tests', stepKey: 'k2', startedAt: 21_000, endedAt: 23_500 }),
      ]
      expect(ScriptBadges.of(ScriptBadges.afterOf(finishing({ result: { kind: 'passed', at: 24_000 } }, history), null)!))
        .toEqual({ phase: 'after', state: 'succeeded', text: 'checks ✓ 3.5 s', title: 'Checks passed in 3.5 s', runId: 't' })
    })

    it('has nothing to say without a chain, or for a pass whose runs have not settled yet', () => {
      expect(ScriptBadges.afterOf(record('p', { life: 'ended' }), null)).toBe(null)
      expect(ScriptBadges.afterOf(finishing({ result: { kind: 'passed', at: 24_000 } }), null)).toBe(null)
    })
  })

  describe('an older peer', () => {
    it('turns its legacy setup into the badge and the run its parent waits on', () => {
      expect(ScriptBadges.legacyOf({ state: 'running', setupSessionId: 's', commands: ['pnpm install'] })).toEqual({
        runs: [],
        badge: {
          phase: 'before',
          state: 'running',
          text: 'installing dependencies',
          title: 'Installing dependencies:\npnpm install',
          runId: 's',
        },
        waitingOn: 's',
      })
      expect(ScriptBadges.legacyOf({ state: 'failed', setupSessionId: 's', commands: [] }))
        .toEqual({ runs: [], badge: { phase: 'before', state: 'failed', text: 'setup failed', title: 'Setup failed', runId: 's' } })
      expect(ScriptBadges.legacyOf({ state: 'skipped', reason: 'none' }).badge).toMatchObject({ state: 'skipped', text: 'setup skipped' })
    })
  })

  function fail(): never {
    throw new Error('expected a badge')
  }

  describe('the checks of an SVN action', () => {
    const check = { key: 'k', scriptId: 'checks' as const, name: 'tests', commands: [{ command: 'pnpm test', cwd: 'C:\\w' }] }
    const acting = (overrides?: Partial<NonNullable<SessionRecord['svnAction']>>): SessionRecord => record('p', {
      life: 'ended',
      svnAction: {
        kind: 'finish', actionId: 'a', stage: 'checks', runId: 'c', root: 'C:\\w', checks: [check], checkCursor: 0, rootCursor: 0,
        rounds: { incoming: 0, outOfDate: 0, lock: 0 }, evidence: [], requestedBy: 'window', startedAt: 1, ...overrides,
      },
    })

    it('says which check runs, and which one the action waits on after it failed', () => {
      expect(ScriptBadges.of(ScriptBadges.actionOf(acting(), null)!))
        .toEqual({ phase: 'after', state: 'running', text: 'checks: tests', title: 'Checks: tests:\npnpm test', runId: 'c' })
      expect(ScriptBadges.of(ScriptBadges.actionOf(acting({ needs: { kind: 'check-failed', reason: 'the check tests failed (exit 1)', at: 2 } }), null)!))
        .toEqual({ phase: 'after', state: 'failed', text: 'checks failed: tests', title: 'The check tests failed (exit 1)', runId: 'c' })
    })

    it('says nothing in another stage, for another reason to wait, or without an action', () => {
      expect(ScriptBadges.actionOf(acting({ stage: 'reviewing' }), null)).toBe(null)
      expect(ScriptBadges.actionOf(acting({ needs: { kind: 'locked', reason: 'x', at: 2 } }), null)).toBe(null)
      expect(ScriptBadges.actionOf(record('p'), null)).toBe(null)
    })

    it('names the checkout of an SVN worktree in the before ladder, and refuses a review run there', () => {
      const run = (scriptId: 'svn' | 'review') => record('r', {
        scriptOf: { sessionId: 'p', phase: 'before', scriptId, name: 'checkout' },
        process: { tool: 'svn', args: ['checkout', '-q', '--', 'file:///r@41', '.'] },
      })
      const waiting = record('p', { life: 'starting', pendingSetup: { setupSessionId: 'r' } })
      expect(ScriptBadges.beforeOf(waiting, run('svn'))).toMatchObject({ state: 'running', step: { kind: 'checkout' } })
      expect(ScriptBadges.of({ phase: 'before', state: 'running', step: { kind: 'checkout' }, runId: 'r', commands: ['svn checkout'] }))
        .toMatchObject({ text: 'checking out', title: 'Checking out:\nsvn checkout' })
      expect(ScriptBadges.of({ phase: 'before', state: 'failed', step: { kind: 'checkout' }, runId: 'r', reason: null }))
        .toMatchObject({ text: 'checkout failed' })
      expect(() => ScriptBadges.beforeOf(waiting, run('review'))).toThrow(/carries no badge/)
    })
  })
})
