import { existsSync } from 'node:fs'
import { SetupInputs } from '../../projectSetup/setupInputs'
import { mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { finishTestRecords, emptyUpdateTargets, testAssembly } from './finishTestRecords'
import { FinishDriver, type FinishDriverDeps } from './finishDriver'
import { SyncStep } from './syncStep'
import { Reconciler } from '../../sessionManager/lifecycle/reconciler'
import { WorktreeLifecycleMigration } from '../worktreeLifecycleMigration'
import { FinishProjection } from './finishProjection'
import { PreparationStep } from './preparationStep'
import { FinishState } from './finishState'
import { SvnAssemblyReader } from '../../svn/svnAssembly'
import { SessionSteps, SessionWorkflows } from '../../sessionManager/worktreeSessionRuntime'
import { WorktreeWords } from '../view/worktreeWords'
import { WorktreeLease, WorktreeLeaseHeld } from '../worktreeLease'
import { WorktreeRecovery } from '../worktreeRecovery'
import { ScriptLogStore } from '../../sessionManager/worktreeSessionScripts'
import { SessionScriptsManager } from '../../sessionManager/worktreeSessionScripts'
import { SessionScriptDefinitions } from '../../sessionManager/worktreeSessionScripts'
import { SessionActionHistory } from '../../sessionManager/records/sessionActionHistory'
import { SvnStepRunner } from '../svnStepRunner'
import { WorktreeResultsStore } from '../results/worktreeResultsStore'
import { LandedRows } from '../landing/landedRows'
import type { SessionRecordScriptStep } from '../../sessionManager/worktreeSessionRecords'

async function harness() {
  const h = await finishTestRecords({ phase: 'active', step: undefined })
  const root = h.records.get('worker')!.worktree!.worktreePath
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'a.txt'), 'worker\r\n')
  await h.records.update('worker', (record) => ({ ...record, worktree: { ...record.worktree!, agentStartedAt: 1 } }))
  let dirty = ['a.txt']
  let revision = 1
  let nextId = 0
  let hash = 'hash'
  let checkSteps: SessionRecordScriptStep[] = []
  let failCommit: 'auth' | 'accepted' | undefined
  const events: string[] = []
  const failures: string[] = []
  const logs = new ScriptLogStore(join(h.root, 'logs'))
  const results = new WorktreeResultsStore(join(h.root, 'results'), { logs, now: () => Date.now(), report: (line) => failures.push(line) })
  const unreachable = async (): Promise<never> => { throw new Error('No Host') }
  const scripts = new SessionScriptsManager({ records: h.records, logs, now: () => Date.now(), report: (line) => failures.push(line), onCollapsed: () => {},
    host: { runtimeInspect: unreachable, runtimeStop: unreachable, runtimeRemove: unreachable } })
  const lease = new WorktreeLease('finish-test', () => [])
  const commands = { lease, accept: vi.fn(async () => {}), verify: vi.fn(async () => {}), acceptInterrupted: vi.fn(async () => {}) }
  const runner = new SvnStepRunner({ records: h.records, scripts, lease, now: () => Date.now(), newId: () => `run-${++nextId}`, changed: () => {},
    svn: { run: async (_cwd, args, options) => {
      events.push(args[0])
      if (args[0] === 'commit' && failCommit === 'auth') return { code: 1, stdout: '', stderr: 'svn: E170001: Authentication failed', failure: null }
      if (args[0] === 'commit') { revision++; dirty = []; options?.onStdout?.(`Committed revision ${revision}.`) }
      if (args[0] === 'commit' && failCommit === 'accepted') return { code: 1, stdout: '', stderr: 'svn: E170013: response lost', failure: null }
      return { code: 0, stdout: `Committed revision ${revision}.`, stderr: '', failure: null }
    } } })
  const svn = {
    assembly: async () => ({ ok: true, value: testAssembly(hash, String(revision)) }),
    present: async () => true,
    conflictSet: async () => ({ ok: true, value: { revision, facts: [], rows: [] } }),
    ownerCheck: async () => ({ ok: true, value: undefined }),
    changes: async () => ({ ok: true, value: dirty.map((path) => ({ path, conflict: false, kind: 'item' })) }),
    commitHashes: async (_root: string, paths: string[]) => ({ ok: true, value: Object.fromEntries(paths.map((path) => [path, hash])) }),
    publicationHashes: async (_root: string, paths: string[]) => ({ ok: true, value: Object.fromEntries(paths.map((path) => [path, hash])) }),
    reviewRoots: async () => ({ ok: true, value: [{ path: root, own: '', pinned: false, changed: dirty.map((path) => ({ path, conflict: false, kind: 'item' })) }] }),
    lowerBounds: async () => ({ ok: true, value: { '': { repository: 'url', base: '/trunk', rootBase: 1, since: 1 } } }),
    prepareCommit: async (_root: string, paths: string[], before: (paths: string[]) => Promise<void>) => { await before([]); return { ok: true, value: { targets: paths, added: [] } } },
    unprepareCommit: async () => ({ ok: true, value: undefined }),
    logSince: async () => ({ ok: true, value: [] }),
    publicationRows: async (_root: string, paths: string[]) => ({ ok: true, value: { changed: paths.map((path) => ({ path, action: 'M' })),
      items: paths.map((path) => ({ path, item: 'normal', props: 'none', base: revision, changed: revision })) } }),
    revertSetup: async () => ({ ok: true, value: undefined }),
    advancePublished: vi.fn(async () => ({ ok: true, value: undefined })),
  }
  const deps = {
    records: h.records, commands, runner, logs, results, svn,
    steps: { at: vi.fn(), clear: vi.fn() },
    sync: { withControl: async <T>(_id: string, work: () => Promise<T>) => work(), run: async () => {
      events.push('sync')
      await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, version: record.worktreeLifecycle!.version + 1, phase: 'finishing', step: 'checking', wait: undefined,
        facts: { ...record.worktreeLifecycle!.facts, syncedAt: { revision, at: Date.now() } } } }))
      return { ok: true, value: { revision, conflicts: [] } }
    } },
    checks: { declaredAfter: async () => ({ ok: true, steps: checkSteps }) },
    runs: { launch: vi.fn(async () => {}) },
    handoffs: { checksFailed: vi.fn(async () => {}), conflicts: vi.fn(async () => {}), notifyCaller: vi.fn(async () => {}), messageWanted: vi.fn(async () => {}) },
    removal: { remove: vi.fn(async () => {
      events.push('remove')
      await h.records.update('worker', (record) => ({ ...record, worktree: undefined,
        retiredWorktree: { kind: 'svn', worktreePath: root, revisions: [], removedAt: Date.now(), ownerDir: h.root } }))
      return { state: 'removed', lines: [] }
    }) },
    stop: async () => { events.push('stop'); await h.records.update('worker', (record) => ({ ...record, life: 'ended' })); return { ok: true, value: undefined } },
    stopRun: async () => true, awaitExit: async () => true, idle: () => true, holdInput: () => () => {},
    busyReason: (id: string) => deps.idle(id) ? null : 'the worker is working',
    liveness: async () => {}, landedDue: () => {}, ended: () => {}, proposalsSpent: () => {},
    changed: () => {}, detach: (promise: Promise<unknown>) => { promise.catch((error) => failures.push(String(error))) }, report: (line: string) => failures.push(line),
    now: () => Date.now(), newId: () => `id-${++nextId}`,
    resolver: { briefs: logs, withMarkers: vi.fn(async () => []), unavailable: () => null, cli: () => ({ ok: true as const, command: 'node "C:/Jamat/skills/claude/appjamat-v3/scripts/jamat-v3.mjs"' }), instance: { configIdentity: 'cfg-test', channel: 'development' as const } }, resolutions: { recoverLocked: async () => ({ ok: true, value: undefined }) },
    update: { held: () => new Set(), drive: async () => {}, noteVerdict: async () => false,
      startUpdate: vi.fn(async () => ({ ok: true as const, value: { actionId: 'update' } })) },
  } as unknown as FinishDriverDeps
  const driver = new FinishDriver(deps)
  // A press answers before its steps run; these cases judge what the steps left behind.
  const press = driver.start.bind(driver)
  driver.start = async (sessionId, finishPress) => {
    const answer = await press(sessionId, finishPress)
    await driver.settled(sessionId)
    return answer
  }
  return { ...h, root, deps, driver, press, events, failures, logs, results, scripts, setDirty: (paths: string[]) => { dirty = paths },
    failCommit: (value: typeof failCommit) => { failCommit = value },
    setRevision: (value: number) => { revision = value },
    setHash: (value: string) => { hash = value },
    setChecks: (steps: SessionRecordScriptStep[]) => { checkSteps = steps },
    state: () => h.records.get('worker')!.worktreeLifecycle!,
    approve: () => driver.start('worker', { choice: 'commit', requestedBy: 'window', selection: [join(root, 'a.txt')], message: '[App] Fix file',
      messageSource: 'person-local', reviewVersion: h.records.get('worker')!.worktreeLifecycle!.version }) }
}

describe('FinishDriver', () => {
  it('answers a press once its action is saved and runs the sync after the answer', async () => {
    const h = await harness()
    const run = h.deps.sync.run
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    h.deps.sync.run = async (...args) => { await held; return run(...args) }
    const answer = await h.press('worker', { choice: 'commit', requestedBy: 'cli' })
    expect(answer).toEqual({ ok: true, value: { actionId: h.state().actionId } })
    expect(h.state()).toMatchObject({ phase: 'finishing', step: 'syncing' })
    expect(h.events).not.toContain('sync')
    expect(h.driver.held().has('worker')).toBe(true)
    release()
    await h.driver.settled('worker')
    expect(h.events).toContain('sync')
    expect(h.state().step).toBe('reviewing')
  })
  it('answers a second press merge-pending while an svn write of the Finish still holds the worktree', async () => {
    const h = await harness()
    vi.spyOn(h.deps.commands.lease, 'checkAndRelease').mockRejectedValueOnce(new WorktreeLeaseHeld('An SVN writer is still active; wait for its command to exit'))
    expect(await h.press('worker', { choice: 'commit', requestedBy: 'cli' }))
      .toEqual({ ok: false, code: 'merge-pending', detail: 'An SVN writer is still active; wait for its command to exit' })
  })
  it('does not replace worker-lost with a delayed wait from the previous Finish operation', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const lost = { kind: 'worker-lost' as const, reason: 'The conversation could not resume twice', at: 30 }
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!,
      phase: 'waiting', wait: lost, facts: { ...record.worktreeLifecycle!.facts, worker: { liveness: 'dead', resumeFailures: 2 } } } }))
    await new FinishState(h.deps).wait('worker', 'checks-failed', 'An earlier check failed')
    expect(h.state().wait).toEqual(lost)
    expect(WorktreeWords.actions(h.state()).some((action) => action.id === 'resume-worker')).toBe(true)
  })
  it.each(['keep', 'discard'] as const)('retains a concurrent journal append while %s reads status', async (choice) => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const changes = h.deps.svn.changes
    h.deps.svn.changes = async (...args) => {
      await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!,
        journal: [...record.worktreeLifecycle!.journal, { stepId: 'concurrent-main-update', attempt: 1, kind: 'update', cwd: h.root,
          startedAt: Date.now(), endedAt: Date.now(), outcome: 'ok', runId: 'concurrent-run', paths: ['.'] }] } }))
      return changes(...args)
    }
    expect(await h.driver.start('worker', { choice, requestedBy: 'window' })).toMatchObject({ ok: true })
    expect(h.state().journal.some((entry) => entry.stepId === 'concurrent-main-update')).toBe(true)
  })
  it.each(['ended', 'confirmed'] as const)('returns to work after a %s check through the real scripts manager', async (condition) => {
    const h = await harness()
    h.setChecks([{ key: 'check', scriptId: 'checks', name: 'Check', commands: [{ cwd: h.root, command: 'check' }] }])
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const runId = h.state().execution!.runId!
    await h.records.update(runId, (record) => ({ ...record, life: 'live', binding: { hostInstanceId: 'fixture', generation: 1 } }))
    const stop = vi.fn(async (target) => ({ ok: true as const, value: { servedByHostInstanceId: 'fixture', target, diagnostic: 'stopped' as const } }))
    const unreachable = async (): Promise<never> => { throw new Error('Unexpected Host call') }
    const scripts = new SessionScriptsManager({ records: h.records, logs: h.logs, now: Date.now, report: () => {}, onCollapsed: () => {},
      host: { runtimeStop: stop, runtimeInspect: unreachable, runtimeRemove: unreachable } })
    if (condition === 'confirmed') expect(await scripts.stopRun(runId)).toBe(true)
    else await h.records.update(runId, (record) => ({ ...record, life: 'ended', endedAt: Date.now(), exitCode: 0 }))
    h.deps.stopRun = (id) => scripts.confirmStopped(id)
    h.deps.awaitExit = vi.fn(async () => true)
    expect(await h.driver.backToWork('worker', 'person')).toMatchObject({ ok: true })
    expect(h.deps.awaitExit).toHaveBeenCalledWith(runId)
    expect(h.state().phase).toBe('active')
  })
  it('requires explicit acknowledgement of changed worktree checks and invalidates that acknowledgement when edited again', async () => {
    const h = await harness()
    await writeFile(join(h.records.get('worker')!.worktree!.repositoryRoot, '.worktree.json'), JSON.stringify({ scripts: { after: ['trusted'] } }))
    await writeFile(join(h.root, '.worktree.json'), JSON.stringify({ scripts: { after: ['changed'] } }))
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().environment).toMatchObject({ pending: true, checksPolicy: expect.any(String) })
    expect(h.state().wait?.reason).toContain('New checks were not executed')
    await writeFile(join(h.root, '.worktree.json'), JSON.stringify({ scripts: { after: ['changed again'] } }))
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', confirmEnvironment: true })).toMatchObject({ ok: false })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', refreshPreparation: true })
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', confirmEnvironment: true })).toMatchObject({ ok: true })
    expect(h.state().environment?.pending).toBeUndefined()
    expect(h.deps.runs.launch).not.toHaveBeenCalled()
    expect(h.state().step).toBe('reviewing')
  })
  it.each(['window', 'cli'] as const)('preserves publication across Keep then Discard by %s and reload', async (requestedBy) => {
    const h = await harness(), remove = h.deps.removal.remove
    h.deps.removal.remove = async () => ({ state: 'in-use', lines: ['held'] })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await h.approve()
    await h.driver.start('worker', { choice: 'keep', requestedBy })
    expect(h.state().phase).toBe('kept')
    const firstAction = h.state().actionId
    h.deps.removal.remove = remove
    expect(await h.driver.start('worker', { choice: 'discard', requestedBy })).toMatchObject({ ok: true })
    const record = (await h.reload()).get('worker')!
    expect(record.worktreeOutcome).toMatchObject({ result: 'committed', labelled: [{ revision: 2 }] })
    expect(record.worktreeLifecycle?.publication?.savedActions).toContain(firstAction)
    expect(LandedRows.landingOf(record)).toMatchObject({ landed: [{ revision: 2 }] })
    expect(h.events.filter((event) => event === 'commit')).toHaveLength(1)
  })

  it.each(['window', 'cli'] as const)('preserves publication across Keep, Prepare and Back to work by %s', async (requestedBy) => {
    const h = await harness()
    h.deps.removal.remove = async () => ({ state: 'in-use', lines: ['held'] })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await h.approve()
    await h.driver.start('worker', { choice: 'keep', requestedBy })
    h.setDirty(['a.txt'])
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy })).toMatchObject({ ok: true })
    expect(await h.driver.backToWork('worker', requestedBy === 'window' ? 'person' : 'agent')).toMatchObject({ ok: true })
    expect(h.state().phase).toBe('active')
    expect(LandedRows.landingOf((await h.reload()).get('worker')!)).toMatchObject({ landed: [{ revision: 2 }] })
    expect(h.events.filter((event) => event === 'commit')).toHaveLength(1)
  })

  it('never shows a launched check run without the pointer that names it', async () => {
    const h = await harness()
    h.setChecks([{ key: 'tests', scriptId: 'checks', name: 'tests', commands: [{ cwd: h.root, command: 'node check.js' }] }])
    const orphans: string[] = []
    const observe = () => {
      for (const run of h.records.list())
        if (run.scriptOf?.scriptId === 'checks' && SessionScriptDefinitions.of(run.scriptOf).pointerOf(h.records.get('worker')!) !== run.sessionId)
          orphans.push(run.sessionId)
    }
    for (const method of ['put', 'update', 'putWith'] as const) {
      const original = (h.records as any)[method]?.bind(h.records)
      if (original !== undefined) (h.records as any)[method] = async (...args: unknown[]) => { const landed = await original(...args); observe(); return landed }
    }
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().execution!.runId).toBeDefined()
    expect(orphans).toEqual([])
  })

  it('reopens the action failed checks closed, so its live steps are not hidden behind the closed copy', async () => {
    const h = await harness()
    h.setChecks([{ key: 'tests', scriptId: 'checks', name: 'tests', commands: [{ cwd: h.root, command: 'node check.js' }] }])
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await completeCheck(h, false)
    expect(h.state().phase).toBe('active')
    expect(h.records.get('worker')!.actionHistory?.map((entry) => entry.key)).toContain(h.state().actionId)
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const record = h.records.get('worker')!
    expect(SessionActionHistory.currentOf(record)?.key).toBe(h.state().actionId)
    expect(SessionActionHistory.entriesOf(record).map((entry) => entry.key)).not.toContain(h.state().actionId)
  })

  it('runs a check again when its record and log are gone instead of retrying the lost log forever', async () => {
    const h = await harness()
    h.setChecks([{ key: 'tests', scriptId: 'checks', name: 'tests', commands: [{ cwd: h.root, command: 'node check.js' }] }])
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const lost = h.state().execution!.runId!
    await h.records.remove(lost, { recoveryPoint: false })
    expect(await h.driver.noteVerdict('worker', { kind: 'failed', reason: 'its tests check session record is gone' })).toBe(true)
    await h.driver.drive('worker')
    await h.driver.drive('worker')
    expect(h.state().wait).toBeUndefined()
    expect(h.state().execution!.pendingLog).toBeUndefined()
    expect(h.state().execution!.runId).toBeDefined()
    expect(h.state().execution!.runId).not.toBe(lost)
    expect(h.records.get(h.state().execution!.runId!)).not.toBeNull()
  })

  it('stops an active check and waits for exit before returning to work', async () => {
    const h = await harness()
    h.setChecks([{ key: 'hang', scriptId: 'checks', name: 'Check', commands: [{ cwd: h.root, command: 'hang' }] }])
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const runId = h.state().execution!.runId!
    h.deps.stopRun = vi.fn(async () => false)
    expect(await h.driver.backToWork('worker', 'person')).toMatchObject({ ok: false })
    expect(h.state().step).toBe('checking')
    h.deps.stopRun = vi.fn(async () => true)
    h.deps.awaitExit = vi.fn(async () => {
      expect(h.state().step).toBe('checking')
      return true
    })
    expect(await h.driver.backToWork('worker', 'person')).toMatchObject({ ok: true })
    expect(h.deps.stopRun).toHaveBeenCalledWith(runId, false)
    expect(h.deps.awaitExit).toHaveBeenCalledWith(runId)
    expect(h.state().phase).toBe('active')
    expect(h.events).not.toContain('commit')
  })

  it('R4: a failed check verdict cannot bypass a refused Stop after its root exits', async () => {
    const h = await harness()
    h.setChecks([{ key: 'check', scriptId: 'checks', name: 'Check', commands: [{ cwd: h.root, command: 'check' }] }])
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const runId = h.state().execution!.runId!
    await h.records.update(runId, (record) => ({ ...record, life: 'ended', endedAt: Date.now(), exitCode: 1,
      binding: { hostInstanceId: 'fixture', generation: 1 } }))
    await h.records.update('worker', (record) => ({ ...record, scriptRuns: [{ runId, title: 'check', phase: 'after', scriptId: 'checks', name: 'check', commands: [],
      startedAt: 1, endedAt: Date.now(), outcome: 'failed', exitCode: 1, log: { state: 'unavailable', reason: 'fixture' } }] }))
    let refuse = true, clock = Date.now()
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected Host call') }
    const scripts = new SessionScriptsManager({ records: h.records, logs: h.logs, now: () => clock, report: () => {}, onCollapsed: () => {},
      host: { runtimeInspect: unexpected, runtimeRemove: unexpected, runtimeStop: async (target) => refuse
        ? { ok: false, code: 'op-rejected', status: 409, detail: 'Child is still alive' }
        : { ok: true, value: { servedByHostInstanceId: 'fixture', target, diagnostic: 'already-dead' } } } })
    h.deps.stopRun = (id) => scripts.confirmStopped(id)
    h.deps.stopRefusal = (id) => scripts.stopRefusalOf(id)
    // UA1-J10-2: the ended run is judged, but into a person wait: the refused Stop is not bypassed.
    expect(await h.driver.noteVerdict('worker', { kind: 'failed', reason: 'root exited' })).toBe(true)
    await h.driver.drive('worker')
    expect(h.state()).toMatchObject({ phase: 'waiting', step: 'checking', wait: { kind: 'host-unhealthy', reason: expect.stringContaining('Child is still alive') } })
    expect(h.state().checks).toBeUndefined()
    expect(h.state().execution).toMatchObject({ verdict: { kind: 'failed' }, stopRefusedRunId: runId })
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })).toMatchObject({ ok: false, code: 'merge-pending' })
    expect(h.state().step).toBe('checking')
    refuse = false
    clock += 120_000
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })).toMatchObject({ ok: true })
    // Its log is gone, so it left no evidence to judge, and the check runs again.
    expect(h.state()).toMatchObject({ phase: 'finishing', step: 'checking' })
    expect(h.state().execution?.runId).not.toBe(runId)
  })

  it('R4: manual Stop confirmation is available only after refusal and is bound to the current check and person', async () => {
    const h = await harness()
    h.setChecks([{ key: 'check', scriptId: 'checks', name: 'Check', commands: [{ cwd: h.root, command: 'check' }] }])
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const runId = h.state().execution!.runId!
    await h.records.update(runId, (record) => ({ ...record, life: 'lost', binding: null }))
    const unexpected = async (): Promise<never> => { throw new Error('A lost check has no bound Host') }
    const scripts = new SessionScriptsManager({ records: h.records, logs: h.logs, now: Date.now, report: () => {}, onCollapsed: () => {},
      host: { runtimeStop: unexpected, runtimeInspect: unexpected, runtimeRemove: unexpected } })
    h.deps.stopRun = vi.fn((id, manual) => scripts.confirmStopped(id, manual))
    expect(await h.driver.backToWork('worker', 'person', runId)).toMatchObject({ ok: false })
    expect(await h.driver.backToWork('worker', 'person')).toMatchObject({ ok: false })
    expect(h.state().execution?.stopRefusedRunId).toBe(runId)
    expect(await h.driver.backToWork('worker', 'agent', runId)).toMatchObject({ ok: false, code: 'person-only' })
    expect(await h.driver.backToWork('worker', 'person', 'another-run')).toMatchObject({ ok: false })
    expect(await h.driver.backToWork('worker', 'person', runId)).toMatchObject({ ok: true })
    expect(h.state().phase).toBe('active')
    expect(h.deps.stopRun).toHaveBeenCalledWith(runId, true)
  })
  it.each(['child/file.txt', '@mount/shared'])('does not advance a root-property receipt across metadata changes in %s', async (changed) => {
    const h = await harness()
    let metadata = 'before'
    h.deps.svn.assembly = async () => {
      const nodes = [{ path: '.', content: 'property', metadata: 'owner' }, { path: changed, content: 'unchanged', metadata }]
      return { ok: true, value: { format: 1, incoming: [], nodes,
        content: SvnAssemblyReader.hash(nodes.map(({ path, content }) => [path, content])),
        metadata: SvnAssemblyReader.hash(nodes.map(({ path, metadata }) => [path, metadata])) } }
    }
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().preparation?.checkedAt).toBeDefined()
    metadata = 'after another repository changed'
    expect(await new PreparationStep(h.deps, new FinishState(h.deps)).advanceReceipt('worker', h.root, ['.'])).toBe(false)
    expect(h.state().preparation?.checks).toBe('pending')
    expect(h.events).not.toContain('commit')
  })
  it('stops an overdue declared check before recording its failure and never publishes it', async () => {
    const h = await harness()
    h.setChecks([{ key: 'hang', scriptId: 'checks', name: 'Hanging check', commands: [{ cwd: h.root, command: 'hang' }] }])
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const runId = h.state().execution!.runId!
    h.deps.stopRun = vi.fn(async () => true)
    h.deps.awaitExit = vi.fn(async () => true)
    await h.logs.write('worker', runId, 'check was running')
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!,
      execution: { ...record.worktreeLifecycle!.execution!, checkStartedAt: Date.now() - 21 * 60_000 } } }))
    await h.driver.drive('worker')
    expect(h.deps.stopRun).toHaveBeenCalledWith(runId)
    expect(h.deps.awaitExit).toHaveBeenCalledWith(runId)
    expect(h.state().checks?.passed).toBe(false)
    expect(h.events).not.toContain('commit')
  })

  it('keeps the approved preparation while the person checks worker idle again', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    h.deps.idle = () => false
    await h.approve()
    const prepared = h.state().preparation
    const approved = h.state().approvedAt
    expect(h.state().step).toBe('awaiting-idle')
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().preparation).toEqual(prepared)
    expect(h.state().approvedAt).toBe(approved)
    expect(h.events.filter((event) => event === 'sync')).toHaveLength(1)
    h.deps.idle = () => true
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().phase).toBe('landed')
    expect(h.events.filter((event) => event === 'commit')).toHaveLength(1)
  })

  it('names what holds a busy worker and publishes only on the person confirmation (UA1-J13-1)', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    h.deps.idle = () => false
    await h.approve()
    expect(h.state()).toMatchObject({ step: 'awaiting-idle', awaitingIdleReason: 'the worker is working' })
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'cli', confirmWorking: true })).toMatchObject({ ok: false, code: 'person-only' })
    expect(h.state().busyConfirmedFor).toBeUndefined()
    expect(h.events).not.toContain('commit')
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', confirmWorking: true })).toMatchObject({ ok: true })
    expect(h.state().phase).toBe('landed')
    expect(h.events.filter((event) => event === 'commit')).toHaveLength(1)
  })

  it.each(['keep', 'discard'] as const)('retains publication and main-update obligation after %s with blocked cleanup', async (choice) => {
    const h = await harness()
    h.deps.landedDue = vi.fn()
    const remove = h.deps.removal.remove
    h.deps.removal.remove = async () => ({ state: 'in-use', lines: ['dev server still running'] })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await h.approve()
    expect(h.state().wait?.kind).toBe('removal-blocked')
    h.deps.removal.remove = remove
    await h.driver.start('worker', { choice, requestedBy: 'window' })
    expect(h.records.get('worker')?.worktreeOutcome).toMatchObject({ result: 'committed', labelled: [{ revision: 2 }] })
    expect((await h.results.list({ sessionId: 'worker' }))[0]).toMatchObject({ result: 'committed', revisions: [{ revision: 2 }] })
    expect(h.deps.landedDue).toHaveBeenCalled()
    expect(h.events.filter((event) => event === 'commit')).toHaveLength(1)
  })

  it('resumes the removal of its aside on Try again after a failure past the rename, without the owner check or a second commit', async () => {
    const h = await harness()
    const aside = `${h.root}.deleting`
    h.deps.svn.present = async (path: string) => existsSync(path)
    h.deps.svn.ownerCheck = async (location) => existsSync(location.worktreePath)
      ? { ok: true, value: undefined } : { ok: false, code: 'refused', detail: `${location.worktreePath} is no SVN checkout` }
    let clock = 5_000
    h.deps.now = () => clock
    const remove = h.deps.removal.remove
    const attempts: string[] = []
    const startedAt: (number | undefined)[] = []
    h.deps.removal.remove = vi.fn(async (...args: Parameters<typeof remove>) => {
      attempts.push(args[1].worktreePath)
      startedAt.push(h.state().execution?.removalAt)
      if (attempts.length > 1) { await rm(aside, { recursive: true, force: true }); return remove(...args) }
      await rename(h.root, aside)
      return { state: 'undeleted' as const, lines: [`ERROR: ${h.root}.deleting is left half deleted`] }
    })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await h.approve()
    expect(h.state().wait?.kind).toBe('removal-blocked')
    expect(h.state().step).toBe('removing')
    clock = 9_000

    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })).toMatchObject({ ok: true })

    expect(attempts).toEqual([h.root, h.root])
    expect(startedAt).toEqual([5_000, 9_000])
    expect(existsSync(aside)).toBe(false)
    expect(h.state().phase).toBe('landed')
    expect(h.events.filter((event) => event === 'commit')).toHaveLength(1)
  })

  it.each(['keep', 'discard'] as const)('retains an unverified published revision as partial after %s', async (choice) => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    h.deps.svn.publicationHashes = async () => ({ ok: true, value: { 'a.txt': 'unexpected repository bytes' } })
    await h.approve()
    expect(h.state().wait?.kind).toBe('published-with-differences')
    await h.driver.start('worker', { choice, requestedBy: 'window' })
    expect(h.records.get('worker')?.worktreeOutcome).toMatchObject({ result: 'partial', labelled: [{ revision: 2 }] })
    expect((await h.results.list({ sessionId: 'worker' }))[0]).toMatchObject({ result: 'partial', revisions: [{ revision: 2 }] })
  })

  it('invalidates environment evidence when resolved setup commands change', async () => {
    const h = await harness()
    let environment = 'first-install'
    h.deps.checks.declaredAfter = async () => ({ ok: true, steps: [], environment })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().environment).toMatchObject({ pending: true, commands: 'first-install' })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', confirmEnvironment: true })
    expect(h.state().preparation?.checkedAt).toBeDefined()
    environment = 'new-install'
    expect(await h.approve()).toMatchObject({ ok: false, code: 'review-stale' })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', refreshPreparation: true })
    expect(h.state().environment).toMatchObject({ pending: true, commands: 'new-install' })
    expect(h.events).not.toContain('commit')
  })

  it('requires human environment confirmation for changed dependency inputs before checks', async () => {
    const h = await harness()
    h.deps.svn.assembly = async () => ({ ok: true, value: testAssembly('dependencies', '1', 'package.json') })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().environment).toMatchObject({ pending: true, paths: ['package.json'] })
    expect(h.deps.runs.launch).not.toHaveBeenCalled()
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'cli', confirmEnvironment: true })).toMatchObject({ ok: false, code: 'person-only' })
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', confirmEnvironment: true })).toMatchObject({ ok: true })
    expect(h.state().step).toBe('reviewing')
    expect(h.state().environment).toMatchObject({ source: 'person' })
    expect(h.state().environment?.pending).toBeUndefined()
    expect(h.events).toEqual(['sync'])
  })

  it('runs the agreed install by itself for changed dependency inputs, then goes on to the checks', async () => {
    const h = await harness()
    const install: SessionRecordScriptStep = { key: 'install', scriptId: 'setup', name: 'setup', commands: [{ cwd: h.root, command: 'pnpm install' }] }
    h.deps.checks.declaredAfter = async () => ({ ok: true, steps: [], environment: 'install-commands', install })
    h.deps.svn.assembly = async () => ({ ok: true, value: testAssembly('dependencies', '1', 'package.json') })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state()).toMatchObject({ phase: 'finishing', step: 'checking', execution: { refresh: { cursor: 0, paths: ['package.json'] } } })
    expect(h.state().environment).toBeUndefined()
    const runId = h.state().execution!.runId!
    expect(h.records.get(runId)?.scriptOf).toMatchObject({ phase: 'after', scriptId: 'setup', name: 'setup' })
    await completeRun(h, true, 'setup')
    expect(h.state().step).toBe('reviewing')
    expect(h.state().environment).toMatchObject({ source: 'setup', commands: 'install-commands', paths: ['package.json'] })
    expect(h.state().environment?.pending).toBeUndefined()
    expect(h.state().execution?.refresh?.endedAt).toBeDefined()
    expect(h.events).toEqual(['sync'])
  })

  it('names only the dependency input that changed since setup, not every input of the project (Finish 072)', async () => {
    const h = await harness()
    h.deps.checks.declaredAfter = async () => ({ ok: true, steps: [], environment: 'install-commands' })
    const nodes = (version: string) => [{ path: 'package.json', content: version, metadata: 'm' }, { path: 'pnpm-lock.yaml', content: 'lock', metadata: 'm' },
      { path: 'app-client-ui/package.json', content: 'ui', metadata: 'm' }]
    await h.records.update('worker', (record) => ({ ...record, worktree: { ...record.worktree!, setupBaseline: { at: 1, hashes: {},
      inputs: SetupInputs.of(nodes('1')).digest, inputHashes: SetupInputs.of(nodes('1')).hashes, commands: 'install-commands' } } }))
    h.deps.svn.assembly = async () => ({ ok: true, value: { ...testAssembly(), nodes: nodes('2') } })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state()).toMatchObject({ phase: 'waiting', environment: { pending: true, paths: ['package.json'] } })
  })

  it('waits for the person when the install fails, and runs it again on Read inputs again', async () => {
    const h = await harness()
    const install: SessionRecordScriptStep = { key: 'install', scriptId: 'setup', name: 'setup', commands: [{ cwd: h.root, command: 'pnpm install' }] }
    h.deps.checks.declaredAfter = async () => ({ ok: true, steps: [], environment: 'install-commands', install })
    h.deps.svn.assembly = async () => ({ ok: true, value: testAssembly('dependencies', '1', 'package.json') })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await completeRun(h, false, 'setup')
    expect(h.state()).toMatchObject({ phase: 'waiting', wait: { kind: 'review' }, environment: { pending: true, paths: ['package.json'] } })
    expect(h.state().wait?.reason).toContain('setup that refreshes them failed')
    expect(h.deps.runs.launch).toHaveBeenCalledTimes(1)
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', refreshPreparation: true })
    expect(h.state()).toMatchObject({ phase: 'finishing', step: 'checking', execution: { refresh: { cursor: 0 } } })
    expect(h.state().environment).toBeUndefined()
    expect(h.deps.runs.launch).toHaveBeenCalledTimes(2)
    await completeRun(h, true, 'setup')
    expect(h.state().step).toBe('reviewing')
    expect(h.state().environment).toMatchObject({ source: 'setup' })
  })

  it('repeats checks for generated source, but bounds an unstable generator', async () => {
    const h = await harness()
    h.setChecks([{ key: 'generator', scriptId: 'checks', name: 'Generate and test', commands: [{ cwd: h.root, command: 'test' }] }])
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(h.state().step).toBe('checking')
      h.setHash(`generated-${attempt}`)
      await completeCheck(h, true)
    }
    expect(h.state().phase).toBe('waiting')
    expect(h.state().preparation?.checkedAt).toBeUndefined()
    expect(h.deps.runs.launch).toHaveBeenCalledTimes(3)
    expect(h.events).not.toContain('commit')
  })

  it.each(['clean-file', 'external', 'properties', 'new-file', 'mapping', 'base'] as const)('invalidates the whole prepared assembly after %s changes', async (kind) => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    h.deps.svn.assembly = async () => ({ ok: true, value: testAssembly(kind === 'base' ? 'hash' : kind, kind === 'base' ? '2' : '1') })
    expect(await h.approve()).toMatchObject({ ok: false, code: 'review-stale' })
    expect(h.state().approvedAt).toBeUndefined()
    expect(h.state().preparation?.checkedAt).toBeUndefined()
    expect(h.events).toEqual(['sync'])
    expect(h.records.get('worker')?.worktree).toBeDefined()
  })

  it('returns incoming repository changes to preparation without any update or commit', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    h.deps.svn.assembly = async () => ({ ok: true, value: { ...testAssembly('hash', '1'), incoming: ['shared/lib/file.ts'] } })
    expect(await h.approve()).toMatchObject({ ok: false, code: 'review-stale', detail: expect.stringContaining('shared/lib/file.ts') })
    expect(h.events).toEqual(['sync'])
  })

  it('keeps a refused incoming change through Recheck and withholds Publish until Update and prepare again', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const assembly = h.deps.svn.assembly
    h.deps.svn.assembly = async () => ({ ok: true, value: { ...testAssembly('hash', '1'), incoming: ['lib/ea/version.txt'] } })
    expect(await h.approve()).toMatchObject({ ok: false, code: 'review-stale' })
    expect(h.state().knownIncoming?.paths).toEqual(['lib/ea/version.txt'])
    // Recheck reads no repository freshness: the assembly answers without the incoming path.
    h.deps.svn.assembly = assembly
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', refreshPreparation: true })).toMatchObject({ ok: true })
    expect(h.state()).toMatchObject({ step: 'reviewing', knownIncoming: { paths: ['lib/ea/version.txt'] } })
    expect(h.state().preparation?.checkedAt).toBeDefined()
    const actions = WorktreeWords.actions(h.state())
    expect(actions.some((action) => action.requiresCommit)).toBe(false)
    expect(actions.find((action) => action.id === 'prepare-worktree')).toMatchObject({ primary: true })
    expect(WorktreeWords.presentation(h.state()).title).toBe('Update and prepare again for incoming changes')
    expect(SessionWorkflows.of(h.records.get('worker')!, () => null)!.summary)
      .toBe('Repository changes are not in this worktree yet: lib/ea/version.txt. Press Update and prepare again before publication.')
    expect(await h.approve()).toMatchObject({ ok: false, code: 'review-stale', detail: expect.stringContaining('lib/ea/version.txt') })
    expect(h.events).toEqual(['sync'])
  })

  it('shows a publication guard refusal at preparation as a wait that names the paths and the press, not as an SVN failure (UA1-J05-4)', async () => {
    const h = await harness()
    const prepare = h.deps.svn.prepareCommit
    h.deps.svn.prepareCommit = async () => ({ ok: false, code: 'refused',
      detail: 'Refused: src/take.txt.r3 is an svn conflict file\nRefused: src/marker.txt contains svn conflict markers' })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state()).toMatchObject({ phase: 'waiting', step: 'reviewing', wait: { kind: 'review',
      reason: 'Refused: src/take.txt.r3 is an svn conflict file; Refused: src/marker.txt contains svn conflict markers. '
        + 'Delete leftover svn conflict files, remove conflict markers and settle conflicted paths in the worktree, then press Recheck local changes.' } })
    expect(WorktreeWords.presentation(h.state())).toMatchObject({ title: 'Preparation needs to run again', tone: 'wait' })
    expect(WorktreeWords.actions(h.state()).some((action) => action.requiresCommit)).toBe(false)
    const workflow = SessionWorkflows.of(h.records.get('worker')!, () => null)!
    expect(workflow.summary).toBe(`Waits for you: ${h.state().wait!.reason}`)
    expect(workflow.rounds.flatMap((round) => round.steps)).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'waits', detail: h.state().wait!.reason }),
    ]))
    expect(workflow.rounds.flatMap((round) => round.steps).some((step) => step.body?.kind === 'commit')).toBe(false)
    expect(await h.approve()).toMatchObject({ ok: false, code: 'review-stale', detail: expect.stringContaining('src/take.txt.r3 is an svn conflict file') })
    expect(h.state().wait?.reason).toContain('src/take.txt.r3 is an svn conflict file')
    h.deps.svn.prepareCommit = prepare
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', refreshPreparation: true })).toMatchObject({ ok: true })
    expect(h.state()).toMatchObject({ step: 'reviewing', wait: undefined })
    expect(h.state().preparation?.checkedAt).toBeDefined()
  })

  it('keeps a refusal that is not the conflict gate, such as an unsupported path, an SVN failure without conflict advice', async () => {
    const h = await harness()
    h.deps.svn.prepareCommit = async () => ({ ok: false, code: 'refused', detail: 'Cannot prove landed path žluťoučký' })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().wait).toMatchObject({ kind: 'svn-failed', reason: expect.stringContaining('Cannot prove landed path žluťoučký') })
    expect(h.state().wait?.reason).not.toContain('conflict')
  })

  it('rechecks local edits without an update and requires new approval', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    h.setHash('edit')
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', refreshPreparation: true })).toMatchObject({ ok: true })
    expect(h.state().step).toBe('reviewing')
    expect(h.state().review?.hashes['a.txt']).toBe('edit')
    expect(h.state().preparation?.checks).toBe('none')
    expect(h.events).toEqual(['sync'])
    await h.approve()
    expect(h.events.filter((event) => event === 'commit')).toHaveLength(1)
  })

  it.each(['missing', 'malformed', 'tampered'] as const)('does not publish with a %s preparation manifest', async (kind) => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const path = h.state().preparation!.manifest
    if (kind === 'missing') await rm(path)
    else if (kind === 'malformed') await writeFile(path, '{')
    else if (kind === 'tampered') {
      const manifest = JSON.parse(await readFile(path, 'utf8'))
      manifest.nodes[0].content = 'forged'
      await writeFile(path, JSON.stringify(manifest))
    } else throw new Error(`Unknown case ${kind satisfies never}`)
    expect(await h.approve()).toMatchObject({ ok: false, code: 'review-stale' })
    expect(h.events).not.toContain('commit')
    expect(h.state().journal).toEqual([])
  })

  it('rejects new check declarations after validation and retains the worktree', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    h.setChecks([{ key: 'changed', scriptId: 'checks', name: 'new check', commands: [{ cwd: h.root, command: 'test' }] }])
    expect(await h.approve()).toMatchObject({ ok: false, code: 'review-stale', detail: expect.stringContaining('Declared checks or setup commands changed') })
    expect(h.events).not.toContain('commit')
  })

  it('stops and awaits only this worktree own requested runs after publication', async () => {
    const h = await harness()
    for (const [sessionId, owner, cwd] of [['dev', 'worker', h.root], ['foreign', 'someone-else', h.root], ['outside', 'worker', h.root + '-outside']])
      await h.records.put({ sessionId, title: sessionId, kind: 'shell', life: 'live', binding: { hostInstanceId: 'fixture', generation: 1 }, createdAt: 1,
        directory: { mode: 'adHoc', path: cwd }, scriptOf: { sessionId: owner, phase: 'inner', scriptId: 'requested', name: 'dev' } })
    let refuse = true
    const stop = vi.fn(async (target) => refuse ? { ok: false as const, code: 'host-unreachable' as const, detail: 'Host refused' }
      : { ok: true as const, value: { servedByHostInstanceId: 'fixture', target, diagnostic: 'stopped' as const } })
    const unreachable = async (): Promise<never> => { throw new Error('Unexpected Host call') }
    const scripts = new SessionScriptsManager({ records: h.records, logs: h.logs, now: Date.now, report: () => {}, onCollapsed: () => {},
      host: { runtimeStop: stop, runtimeInspect: unreachable, runtimeRemove: unreachable } })
    h.deps.stopRun = (id) => scripts.confirmStopped(id)
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await h.approve()
    expect(h.state().wait).toMatchObject({ kind: 'removal-blocked', reason: expect.stringContaining('dev') })
    expect(stop).toHaveBeenCalledExactlyOnceWith({ hostInstanceId: 'fixture', runtimeSessionId: 'dev', generation: 1 })
    expect(h.state().verified).toHaveLength(1)
    expect(h.events).not.toContain('remove')
    refuse = false
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.events.filter((event) => event === 'commit')).toHaveLength(1)
  })

  // Worker-agent 031: the Solve with agent helper still ran in the worktree, so the published worktree was kept.
  it('stops the helper agent of this worker in the worktree before removal, and only that one', async () => {
    const h = await harness()
    for (const [sessionId, parent, cwd] of [['solve', 'worker', h.root], ['foreign', 'someone-else', h.root + '-outside']])
      await h.records.put({ sessionId, title: sessionId, kind: 'agent', life: 'live', binding: { hostInstanceId: 'fixture', generation: 1 }, createdAt: 1,
        directory: { mode: 'adHoc', path: cwd }, parent: { sessionId: parent, kind: 'worker' }, agent: { agentId: 'claude', launchMode: 'new' } })
    let refuse = true
    const stopped: string[] = []
    h.deps.stop = async (id) => {
      if (id === 'solve' && refuse) return { ok: false, code: 'host-unreachable', detail: 'Host refused' }
      stopped.push(id)
      await h.records.update(id, (record) => ({ ...record, life: 'ended' }))
      return { ok: true, value: undefined }
    }
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await h.approve()
    expect(h.state().wait).toMatchObject({ kind: 'removal-blocked', reason: expect.stringContaining('helper session solve (solve) did not stop: Host refused') })
    expect(h.events).not.toContain('remove')
    refuse = false
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(stopped).toEqual(['solve', 'worker'])
    expect(h.records.get('foreign')?.life).toBe('live')
    expect(h.events).toContain('remove')
  })

  it.each(['start', 'drive'] as const)('%s waits for automatic sync to release its lease and reaches review', async (operation) => {
    const h = await harness()
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const set = { entries: [], readAt: 1, revision: 1, baseRevision: 1, more: 0 }
    const sync = new SyncStep({ records: h.records, commands: h.deps.commands,
      svn: { updateTargets: emptyUpdateTargets, revisionOf: async () => ({ ok: true, value: 1 }), headRevisionOf: async () => ({ ok: true, value: 1 }),
        scheduleMissing: async () => ({ ok: true, value: undefined }), conflictSet: async () => ({ ok: true, value: { revision: 1, facts: [], rows: [] } }),
        unmoved: async () => ({ ok: true, value: false }) },
      runner: { run: async () => { entered(); await gate; return { ok: true, output: '', exitCode: 0, runId: 'sync' } } },
      conflicts: { remember: async () => ({ ok: true, value: { set, memory: { actionId: 'sync', readAt: 1, paths: [] } } }),
        remembered: async (_action, memory) => ({ ok: true, value: { set, memory, reasons: [] } }), fix: async (action) => ({ kind: 'settled', action }) },
      ready: { current: async () => true }, busyReason: () => null, holdInput: () => () => {}, changed: () => {} })
    h.deps.sync = sync
    if (operation === 'drive')
      await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'finishing', step: 'syncing',
        execution: { root: h.root, checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 1 } } }))
    const background = sync.run('worker', 'ready')
    await started
    const finishing = operation === 'start' ? h.driver.start('worker', { choice: 'commit', requestedBy: 'window' }) : h.driver.drive('worker')
    expect(await sync.run('worker', 'ready')).toMatchObject({ ok: false, code: 'merge-pending' })
    release()
    expect(await background).toMatchObject({ ok: true })
    await finishing
    expect(h.state()).toMatchObject({ step: 'reviewing' })
    expect(h.state().review).toBeDefined()
    expect(h.failures).toEqual([])
    expect(h.events).not.toContain('commit')
    const lease = await h.deps.commands.lease.take(h.root, 'finish')
    expect(lease.ok).toBe(true)
    if (lease.ok) await lease.release()
  })

  it('retries a refused merger launch once and starts its wall-clock limit at the actual launch', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    let now = Date.now()
    h.deps.now = () => now
    h.deps.svn.logOf = async () => ({ ok: true, value: [] })
    h.deps.svn.hashes = async () => ({ ok: true, value: { 'a.txt': 'conflict' } })
    h.deps.svn.conflictSet = async () => ({ ok: true, value: { revision: 2,
      facts: [{ path: 'a.txt', kind: 'text', takesArgument: true, tree: null, sidecars: [], properties: [], content: null }],
      rows: [{ path: 'a.txt', item: 'conflicted', conflict: true, base: 2 }] } })
    vi.mocked(h.deps.resolver.withMarkers).mockResolvedValue(['a.txt'])
    h.deps.createResolver = vi.fn().mockResolvedValueOnce({ ok: false, code: 'invalid-spec', detail: 'no terminal available' })
      .mockResolvedValue({ ok: true, value: undefined })
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'waiting', step: 'worker-resolving', review: undefined,
      wait: { kind: 'conflict-person', reason: 'Choose resolution', at: now },
      syncConflictSet: { readAt: 1, baseRevision: 1, revision: 2, more: 0,
        entries: [{ path: 'a.txt', kind: 'text', shape: 'text-overlap', state: 'person', options: ['merged'], facts: {} }] } } }))
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', agent: true })
    expect(h.state().wait?.reason).toBe('no terminal available')
    expect(h.state().execution?.runId).toBeUndefined()
    expect(h.state().execution?.merger).toBeUndefined()
    now += 30 * 60_000
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', agent: true })
    expect(h.deps.createResolver).toHaveBeenCalledTimes(2)
    expect(h.state().conflictProgress).toMatchObject({ owner: 'merger', milliseconds: 0, observedAt: now })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', agent: true })
    expect(h.deps.createResolver).toHaveBeenCalledTimes(2)
    now += 20 * 60_000
    await h.driver.drive('worker')
    expect(h.state().wait?.reason).toBe('The merger made no settlement for twenty minutes')
    expect(h.events).not.toContain('commit')
  })

  it.each(['live', 'uncaptured'] as const)('keeps a %s merger behind the conflict wait on a repeated press', async (kind) => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const syncs = h.events.filter((event) => event === 'sync').length
    await h.records.put({ sessionId: 'merger', kind: 'shell', title: 'merge', createdAt: 1, life: kind === 'live' ? 'live' : 'ended', binding: null, directory: { mode: 'adHoc', path: h.root } })
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'waiting', step: 'worker-resolving', review: undefined,
      wait: { kind: 'conflict-person', reason: 'The merger made no settlement for twenty minutes', at: Date.now() },
      execution: { ...record.worktreeLifecycle!.execution!, runId: 'merger', merger: { runId: 'merger', setAt: 1, startedAt: 1 } },
      syncConflictSet: { readAt: 1, baseRevision: 1, revision: 2, more: 0, entries: [
        { path: 'a.txt', kind: 'text', shape: 'text-overlap', state: 'settled', by: 'agent', settledWith: 'merged', options: ['merged'], facts: {} },
      ] } } }))
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state()).toMatchObject({ phase: 'waiting', step: 'worker-resolving', execution: { runId: 'merger' } })
    expect(h.state().execution?.merger?.endedAt).toBeUndefined()
    expect(h.state().review).toBeUndefined()
    expect(h.events.filter((event) => event === 'sync')).toHaveLength(syncs)
    expect(h.events).not.toContain('commit')
  })

  it.each([false, true])('restarts only the reopened conflict journal while merger live is %s', async (merging) => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const saved = join(h.root, 'saved-local.txt')
    await writeFile(saved, 'preserved session content')
    const completed = { option: 'keep-both' as const, done: 5 }
    h.deps.svn.conflictSet = async () => ({ ok: true, value: { revision: 2, facts: [],
      rows: [{ path: 'folder/incoming', item: 'deleted', base: 2, conflict: false }] } })
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'finishing', step: 'worker-resolving', review: undefined,
      execution: { ...record.worktreeLifecycle!.execution!, ...(merging ? { merger: { runId: 'merger', setAt: 1, startedAt: 1 } } : {}) },
      syncJournals: { folder: completed, unaffected: completed, retained: completed },
      syncConflictSet: { readAt: 1, baseRevision: 1, revision: 2, more: 0, entries: [
        { path: 'folder', kind: 'tree', shape: 'obstructed-dir', state: 'settled', by: 'jamat', settledWith: 'keep-both', journal: completed,
          options: ['keep-both'], saved, facts: { action: 'added', incomingRevision: 2 } },
        { path: 'unaffected', kind: 'tree', shape: 'obstructed-dir', state: 'settled', by: 'jamat', settledWith: 'keep-both', journal: completed,
          options: ['keep-both'], facts: { action: 'added', incomingRevision: 2 } },
      ] } } }))
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().syncConflictSet?.entries[0]).toMatchObject({ state: 'person', shape: 'drops-incoming', saved })
    expect(h.state().syncConflictSet?.entries[0].journal).toBeUndefined()
    expect(h.state().syncJournals).toEqual({ retained: completed })
    expect(h.state().syncConflictSet?.entries.find((entry) => entry.path === 'unaffected')?.journal).toEqual(completed)
    expect(await readFile(saved, 'utf8')).toBe('preserved session content')
    expect(h.events).not.toContain('commit')
  })

  it('waits without launching a merger when fresh idle fallback reaches an unavailable resolver', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    let now = Date.now()
    h.deps.now = () => now
    h.deps.resolver.unavailable = () => 'no configured merger'
    h.deps.createResolver = vi.fn()
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'finishing', step: 'worker-resolving',
      syncConflictSet: { readAt: now, baseRevision: 1, revision: 2, more: 0,
        entries: [{ path: 'a.txt', kind: 'text', shape: 'text-overlap', state: 'agent', options: ['merged'], facts: {} }] } } }))
    for (let poll = 0; poll < 140 && h.state().wait === undefined; poll++) { now += 9000; await h.driver.drive('worker') }
    expect(h.state().wait).toMatchObject({ kind: 'conflict-person', reason: expect.stringContaining('no merger runs here') })
    expect(h.state().syncConflictSet?.entries[0].state).toBe('person')
    expect(h.deps.createResolver).not.toHaveBeenCalled()
    expect(h.events).not.toContain('commit')
  })

  it.each(['outside edit', 'foreign commit', 'clean', 'restart', 'timeout'] as const)('checks %s once after the captured merger verdict before review', async (change) => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    h.setDirty(['a.txt', 'notes.txt'])
    h.deps.svn.hashes = async () => ({ ok: true, value: { 'a.txt': 'merged', 'notes.txt': change === 'outside edit' ? 'new' : 'old' } })
    h.deps.svn.baseAbove = vi.fn(async () => ({ ok: true as const, value: change === 'foreign commit' ? 3 : null }))
    await h.results.writeHandover(h.state().actionId!, { 'a.txt': 'conflicted', 'notes.txt': 'old' })
    await h.records.put({ sessionId: 'merger', kind: 'shell', title: 'merge', createdAt: 1, life: 'live', binding: null, directory: { mode: 'adHoc', path: h.root } })
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'finishing', step: 'worker-resolving', review: undefined,
      execution: { ...record.worktreeLifecycle!.execution!, runId: 'merger', merger: { runId: 'merger', setAt: 1, startedAt: 1 } },
      syncConflictSet: { readAt: 1, baseRevision: 1, revision: 2, more: 0,
        entries: [{ path: 'a.txt', kind: 'text', shape: 'text-overlap', state: 'agent', options: ['merged'], facts: {} }] } } }))
    h.deps.sync.resolve = async () => {
      await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, step: 'checking',
        syncConflictSet: { ...record.worktreeLifecycle!.syncConflictSet!, entries: record.worktreeLifecycle!.syncConflictSet!.entries.map((entry) => ({ ...entry, state: 'settled', by: 'agent', settledWith: 'merged' })) } } }))
      return { ok: true, value: { sessionId: 'worker', path: 'a.txt', state: 'settled', left: 0 } }
    }
    expect(await h.driver.resolveConflict('worker', { path: 'a.txt', option: 'merged', confirm: false, requestedBy: 'cli', by: 'agent' })).toMatchObject({ ok: true })
    expect(h.state().step).toBe('worker-resolving')
    expect(h.state().review).toBeUndefined()
    expect(await h.driver.noteVerdict('worker', { kind: 'succeeded' })).toBe(false)
    await h.logs.write('worker', 'merger', 'full merger output')
    await h.records.update('merger', (record) => ({ ...record, life: 'ended', exitCode: 0 }))
    await h.records.update('worker', (record) => ({ ...record, scriptRuns: [{ runId: 'merger', phase: 'after', scriptId: 'svn-merge', name: 'merge', title: 'merge', commands: [], startedAt: 1, endedAt: 2, exitCode: 0,
      log: { state: 'saved', bytes: 18, truncated: false }, outcome: 'succeeded' }] }))
    const update = h.records.update.bind(h.records)
    vi.spyOn(h.records, 'update').mockImplementation(async (...args) => {
      const before = h.state().execution?.merger?.checkedAt
      const result = await update(...args)
      if (before === undefined && h.state().execution?.merger?.checkedAt !== undefined) {
        if (change === 'outside edit' || change === 'foreign commit') expect(h.state().wait?.kind).toBe('conflict-person')
        else expect(h.state()).toMatchObject({ step: 'syncing', execution: { checkCursor: 0 } })
      }
      return result
    })
    if (change === 'timeout') {
      await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'waiting',
        wait: { kind: 'conflict-person', reason: 'The merger made no settlement for twenty minutes', at: Date.now() } } }))
      await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    } else if (change === 'restart') {
      await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, execution: { ...record.worktreeLifecycle!.execution!,
        verdict: { kind: 'succeeded' }, merger: { ...record.worktreeLifecycle!.execution!.merger!, endedAt: 2 } } } }))
      await new FinishDriver(h.deps).drive('worker')
    } else {
      expect(await h.driver.noteVerdict('worker', { kind: 'succeeded' })).toBe(true)
      await h.driver.drive('worker')
    }
    expect(h.state().execution?.merger?.checkedAt).toBeDefined()
    expect(h.state().execution?.runId).toBeUndefined()
    expect(h.state().execution?.verdict).toBeUndefined()
    if (change === 'outside edit' || change === 'foreign commit') {
      expect(h.state().wait).toMatchObject({ kind: 'conflict-person', reason: expect.stringContaining(change === 'outside edit' ? 'notes.txt' : 'r3') })
      expect(h.state().review).toBeUndefined()
      await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    }
    expect(h.state().step).toBe('reviewing')
    expect(h.deps.svn.baseAbove).toHaveBeenCalledTimes(1)
    expect(h.events).not.toContain('commit')
    expect(h.failures).toEqual([])
  })

  it('finishes a persisted no-window review wait after restart without repeating its notice', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'cli' })
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'finishing', wait: undefined,
      execution: { ...record.worktreeLifecycle!.execution!, reviewWaitAt: undefined } } }))
    vi.mocked(h.deps.handoffs.notifyCaller).mockClear()
    expect(WorktreeWords.reviewReady(h.state())).toBe(false)
    const prior = h.state().version
    await new FinishDriver(h.deps).drive('worker')
    expect(h.state()).toMatchObject({ phase: 'waiting', step: 'reviewing', version: prior + 1, wait: { kind: 'waiting-for-review' }, review: { version: prior + 1 } })
    expect(WorktreeWords.reviewReady(h.state())).toBe(true)
    expect(h.state().execution?.reviewWaitAt).toBe(h.state().wait?.at)
    await new FinishDriver(h.deps).drive('worker')
    expect(h.deps.handoffs.notifyCaller).toHaveBeenCalledTimes(1)
    expect(h.events).not.toContain('commit')
  })
  it.each(['window', 'cli'] as const)('exposes only the final ready review version to %s observers', async (requestedBy) => {
    const h = await harness()
    const versions: number[] = []
    let preparing = false
    const update = h.records.update.bind(h.records)
    vi.spyOn(h.records, 'update').mockImplementation(async (...args) => {
      const result = await update(...args)
      const record = h.records.get('worker')!
      const state = record.worktreeLifecycle!
      if (state.step === 'reviewing' && state.execution !== undefined) {
        const workflow = SessionWorkflows.of(record, () => null)!
        const body = workflow.rounds.flatMap((round) => round.steps).some((step) => step.body?.kind === 'commit')
        if (!WorktreeWords.reviewReady(state)) {
          preparing = true
          expect(body).toBe(false)
          expect(workflow.actions.some((action) => action.requiresCommit)).toBe(false)
          expect(workflow.summary).toBe('Preparing the synced review')
          expect(WorktreeWords.presentation(state)).toMatchObject({ tone: 'running' })
        } else {
          expect(body).toBe(true)
          expect(workflow.actions.some((action) => action.requiresCommit)).toBe(true)
          expect(WorktreeWords.presentation(state)).toMatchObject({ title: 'Ready for validation', tone: 'wait' })
          versions.push(state.version)
        }
      }
      return result
    })
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy })).toMatchObject({ ok: true })
    expect(preparing).toBe(true)
    expect([...new Set(versions)]).toEqual([h.state().version])
    const displayed = h.state().version
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, version: displayed + 1,
      review: { ...record.worktreeLifecycle!.review!, version: displayed + 1 } } }))
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', selection: [join(h.root, 'a.txt')],
      message: '[App] Fix file', messageSource: 'person-local', reviewVersion: displayed })).toMatchObject({ ok: false, code: 'review-stale' })
    expect(h.events).not.toContain('commit')
  })
  it('reconciles a failed publication before a new approval, then stops two identical failures across real presses', async () => {
    const h = await harness()
    h.failCommit('auth')
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await h.approve()
    expect(h.state().wait?.kind).toBe('auth')
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().wait?.kind).toBe('review')
    expect(h.events.filter((e) => e === 'commit')).toHaveLength(1)
    const repeated = await h.approve()
    expect(repeated, JSON.stringify(h.state())).toMatchObject({ ok: true })
    expect(h.state().stoppedFailure, JSON.stringify(h.state())).toContain('Stopped after two identical failures')
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'cli' })).toMatchObject({ ok: false, code: 'svn-failed' })
    expect(h.events.filter((e) => e === 'commit')).toHaveLength(2)
    h.failCommit(undefined)
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })).toMatchObject({ ok: true })
    expect(h.state().stoppedFailure).toBeUndefined()
    expect(h.events.filter((e) => e === 'commit')).toHaveLength(2)
    await h.approve()
    expect(h.events.filter((e) => e === 'commit')).toHaveLength(3)
    expect(h.state().phase).toBe('landed')
  })
  it('recovers an accepted commit after a failed response on the next press without duplicate publication', async () => {
    const h = await harness()
    h.failCommit('accepted')
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await h.approve()
    h.deps.svn.logSince = async () => ({ ok: true, value: [{ revision: 2, author: null, date: Date.now(), message: '[App] Fix file', paths: ['/trunk/a.txt'] }] })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.events.filter((e) => e === 'commit')).toHaveLength(1)
    expect(h.state().execution?.evidence.map((row) => row.revision)).toEqual([2])
    expect(h.state().verified?.[0].revision).toBe(2)
  })
  it('reviews a corrective publication explicitly and retains both revisions while ordinary Retry only verifies', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const publish = h.deps.svn.publicationRows
    h.deps.svn.publicationRows = async (...args) => { h.setHash('edited-after-publication'); return publish(...args) }
    await h.approve()
    expect(h.state().wait?.kind).toBe('published-with-differences')
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.events.filter((e) => e === 'commit')).toHaveLength(1)
    h.setDirty(['a.txt'])
    h.deps.svn.publicationRows = publish
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', reviewCorrection: true })
    expect(h.state().step).toBe('reviewing')
    await h.approve()
    expect(h.events.filter((e) => e === 'commit')).toHaveLength(2)
    expect(h.state().execution?.evidence.map((row) => row.revision)).toEqual([3])
    expect(h.state().publication?.revisions.map((row) => row.revision)).toEqual([2, 3])
    const result = await h.results.list({ sessionId: 'worker' })
    expect(result.find((row) => row.result === 'committed')?.revisions.map((row) => row.revision)).toEqual([2, 3])
  })
  it('keeps in the result the message each repository was committed with, not an earlier draft', async () => {
    const h = await harness()
    h.deps.svn.assembly = async () => ({ ok: true, value: testAssembly() })
    const paths = ['lib/ea/a.txt', 'a.txt']
    for (const path of paths) { await mkdir(join(h.root, path, '..'), { recursive: true }); await writeFile(join(h.root, path), 'worker\r\n') }
    h.setDirty(paths)
    const roots = ['lib/ea', ''].map((own, index) => ({ own, path: join(h.root, own), pinned: false,
      changed: [{ path: 'a.txt', kind: 'item' as const, conflict: false }], repository: ['https://svn/ea', 'https://svn/app'][index] }))
    h.deps.svn.reviewRoots = async () => ({ ok: true, value: roots })
    h.deps.svn.lowerBounds = async () => ({ ok: true, value: Object.fromEntries(roots.map((root) => [root.own,
      { repository: root.repository, base: '/trunk', rootBase: 1, since: 1 }])) })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const finals = { '[ea]': '[ea] EA version 2', '[app]': '[app] Limit 20 without the legacy cap' }
    const repositories = h.state().review!.repositories!.map((row) => ({ ...row, message: finals[row.expectedPrefix as keyof typeof finals], source: 'person-local' as const }))
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', selection: paths.map((path) => join(h.root, path)),
      message: '[app] Limit 20 (first draft)', messageSource: 'person-local', repositories, reviewVersion: h.state().version })).toMatchObject({ ok: true })
    expect(h.state().phase).toBe('landed')
    const result = (await h.results.list({ sessionId: 'worker' })).find((row) => row.result === 'committed')!
    expect(result.message).toBe('[app] Limit 20 without the legacy cap')
    expect(result.messages?.map((row) => [row.repository, row.message]).sort()).toEqual([['https://svn/app', '[app] Limit 20 without the legacy cap'], ['https://svn/ea', '[ea] EA version 2']])
    expect(WorktreeResultsStore.dtoOf(result).messages).toEqual(result.messages)
  })
  it('names the mount of two repositories of one name and keeps the source of each repository message (UA1-J12-5, UA1-J12-7)', async () => {
    const h = await harness()
    h.deps.svn.assembly = async () => ({ ok: true, value: testAssembly() })
    const paths = ['lib/ea/a.txt', 'a.txt']
    for (const path of paths) { await mkdir(join(h.root, path, '..'), { recursive: true }); await writeFile(join(h.root, path), 'worker\r\n') }
    h.setDirty(paths)
    const roots = ['lib/ea', ''].map((own, index) => ({ own, path: join(h.root, own), pinned: false,
      changed: [{ path: 'a.txt', kind: 'item' as const, conflict: false }], repository: ['https://svn/ea/j12', 'https://svn/app/j12'][index] }))
    h.deps.svn.reviewRoots = async () => ({ ok: true, value: roots })
    h.deps.svn.lowerBounds = async () => ({ ok: true, value: Object.fromEntries(roots.map((root) => [root.own,
      { repository: root.repository, base: '/trunk', rootBase: 1, since: 1 }])) })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const repositories = h.state().review!.repositories!.map((row) => ({ ...row, message: `[j12] ${row.root === h.root ? 'App' : 'EA'} change`,
      source: row.root === h.root ? 'person-local' as const : 'agent-proposal' as const }))
    // The top-level message is the hidden one of a review with several repositories.
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', selection: paths.map((path) => join(h.root, path)),
      message: '[j12] Hidden proposal', messageSource: 'agent-proposal', repositories, reviewVersion: h.state().version })).toMatchObject({ ok: true })
    const result = (await h.results.list({ sessionId: 'worker' })).find((row) => row.result === 'committed')!
    expect(result.lines[0]).toMatch(/^Published: j12 \(\.\) r\d+, j12 \(lib\/ea\) r\d+$/)
    expect(result).toMatchObject({ message: '[j12] App change', messageSource: 'person-local' })
    expect(result.messages?.map((row) => [row.message, row.source]).sort()).toEqual([['[j12] App change', 'person-local'], ['[j12] EA change', 'agent-proposal']])
  })
  it('names the mount of a lone published repository whose name an unchanged root of the worktree has too (UA1-J13-5)', async () => {
    const h = await harness()
    h.deps.svn.assembly = async () => ({ ok: true, value: testAssembly() })
    const paths = ['lib/ea/a.txt']
    await mkdir(join(h.root, 'lib/ea'), { recursive: true })
    await writeFile(join(h.root, 'lib/ea/a.txt'), 'worker\r\n')
    h.setDirty(paths)
    const roots = ['lib/ea', ''].map((own, index) => ({ own, path: join(h.root, own), pinned: false,
      changed: own === '' ? [] : [{ path: 'a.txt', kind: 'item' as const, conflict: false }], repository: ['https://svn/ea/j12', 'https://svn/app/j12'][index] }))
    h.deps.svn.reviewRoots = async () => ({ ok: true, value: roots })
    h.deps.svn.lowerBounds = async (wanted) => ({ ok: true, value: Object.fromEntries(roots.filter((root) => wanted.some((row) => row.own === root.own))
      .map((root) => [root.own, { repository: root.repository, base: '/trunk', rootBase: 1, since: 1 }])) })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const repositories = h.state().review!.repositories!.map((row) => ({ ...row, message: '[j12] EA change', source: 'person-local' as const }))
    expect(repositories.map((row) => row.root)).toEqual([join(h.root, 'lib/ea')])
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', selection: paths.map((path) => join(h.root, path)),
      message: '[j12] EA change', messageSource: 'person-local', repositories, reviewVersion: h.state().version })).toMatchObject({ ok: true })
    const result = (await h.results.list({ sessionId: 'worker' })).find((row) => row.result === 'committed')!
    expect(result.lines[0]).toMatch(/^Published: j12 \(lib\/ea\) r\d+$/)
    expect(h.state().execution?.mounts).toEqual([{ own: 'lib/ea', repository: 'https://svn/ea/j12' }, { own: '', repository: 'https://svn/app/j12' }])
  })
  it('publishes two mounts before their owner with separate messages and retains partial receipts on retry', async () => {
    const h = await harness()
    h.deps.svn.assembly = async () => ({ ok: true, value: testAssembly() })
    const paths = ['shared/front/a.txt', 'shared/back/a.txt', 'a.txt']
    for (const path of paths) { await mkdir(join(h.root, path, '..'), { recursive: true }); await writeFile(join(h.root, path), 'worker\r\n') }
    h.setDirty(paths)
    const roots = ['shared/front', 'shared/back', ''].map((own, index) => ({ own, path: join(h.root, own), pinned: false,
      changed: [{ path: 'a.txt', kind: 'item' as const, conflict: false }], repository: ['https://svn/front', 'https://svn/back', 'https://svn/apps'][index] }))
    h.deps.svn.reviewRoots = async () => ({ ok: true, value: roots })
    h.deps.svn.lowerBounds = async () => ({ ok: true, value: Object.fromEntries(roots.map((root) => [root.own,
      { repository: root.repository, base: '/trunk', rootBase: 1, since: 1 }])) })
    const messages: string[] = []
    const write = h.logs.writeCommitFiles.bind(h.logs)
    vi.spyOn(h.logs, 'writeCommitFiles').mockImplementation(async (...args) => { messages.push(args[3]); return write(...args) })
    const run = h.deps.runner.run.bind(h.deps.runner)
    let failed = false
    vi.spyOn(h.deps.runner, 'run').mockImplementation(async (...args) => {
      if (args[1] === 'commit' && args[2] === h.root && !failed) { failed = true; return { ok: false, failure: 'out-of-date', output: 'out of date', exitCode: 1, runId: 'failed-main' } }
      return run(...args)
    })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const repositories = h.state().review!.repositories!.map((row) => ({ ...row, message: `${row.expectedPrefix} Fix`, source: 'person-local' as const }))
    expect(repositories.map((row) => row.expectedPrefix)).toEqual(['[front]', '[back]', '[apps]'])
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', selection: paths.map((path) => join(h.root, path)),
      message: '[apps] Fix', messageSource: 'person-local', repositories, reviewVersion: h.state().version })).toMatchObject({ ok: true })
    expect(h.state().wait?.kind).toBe('partially-landed')
    expect(h.state().verified?.map((row) => row.root)).toEqual(roots.slice(0, 2).map((row) => row.path))
    expect(h.records.get('worker')?.commitReceipts).toHaveLength(2)
    h.setDirty(['a.txt'])
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().step).toBe('reviewing')
    expect(h.records.get('worker')?.commitReceipts).toHaveLength(2)
    await h.approve()
    expect(h.state().phase).toBe('landed')
    expect(h.records.get('worker')?.commitReceipts).toHaveLength(3)
    expect(messages).toEqual(['[front] Fix', '[back] Fix', '[apps] Fix', '[App] Fix file'])
    expect(h.events.filter((event) => event === 'commit')).toHaveLength(3)
    expect(h.failures).toEqual([])
  })
  it.each(['finish', 'discard'] as const)('keeps the messages of mounts an earlier kept action published in the result of a later %s', async (later) => {
    const h = await harness()
    h.deps.svn.assembly = async () => ({ ok: true, value: testAssembly() })
    const paths = ['shared/front/a.txt', 'a.txt']
    for (const path of paths) { await mkdir(join(h.root, path, '..'), { recursive: true }); await writeFile(join(h.root, path), 'worker\r\n') }
    h.setDirty(paths)
    const roots = ['shared/front', ''].map((own, index) => ({ own, path: join(h.root, own), pinned: false,
      changed: [{ path: 'a.txt', kind: 'item' as const, conflict: false }], repository: ['https://svn/front', 'https://svn/apps'][index] }))
    h.deps.svn.reviewRoots = async () => ({ ok: true, value: roots })
    h.deps.svn.lowerBounds = async () => ({ ok: true, value: Object.fromEntries(roots.map((root) => [root.own,
      { repository: root.repository, base: '/trunk', rootBase: 1, since: 1 }])) })
    const run = h.deps.runner.run.bind(h.deps.runner)
    let refuse = true
    vi.spyOn(h.deps.runner, 'run').mockImplementation(async (...args) => {
      if (args[1] === 'commit' && args[2] === h.root && refuse) return { ok: false, failure: 'other', output: 'Commit blocked by pre-commit hook', exitCode: 1, runId: 'refused-main' }
      return run(...args)
    })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const repositories = h.state().review!.repositories!.map((row) => ({ ...row, message: `${row.expectedPrefix} Fix`, source: 'person-local' as const }))
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', selection: paths.map((path) => join(h.root, path)),
      message: '[apps] Fix', messageSource: 'person-local', repositories, reviewVersion: h.state().version })
    const kept = h.state().actionId!
    expect(h.state().publication?.revisions.map((row) => row.repository)).toEqual(['https://svn/front'])
    await h.driver.start('worker', { choice: 'keep', requestedBy: 'window' })
    refuse = false
    h.setDirty(['a.txt'])
    if (later === 'finish') {
      await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
      expect(reviewBodyOf(h)).toMatchObject({ repositories: [{ repository: 'https://svn/apps' }], separateMessages: true })
      await h.approve()
      expect(h.state().phase).toBe('landed')
    }
    else await h.driver.start('worker', { choice: 'discard', requestedBy: 'window' })
    expect(h.state().actionId).not.toBe(kept)
    const result = (await h.results.list({ sessionId: 'worker' })).find((row) => row.actionId === h.state().actionId)!
    expect(result.revisions.map((row) => row.repository).sort()).toEqual(later === 'finish' ? ['https://svn/apps', 'https://svn/front'] : ['https://svn/front'])
    expect(result.messages?.find((row) => row.repository === 'https://svn/front')).toEqual({ repository: 'https://svn/front', revision: 2, message: '[front] Fix', adoptedFrom: kept })
    if (later === 'finish') expect(result.messages?.find((row) => row.repository === 'https://svn/apps')).toEqual({ repository: 'https://svn/apps', revision: 3, message: '[App] Fix file', source: 'person-local', acknowledgedFindings: [] })
    expect(WorktreeResultsStore.dtoOf(result).messages).toEqual(result.messages)
  })

  it('gives a lone repository its own labelled message when it is a mount, and keeps one plain message for the project alone', async () => {
    const plain = await harness()
    await plain.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(reviewBodyOf(plain)).toMatchObject({ repositories: [{ root: plain.root }] })
    expect(reviewBodyOf(plain)?.separateMessages).toBeUndefined()
    const h = await harness()
    h.deps.svn.assembly = async () => ({ ok: true, value: testAssembly() })
    await mkdir(join(h.root, 'lib/ea'), { recursive: true })
    await writeFile(join(h.root, 'lib/ea/a.txt'), 'worker\r\n')
    h.setDirty(['lib/ea/a.txt'])
    const roots = ['lib/ea', ''].map((own, index) => ({ own, path: join(h.root, own), pinned: false,
      changed: index === 0 ? [{ path: 'a.txt', kind: 'item' as const, conflict: false }] : [], repository: ['https://svn/ea', 'https://svn/app'][index] }))
    h.deps.svn.reviewRoots = async () => ({ ok: true, value: roots })
    h.deps.svn.lowerBounds = async () => ({ ok: true, value: Object.fromEntries(roots.map((root) => [root.own,
      { repository: root.repository, base: '/trunk', rootBase: 1, since: 1 }])) })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(reviewBodyOf(h)).toMatchObject({ repositories: [{ repository: 'https://svn/ea' }], separateMessages: true })
  })

  function reviewBodyOf(h: Awaited<ReturnType<typeof harness>>) {
    const body = SessionWorkflows.of(h.records.get('worker')!, () => null)?.rounds.flatMap((round) => round.steps).find((step) => step.body?.kind === 'commit')?.body
    return body?.kind === 'commit' ? body : undefined
  }

  async function completeCheck(h: Awaited<ReturnType<typeof harness>>, passed: boolean) {
    await completeRun(h, passed, 'checks')
  }

  async function completeRun(h: Awaited<ReturnType<typeof harness>>, passed: boolean, scriptId: 'checks' | 'setup') {
    const runId = h.state().execution!.runId!
    await h.logs.write('worker', runId, 'complete check output\n')
    await h.records.update(runId, (run) => ({ ...run, life: 'ended', exitCode: passed ? 0 : 1,
      pendingOperationId: undefined, pendingOperationKind: undefined }))
    await h.records.update('worker', (record) => ({ ...record, scriptRuns: [...record.scriptRuns ?? [], { runId, title: scriptId, phase: 'after', scriptId, name: scriptId, commands: [], startedAt: 1, log: { state: 'saved', bytes: 22, truncated: false }, endedAt: Date.now(), exitCode: passed ? 0 : 1, outcome: passed ? 'succeeded' : 'failed' }] }))
    const changes = Reconciler.plan(h.records.list(), { hostInstanceId: 'host', throughRevision: 1, sessions: [] })
    expect(changes).toContainEqual(expect.objectContaining({ kind: passed ? 'script-succeeded' : 'script-failed', sessionId: 'worker', gate: 'action' }))
    expect(await h.driver.noteVerdict('worker', passed ? { kind: 'succeeded' } : { kind: 'failed', reason: 'check failed' })).toBe(true)
    await h.driver.drive('worker')
  }

  it('takes a message the person wrote without acknowledgements, but refuses an empty one', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const press = { choice: 'commit' as const, requestedBy: 'window' as const, selection: [join(h.root, 'a.txt')],
      reviewVersion: h.state().version, messageSource: 'person-local' as const }
    expect(await h.driver.start('worker', { ...press, message: '' })).toMatchObject({ ok: false, code: 'message-unchecked' })
    expect(await h.driver.start('worker', { ...press, message: 'Fix file' })).toMatchObject({ ok: true })
  })

  it('answers an approval that failed before it was saved with its reason, not an uncertain outcome (Finish 072)', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    h.deps.svn.commitHashes = async () => ({ ok: false, code: 'svn-failed', detail: 'svn: E155004: Working copy is locked' })
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', selection: [join(h.root, 'a.txt')], reviewVersion: h.state().version,
      message: 'Fix file', messageSource: 'person-local' })).toEqual({ ok: false, code: 'svn-failed', detail: 'svn: E155004: Working copy is locked' })
    expect(h.state()).toMatchObject({ step: 'reviewing', approvedAt: undefined })
    expect(h.events).not.toContain('commit')
  })

  it('requires acknowledgements of a proposed message and preserves them in the final result', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const press = { choice: 'commit' as const, requestedBy: 'window' as const, selection: [join(h.root, 'a.txt')],
      reviewVersion: h.state().version, messageSource: 'agent-proposal' as const }
    expect(await h.driver.start('worker', { ...press, message: '' })).toMatchObject({ ok: false, code: 'message-unchecked' })
    expect(await h.driver.start('worker', { ...press, message: 'Fix file' })).toMatchObject({ ok: false, code: 'message-unchecked' })
    expect(h.events).not.toContain('commit')
    expect(await h.driver.start('worker', { ...press, message: 'Fix file', acknowledgedFindings: ['no-prefix'] })).toMatchObject({ ok: true })
    expect(h.results.list({})[0].acknowledgedFindings).toEqual(['no-prefix'])
  })

  it('refuses to discard setup source from the tested selection during publication', async () => {
    const h = await harness()
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, checkBaseline: { 'a.txt': 'hash' } } }))
    h.deps.svn.revertSetup = vi.fn(async () => ({ ok: true as const, value: undefined }))
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().review?.selection).toEqual(['a.txt'])
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', selection: [], message: '', reviewVersion: h.state().version }))
      .toMatchObject({ ok: false, code: 'review-stale' })
    expect(h.deps.svn.revertSetup).not.toHaveBeenCalled()
    expect(h.events).not.toContain('commit')
    expect(h.events).not.toContain('remove')
  })

  it.each(['unavailable', 'ambiguous'] as const)('never replaces a migrated commit while its log is %s, including another Finish press', async (kind) => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'finishing', step: 'committing',
      execution: { ...record.worktreeLifecycle!.execution!, runId: 'old-commit', verdict: { kind: 'succeeded', exitCode: 0 } } } }))
    if (kind === 'ambiguous') await h.logs.write('worker', 'old-commit', 'Connection closed without a revision')
    const syncs = h.events.filter((event) => event === 'sync').length
    await h.driver.drive('worker')
    expect(h.state().wait?.kind).toBe(kind === 'unavailable' ? 'svn-failed' : 'published-with-differences')
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().phase).toBe('waiting')
    expect(h.events).not.toContain('commit')
    expect(h.events.filter((event) => event === 'sync')).toHaveLength(syncs)
    expect(h.deps.removal.remove).not.toHaveBeenCalled()
  })

  it.each([1, 4])('verifies a foreign receipt at or before HEAD %s without another commit route', async (head) => {
    const h = await harness()
    h.setDirty([])
    h.deps.svn.lowerBounds = async () => ({ ok: true, value: { '': { repository: 'url', base: '/trunk', rootBase: 1, since: head } } })
    const receipt = { scopeRoot: h.root, revision: 1, paths: ['a.txt'], at: Date.now() }
    await h.records.update('worker', (record) => ({ ...record, commitReceipts: [receipt] }))
    await h.driver.foreignCommit('worker', [receipt])
    await h.driver.drive('worker')
    expect(h.state().verified).toMatchObject([{ revision: 1, paths: ['a.txt'] }])
    expect(h.events).not.toContain('commit')
    expect(h.state().phase).toBe('landed')
    expect(h.records.get('worker')?.worktreeOutcome?.result).toBe('committed')
  })

  it.each([true, false])('bases foreign receipt completion on remaining work (remaining=%s), not obsolete approval history', async (remaining) => {
    const h = await harness()
    h.setDirty(remaining ? ['pending.txt'] : [])
    const receipt = { scopeRoot: h.root, revision: 1, paths: ['a.txt'], at: Date.now() }
    await h.records.update('worker', (record) => ({ ...record, commitReceipts: [receipt], worktreeLifecycle: { ...record.worktreeLifecycle!,
      publication: { revisions: [], verified: [], proofs: [], savedActions: [], selected: [{ repository: 'url', since: 0, paths: ['/trunk/pending.txt'] }] } } }))
    await h.driver.foreignCommit('worker', [receipt])
    await h.driver.drive('worker')
    expect(h.failures).toEqual([])
    expect(h.state().verified).toMatchObject([{ revision: 1, paths: ['a.txt'] }])
    expect(h.records.get('worker')?.worktreeOutcome?.result).toBe(remaining ? 'partial' : 'committed')
    expect(h.events).not.toContain('commit')
  })

  it('verifies foreign file and directory deletion receipts against exact publication evidence', async () => {
    const h = await harness()
    h.setDirty([])
    await rm(join(h.root, 'a.txt'))
    h.deps.svn.publicationRows = async (_root, paths) => ({ ok: true, value: { items: [], changed: paths.map((path) => ({ path, revision: 1, action: 'D' as const })) } })
    const receipt = { scopeRoot: h.root, revision: 1, paths: ['a.txt', 'removed-dir'], at: Date.now() }
    await h.records.update('worker', (record) => ({ ...record, commitReceipts: [receipt] }))
    await h.driver.foreignCommit('worker', [receipt])
    await h.driver.drive('worker')
    expect(h.state().review?.deletions).toEqual(['a.txt', 'removed-dir'])
    expect(h.state().verified?.[0].paths).toEqual(['a.txt', 'removed-dir'])
    expect(h.state().phase).toBe('landed')
    expect(h.records.get('worker')?.worktreeOutcome?.result).toBe('committed')
    expect(h.events).not.toContain('commit')
  })

  it('does not migrate or relabel recovery state when another client holds the lease', async () => {
    const h = await harness()
    const before = h.records.get('worker')!
    const other = new WorktreeLease('other-client', () => [])
    await other.within(h.root, 'finish', async () => {
      await expect(h.driver.recoverCommit('worker', { stepId: 'old', kind: 'commit', attempt: 1, cwd: h.root, args: [], runId: 'old', startedAt: 1 }))
        .rejects.toThrow(/lease is held/)
      expect(h.records.get('worker')).toEqual(before)
    })
  })

  it('refuses a changed owner before sync or publication and leaves the operation untouched', async () => {
    const h = await harness()
    h.deps.svn.ownerCheck = async () => ({ ok: false, code: 'refused', detail: 'Owner checks out another URL' })
    const before = h.state()
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })).toMatchObject({ ok: false, detail: 'Owner checks out another URL' })
    expect(h.state()).toEqual(before)
    expect(h.events).toEqual([])
  })

  it('requires an explicit person override and keeps its failed-check result through publication', async () => {
    const h = await harness()
    h.setChecks([{ key: 'failed', scriptId: 'checks', name: 'failed', commands: [{ cwd: h.root, command: 'test' }] }])
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await completeCheck(h, false)
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'cli', overrideChecks: true })).toMatchObject({ ok: false, code: 'person-only' })
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', overrideChecks: true })).toMatchObject({ ok: true })
    expect(h.state().checks).toMatchObject({ passed: false, overridden: true })
    await h.approve()
    expect(h.state().phase).toBe('landed')
    expect(h.records.get('worker')!.worktreeOutcome?.lines).toContain('checks-failed: explicitly accepted by the person')
    expect(h.deps.runs.launch).toHaveBeenCalledTimes(1)
  })

  it('keeps every settlement of the sync in the durable result, with its option and who chose it (UA1-J05-5)', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const settled = (path: string, by: 'jamat' | 'agent' | 'merger' | 'person', settledWith: 'keep-both' | 'keep-mine' | 'merged' | 'take-incoming') =>
      ({ path, kind: 'text' as const, shape: 'text-overlap' as const, state: 'settled' as const, options: [], facts: {}, by, settledWith })
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!,
      syncConflictSet: { readAt: 1, baseRevision: 1, revision: 2, more: 0, entries: [settled('newdir', 'jamat', 'keep-both'),
        settled('w.txt', 'agent', 'keep-mine'), settled('m.txt', 'merger', 'merged'), settled('p.bin', 'person', 'take-incoming')] } } }))
    await h.approve()
    expect(h.state().phase).toBe('landed')
    expect(h.records.get('worker')!.worktreeOutcome?.lines).toEqual(expect.arrayContaining(['FIXED: newdir (keep both)',
      'SETTLED: w.txt (keep mine) by the worker', 'SETTLED: m.txt (merged) by the merger', 'SETTLED: p.bin (take incoming) by the person']))
  })

  it('hands 22 conflicts to the worker and preserves them through Keep and a new Finish', async () => {
    const h = await harness()
    const paths = Array.from({ length: 22 }, (_, n) => `file-${n}.ts`)
    let unresolved = true
    const synced = h.deps.sync.run
    h.deps.sync.run = async (...args) => {
      if (!unresolved) return synced(...args)
      await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'finishing', step: 'worker-resolving',
        syncConflictSet: { revision: 2, baseRevision: 1, readAt: Date.now(), entries: paths.map((path) => ({ path, kind: 'text', shape: 'text-overlap', state: 'agent', options: ['merged'], facts: {} })), more: 0 } } }))
      await h.deps.handoffs.conflicts('worker')
      return { ok: true, value: { sessionId: 'worker', revision: 2, conflicts: paths.map((path) => ({ path, kind: 'text' as const })) } }
    }
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().step).toBe('worker-resolving')
    expect(h.state().syncConflictSet?.entries).toHaveLength(22)
    await h.driver.start('worker', { choice: 'keep', requestedBy: 'window' })
    expect(h.state().phase).toBe('kept')
    expect(h.state().syncConflictSet?.entries).toHaveLength(22)
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().syncConflictSet?.entries).toHaveLength(22)
    unresolved = false
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await h.approve()
    expect(h.state().phase).toBe('landed')
    expect(h.events.filter((event) => event === 'commit')).toHaveLength(1)
  })

  it('delivers a readable failed log through the production gate and reruns every check after repair', async () => {
    const h = await harness()
    h.setChecks(['first', 'second'].map((name) => ({ key: name, scriptId: 'checks', name, commands: [{ cwd: h.root, command: name }] })))
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await completeCheck(h, true)
    expect(h.state().execution?.checkCursor).toBe(1)
    await completeCheck(h, false)
    expect(h.state().phase).toBe('active')
    const path = h.state().checks!.logPath
    expect(await readFile(path, 'utf8')).toBe('complete check output\n')
    expect(h.deps.handoffs.checksFailed).toHaveBeenCalledWith('worker', expect.any(Number), path)
    h.setHash('repaired')
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().execution?.checkCursor).toBe(0)
    expect(h.records.get(h.state().execution!.runId!)?.scriptOf?.name).toBe('first')
  })

  it('preserves the failed copy and check verdict until the log can be retained', async () => {
    const h = await harness()
    h.setChecks([{ key: 'check', scriptId: 'checks', name: 'check', commands: [{ cwd: h.root, command: 'check' }] }])
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const original = h.results.keepAttempt.bind(h.results)
    h.results.keepAttempt = async () => { throw new Error('result disk unavailable') }
    await completeCheck(h, false)
    expect(h.state().wait?.reason).toContain('result disk unavailable')
    const runId = h.state().execution!.runId
    h.results.keepAttempt = original
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().checks?.passed).toBe(false)
    expect(h.state().execution?.pendingLog).toBeUndefined()
    expect(h.deps.runs.launch).toHaveBeenCalledTimes(1)
    expect(h.state().checks!.logPath).toContain(runId)
  })

  it('does not relabel a migrated person-owned dirty action for an agent Keep or Discard', async () => {
    const h = await harness()
    const old = { kind: 'finish' as const, actionId: 'old', stage: 'changes' as const, root: h.root,
      checks: [], checkCursor: 0, rootCursor: 0, rounds: { incoming: 0, lock: 0, outOfDate: 0 }, evidence: [], requestedBy: 'window' as const, startedAt: 1 }
    await h.records.update('worker', (record) => { const next = { ...record, svnAction: old }; return { ...next, worktreeLifecycle: WorktreeLifecycleMigration.fromOld(next)! } })
    const before = h.records.get('worker')
    for (const choice of ['keep', 'discard'] as const)
      expect(await h.driver.start('worker', { choice, requestedBy: 'cli' })).toMatchObject({ ok: false, code: 'person-only' })
    expect(h.records.get('worker')).toEqual(before)
  })

  it('rechecks HEAD and refreshes changed review bytes on every press', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const version = h.state().version
    h.setHash('new bytes')
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.events).toEqual(['sync', 'sync'])
    expect(h.state().review?.hashes['a.txt']).toBe('new bytes')
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', reviewVersion: version, selection: [join(h.root, 'a.txt')], message: '[App] Fix' }))
      .toMatchObject({ ok: false, code: 'review-stale' })
  })

  it('retries a published-with-differences receipt after repair without another commit', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const read = h.deps.svn.publicationRows
    h.deps.svn.publicationRows = async (...args) => { const result = await read(...args); h.setHash('outside'); return result }
    await h.approve()
    expect(h.state().wait?.kind).toBe('published-with-differences')
    h.deps.svn.publicationRows = read; h.setHash('hash')
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().phase).toBe('landed')
    expect(h.events.filter((event) => event === 'commit')).toHaveLength(1)
  })

  it('awaits actual worker exit before removal and resumes the removal continuation', async () => {
    const h = await harness()
    h.deps.awaitExit = async () => false
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' }); await h.approve()
    expect(h.state().step).toBe('stopping-worker')
    expect(h.events).not.toContain('remove')
    h.deps.awaitExit = async () => true
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.events.filter((event) => event === 'commit')).toHaveLength(1)
    expect(h.state().phase).toBe('landed')
  })
  it('syncs before review, publishes the approved bytes, verifies, stops and removes', async () => {
    const h = await harness()
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })).toMatchObject({ ok: true })
    expect(h.state().step).toBe('reviewing')
    expect(h.events).toEqual(['sync'])
    expect(h.records.get('worker')?.svnAction).toBeUndefined()
    expect(FinishProjection.action(h.records.get('worker')!)?.stage).toBe('changes')
    expect(await h.approve()).toMatchObject({ ok: true })
    expect(h.state().wait).toBeUndefined()
    expect(h.state().phase).toBe('landed')
    expect(h.events).toEqual(['sync', 'commit', 'stop', 'remove'])
    expect(h.state().verified).toMatchObject([{ revision: 2, paths: ['a.txt'] }])
    // The main copy updates at once, without a press, and starts no resolver by itself (Finish 072).
    await vi.waitFor(() => expect(h.deps.update.startUpdate).toHaveBeenCalledWith('worker', h.records.get('worker')!.retiredWorktree!.ownerDir, 'window', false, false))
  })

  it('starts no UPDATE when nothing was published, and lands even when the UPDATE cannot start', async () => {
    const h = await harness()
    vi.mocked(h.deps.update.startUpdate).mockResolvedValue({ ok: false, code: 'merge-pending', detail: 'An UPDATE is already using this main copy' })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(await h.approve()).toMatchObject({ ok: true })
    expect(h.state().phase).toBe('landed')
    await vi.waitFor(() => expect(h.failures).toEqual(expect.arrayContaining([expect.stringContaining('did not start after the Finish (An UPDATE is already using this main copy)')])))
    const kept = await harness()
    await kept.driver.start('worker', { choice: 'keep', requestedBy: 'window' })
    expect(kept.deps.update.startUpdate).not.toHaveBeenCalled()
  })

  it('leaves no removal step running once the worktree is removed and the result is recorded', async () => {
    const h = await harness()
    const steps = new SessionSteps({ changed: () => {}, now: () => Date.now() })
    const remove = h.deps.removal.remove
    h.deps.steps = steps
    h.deps.removal.remove = async (sessionId, ...rest) => {
      steps.at(sessionId, { kind: 'removal', phase: 'tombstone', path: h.root })
      return remove(sessionId, ...rest)
    }
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await h.approve()
    expect(h.state().phase).toBe('landed')
    expect(steps.infoOf(h.records.get('worker')!)?.text).not.toBe('Recording the removal')
    expect(steps.infoOf(h.records.get('worker')!)?.startedAt ?? null).toBeNull()
  })

  // Worker-agent 031: a ready sync met conflicts, Finish took a new id, and its sync refused the unfinished update of the old one.
  it('keeps the action of a sync that met conflicts before Finish, so Finish continues its update', async () => {
    const h = await harness()
    const update = { actionId: 'sync-action', generation: 'g1', root: h.root, revision: 2, cursor: 0, completed: false,
      units: [{ target: { path: h.root, url: 'https://svn.test/repos/app', repository: 'https://svn.test/repos', revision: 2, kind: 'dir' as const, pinned: false }, phase: 'updated' as const }] }
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, actionId: 'sync-action',
      phase: 'finishing', step: 'worker-resolving', execution: undefined, update } }))
    let seen: string | null = null
    const sync = h.deps.sync as { run: (...args: unknown[]) => Promise<unknown> }
    sync.run = async () => { seen = h.state().actionId; return { ok: false, code: 'session-working', detail: 'busy' } }
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })).toMatchObject({ ok: true })
    expect(seen).toBe('sync-action')
    expect(h.state()).toMatchObject({ actionId: 'sync-action', update: { actionId: 'sync-action' } })
  })

  // Worker-agent 031: the worker settled a conflict of a ready sync and the main-copy update answered not-found.
  it('settles a conflict of a sync that no Finish holds yet through the sync', async () => {
    const h = await harness()
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, actionId: 'sync-action',
      phase: 'finishing', step: 'worker-resolving', execution: undefined,
      syncConflictSet: { readAt: 1, baseRevision: 1, revision: 2, more: 0,
        entries: [{ path: 'a.txt', kind: 'text', shape: 'text-overlap', state: 'agent', options: ['merged'], facts: {} }] } } }))
    const resolve = vi.fn(async () => ({ ok: true as const, value: { sessionId: 'worker', path: 'a.txt', state: 'settled' as const, left: 0 } }))
    h.deps.sync.resolve = resolve
    const mainCopy = vi.fn(async () => ({ ok: false as const, code: 'not-found' as const, detail: 'no SVN action' }))
    Object.assign(h.deps.update, { resolveConflict: mainCopy })
    expect(await h.driver.resolveConflict('worker', { path: 'a.txt', option: 'merged', confirm: false, requestedBy: 'cli', by: 'agent' })).toMatchObject({ ok: true })
    expect(resolve).toHaveBeenCalledWith('worker', expect.objectContaining({ path: 'a.txt', option: 'merged', requestedBy: 'cli' }))
    expect(mainCopy).not.toHaveBeenCalled()
  })

  it('waits for a busy worker as such and goes back to work without touching the worktree or the worker', async () => {
    const h = await harness()
    const sync = h.deps.sync as { run: (...args: unknown[]) => Promise<unknown> }
    const synced = sync.run
    sync.run = async () => ({ ok: false, code: 'session-working', detail: 'Sync waits for an idle worker or your confirmation' })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state()).toMatchObject({ phase: 'waiting', step: 'syncing', wait: { kind: 'worker-busy' } })
    expect(FinishProjection.action(h.records.get('worker')!)?.needs?.kind).toBe('worker-busy')

    expect(await h.driver.backToWork('worker', 'agent')).toMatchObject({ ok: false, code: 'person-only' })
    expect(await h.driver.backToWork('worker', 'person')).toMatchObject({ ok: true })
    expect(h.state()).toMatchObject({ phase: 'active' })
    expect(h.state().step).toBeUndefined()
    expect(FinishProjection.action(h.records.get('worker')!)).toBeUndefined()
    expect(h.records.get('worker')?.worktree).toBeDefined()
    expect(h.events).not.toContain('stop')

    sync.run = synced
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })).toMatchObject({ ok: true })
    expect(h.state().step).toBe('reviewing')
  })

  // The Host refuses a stop whose descendants survive and names them; the worker is not lost (UA1-J14-7).
  it('keeps the worktree with the survivors named when the Host cannot stop the worker tree', async () => {
    const h = await harness()
    const survivors = 'Owned child processes did not stop; retry Stop: PID 82792: Access is denied'
    h.deps.stop = async () => ({ ok: false, code: 'op-rejected', detail: survivors })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await h.approve()
    expect(h.state()).toMatchObject({ phase: 'waiting', step: 'stopping-worker', wait: { kind: 'removal-blocked' } })
    expect(h.state().wait?.reason).toContain(survivors)
    expect(h.events).toEqual(['sync', 'commit'])
  })

  // The wait went on only at Sync now, 1 min 25 s after the worker was idle (UA1-J14-4).
  it('goes on from the busy-worker wait by itself once the worker is idle, and not before', async () => {
    const h = await harness()
    const sync = h.deps.sync as { run: (...args: unknown[]) => Promise<unknown> }
    const synced = sync.run
    sync.run = async () => ({ ok: false, code: 'session-working', detail: WorktreeWords.syncBusyOf('the worker is working') })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state()).toMatchObject({ phase: 'waiting', step: 'syncing', wait: { kind: 'worker-busy' } })
    const version = h.state().version
    h.deps.idle = () => false
    await h.driver.workerIdle('worker')
    expect(h.state()).toMatchObject({ version, phase: 'waiting', wait: { kind: 'worker-busy' } })

    h.deps.idle = () => true
    sync.run = synced
    await h.driver.workerIdle('worker')
    expect(h.state()).toMatchObject({ phase: 'finishing', step: 'reviewing' })
    expect(h.events).toEqual(['sync'])
  })

  // worker-agent 031, 032: the worker still ended the turn Jamat's conflict prompt began, the sync raised
  // a wait for the person, and the person pressed Finish again in 2 of 4 Finishes.
  it('waits for the worker that settled Jamat\'s conflict prompt without asking anybody, and syncs once it is idle', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'finishing', step: 'syncing',
      wait: undefined, review: undefined, approvedAt: undefined, preparation: undefined, awaitingIdleAt: 5 } }))
    h.events.splice(0)
    h.deps.idle = () => false
    await h.driver.drive('worker')
    expect(h.state()).toMatchObject({ phase: 'finishing', step: 'syncing', awaitingIdleReason: 'the worker is working' })
    expect(h.state().wait).toBeUndefined()
    expect(FinishProjection.action(h.records.get('worker')!)?.needs).toBeUndefined()
    expect(WorktreeWords.idleWaitOf(h.state())).toContain('ending its turn on the conflicts Jamat handed it: the worker is working')
    expect(WorktreeWords.actions(h.state()).find((action) => action.label === 'Sync now')).toMatchObject({ id: 'finish-again', confirmWorking: true })
    const version = h.state().version
    await h.driver.drive('worker')
    expect(h.state().version).toBe(version)
    expect(h.events).toEqual([])

    h.deps.idle = () => true
    await h.driver.drive('worker')
    expect(h.events).toEqual(['sync'])
    expect(h.state()).toMatchObject({ phase: 'finishing', step: 'reviewing' })
  })

  /** 023 looped: every Try again verified the same changed fingerprint, and nothing accepted it. */
  it('lets only the person accept svn changes made outside Jamat, then reviews them afresh', async () => {
    const h = await harness()
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'waiting', step: 'syncing',
      owner: 'person', wait: { kind: 'changed-outside', reason: 'The svn state changed outside Jamat', at: 1 } } }))
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'cli' })).toMatchObject({ ok: false, code: 'person-only' })
    expect(h.deps.commands.accept).not.toHaveBeenCalled()
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })).toMatchObject({ ok: true })
    expect(h.deps.commands.accept).toHaveBeenCalled()
    expect(h.state()).toMatchObject({ phase: 'finishing', step: 'reviewing' })
  })

  it('waits without a window, preserves the wait timestamp and requires the displayed current review', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'cli' })
    expect(h.state().wait?.kind).toBe('waiting-for-review')
    const wait = h.state().wait
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'peer' })
    expect(h.state().wait).toEqual(wait)
    expect(h.deps.handoffs.notifyCaller).toHaveBeenCalledTimes(1)
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().wait).toBeUndefined()
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', selection: [join(h.root, 'a.txt')], message: '', reviewVersion: h.state().version }))
      .toMatchObject({ ok: false, code: 'message-unchecked' })
    expect(await h.approve()).toMatchObject({ ok: true })
    expect(h.state().phase).toBe('landed')
  })

  it('finishes a clean started worker without a review or an invented receipt, and records never-started Discard', async () => {
    const h = await harness(); h.setDirty([])
    h.setChecks([{ key: 'tests', scriptId: 'checks', name: 'tests', commands: [{ cwd: h.root, command: 'test' }] }])
    const assembly = vi.spyOn(h.deps.svn, 'assembly')
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'cli' })
    expect(h.state().phase).toBe('landed')
    // Nothing to publish: no assembly read and no check run (Mirabia, 76 s of reading, 2026-10-30).
    expect(assembly).not.toHaveBeenCalled()
    expect(h.deps.runs.launch).not.toHaveBeenCalled()
    expect(h.state().review?.selection).toEqual([])
    expect(h.events).not.toContain('commit')
    expect(h.records.get('worker')?.commitReceipts).toBeUndefined()
    const never = await harness()
    await never.records.update('worker', (record) => ({ ...record, life: 'ended', worktree: { ...record.worktree!, agentStartedAt: undefined } }))
    expect(await never.driver.start('worker', { choice: 'commit', requestedBy: 'window' })).toMatchObject({ ok: false, code: 'never-started' })
    await never.driver.start('worker', { choice: 'discard', requestedBy: 'window' })
    expect(never.state().phase).toBe('removed')
    expect(never.events).not.toContain('commit')
  })

  it('prepares in full when a change appears after a preparation that found nothing to publish', async () => {
    const h = await harness(); h.setDirty([])
    const reviewRoots = h.deps.svn.reviewRoots
    let reads = 0
    h.deps.svn.reviewRoots = async (...args) => {
      const read = await reviewRoots(...args)
      if (++reads === 1) h.setDirty(['a.txt'])
      return read
    }
    const assembly = vi.spyOn(h.deps.svn, 'assembly')
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state()).toMatchObject({ phase: 'finishing', step: 'reviewing', review: { selection: ['a.txt'] } })
    expect(h.state().preparation?.checkedAt).toEqual(expect.any(Number))
    expect(assembly).toHaveBeenCalled()
    await h.approve()
    expect(h.state().phase).toBe('landed')
    expect(h.events).toContain('commit')
  })

  it('persists the check pointer used by the production gate and ignores its verdict after Keep', async () => {
    const h = await harness()
    h.setChecks([{ key: 'tests', scriptId: 'checks', name: 'tests', commands: [{ cwd: h.root, command: 'test' }] }])
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const parent = h.records.get('worker')!
    expect(SessionScriptDefinitions.judging('action', parent)).toBe(true)
    expect(SessionScriptDefinitions.gatesOf(parent)).toEqual(expect.arrayContaining([expect.objectContaining({ gate: 'action', runId: h.state().execution!.runId })]))
    await h.driver.start('worker', { choice: 'keep', requestedBy: 'window' })
    expect(await h.driver.noteVerdict('worker', { kind: 'succeeded' })).toBe(false)
    expect(h.state().phase).toBe('kept')
  })

  it.each(['absent', 'ambiguous'] as const)('recovers %s publication evidence without cleanup before repository proof or another commit', async (kind) => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    h.deps.svn.publicationRows = async () => { throw new Error('verification interrupted') }
    await h.approve()
    const saved = h.state().journal.find((row) => row.kind === 'commit')!
    const entry = { ...saved, endedAt: undefined, revision: undefined }
    await h.records.update('worker', (record) => ({ ...record, commitReceipts: undefined,
      worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'finishing', step: 'committing', wait: undefined,
        execution: { ...record.worktreeLifecycle!.execution!, evidence: [] }, journal: record.worktreeLifecycle!.journal.map((row) => row.runId === saved.runId ? entry : row) } }))
    const order: string[] = []
    h.deps.svn.logSince = async () => { order.push('history'); return { ok: true, value: kind === 'absent' ? [] : [2, 3].map((revision) => ({ revision, author: 'person', date: entry.startedAt, paths: ['/trunk/a.txt'], message: '[App] Fix file' })) } }
    const run = h.deps.runner.run.bind(h.deps.runner)
    h.deps.runner.run = async (...args) => { order.push(args[1]); return run(...args) }
    h.setDirty(['a.txt'])
    expect(await h.driver.recoverCommit('worker', entry)).toBe(false)
    expect(order[0]).toBe('history')
    expect(h.events.filter((event) => event === 'commit')).toHaveLength(1)
    if (kind === 'absent') {
      expect(h.state().wait?.kind).toBe('review')
      expect(WorktreeRecovery.pending(h.records.get('worker')!)).toEqual([])
      expect(WorktreeRecovery.pending((await h.reload()).get('worker')!)).toEqual([])
    } else {
      expect(order).toEqual(['history'])
      expect(h.state().wait?.reason).toContain('Several repository revisions')
      expect(WorktreeRecovery.pending(h.records.get('worker')!)).toHaveLength(1)
    }
  })

  it.each([false, true])('detects a closed commit journal before evidence processing (receipt saved=%s) without repeating publication', async (saved) => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    h.deps.svn.publicationRows = async () => { throw new Error('verification interrupted') }
    await h.approve()
    expect(h.state().step).toBe('verifying')
    const original = h.records.get('worker')!
    await h.records.update('worker', (record) => ({ ...record, commitReceipts: saved ? record.commitReceipts : undefined,
      worktreeLifecycle: { ...record.worktreeLifecycle!, execution: { ...record.worktreeLifecycle!.execution!, evidence: [] } } }))
    expect(WorktreeRecovery.pending(h.records.get('worker')!)).toHaveLength(1)
    const intent = WorktreeRecovery.pending(h.records.get('worker')!)[0]
    h.deps.svn.logSince = async () => ({ ok: true, value: [{ revision: 2, author: 'person', date: intent.startedAt, paths: ['/trunk/a.txt'], message: '[App] Fix file' }] })
    expect(await h.driver.recoverCommit('worker', intent)).toBe(true)
    expect(WorktreeRecovery.pending(h.records.get('worker')!)).toEqual([])
    expect(h.records.get('worker')?.commitReceipts).toMatchObject(original.commitReceipts!.map(({ at, ...receipt }) => receipt))
    expect(h.events.filter((event) => event === 'commit')).toHaveLength(1)
  })
})

describe('UA1-J09 recovery after a lost commit reply', () => {
  async function lostReply() {
    const h = await harness()
    h.failCommit('accepted')
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await h.approve()
    expect(h.state().step).toBe('committing')
    return h
  }
  const landed = (...revisions: number[]) => async () => ({ ok: true as const,
    value: revisions.map((revision) => ({ revision, author: 'person', date: Date.now(), paths: ['/trunk/a.txt'], message: '[App] Fix file' })) })

  /** UA1-J09-1: accepting the outside change wrote a committing step without its approval, and the record store refused it. */
  it('accepts an outside change during an interrupted commit without dropping its approval, then recovers the commit', async () => {
    const h = await lostReply()
    const saved = h.state().journal.find((row) => row.kind === 'commit')!
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'waiting',
      wait: { kind: 'changed-outside', reason: 'The svn state changed outside Jamat', at: 1 },
      journal: record.worktreeLifecycle!.journal.map((row) => row.runId === saved.runId ? { ...row, endedAt: undefined, outcome: undefined } : row) } }))
    h.deps.svn.logSince = landed(2)
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })).toMatchObject({ ok: true })
    expect(h.deps.commands.accept).toHaveBeenCalled()
    expect(h.failures).toEqual([])
    expect(h.state().verified?.map((row) => row.revision)).toEqual([2])
    expect(h.events.filter((event) => event === 'commit')).toHaveLength(1)
  })

  it('returns an outside change accepted before publication to a fresh preparation, never to a step without approval', async () => {
    const h = await harness()
    h.deps.idle = () => false
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await h.approve()
    expect(h.state().step).toBe('awaiting-idle')
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'waiting',
      wait: { kind: 'changed-outside', reason: 'The svn state changed outside Jamat', at: 1 } } }))
    h.deps.idle = () => true
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })).toMatchObject({ ok: true })
    expect(h.failures).toEqual([])
    expect(h.state()).toMatchObject({ step: 'reviewing', approvedAt: undefined })
    expect(h.events).not.toContain('commit')
  })

  /** UA1-J09-2 and -4: the killed client left the published nodes at BASE r1 as local edits; verification found differences and the result stayed partial. */
  it('moves the nodes of a recovered commit to its revision, verifies it and records the Finish as committed', async () => {
    const h = await lostReply()
    let base = 1
    h.deps.svn.publicationRows = async (_root: string, paths: readonly string[]) => ({ ok: true, value: { changed: paths.map((path) => ({ path, revision: 2, action: 'M' as const })),
      items: paths.map((path) => ({ path, item: base === 2 ? 'normal' as const : 'modified' as const, props: 'none' as const, base, changed: base })) } })
    h.deps.svn.advancePublished = vi.fn(async () => { base = 2; return { ok: true as const, value: undefined } })
    h.deps.svn.logSince = landed(2)
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })).toMatchObject({ ok: true })
    expect(h.deps.commands.acceptInterrupted).toHaveBeenCalledWith(h.root, [join(h.root, 'a.txt')])
    expect(h.deps.svn.advancePublished).toHaveBeenCalledWith(h.root, ['a.txt'], 2)
    expect(h.state().phase, JSON.stringify(h.state().wait)).toBe('landed')
    expect((await h.results.list({ sessionId: 'worker' })).map((row) => row.result)).toContain('committed')
    expect(h.records.get('worker')?.worktreeOutcome?.result).toBe('committed')
    expect(h.events.filter((event) => event === 'commit')).toHaveLength(1)
  })

  it('leaves a node whose bytes differ from the published revision for verification to name', async () => {
    const h = await lostReply()
    h.deps.svn.publicationRows = async (_root: string, paths: readonly string[]) => ({ ok: true, value: { changed: paths.map((path) => ({ path, revision: 2, action: 'M' as const })),
      items: paths.map((path) => ({ path, item: 'modified' as const, props: 'none' as const, base: 1, changed: 1 })) } })
    h.deps.svn.publicationHashes = async (_root: string, paths: readonly string[]) => ({ ok: true, value: Object.fromEntries(paths.map((path) => [path, 'other bytes'])) })
    h.deps.svn.advancePublished = vi.fn(async () => ({ ok: true as const, value: undefined }))
    h.deps.svn.logSince = landed(2)
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.deps.svn.advancePublished).not.toHaveBeenCalled()
    expect(h.state().wait?.kind).toBe('published-with-differences')
  })

  /** UA1-J09-5: the wait named no candidate, Discard did not warn, and its result said "Nothing published" although r9 held the worktree's bytes. */
  it('names the candidates of an ambiguous recovery in the wait, the Discard confirm and the durable result', async () => {
    const h = await lostReply()
    h.deps.svn.logSince = landed(9, 10)
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().wait?.reason).toContain('url r9, r10')
    const discard = WorktreeWords.actions(h.state()).find((action) => action.id === 'discard')
    expect(discard?.confirm).toContain('may have landed')
    expect(discard?.confirm).toContain('url r9, r10')
    expect(await h.driver.start('worker', { choice: 'discard', requestedBy: 'window' })).toMatchObject({ ok: true })
    await h.driver.settled('worker')
    const result = (await h.results.list({ sessionId: 'worker' })).find((row) => row.action === 'discard')
    expect(result?.lines.join('\n')).not.toContain('Nothing published')
    expect(result?.lines.join('\n')).toContain('url r9, r10')
    expect(h.state().publication?.revisions ?? []).toEqual([])
    expect(h.events.filter((event) => event === 'commit')).toHaveLength(1)
  })
})

describe('R3 partial repro', () => {
  it.each(['keep', 'discard'] as const)('partial publication then %s', async (choice) => {
    const h = await harness()
    h.deps.svn.assembly = async () => ({ ok: true, value: testAssembly() })
    const paths = ['shared/front/a.txt', 'shared/back/a.txt', 'a.txt']
    for (const path of paths) { await mkdir(join(h.root, path, '..'), { recursive: true }); await writeFile(join(h.root, path), 'worker\r\n') }
    h.setDirty(paths)
    const roots = ['shared/front', 'shared/back', ''].map((own, index) => ({ own, path: join(h.root, own), pinned: false,
      changed: [{ path: 'a.txt', kind: 'item' as const, conflict: false }], repository: ['https://svn/front', 'https://svn/back', 'https://svn/apps'][index] }))
    h.deps.svn.reviewRoots = async () => ({ ok: true, value: roots })
    h.deps.svn.lowerBounds = async () => ({ ok: true, value: Object.fromEntries(roots.map((root) => [root.own,
      { repository: root.repository, base: '/trunk', rootBase: 1, since: 1 }])) })
    const run = h.deps.runner.run.bind(h.deps.runner)
    vi.spyOn(h.deps.runner, 'run').mockImplementation(async (...args) => {
      if (args[1] === 'commit' && args[2] === h.root) return { ok: false, failure: 'out-of-date', output: 'out of date', exitCode: 1, runId: 'failed-main' }
      return run(...args)
    })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const repositories = h.state().review!.repositories!.map((row) => ({ ...row, message: `${row.expectedPrefix} Fix`, source: 'person-local' as const }))
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', selection: paths.map((path) => join(h.root, path)),
      message: '[apps] Fix', messageSource: 'person-local', repositories, reviewVersion: h.state().version })
    expect(h.state().wait?.kind).toBe('partially-landed')
    h.setDirty(['a.txt'])
    const r = await h.driver.start('worker', { choice, requestedBy: 'window' })
    expect(r.ok).toBe(true)
    expect(h.records.get('worker')!.worktreeOutcome?.result).toBe('partial')
    const rows = await h.results.list({ sessionId: 'worker' })
    expect(rows.every((row) => row.result === 'partial')).toBe(true)
  })
})

describe('R3 publication repro', () => {
  it('does not reuse a proof after a mount changes repository at the same revision number', async () => {
    const h = await harness()
    h.deps.removal.remove = async () => ({ state: 'in-use', lines: ['held'] })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await h.approve()
    await h.driver.start('worker', { choice: 'keep', requestedBy: 'window' })
    h.setRevision(1)
    h.setDirty(['a.txt'])
    h.deps.svn.lowerBounds = async () => ({ ok: true, value: { '': { repository: 'new-url', base: '/trunk', rootBase: 1, since: 1 } } })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    h.deps.svn.publicationHashes = async () => ({ ok: true, value: { 'a.txt': 'different' } })
    await h.approve()
    expect(h.state().wait?.kind).toBe('published-with-differences')
    await h.driver.start('worker', { choice: 'keep', requestedBy: 'window' })
    expect(h.records.get('worker')?.worktreeOutcome?.result).toBe('partial')
  })
  async function twoFiles() {
    const h = await harness()
    await writeFile(join(h.root, 'b.txt'), 'worker\r\n')
    h.setDirty(['a.txt', 'b.txt'])
    return h
  }
  const approveBoth = (h: Awaited<ReturnType<typeof harness>>, files: string[]) => h.driver.start('worker', { choice: 'commit', requestedBy: 'window',
    selection: files.map((f) => join(h.root, f)), message: '[App] Fix file', messageSource: 'person-local', reviewVersion: h.state().version })

  it('R4 T1: supersedes an unpublished approval after a reverted file', async () => {
    const h = await twoFiles()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    h.failCommit('auth')
    await approveBoth(h, ['a.txt', 'b.txt'])
    expect(h.state().wait?.kind).toBe('auth')
    h.failCommit(undefined)
    h.setDirty(['a.txt'])
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await approveBoth(h, ['a.txt'])
    expect(h.records.get('worker')!.worktreeOutcome?.result).toBe('committed')
  })

  it('R4 T2: an empty corrective approval preserves valid writable history', async () => {
    const h = await twoFiles()
    h.deps.removal.remove = async () => ({ state: 'in-use', lines: ['held'] })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const publish = h.deps.svn.publicationHashes
    h.deps.svn.publicationHashes = async (_root, paths) => ({ ok: true, value: Object.fromEntries(paths.map((p) => [p, p === 'b.txt' ? 'bad' : 'hash'])) })
    await approveBoth(h, ['a.txt', 'b.txt'])
    expect(h.state().wait?.kind).toBe('published-with-differences')
    h.deps.svn.publicationHashes = publish
    h.setDirty([])
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', reviewCorrection: true })
    await approveBoth(h, [])
    expect(await h.driver.start('worker', { choice: 'keep', requestedBy: 'window' })).toMatchObject({ ok: true })
    expect(await h.records.update('worker', (record) => ({ ...record, title: 'renamed' }))).toBe(true)
    expect(await h.driver.start('worker', { choice: 'discard', requestedBy: 'window' })).toMatchObject({ ok: true })
    expect((await h.reload()).get('worker')?.title).toBe('renamed')
  })

  it('R4 T7: dialog receipts replace hashes from an older Finish review', async () => {
    const h = await harness()
    h.deps.removal.remove = async () => ({ state: 'in-use', lines: ['held'] })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    h.setHash('newer')
    h.setRevision(2)
    h.setDirty([])
    const receipt = { scopeRoot: h.root, revision: 2, paths: ['a.txt'], at: Date.now() }
    await h.records.update('worker', (record) => ({ ...record, commitReceipts: [receipt] }))
    await h.driver.foreignCommit('worker', [receipt])
    await h.driver.drive('worker')
    expect(h.state().review?.hashes['a.txt']).toBe('newer')
    expect(h.records.get('worker')?.worktreeOutcome?.result).toBe('committed')
  })

  it.each(['', '/trunk'])('corrective publication of only the differing file still reports committed at %s', async (base) => {
    const h = await twoFiles()
    h.deps.svn.lowerBounds = async () => ({ ok: true, value: { '': { repository: 'url', base, rootBase: 1, since: 1 } } })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const publish = h.deps.svn.publicationHashes
    h.deps.svn.publicationHashes = async (_root: string, paths: string[]) => ({ ok: true, value: Object.fromEntries(paths.map((p) => [p, p === 'b.txt' ? 'bad' : 'hash'])) }) as never
    await approveBoth(h, ['a.txt', 'b.txt'])
    expect(h.state().wait?.kind).toBe('published-with-differences')
    h.deps.svn.publicationHashes = publish
    h.setDirty(['b.txt'])
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', reviewCorrection: true })
    expect(h.state().step).toBe('reviewing')
    await approveBoth(h, ['b.txt'])
    expect(h.state().phase).toBe('landed')
    const rows = await h.results.list({ sessionId: 'worker' })
    expect(rows.at(-1)?.result).toBe('committed')
    expect(h.records.get('worker')!.worktreeOutcome?.result).toBe('committed')
  })

  it('second action commit failure after earlier publication: wait kind', async () => {
    const h = await harness()
    h.deps.removal.remove = async () => ({ state: 'in-use', lines: ['held'] })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await h.approve()
    await h.driver.start('worker', { choice: 'keep', requestedBy: 'window' })
    h.setDirty(['a.txt'])
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().step).toBe('reviewing')
    h.failCommit('auth')
    await h.approve()
    expect(h.state().wait?.kind).toBe('auth')
  })

  it('Keep after published-with-differences keeps a landing obligation', async () => {
    const h = await harness()
    h.deps.removal.remove = async () => ({ state: 'in-use', lines: ['held'] })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    h.deps.svn.publicationHashes = async (_root: string, paths: string[]) => ({ ok: true, value: Object.fromEntries(paths.map((p) => [p, 'bad'])) }) as never
    await h.approve()
    expect(h.state().wait?.kind).toBe('published-with-differences')
    await h.driver.start('worker', { choice: 'keep', requestedBy: 'window' })
    const record = (await h.reload()).get('worker')!
    expect(LandedRows.landingOf(record)?.landed).toHaveLength(1)
  })

  async function lostRun(h: Awaited<ReturnType<typeof harness>>, runId: string, step: 'worker-resolving' | 'checking') {
    await h.records.put({ sessionId: runId, kind: 'shell', title: 'helper', directory: { mode: 'default' }, binding: null, life: 'lost', createdAt: 1,
      scriptOf: { sessionId: 'worker', phase: 'after', scriptId: 'checks', name: 'check' } } as never)
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'finishing', step, wait: undefined,
      execution: { ...record.worktreeLifecycle!.execution!, runId, verdict: undefined } } }))
    const unexpected = async (): Promise<never> => { throw new Error('A lost run has no bound Host') }
    const scripts = new SessionScriptsManager({ records: h.records, logs: h.logs, now: Date.now, report: () => {}, onCollapsed: () => {},
      host: { runtimeStop: unexpected, runtimeInspect: unexpected, runtimeRemove: unexpected } })
    h.deps.stopRun = (id, manual) => scripts.confirmStopped(id, manual)
  }

  it('R5-H2: a lost merger refuses Keep and Discard, then the person confirms its stop and returns to work', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await lostRun(h, 'merger-1', 'worker-resolving')
    expect(await h.driver.start('worker', { choice: 'keep', requestedBy: 'window' })).toMatchObject({ ok: false, code: 'merge-pending' })
    expect(await h.driver.start('worker', { choice: 'discard', requestedBy: 'window' })).toMatchObject({ ok: false, code: 'merge-pending' })
    expect(await h.driver.backToWork('worker', 'person')).toMatchObject({ ok: false, code: 'merge-pending' })
    expect(h.state().execution?.stopRefusedRunId).toBe('merger-1')
    expect(WorktreeWords.actions(h.state())).toContainEqual(expect.objectContaining({ id: 'confirm-stopped', runId: 'merger-1' }))
    expect(await h.driver.backToWork('worker', 'agent', 'merger-1')).toMatchObject({ ok: false, code: 'person-only' })
    expect(await h.driver.backToWork('worker', 'person', 'merger-1')).toMatchObject({ ok: true })
    expect(h.state().phase).toBe('active')
  })

  it.each(['keep', 'discard'] as const)('UA1-J10-4: the manual stop confirmation after a refused %s goes on with that press', async (choice) => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await lostRun(h, 'merger-1', 'worker-resolving')
    const refused = await h.driver.start('worker', { choice, requestedBy: 'window' })
    expect(refused).toMatchObject({ ok: false, code: 'merge-pending', detail: expect.stringContaining('I stopped the processes manually') })
    const confirm = WorktreeWords.actions(h.state()).find((action) => action.id === 'confirm-stopped')!
    expect(confirm.confirm).toContain(choice === 'keep' ? 'keep the worktree' : 'discard the worktree')
    expect(await h.driver.backToWork('worker', 'person', 'merger-1')).toMatchObject({ ok: true })
    if (choice === 'keep') expect(h.state().phase).toBe('kept')
    else expect(h.state()).toMatchObject({ purpose: 'discard' })
  })

  it('UA1-J10-1: a refused Stop of a live check says to retry Stop and offers no manual confirmation', async () => {
    const h = await harness()
    h.setChecks([{ key: 'check', scriptId: 'checks', name: 'Check', commands: [{ cwd: h.root, command: 'check' }] }])
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const runId = h.state().execution!.runId!
    await h.records.update(runId, (record) => ({ ...record, life: 'live', binding: { hostInstanceId: 'fixture', generation: 1 } }))
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected Host call') }
    const scripts = new SessionScriptsManager({ records: h.records, logs: h.logs, now: Date.now, report: () => {}, onCollapsed: () => {},
      host: { runtimeInspect: unexpected, runtimeRemove: unexpected, runtimeStop: async () => ({ ok: false, code: 'op-rejected', status: 409,
        detail: 'runtime.stop answered 409: Terminal descendant inspection failed for root PID 7; retry Stop: CIM timed out' }) } })
    h.deps.stopRun = (id, manual) => scripts.confirmStopped(id, manual)
    h.deps.stopRefusal = (id) => scripts.stopRefusalOf(id)
    const refused = await h.driver.backToWork('worker', 'person')
    expect(refused).toMatchObject({ ok: false, code: 'merge-pending', detail: expect.stringContaining('descendant inspection failed') })
    expect(refused.ok ? '' : refused.detail).toContain('Stop again')
    expect(refused.ok ? '' : refused.detail).not.toContain('manually')
    expect(refused.ok ? '' : refused.detail).not.toContain('runtime.stop answered')
    expect(h.state().execution?.stopRefusedRunId).toBeUndefined()
    expect(WorktreeWords.actions(h.state()).map((action) => action.id)).not.toContain('confirm-stopped')
  })

  it('UA1-J10-2: a lost check is judged into a person wait that names the loss, and Try again needs its stop confirmed', async () => {
    const h = await harness()
    h.setChecks([{ key: 'check', scriptId: 'checks', name: 'tests', commands: [{ cwd: h.root, command: 'check' }] }])
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await lostRun(h, 'check-1', 'checking')
    await settledWithoutLog(h, 'check-1')
    expect(await h.driver.noteVerdict('worker', { kind: 'failed', reason: 'its check session was lost' })).toBe(true)
    await h.driver.drive('worker')
    const state = h.state()
    expect(state).toMatchObject({ phase: 'waiting', step: 'checking', wait: { kind: 'host-unhealthy', reason: expect.stringContaining('The check tests was lost') } })
    expect(state.wait?.reason).toContain('may still run')
    expect(state.execution).toMatchObject({ verdict: { kind: 'failed' }, stopRefusedRunId: 'check-1' })
    expect(WorktreeWords.presentation(state)).toMatchObject({ title: 'Processes may still run' })
    expect(FinishProjection.action(h.records.get('worker')!)?.needs).toMatchObject({ kind: 'not-stopped' })
    expect(WorktreeWords.actions(state).map((action) => action.id)).toContain('confirm-stopped')
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })).toMatchObject({ ok: false, code: 'merge-pending' })
    expect(h.state().execution?.runId).toBe('check-1')
    expect(await h.driver.backToWork('worker', 'person', 'check-1')).toMatchObject({ ok: true })
    expect(h.state()).toMatchObject({ phase: 'finishing', step: 'checking' })
    expect(h.state().execution?.runId).not.toBe('check-1')
  })

  it('UA1-J10-2: a lost merger is judged into a person wait, its step ends and Stop agent is no longer offered', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await lostMerger(h)
    expect(await h.driver.noteVerdict('worker', { kind: 'failed', reason: 'its merger session was lost' })).toBe(true)
    const state = h.state()
    expect(state).toMatchObject({ phase: 'waiting', step: 'worker-resolving', wait: { kind: 'host-unhealthy', reason: expect.stringContaining('The merger was lost') } })
    expect(state.execution?.merger?.endedAt).toBeDefined()
    const ids = WorktreeWords.actions(state).map((action) => action.id)
    expect(ids).not.toContain('stop-agent')
    expect(ids).toContain('confirm-stopped')
  })

  it('UA1-J10-3: Check again with a lost merger that saved no log records it ended and goes on', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await lostMerger(h)
    Object.assign(h.deps.svn, { hashes: async (_root: string, paths: string[]) => ({ ok: true, value: Object.fromEntries(paths.map((path) => [path, 'same'])) }),
      baseAbove: async () => ({ ok: true, value: null }) })
    expect(await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })).toMatchObject({ ok: true })
    expect(h.state().execution?.merger?.endedAt).toBeDefined()
    expect(h.failures.join(' ')).not.toContain('could not be retained')
  })

  async function settledWithoutLog(h: Awaited<ReturnType<typeof harness>>, runId: string) {
    await h.records.update('worker', (record) => ({ ...record, scriptRuns: [...record.scriptRuns ?? [], { runId, title: runId, phase: 'after', scriptId: 'checks', name: runId,
      commands: [], startedAt: 1, endedAt: Date.now(), outcome: 'lost', log: { state: 'unavailable', reason: 'the Host restarted before the output was saved' } }] }))
  }

  async function lostMerger(h: Awaited<ReturnType<typeof harness>>) {
    await lostRun(h, 'merger-1', 'worker-resolving')
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!,
      execution: { ...record.worktreeLifecycle!.execution!, merger: { runId: 'merger-1', setAt: 1, startedAt: Date.now() - 60_000 } } } }))
    await settledWithoutLog(h, 'merger-1')
  }

  it('R5-H4: a refused stop does not offer or accept a manual confirmation for the next run', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await lostRun(h, 'check-1', 'checking')
    expect(await h.driver.backToWork('worker', 'person')).toMatchObject({ ok: false, code: 'merge-pending' })
    await lostRun(h, 'check-2', 'checking')
    expect(WorktreeWords.actions(h.state()).map((action) => action.id)).not.toContain('confirm-stopped')
    expect(await h.driver.backToWork('worker', 'person', 'check-2')).toMatchObject({ ok: false, code: 'person-only' })
  })

  it('R5-P1: a failed interim status read after the first of two roots does not skip the second root', async () => {
    const h = await harness()
    h.deps.svn.assembly = async () => ({ ok: true, value: testAssembly() })
    const paths = ['shared/back/a.txt', 'a.txt']
    for (const path of paths) { await mkdir(join(h.root, path, '..'), { recursive: true }); await writeFile(join(h.root, path), 'worker\r\n') }
    h.setDirty(paths)
    const roots = ['shared/back', ''].map((own, index) => ({ own, path: join(h.root, own), pinned: false,
      changed: [{ path: 'a.txt', kind: 'item' as const, conflict: false }], repository: ['https://svn/back', 'https://svn/apps'][index] }))
    h.deps.svn.reviewRoots = async () => ({ ok: true, value: roots })
    h.deps.svn.lowerBounds = async () => ({ ok: true, value: Object.fromEntries(roots.map((root) => [root.own,
      { repository: root.repository, base: '/trunk', rootBase: 1, since: 1 }])) })
    const changes = h.deps.svn.changes
    let failed = false
    h.deps.svn.changes = async (...args) => {
      if (failed || (h.state().verified?.length ?? 0) === 0) return changes(...args)
      failed = true
      return { ok: false, code: 'svn-failed', detail: 'svn: E155004: Working copy locked' }
    }
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const repositories = h.state().review!.repositories!.map((row) => ({ ...row, message: `${row.expectedPrefix} Fix`, source: 'person-local' as const }))
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', selection: paths.map((path) => join(h.root, path)),
      message: '[apps] Fix', messageSource: 'person-local', repositories, reviewVersion: h.state().version })
    expect(failed).toBe(true)
    expect(h.events.filter((event) => event === 'commit')).toHaveLength(2)
    expect(h.state().phase).toBe('landed')
    expect(h.records.get('worker')?.worktreeOutcome?.result).toBe('committed')
    expect(h.failures).toEqual([expect.stringContaining('E155004')])
  })

  async function corrective(h: Awaited<ReturnType<typeof harness>>) {
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const publish = h.deps.svn.publicationHashes
    h.deps.svn.publicationHashes = async (_root: string, paths: string[]) => ({ ok: true, value: Object.fromEntries(paths.map((p) => [p, p === 'b.txt' ? 'bad' : 'hash'])) }) as never
    await approveBoth(h, ['a.txt', 'b.txt'])
    expect(h.state().wait?.kind).toBe('published-with-differences')
    h.deps.svn.publicationHashes = publish
  }

  it('R5-P2: refuses Back to work for the whole corrective publication', async () => {
    const h = await twoFiles()
    await corrective(h)
    h.setDirty(['b.txt'])
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', reviewCorrection: true })
    expect(h.state().step).toBe('reviewing')
    expect(WorktreeWords.actions(h.state()).map((action) => action.id)).not.toContain('back-to-work')
    expect(await h.driver.backToWork('worker', 'person')).toMatchObject({ ok: false, detail: 'Back to work is possible only before the commit starts' })
    h.failCommit('auth')
    await approveBoth(h, ['b.txt'])
    expect(h.state().wait?.kind).toBe('auth')
    expect(WorktreeWords.actions(h.state()).map((action) => action.id)).not.toContain('back-to-work')
    expect(await h.driver.backToWork('worker', 'person')).toMatchObject({ ok: false })
    expect(h.state().phase).toBe('waiting')
  })

  it('R5-P7: an empty corrective action keeps the published revision in the removal tombstone and the title', async () => {
    const h = await twoFiles()
    const remove = h.deps.removal.remove
    h.deps.removal.remove = vi.fn(async () => ({ state: 'in-use' as const, lines: ['held'] }))
    await corrective(h)
    h.setDirty([])
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', reviewCorrection: true })
    await approveBoth(h, [])
    expect(h.deps.removal.remove).toHaveBeenLastCalledWith('worker', expect.anything(), ['url:r2'], expect.anything())
    expect(WorktreeWords.presentation(h.state()).title).toBe('Changes published; worktree removal is blocked')
    h.deps.removal.remove = remove
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(h.state().phase).toBe('landed')
    expect(WorktreeWords.presentation(h.state()).title).toBe('Changes published')
  })

  it('R5-P3: Keep records its own status when the result status read fails', async () => {
    const h = await harness()
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const changes = h.deps.svn.changes
    let calls = 0
    h.deps.svn.changes = async (...args) => ++calls === 2 ? { ok: false, code: 'svn-failed', detail: 'svn: E155037: Previous operation has not finished' } : changes(...args)
    expect(await h.driver.start('worker', { choice: 'keep', requestedBy: 'window' })).toMatchObject({ ok: true })
    expect(h.state().phase).toBe('kept')
    expect(h.state().publication?.remaining).toEqual(['a.txt'])
    expect((await h.results.list({ sessionId: 'worker' })).map((row) => row.result)).toEqual(['kept'])
  })

  it('R5-P4: a new action does not reuse the remaining paths observed by an older one', async () => {
    const h = await harness()
    h.deps.removal.remove = async () => ({ state: 'in-use', lines: ['held'] })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    await h.approve()
    expect(await h.driver.start('worker', { choice: 'keep', requestedBy: 'window' })).toMatchObject({ ok: true })
    expect(h.state().publication?.remaining).toEqual([])
    h.setDirty(['c.txt'])
    h.deps.svn.present = async () => false
    h.deps.removal.remove = async () => ({ state: 'removed', lines: [] })
    expect(await h.driver.start('worker', { choice: 'discard', requestedBy: 'window' })).toMatchObject({ ok: true })
    expect(h.records.get('worker')?.worktreeOutcome?.result).toBe('partial')
  })
})

// worker-agent r288: Prepare added the empty lockfile the setup wrote, and the review required its publication.
describe('setup outputs', () => {
  it('neither adds nor reviews an untouched unversioned setup output and publishes without it', async () => {
    const h = await harness()
    const lock = 'components/package-lock.json'
    await h.records.update('worker', (record) => ({ ...record, worktree: { ...record.worktree!, setupBaseline: { at: 1, hashes: { [lock]: 'hash' } } } }))
    const rows = () => [{ path: 'a.txt', conflict: false, kind: 'item' as const }, { path: lock, conflict: false, kind: 'item' as const, unversioned: true as const }]
    h.deps.svn.changes = async () => ({ ok: true, value: rows() })
    h.deps.svn.reviewRoots = async () => ({ ok: true, value: [{ path: h.root, own: '', pinned: false, changed: rows() }] })
    const prepared: string[] = []
    const prepare = h.deps.svn.prepareCommit
    h.deps.svn.prepareCommit = async (scope, paths, before, normalize) => { prepared.push(...paths); return prepare(scope, paths, before, normalize) }
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    expect(prepared).toEqual([join(h.root, 'a.txt')])
    expect(h.state().review).toMatchObject({ selection: ['a.txt'], setupOutputs: [lock] })
    expect(Object.keys(h.state().review!.hashes)).toEqual(['a.txt'])
    expect(await h.approve()).toMatchObject({ ok: true })
    expect(prepared.some((path) => path.endsWith('package-lock.json'))).toBe(false)
  })
})


describe('UA1-J07 the ending of a partial publication', () => {
  async function partlyPublished() {
    const h = await harness()
    h.deps.svn.assembly = async () => ({ ok: true, value: testAssembly() })
    const paths = ['shared/front/a.txt', 'shared/back/a.txt', 'a.txt']
    for (const path of paths) { await mkdir(join(h.root, path, '..'), { recursive: true }); await writeFile(join(h.root, path), 'worker\r\n') }
    h.setDirty(paths)
    const roots = ['shared/front', 'shared/back', ''].map((own, index) => ({ own, path: join(h.root, own), pinned: false,
      changed: [{ path: 'a.txt', kind: 'item' as const, conflict: false }], repository: ['https://svn/front', 'https://svn/back', 'https://svn/apps'][index] }))
    h.deps.svn.reviewRoots = async () => ({ ok: true, value: roots })
    h.deps.svn.lowerBounds = async () => ({ ok: true, value: Object.fromEntries(roots.map((root) => [root.own,
      { repository: root.repository, base: '/trunk', rootBase: 1, since: 1 }])) })
    const run = h.deps.runner.run.bind(h.deps.runner)
    vi.spyOn(h.deps.runner, 'run').mockImplementation(async (...args) => {
      if (args[1] === 'commit' && args[2] === h.root) return { ok: false, failure: 'other', output: 'Commit blocked by pre-commit hook', exitCode: 1, runId: 'refused-main' }
      return run(...args)
    })
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window' })
    const repositories = h.state().review!.repositories!.map((row) => ({ ...row, message: `${row.expectedPrefix} Fix`, source: 'person-local' as const }))
    await h.driver.start('worker', { choice: 'commit', requestedBy: 'window', selection: paths.map((path) => join(h.root, path)),
      message: '[apps] Fix', messageSource: 'person-local', repositories, reviewVersion: h.state().version })
    expect(h.state().wait?.kind).toBe('partially-landed')
    h.setDirty(['a.txt', 'src/b.txt'])
    return h
  }

  it.each([
    ['keep', ['Worktree kept. Partly published: back r3, front r2', 'Not published, left in the worktree: a.txt, src/b.txt']],
    ['discard', ['Worktree discarded. Partly published: back r3, front r2', 'Not published: a.txt, src/b.txt']],
  ] as const)('after %s names what was published and what was not, in the one section of its action', async (choice, lines) => {
    const h = await partlyPublished()
    const actionId = h.state().actionId
    expect(await h.driver.start('worker', { choice, requestedBy: 'window' })).toMatchObject({ ok: true })
    const record = h.records.get('worker')!
    expect(record.worktreeOutcome?.lines.slice(0, 2)).toEqual(lines)
    expect((await h.results.list({ sessionId: 'worker' })).find((row) => row.actionId === actionId)?.lines.slice(0, 2)).toEqual(lines)
    const sections = SessionWorkflows.sectionsOf(record, (id) => h.records.get(id)).filter((section) => section.kind === 'finish' || section.kind === 'discard')
    expect(sections.map((section) => [section.workflowId, section.summary])).toEqual([[actionId, lines[0]]])
  })
})
