import { describe, expect, it } from 'vitest'

import type { SessionRecord } from '../records/sessionRecord.types'
import type { SessionScriptRunInfo } from '../sessionManagerApi.types'
import { SessionWorkflows } from './sessionWorkflows'

describe('Session actions sections', () => {
  it('keeps completed setup before a waiting Finish and preserves the current workflow', () => {
    const record: SessionRecord = {
      sessionId: 's1', title: 'Work', kind: 'agent', directory: { mode: 'adHoc', path: 'Q:/Work' },
      life: 'ended', binding: null, createdAt: 0,
      scriptRuns: [{ runId: 'checkout', phase: 'before', scriptId: 'svn', name: 'checkout', title: 'Checkout',
        commands: [], startedAt: 1, endedAt: 2, outcome: 'succeeded', log: { state: 'saved', bytes: 1, truncated: false } }],
      svnAction: { kind: 'finish', actionId: 'a1', stage: 'updating', root: 'Q:/Work', checks: [], checkCursor: 0,
        rootCursor: 0, rounds: { incoming: 0, outOfDate: 0, lock: 0 }, evidence: [], requestedBy: 'window', startedAt: 3,
        needs: { kind: 'conflict', reason: 'Resolve the conflict', at: 4 } },
    }
    const sections = SessionWorkflows.sectionsOf(record, () => null)
    expect(sections.map((section) => section.kind)).toEqual(['before', 'finish'])
    expect(sections[0]).toMatchObject({ open: false, rounds: [{ steps: [{ state: 'done', target: { kind: 'run', runId: 'checkout' } }] }] })
    expect(sections[1]).toEqual(SessionWorkflows.of(record, () => null))
    expect(sections[1].open).toBe(true)
  })
  // A worker lost outside a Finish had no section: the person saw only "exit 1" and no choice (UA1-J14R-1).
  it('shows a worker lost outside a Finish as an open section with the person\'s choices', () => {
    const record: SessionRecord = {
      sessionId: 's1', title: 'Work', kind: 'agent', directory: { mode: 'adHoc', path: 'Q:/Work' }, life: 'ended', binding: null, createdAt: 0,
      worktree: { kind: 'svn', worktreePath: 'Q:/Work/.worktrees/w', repositoryRoot: 'Q:/Work', branch: 'url', baseCommit: 'r1' },
      worktreeLifecycle: { version: 3, actionId: null, phase: 'waiting', wait: { kind: 'worker-lost', reason: 'The worker could not resume twice.', at: 9 },
        outOfDate: 0, journal: [], facts: { worker: { liveness: 'dead', resumeFailures: 2 } } },
    }
    const sections = SessionWorkflows.sectionsOf(record, () => null)
    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({ kind: 'finish', open: true, badge: 'Worker needs to be resumed', summary: 'Waits for you: The worker could not resume twice.',
      rounds: [{ steps: [{ state: 'waits', detail: 'The worker could not resume twice.' }] }] })
    expect(sections[0].actions.map((action) => action.id)).toEqual(['resume-worker', 'open-in-vscode', 'keep', 'discard'])
    expect(SessionWorkflows.sectionsOf({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'active', wait: undefined } }, () => null)).toEqual([])
  })
  it('retains failed setup history for a kept worktree while an ordinary ended session expires', () => {
    const ended: SessionRecord = { sessionId: 'ordinary', kind: 'shell', title: 'Ended', directory: { mode: 'default' },
      life: 'ended', binding: null, createdAt: 1 }
    const setup: SessionRecord = { ...ended, sessionId: 'setup', pendingSetup: { setupSessionId: 'failed' },
      worktree: { worktreePath: 'C:/work/.worktrees/fix', repositoryRoot: 'C:/work', branch: 'jamat/fix', baseCommit: 'base' } }
    const run: SessionRecord = { ...ended, sessionId: 'failed', exitCode: 7,
      scriptOf: { sessionId: 'setup', phase: 'before', scriptId: 'setup', name: 'setup' } }
    expect(SessionWorkflows.endedHistoryOf([ended, setup, run])).toEqual(new Set(['ordinary', 'failed']))
    expect(SessionWorkflows.holdsWorktreeHistory(setup)).toBe(true)
    expect(SessionWorkflows.holdsWorktreeHistory(ended)).toBe(false)
  })

  it('retains journal-backed and kept-outcome history after the worktree pointer is gone', () => {
    const ended: SessionRecord = { sessionId: 'journal', kind: 'shell', title: 'Ended', directory: { mode: 'default' },
      life: 'ended', binding: null, createdAt: 1,
      worktreeLifecycle: { version: 1, actionId: 'finish', phase: 'landed', outOfDate: 0,
        journal: [{ stepId: 'commit', kind: 'commit', attempt: 1, startedAt: 1, endedAt: 2, outcome: 'ok', runId: 'commit' }],
        facts: { worker: { liveness: 'stopped', resumeFailures: 0 } } } }
    const kept: SessionRecord = { ...ended, sessionId: 'kept', worktreeLifecycle: undefined,
      worktreeOutcome: { result: 'failed', revisions: [], main: 'none', worktree: 'kept', lines: [], at: 2 } }
    expect(SessionWorkflows.endedHistoryOf([ended, kept])).toEqual(new Set())
  })

  it('shows a requested run that was stopped as stopped, not failed', () => {
    const record: SessionRecord = { sessionId: 's1', title: 'Work', kind: 'agent', directory: { mode: 'adHoc', path: 'Q:/Work' },
      life: 'ended', binding: null, createdAt: 0,
      scriptRuns: (['stopped', 'failed'] as const).map((outcome) => ({ runId: outcome, phase: 'inner' as const, scriptId: 'requested' as const,
        name: 'validation', title: 'Worktree validation', commands: [], startedAt: 1, endedAt: 2, outcome,
        log: { state: 'saved' as const, bytes: 1, truncated: false } })) }
    const steps = SessionWorkflows.sectionsOf(record, () => null).filter((section) => section.kind === 'script')
      .map((section) => [section.badge, section.rounds[0].steps[0].state])
    expect(steps).toEqual([['stopped', 'skipped'], ['failed', 'failed']])
  })

  it('offers Stop on a requested run while it runs and on the validation of the prepared worktree', () => {
    const execution = { root: 'Q:/app/.worktrees/001', checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window' as const, startedAt: 3 }
    const record: SessionRecord = { sessionId: 's1', title: 'Work', kind: 'agent', directory: { mode: 'adHoc', path: 'Q:/app' },
      life: 'live', binding: null, createdAt: 0,
      worktreeLifecycle: { version: 1, actionId: 'f1', phase: 'waiting', step: 'reviewing', outOfDate: 0, journal: [], execution,
        facts: { worker: { liveness: 'alive', resumeFailures: 0 } },
        wait: { kind: 'waiting-for-review', reason: 'Ready for validation in Session actions', at: 4 } } }
    const run = (runId: string, state: 'running' | 'stopped'): SessionScriptRunInfo => ({ runId, phase: 'inner', scriptId: 'requested', name: 'Worktree validation',
      title: 'Worktree validation', state, summary: 'Worktree validation', startedAt: 5, commands: [], row: state === 'running', log: 'none' })
    const sections = SessionWorkflows.sectionsOf(record, () => null, undefined, [run('v1', 'running'), run('v0', 'stopped')])
    const stop = { id: 'stop-run', label: 'Stop', primary: false, runId: 'v1' }
    expect(sections.find((section) => section.workflowId === 'script:v1')?.actions).toEqual([stop])
    expect(sections.find((section) => section.workflowId === 'script:v0')?.actions).toEqual([])
    expect(sections.find((section) => section.validation !== undefined)?.validation?.runs)
      .toEqual([{ runId: 'v1', title: 'Worktree validation', startedAt: 5, stop }])
  })

  // A failed run of an old Host instance stayed as a section with no press while its parent had actions (UA1-J10-8).
  it('offers Remove on an ended requested run whose row remains, the same removal the CLI makes', () => {
    const record: SessionRecord = { sessionId: 's1', title: 'Work', kind: 'agent', directory: { mode: 'adHoc', path: 'Q:/app' },
      life: 'live', binding: null, createdAt: 0 }
    const run = (runId: string, state: 'failed' | 'lost' | 'succeeded', row: boolean): SessionScriptRunInfo => ({ runId, phase: 'inner',
      scriptId: 'requested', name: 'j10-requested-fail', title: 'j10-requested-fail', state, summary: 'exit 1', startedAt: 5, endedAt: 6,
      commands: [], row, log: 'saved' })
    const sections = SessionWorkflows.sectionsOf(record, () => null, undefined, [run('r1', 'failed', true), run('r2', 'lost', true), run('r3', 'succeeded', false)])
    const remove = (runId: string) => [{ id: 'remove-run', label: 'Remove', primary: false, runId }]
    expect(sections.find((section) => section.workflowId === 'script:r1')?.actions).toEqual(remove('r1'))
    expect(sections.find((section) => section.workflowId === 'script:r2')?.actions).toEqual(remove('r2'))
    expect(sections.find((section) => section.workflowId === 'script:r3')?.actions).toEqual([])
  })

  it('offers Discard and a new preparation on the outcome of a kept worktree, and nothing once it is gone (UA1-J07-7)', () => {
    const execution = { root: 'Q:/app/.worktrees/002', checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window' as const, startedAt: 3 }
    const record: SessionRecord = { sessionId: 's2', title: 'Work', kind: 'agent', directory: { mode: 'adHoc', path: 'Q:/app' },
      life: 'live', binding: null, createdAt: 0,
      worktree: { kind: 'svn', worktreePath: 'Q:/app/.worktrees/002', repositoryRoot: 'Q:/app', branch: '', baseCommit: '4' },
      worktreeLifecycle: { version: 3, actionId: 'f2', phase: 'kept', outOfDate: 0, journal: [], execution,
        facts: { worker: { liveness: 'alive', resumeFailures: 0 } },
        publication: { revisions: [{ repository: 'file:///repos/j07ea', revision: 4, label: 'receipt' }], verified: [], proofs: [], savedActions: [], remaining: ['src/config.json'] } },
      worktreeOutcome: { result: 'partial', revisions: ['file:///repos/j07ea:r4'], main: 'none', worktree: 'kept', lines: ['partial: Q:/app/.worktrees/002'], at: 10 } }
    const kept = SessionWorkflows.sectionsOf(record, () => null).find((section) => section.workflowId === 'ended:10')
    expect(kept?.actions.map((action) => action.id)).toEqual(['prepare-worktree', 'discard'])
    expect(kept?.actions[1].confirm).toBe('Already published: j07ea r4. 1 changed path is not published and will be discarded with this worktree. Save a copy and discard it?')
    const removed: SessionRecord = { ...record, worktree: undefined, worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'removed' },
      worktreeOutcome: { ...record.worktreeOutcome!, worktree: 'removed', at: 20 } }
    expect(SessionWorkflows.sectionsOf(removed, () => null).find((section) => section.workflowId === 'ended:20')?.actions).toEqual([])
  })

  it('times a closed main-copy UPDATE offer from the offer, not from the Finish before it (UA1-J09-11)', () => {
    const offered = 1_240_000
    const pressed = offered + 31_000
    const record: SessionRecord = { sessionId: 's3', title: 'Work', kind: 'agent', directory: { mode: 'adHoc', path: 'Q:/app' },
      life: 'ended', binding: null, createdAt: 0,
      actionHistory: [{ key: 'f3:update-main', startedAt: offered, endedAt: pressed,
        source: { svnAction: { kind: 'finish', actionId: 'f3', stage: 'main-update', root: 'Q:/app/.worktrees/003', checks: [], checkCursor: 0,
          rootCursor: 0, rounds: { incoming: 0, outOfDate: 0, lock: 0 }, evidence: [], requestedBy: 'window', startedAt: 0 } } }] }
    const step = SessionWorkflows.sectionsOf(record, () => null).find((section) => section.workflowId === 'f3:update-main')
      ?.rounds.flatMap((round) => round.steps).find((row) => row.title === 'Update main copy')
    expect(step).toMatchObject({ startedAt: offered, endedAt: pressed })
  })

})
