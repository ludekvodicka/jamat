import { describe, expect, it } from 'vitest'
import { WorktreeWords } from './worktreeWords'
import { WorktreeViews } from './worktreeView'
import type { WorktreeLifecycle } from '../worktreeState'
import type { SessionInfo } from '../../sessionManager/sessionManagerApi.types'

const state: WorktreeLifecycle = { version: 1, actionId: 'finish', phase: 'waiting', step: 'syncing', outOfDate: 0, journal: [], facts: { worker: { liveness: 'alive', resumeFailures: 0 } } }
describe('WorktreeWords', () => {
  it('does not offer a wait helper while the worker owns conflicts or a conflict resolver is available', () => {
    const resolving = { ...state, phase: 'finishing' as const, step: 'worker-resolving' as const,
      syncConflictSet: { readAt: 1, baseRevision: 1, revision: 2, more: 0,
        entries: [{ path: 'README.md', kind: 'text' as const, shape: 'text-overlap' as const,
          state: 'person' as const, options: ['merged' as const], facts: {} }] } }
    expect(WorktreeWords.actions(resolving).map((action) => action.id)).not.toContain('solve-with-agent')
    const waiting = { ...resolving, phase: 'waiting' as const, wait: { kind: 'conflict-person' as const, reason: 'Choose a resolution', at: 1 } }
    expect(WorktreeWords.actions(waiting).map((action) => action.id)).toContain('resolve-with-agent')
    expect(WorktreeWords.actions(waiting).map((action) => action.id)).not.toContain('solve-with-agent')
    expect(WorktreeWords.actions({ ...waiting, syncConflictSet: { ...waiting.syncConflictSet,
      entries: [{ ...waiting.syncConflictSet.entries[0], shape: 'binary', options: ['take-incoming'] }] } })
      .map((action) => action.id)).toContain('solve-with-agent')
  })
  it('keeps both review preparation writes running until their final person-review state', () => {
    const review = { version: 2, selection: ['a'], hashes: { a: 'hash' }, message: '[App] Change', source: 'person-local' as const, acknowledged: [], headMovedBy: 0 }
    const building = { ...state, preparation: { format: 1 as const, manifest: 'fixture', content: 'hash', metadata: 'hash', commands: 'hash', checks: 'none' as const, checkedAt: 1, attempt: 0 }, phase: 'finishing' as const, step: 'reviewing' as const, hasWindow: true }
    expect(WorktreeWords.reviewReady(building)).toBe(false)
    expect(WorktreeWords.presentation(building)).toMatchObject({ title: 'Preparing the synced review', tone: 'running' })
    expect(WorktreeWords.actions(building).some((action) => action.requiresCommit)).toBe(false)
    expect(WorktreeWords.presentation({ ...building, review })).toMatchObject({ title: 'Ready for validation', tone: 'wait' })
    const noWindow = { ...building, hasWindow: false, review }
    expect(WorktreeWords.reviewReady(noWindow)).toBe(false)
    expect(WorktreeWords.actions(noWindow).some((action) => action.requiresCommit)).toBe(false)
    const waiting = { ...noWindow, phase: 'waiting' as const, wait: { kind: 'waiting-for-review' as const, at: 1, reason: 'Ready for validation in Session actions' } }
    expect(WorktreeWords.reviewReady(waiting)).toBe(true)
    expect(WorktreeWords.presentation(waiting)).toMatchObject({ title: 'Ready for validation', tone: 'wait' })
    expect(WorktreeWords.actions(waiting).some((action) => action.requiresCommit)).toBe(true)
  })
  it.each([
    ['review', 'Ready for validation', 'wait'],
    ['waiting-for-review', 'Ready for validation', 'wait'],
    ['conflict-person', 'Conflicts need your decision', 'wait'],
    ['checks-failed', 'Checks failed', 'error'],
    ['repository-busy', 'Repository keeps changing', 'wait'],
    ['published-with-differences', 'Published with differences', 'error'],
    ['worker-lost', 'Worker needs to be resumed', 'error'],
    ['changed-outside', 'Worktree changed outside Finish', 'wait'],
    ['removal-blocked', 'Worktree removal is blocked', 'wait'],
    ['host-unhealthy', 'Processes may still run', 'error'],
    ['svn-failed', 'SVN step failed', 'error'],
    ['locked', 'Working copy is locked', 'wait'],
    ['auth', 'SVN sign-in needed', 'error'],
    ['pinned-external', 'A selected external is pinned', 'wait'],
    ['partially-landed', 'Some repositories were published', 'wait'],
    ['never-started', 'The worker never started', 'error'],
  ] as const)('composes the title, tone and actions of %s once', (kind, title, tone) => {
    const view = WorktreeViews.of({ ...state, wait: { kind, reason: 'Reason', at: 1 } })!
    expect(view.title).toBe(title)
    expect(view.tone).toBe(tone)
    expect(view.actions?.map((action) => action.id)).toContain('keep')
    expect(view.actions?.map((action) => action.id)).toContain('discard')
  })
  // The wait named Resume and offered no such press, and Back to work left the worker dead (UA1-J14R-3).
  it('offers Resume worker first on a worker-lost wait, in a Finish and outside one, with Keep and Discard', () => {
    const lost = { kind: 'worker-lost' as const, reason: 'lost', at: 1 }
    const outside = WorktreeWords.actions({ ...state, actionId: null, step: undefined, wait: lost })
    expect(outside.map((row) => row.id)).toEqual(['resume-worker', 'open-in-vscode', 'keep', 'discard'])
    expect(outside[0]).toMatchObject({ label: 'Resume worker', primary: true })
    expect(WorktreeWords.command(outside[0])).toEqual({ operation: 'sessions.reopen', body: {} })
    const reviewing = WorktreeWords.actions({ ...state, step: 'reviewing', wait: lost })
    expect(reviewing[0]).toMatchObject({ id: 'resume-worker', primary: true })
    expect(reviewing.filter((row) => row.primary)).toHaveLength(1)
    const checking = WorktreeWords.actions({ ...state, step: 'checking', wait: lost,
      execution: { root: 'Q:/wt', checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 1, runId: 'r1' } })
    expect(checking.map((row) => row.id)).toEqual(expect.arrayContaining(['resume-worker', 'keep', 'discard']))
    expect(WorktreeWords.actions({ ...state, step: 'reviewing', wait: { ...lost, kind: 'checks-failed' } }).map((row) => row.id)).not.toContain('resume-worker')
  })
  it('keeps worker resolution controls and explicit failed-check acceptance in the same action map', () => {
    const actions = WorktreeWords.actions({ ...state, step: 'worker-resolving' })
    expect(actions.map((row) => row.id)).toEqual(['finish-again', 'back-to-work', 'open-in-vscode', 'keep', 'discard'])
    const override = WorktreeWords.actions({ ...state, wait: { kind: 'checks-failed', reason: 'failed', at: 1 } }).find((row) => row.id === 'override-checks')!
    expect(override.confirm).toBeTruthy()
    expect(WorktreeWords.command(override)).toEqual({ operation: 'sessions.finishWorktree', body: { choice: 'commit', overrideChecks: true } })
  })
  it('UA1-J10-5: offers Resolve with agent on a person conflict wait while a path an agent may settle is open and no merger runs', () => {
    const entry = { path: 'a.txt', kind: 'text' as const, shape: 'text-overlap' as const, state: 'person' as const, options: ['merged' as const], facts: {} }
    const set = { readAt: 1, baseRevision: 1, revision: 2, entries: [entry], more: 0, waited: true as const }
    const waiting = { ...state, step: 'worker-resolving' as const, wait: { kind: 'conflict-person' as const, reason: '1 conflict needs you', at: 1 }, syncConflictSet: set,
      execution: { root: 'Q:/wt', checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window' as const, startedAt: 1 } }
    const actions = WorktreeWords.actions(waiting)
    expect(actions.map((row) => row.id).slice(0, 2)).toEqual(['finish-again', 'resolve-with-agent'])
    expect(WorktreeWords.command(actions[1])).toEqual({ operation: 'sessions.finishWorktree', body: { choice: 'commit', agent: true } })
    const personOnly = { ...waiting, syncConflictSet: { ...set, entries: [{ ...entry, shape: 'binary' as const, options: ['take-incoming' as const] }] } }
    expect(WorktreeWords.actions(personOnly).map((row) => row.id)).not.toContain('resolve-with-agent')
    const merging = { ...waiting, phase: 'finishing' as const, wait: undefined, execution: { ...waiting.execution, merger: { runId: 'm1', setAt: 1, startedAt: 2 } } }
    expect(WorktreeWords.actions(merging).map((row) => row.id)).toEqual(['finish-again', 'open-merger', 'stop-agent', 'back-to-work', 'open-in-vscode', 'keep', 'discard'])
  })
  it('waits for a busy worker with Sync now and Back to work, not as an SVN failure', () => {
    const busy = { ...state, step: 'syncing' as const, phase: 'waiting' as const, wait: { kind: 'worker-busy' as const, reason: 'busy', at: 1 } }
    expect(WorktreeWords.presentation(busy)).toMatchObject({ title: 'The worker is not idle', tone: 'wait' })
    const actions = WorktreeWords.actions(busy)
    expect(actions.map((row) => row.id)).toEqual(['finish-again', 'back-to-work', 'solve-with-agent', 'open-in-vscode', 'keep', 'discard'])
    // The confirm says what holds the worker now, not a fixed "still working" (UA1-J14-4).
    expect(actions[0].confirm).toBe('Sync although the worker is not idle?')
    const held = { ...busy, wait: { ...busy.wait, reason: WorktreeWords.syncBusyOf('a message to the worker is not delivered yet: Checks failed') } }
    expect(WorktreeWords.actions(held)[0].confirm).toBe('Sync although a message to the worker is not delivered yet: Checks failed?')
    expect(WorktreeWords.command(actions[0])).toEqual({ operation: 'sessions.finishWorktree', body: { choice: 'commit', confirmWorking: true } })
    expect(WorktreeWords.command(actions[1])).toEqual({ operation: 'sessions.backToWork', body: {} })
    expect(WorktreeWords.actions({ ...busy, step: 'committing' as const }).map((row) => row.id)).not.toContain('back-to-work')
  })
  it('names what holds the worker before publication and lets the person publish anyway (UA1-J13-1)', () => {
    const reason = 'a message to the worker is not delivered yet: Continue the interrupted worktree task'
    const waiting = { ...state, phase: 'finishing' as const, step: 'awaiting-idle' as const, approvedAt: 5, awaitingIdleReason: reason }
    expect(WorktreeWords.presentation(waiting)).toMatchObject({ title: 'Waiting for the worker to become idle' })
    expect(WorktreeWords.idleWaitOf(waiting)).toBe(`The worker is not idle: ${reason}`)
    expect(WorktreeWords.idleWaitOf({ ...waiting, awaitingIdleReason: undefined })).toBeNull()
    const actions = WorktreeWords.actions(waiting)
    expect(actions.map((row) => row.id)).toEqual(['finish-again', 'confirm-busy', 'back-to-work', 'keep', 'discard'])
    expect(actions[1]).toMatchObject({ label: 'Publish anyway', place: 'step', confirm: expect.stringContaining(reason) })
    expect(WorktreeWords.command(actions[1])).toEqual({ operation: 'sessions.finishWorktree', body: { choice: 'commit', confirmWorking: true } })
  })
  it('offers UPDATE beside removal retry after verified publication', () => {
    const blocked = { ...state, step: 'removing' as const, wait: { kind: 'removal-blocked' as const, reason: 'in use', at: 1 } }
    expect(WorktreeWords.actions(blocked).map((row) => row.id)).not.toContain('update-main')
    const actions = WorktreeWords.actions({ ...blocked, verified: [{ root: 'Q:/tree', revision: 2, paths: ['a.txt'], at: 1 }] })
    expect(actions.map((row) => row.id)).toEqual(['finish-again', 'update-main', 'solve-with-agent', 'open-in-vscode', 'keep', 'discard'])
    expect(WorktreeWords.command(actions[1])).toEqual({ operation: 'sessions.updateMain', body: { confirmLive: [] } })
  })
  it('sends identical local and remote lists and command payloads', () => {
    const actions = WorktreeWords.actions({ ...state, wait: { kind: 'partially-landed', reason: 'wait', at: 1 } })
    const info = { sessionId: 'worker', workflow: { actions: structuredClone(actions) }, actions: { sections: [{ actions: structuredClone(actions) }] } } as SessionInfo
    WorktreeWords.decorate(info)
    expect(info.workflow?.actions).toEqual(info.actions?.sections[0].actions)
    expect(info.workflow?.actions[0].command).toEqual({ operation: 'sessions.finishWorktree', body: { choice: 'commit' } })
  })
  it('reports retained conflicts, completed empty outcomes, stopped failures, and a current UPDATE directly', () => {
    expect(WorktreeWords.presentation({ ...state, phase: 'kept', syncConflictSet: { entries: [{ state: 'person' }, { state: 'agent' }] } as never }))
      .toMatchObject({ title: 'Worktree kept with 2 conflicts', tone: 'done' })
    expect(WorktreeWords.wait('never-started')).toEqual({ title: 'The worker never started', tone: 'error' })
    expect(WorktreeWords.outcome(undefined, undefined, 1, { result: 'never-started', revisions: [], lines: ['Nothing to land'] }))
      .toEqual({ kind: 'done', revision: '', output: 'Nothing to land' })
    expect(WorktreeWords.outcome(undefined, { open: true, summary: 'Stopped', rounds: [{ steps: [{ state: 'failed' }] }], actions: [{ id: 'keep' }] } as never, 1))
      .toEqual({ kind: 'waiting', detail: 'Stopped' })
    const info = { worktreeView: { title: 'Changes published', tone: 'done' }, svnAction: { kind: 'update-main', stage: 'updating', needs: null } } as SessionInfo
    WorktreeWords.decorate(info)
    expect(info.svnAction?.title).toBe('Updating the main copy')
    expect(info.worktreeView).toMatchObject({ title: 'Updating the main copy', tone: 'running' })
  })

  it('names what is already published and what Discard throws away in a partial publication', () => {
    const published = { revisions: [{ repository: 'http://svn.local/svn/shared', revision: 45, label: 'receipt' as const },
      { repository: 'http://svn.local/svn/App%20Core', revision: 120, label: 'receipt' as const }], verified: [], proofs: [], savedActions: [] }
    const confirmOf = (value: WorktreeLifecycle) => WorktreeWords.actions(value).find((action) => action.id === 'discard')!.confirm
    const partial: WorktreeLifecycle = { ...state, phase: 'waiting', wait: { kind: 'partially-landed', reason: 'App failed', at: 1 },
      publication: { ...published, remaining: ['a.ts', 'b.ts'] } }
    expect(confirmOf(partial)).toBe('Already published: App Core r120, shared r45. 2 changed paths are not published and will be discarded with this worktree. Save a copy and discard it?')
    expect(confirmOf({ ...partial, publication: { ...published, remaining: ['a.ts'] } }))
      .toBe('Already published: App Core r120, shared r45. 1 changed path is not published and will be discarded with this worktree. Save a copy and discard it?')
    expect(confirmOf({ ...partial, publication: published }))
      .toBe('Already published: App Core r120, shared r45. The rest is not published and will be discarded with this worktree. Save a copy and discard it?')
    expect(confirmOf({ ...state, wait: { kind: 'svn-failed', reason: 'x', at: 1 } })).toBe('Save a copy and discard this worktree?')
  })

  it('offers Discard of a kept worktree beside a new preparation, without preparing it first (UA1-J07-7)', () => {
    const publication = { revisions: [{ repository: 'file:///repos/j07ea', revision: 4, label: 'receipt' as const },
      { repository: 'file:///repos/j07eb', revision: 3, label: 'receipt' as const }], verified: [], proofs: [], savedActions: [], remaining: ['src/config.json'] }
    const kept: WorktreeLifecycle = { ...state, phase: 'kept', step: undefined, publication,
      execution: { root: 'Q:/wt', checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 1 } }
    const actions = WorktreeWords.actions(kept)
    expect(actions.map((action) => [action.id, action.label])).toEqual([['prepare-worktree', WorktreeWords.prepareAgainConst], ['discard', 'Discard']])
    expect(actions[1].confirm).toBe('Already published: j07ea r4, j07eb r3. 1 changed path is not published and will be discarded with this worktree. Save a copy and discard it?')
    expect(WorktreeWords.command(actions[1])).toEqual({ operation: 'sessions.finishWorktree', body: { choice: 'discard' } })
    expect(WorktreeWords.presentation(kept)).toEqual({ title: 'Worktree kept', tone: 'done', actions })
    expect(WorktreeWords.actions({ ...kept, execution: { ...kept.execution!, neverStartedReason: 'No agent start was recorded' } }).map((action) => action.id)).toEqual(['discard'])
  })

  it('sends a stale review to the press that prepares it again, naming every changed path', () => {
    expect(WorktreeWords.reviewChanged(['.aidocs/engines/run-w2', '.aidocs/engines/brief.md']))
      .toBe('Changed since this review was read: .aidocs/engines/run-w2, .aidocs/engines/brief.md. Press Recheck local changes, then review the changes again.')
    expect(WorktreeWords.actions({ version: 1, actionId: 'a', phase: 'waiting', step: 'reviewing',
      wait: { kind: 'review', reason: 'x', at: 1 }, outOfDate: 0, journal: [], facts: { worker: { liveness: 'alive', resumeFailures: 0 } } })
      .some((action) => action.label === WorktreeWords.recheckConst)).toBe(true)
  })

  it('says beside each secondary press of the review when it is needed, so the one primary is the next step (Finish 072)', () => {
    const reviewing: WorktreeLifecycle = { version: 1, actionId: 'a', phase: 'waiting', step: 'reviewing',
      wait: { kind: 'review', reason: 'x', at: 1 }, outOfDate: 0, journal: [], facts: { worker: { liveness: 'alive', resumeFailures: 0 } } }
    const step = (state: WorktreeLifecycle) => WorktreeWords.actions(state).filter((action) => action.place === 'step')
      .map((action) => [action.label, action.primary, action.note])
    expect(step(reviewing)).toEqual([
      [WorktreeWords.recheckConst, false, 'Only after you edit files in the worktree'],
      [WorktreeWords.prepareAgainConst, false, 'Only to take newer repository changes first'],
    ])
    expect(step({ ...reviewing, knownIncoming: { paths: ['a.txt'], at: 1 } })[1]).toEqual([WorktreeWords.prepareAgainConst, true, undefined])
  })

  it('removes an ended requested run as the CLI does, by the run id', () => {
    expect(WorktreeWords.command({ id: 'remove-run', label: 'Remove', primary: false, runId: 'r1' }))
      .toEqual({ operation: 'sessions.remove', sessionId: 'r1', body: {} })
    expect(WorktreeWords.command({ id: 'remove-run', label: 'Remove', primary: false })).toBeUndefined()
  })

  it('stops a requested run as a stop of that run, from its own section and from the validation', () => {
    const stop = { id: 'stop-run' as const, label: 'Stop', primary: false, runId: 'v1' }
    const command = { operation: 'sessions.finalize', sessionId: 'v1', body: { expect: 'stop' } }
    expect(WorktreeWords.command(stop)).toEqual(command)
    const info = { actions: { sections: [
      { kind: 'script', workflowId: 'script:v1', title: 'Worktree validation', badge: 'running', summary: '', open: true, rounds: [], actions: [stop] },
      { kind: 'finish', workflowId: 'f1', title: 'Finish', badge: 'Ready for validation', summary: '', open: true, rounds: [], actions: [],
        validation: { cwd: 'Q:/wt', checks: 'none', canRun: true, runs: [{ runId: 'v1', title: 'Worktree validation', startedAt: 5, stop }] } },
    ] } } as unknown as SessionInfo
    WorktreeWords.decorate(info)
    expect(info.actions?.sections[0].actions[0].command).toEqual(command)
    expect(info.actions?.sections[1].validation?.runs?.[0].stop.command).toEqual(command)
  })

})
