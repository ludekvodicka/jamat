import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostDescriptor, HostWsClientMsg } from '../../../app-host/app/wire/hostWire.js'
import type { TerminalAttachSocketDeps } from '../../hostClient/terminalAttachSocket'
import { CommandInvoker } from '../../shared/commandInvoker'
import { SvnInvoker } from '../../svn/svnInvoker'
import type { SvnConflictFact } from '../../svn/svn.types'
import { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import type { SvnActionConflictSet } from '../../sessionManager/worktreeSessionRecords'
import { WorktreeLease } from '../worktreeLease'
import { WorktreeSvnCommands } from '../worktreeSvnCommands'
import { TerminalGateway } from '../../sessionManager/terminals/terminalGateway'
import { SyncStep } from './syncStep'
import { emptyUpdateTargets } from './finishTestRecords'
import { WorktreeWords } from '../view/worktreeWords'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'jamat-sync-'))
  directories.push(root)
  const records = await SessionRecordsStore.load(join(root, 'records.json'), { snapshotsDirectory: join(root, 'snapshots'), report: () => {} })
  const path = join(root, '.worktrees', 'tree')
  await records.put({ sessionId: 'worker', kind: 'agent', title: 'Worker', life: 'live', binding: null, directory: { mode: 'default' }, createdAt: 1,
    agent: { agentId: 'claude', launchMode: 'new' }, worktree: { kind: 'svn', repositoryRoot: root, worktreePath: path, branch: 'url', baseCommit: 'r1' },
    worktreeLifecycle: { version: 0, actionId: null, phase: 'active', outOfDate: 0, journal: [],
      facts: { worker: { liveness: 'alive', resumeFailures: 0, ready: { at: 1, hashes: { a: 'hash' } } } } } })
  let idle = true
  let ready = true
  let held = 0
  let facts: SvnConflictFact[] = []
  const set: SvnActionConflictSet = { entries: [], readAt: 2, revision: 2, baseRevision: 1, more: 0 }
  const runner = { run: vi.fn(async () => ({ ok: true as const, output: '', exitCode: 0, runId: 'run' })) }
  const deps: ConstructorParameters<typeof SyncStep>[0] = {
    records, runner, commands: { lease: new WorktreeLease('self', () => []), accept: vi.fn(async () => {}), verify: vi.fn(async () => {}) },
    svn: { updateTargets: emptyUpdateTargets, headRevisionOf: vi.fn(async () => { expect(held).toBe(1); return { ok: true as const, value: 2 } }),
      revisionOf: async () => ({ ok: true, value: 1 }), conflictSet: async () => ({ ok: true, value: { revision: 2, rows: [], facts } }),
      scheduleMissing: vi.fn(async () => ({ ok: true as const, value: undefined })) },
    conflicts: { remember: async () => ({ ok: true, value: { set, memory: { actionId: 'sync', readAt: 2, paths: [] } } }),
      remembered: async (_action, memory) => ({ ok: true, value: { set, memory, reasons: [] } }),
      fix: async (action) => ({ kind: 'settled', action }) },
    ready: { current: async () => ready }, busyReason: () => idle ? null : 'the worker is working', holdInput: () => { held++; return () => { held-- } }, changed: () => {},
  }
  return { step: new SyncStep(deps), deps, records, runner, path, set, held: () => held,
    idle: (value: boolean) => { idle = value }, ready: (value: boolean) => { ready = value }, facts: (value: SvnConflictFact[]) => { facts = value } }
}

describe('SyncStep', () => {
  it('carries verified settlements and pruned conflict memory into the remaining update steps', async () => {
    const h = await harness()
    h.facts([{ path: 'a', kind: 'text' } as SvnConflictFact])
    let reads = 0
    h.deps.conflicts.remember = async (_action, previous) => {
      reads++
      if (reads > 1) expect(previous?.paths).toEqual([])
      return { ok: true, value: { set: { ...h.set, entries: reads === 1 ? [{ path: 'a', kind: 'text', shape: 'unrecognized',
        state: 'rule', options: ['take-incoming'], facts: {} }] : [] },
      memory: { actionId: 'sync', readAt: 2, paths: reads === 1 ? [{ path: 'a', saved: '/saved', sidecars: [], kind: 'text' }] : [] } } }
    }
    h.deps.conflicts.fix = async (action) => {
      h.facts([])
      return { kind: 'applied', action: { ...action, conflictSet: { ...action.conflictSet!,
        entries: action.conflictSet!.entries.map((entry) => ({ ...entry, state: 'settled', settledWith: 'take-incoming' })) } } }
    }
    h.deps.conflicts.remembered = async (action, memory) => {
      expect(action.conflictSet?.entries[0]).toMatchObject({ state: 'settled', settledWith: 'take-incoming' })
      return { ok: true, value: { set: h.set, memory: { ...memory, paths: [] }, reasons: [] } }
    }
    expect(await h.step.run('worker', 'finish')).toMatchObject({ ok: true, value: { conflicts: [] } })
    expect(reads).toBe(2)
    expect(h.records.get('worker')?.worktreeLifecycle).toMatchObject({ step: 'checking', update: { completed: true },
      syncConflictSet: { entries: [{ state: 'settled', settledWith: 'take-incoming' }] } })
  })

  it('does not reuse same-HEAD ready evidence while a saved external update is pending', async () => {
    const h = await harness()
    const target = await emptyUpdateTargets.owner(h.path, 2)
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, actionId: 'sync',
      facts: { ...record.worktreeLifecycle!.facts, syncedAt: { revision: 2, at: 1 } },
      update: { actionId: 'sync', generation: 'saved', root: h.path, revision: 2, cursor: 0, completed: false,
        units: [{ target, phase: 'pending' }] } } }))
    expect(await h.step.run('worker', 'ready')).toMatchObject({ ok: true })
    expect(h.runner.run).toHaveBeenCalledOnce()
    expect(h.records.get('worker')?.worktreeLifecycle?.update?.completed).toBe(true)
  })

  it('reserves Finish control before waiting, permits its nested sync and releases control after failure', async () => {
    const h = await harness()
    await expect(h.step.withControl('worker', async () => {
      expect(await h.step.run('worker', 'ready')).toMatchObject({ ok: false, code: 'merge-pending' })
      expect(await h.step.run('worker', 'worker')).toMatchObject({ ok: false, code: 'merge-pending' })
      await h.step.withControl('worker', async () => { expect(await h.step.run('worker', 'finish')).toMatchObject({ ok: true }) })
      expect(await h.step.run('worker', 'ready')).toMatchObject({ ok: false, code: 'merge-pending' })
      throw new Error('Finish stopped')
    })).rejects.toThrow('Finish stopped')
    expect(await h.step.run('worker', 'worker')).toMatchObject({ ok: true })
  })

  it('schedules filesystem deletions before update while excluding native and remembered conflict victims', async () => {
    const h = await harness()
    const memory = { actionId: 'old', readAt: 1, paths: [{ path: 'remembered', saved: '/saved', sidecars: [], kind: 'text' as const }] }
    await h.records.update('worker', (record) => ({ ...record, worktree: { ...record.worktree!, conflictMemory: memory } }))
    h.facts([{ path: 'native', kind: 'tree' } as SvnConflictFact])
    h.deps.svn.scheduleMissing = vi.fn(async (_root, victims) => {
      expect(h.runner.run).not.toHaveBeenCalled()
      expect(victims).toEqual(['native', 'remembered'])
      return { ok: true as const, value: undefined }
    })
    expect(await h.step.run('worker', 'finish')).toMatchObject({ ok: true })
    expect(h.deps.svn.scheduleMissing).toHaveBeenCalledOnce()
    expect(h.runner.run).toHaveBeenCalledOnce()
  })

  it('refuses update when filesystem deletion preparation fails', async () => {
    const h = await harness()
    h.deps.svn.scheduleMissing = async () => ({ ok: false, code: 'refused', detail: 'Cannot schedule deletion' })
    expect(await h.step.run('worker', 'finish')).toMatchObject({ ok: false, code: 'svn-failed', detail: 'Cannot schedule deletion' })
    expect(h.runner.run).not.toHaveBeenCalled()
    expect(h.records.get('worker')?.worktreeLifecycle?.wait).toMatchObject({ kind: 'svn-failed' })
  })

  it('settles the worker retained set under the lease and starts checks only after the last path', async () => {
    const h = await harness()
    h.set.entries.push(...['a', 'b'].map((path) => ({ path, kind: 'text' as const, shape: 'unrecognized' as const,
      state: 'agent' as const, options: ['merged' as const], facts: {} })))
    h.facts([{ path: 'a', kind: 'text' }, { path: 'b', kind: 'text' }] as SvnConflictFact[])
    await h.step.run('worker', 'worker')
    h.deps.conflicts.resolve = vi.fn<NonNullable<typeof h.deps.conflicts.resolve>>(async (action, request, journal, step) => {
      expect(step).toBe('worker-resolving')
      await journal(request.path, { option: 'merged', done: 1 }, 'text')
      const entries = action.conflictSet!.entries.map((entry) => entry.path === request.path ? { ...entry, state: 'settled' as const, journal: { option: 'merged' as const, done: 1 } } : entry)
      return { ok: true, value: { action: { ...action, conflictSet: { ...action.conflictSet!, entries } }, state: 'settled', left: entries.filter((entry) => entry.state !== 'settled').length } }
    })
    h.deps.conflicts.remembered = async (action, memory) => ({ ok: true, value: { memory, reasons: [],
      set: { ...action.conflictSet!, entries: action.conflictSet!.entries.filter((entry) => entry.state !== 'settled') } } })
    expect(await h.step.resolve('worker', { path: 'a', option: 'merged', requestedBy: 'cli', confirm: false })).toMatchObject({ ok: true, value: { left: 1 } })
    expect(h.records.get('worker')?.worktreeLifecycle?.step).toBe('worker-resolving')
    expect(await h.step.resolve('worker', { path: 'b', option: 'merged', requestedBy: 'cli', confirm: false })).toMatchObject({ ok: true, value: { left: 0 } })
    expect(h.records.get('worker')?.worktreeLifecycle).toMatchObject({ step: 'syncing', syncConflictSet: { entries: [
      expect.objectContaining({ path: 'a', journal: { option: 'merged', done: 1 } }),
      expect.objectContaining({ path: 'b', journal: { option: 'merged', done: 1 } }),
    ] } })
    h.facts([])
    h.set.entries.splice(0)
    expect(await h.step.run('worker', 'finish')).toMatchObject({ ok: true, value: { conflicts: [] } })
    expect(h.records.get('worker')?.worktreeLifecycle?.step).toBe('checking')
  })

  it('rewrites the person\'s conflict wait after each settlement, and names Try again once nothing is left', async () => {
    const h = await harness()
    h.set.entries.push(...['a', 'b'].map((path) => ({ path, kind: 'text' as const, shape: 'text-overlap' as const,
      state: 'person' as const, options: ['merged' as const], facts: {} })))
    h.facts([{ path: 'a', kind: 'text' }, { path: 'b', kind: 'text' }] as SvnConflictFact[])
    await h.step.run('worker', 'worker')
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, phase: 'waiting',
      wait: { kind: 'conflict-person', at: 3, reason: '2 conflicts need you: a, b; settle them, then press Check again' } } }))
    h.deps.conflicts.resolve = async (action, request) => {
      const entries = action.conflictSet!.entries.map((entry) => entry.path === request.path ? { ...entry, state: 'settled' as const, by: 'person' as const } : entry)
      return { ok: true, value: { action: { ...action, conflictSet: { ...action.conflictSet!, entries } }, state: 'settled', left: entries.filter((entry) => entry.state !== 'settled').length } }
    }
    h.deps.conflicts.remembered = async (action, memory) => ({ ok: true, value: { memory, reasons: [],
      set: { ...action.conflictSet!, entries: action.conflictSet!.entries.filter((entry) => entry.state !== 'settled') } } })
    expect(await h.step.resolve('worker', { path: 'a', option: 'merged', requestedBy: 'window', confirm: false })).toMatchObject({ ok: true, value: { left: 1 } })
    expect(h.records.get('worker')?.worktreeLifecycle?.wait)
      .toEqual({ kind: 'conflict-person', at: 3, reason: '2 conflicts: you fixed 1, 1 needs you: b; settle them, then press Check again' })
    await h.step.resolve('worker', { path: 'b', option: 'merged', requestedBy: 'window', confirm: false })
    expect(h.records.get('worker')?.worktreeLifecycle).toMatchObject({ step: 'syncing',
      wait: { kind: 'conflict-person', at: 3, reason: '2 conflicts: you fixed 2; all are settled, press Try again to go on' } })
  })

  it('waits for current ready plus idle, then journals one fixed-target update', async () => {
    const h = await harness()
    h.idle(false)
    expect(await h.step.run('worker', 'ready')).toMatchObject({ ok: false, code: 'session-working' })
    expect(h.runner.run).not.toHaveBeenCalled()
    expect(h.held()).toBe(0)
    h.idle(true)
    expect(await h.step.run('worker', 'ready')).toMatchObject({ ok: true, value: { revision: 2, conflicts: [] } })
    expect(h.runner.run).toHaveBeenCalledWith('worker', 'update', h.path, ['update', '-r', '2', '--ignore-externals', '--accept', 'postpone', '--', '.'],
      expect.objectContaining({ targetRevision: 2 }), expect.objectContaining({ title: 'Update . to r2' }))
    expect(h.records.get('worker')?.worktreeLifecycle).toMatchObject({ step: 'checking', facts: { syncedAt: { revision: 2, headMovedBy: 1 } } })
  })

  // Sync now after the worker settled r2 synced to r2 although HEAD was r3 (UA1-J14-5).
  it('finishes the update its conflicts held at its own target, then syncs again to the HEAD of the press', async () => {
    const h = await harness()
    h.facts([{ path: 'a', kind: 'text' } as SvnConflictFact])
    expect(await h.step.run('worker', 'finish')).toMatchObject({ ok: true, value: { revision: 2, conflicts: [{ path: 'a', kind: 'text' }] } })
    h.facts([])
    h.deps.svn.headRevisionOf = async () => ({ ok: true, value: 3 })
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, step: 'syncing' } }))
    expect(await h.step.run('worker', 'finish')).toMatchObject({ ok: true, value: { revision: 3, conflicts: [] } })
    expect(h.runner.run).toHaveBeenLastCalledWith('worker', 'update', h.path, ['update', '-r', '3', '--ignore-externals', '--accept', 'postpone', '--', '.'],
      expect.objectContaining({ targetRevision: 3 }), expect.objectContaining({ title: 'Update . to r3' }))
    expect(h.records.get('worker')?.worktreeLifecycle).toMatchObject({ step: 'checking', facts: { syncedAt: { revision: 3 } } })
  })

  it('names in the busy wait what holds the worker', async () => {
    const h = await harness()
    h.deps.busyReason = () => 'a message to the worker is not delivered yet: Checks failed'
    expect(await h.step.run('worker', 'finish')).toMatchObject({ ok: false, code: 'session-working',
      detail: WorktreeWords.syncBusyOf('a message to the worker is not delivered yet: Checks failed') })
  })

  it('same-HEAD Finish refreshes floating externals even after a ready sync', async () => {
    const h = await harness()
    await h.step.run('worker', 'ready')
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, step: 'syncing' } }))
    expect(await h.step.run('worker', 'finish')).toMatchObject({ ok: true })
    expect(h.runner.run).toHaveBeenCalledTimes(2)
    expect(h.records.get('worker')?.worktreeLifecycle?.step).toBe('checking')
    expect(h.records.get('worker')?.worktreeLifecycle?.facts.worker.ready).toBeUndefined()
  })

  it('keeps a same-name file a keep-both rule left diverged open for the person, across the update that goes on', async () => {
    const h = await harness()
    h.facts([{ path: '.aidocs', kind: 'tree' } as SvnConflictFact])
    let reads = 0
    h.deps.conflicts.remember = async () => {
      reads++
      return { ok: true, value: { set: { ...h.set, entries: reads === 1 ? [{ path: '.aidocs', kind: 'tree', shape: 'obstructed-dir',
        state: 'rule', rule: 'keep-both', options: ['keep-both', 'take-incoming', 'keep-mine'], facts: {} }] : [] },
      memory: { actionId: 'sync', readAt: 2, paths: [] } } }
    }
    const diverged = { path: '.aidocs/engines/brief.md', kind: 'diverged' as const, shape: 'diverged' as const, state: 'person' as const,
      options: ['merged' as const, 'take-incoming' as const, 'keep-mine' as const], facts: { incomingRevision: 2 }, saved: '/saved/.aidocs/engines/brief.md' }
    h.deps.conflicts.fix = async (action) => {
      h.facts([])
      return { kind: 'applied', action: { ...action, conflictSet: { ...action.conflictSet!, entries: [
        ...action.conflictSet!.entries.map((entry) => ({ ...entry, state: 'settled' as const, by: 'jamat' as const, settledWith: 'keep-both' as const, saved: '/saved/.aidocs' })),
        diverged] } } }
    }
    h.deps.conflicts.remembered = async (_action, memory) => ({ ok: true, value: { set: { ...h.set, entries: [] }, memory, reasons: [] } })
    expect(await h.step.run('worker', 'finish')).toMatchObject({ ok: true, value: { conflicts: [{ path: '.aidocs/engines/brief.md', kind: 'diverged' }] } })
    const state = h.records.get('worker')?.worktreeLifecycle
    expect(state?.step).toBe('worker-resolving')
    expect(state?.syncConflictSet?.entries).toEqual([expect.objectContaining({ path: '.aidocs', state: 'settled', settledWith: 'keep-both' }), diverged])
  })

  it('carries an open diverged file into a later sync whose update svn reports clean', async () => {
    const h = await harness()
    const fixed = { path: '.aidocs', kind: 'tree' as const, shape: 'obstructed-dir' as const, state: 'settled' as const,
      by: 'jamat' as const, settledWith: 'keep-both' as const, saved: '/saved/.aidocs', options: ['keep-both' as const], facts: {} }
    const diverged = { path: '.aidocs/engines/brief.md', kind: 'diverged' as const, shape: 'diverged' as const, state: 'person' as const,
      options: ['merged' as const, 'take-incoming' as const, 'keep-mine' as const], facts: { incomingRevision: 2 }, saved: '/saved/.aidocs/engines/brief.md' }
    await h.records.update('worker', (record) => ({ ...record,
      worktreeLifecycle: { ...record.worktreeLifecycle!, syncConflictSet: { ...h.set, entries: [fixed, diverged] } } }))
    expect(await h.step.run('worker', 'finish')).toMatchObject({ ok: true, value: { conflicts: [{ path: '.aidocs/engines/brief.md', kind: 'diverged' }] } })
    expect(h.records.get('worker')?.worktreeLifecycle?.syncConflictSet?.entries).toEqual([fixed, diverged])
    expect(h.records.get('worker')?.worktreeLifecycle?.step).toBe('worker-resolving')
  })

  it('retains completed conflict evidence across repeated sync but a new conflict replaces its settlement', async () => {
    const h = await harness()
    const fixed = { path: 'folder', kind: 'tree' as const, shape: 'obstructed-dir' as const, state: 'settled' as const,
      by: 'jamat' as const, settledWith: 'keep-both' as const, saved: '/saved/folder', options: ['keep-both' as const], facts: {} }
    await h.records.update('worker', (record) => ({ ...record,
      worktreeLifecycle: { ...record.worktreeLifecycle!, syncConflictSet: { ...h.set, entries: [fixed] } } }))
    await h.step.run('worker', 'finish')
    expect(h.records.get('worker')?.worktreeLifecycle?.syncConflictSet?.entries).toEqual([fixed])
    expect(h.records.get('worker')?.worktreeLifecycle?.step).toBe('checking')
    h.set.entries.push({ ...fixed, state: 'person', by: undefined, settledWith: undefined })
    h.facts([{ path: 'folder', kind: 'tree' } as SvnConflictFact])
    await h.step.run('worker', 'finish')
    expect(h.records.get('worker')?.worktreeLifecycle?.syncConflictSet?.entries).toEqual(h.set.entries)
    expect(h.records.get('worker')?.worktreeLifecycle?.step).toBe('worker-resolving')
  })

  it('worker request returns conflicts in its own call even while its turn is busy', async () => {
    const h = await harness()
    h.idle(false)
    h.facts([{ path: 'a', kind: 'text' } as SvnConflictFact])
    expect(await h.step.run('worker', 'worker')).toMatchObject({ ok: true, value: { revision: 2, conflicts: [{ path: 'a', kind: 'text' }] } })
    expect(h.records.get('worker')?.worktreeLifecycle?.step).toBe('worker-resolving')
  })

  it('persists automatic-rule options, settlement and journal for the next Finish step', async () => {
    const h = await harness()
    h.set.entries.push({ path: 'a', kind: 'text', shape: 'unrecognized', state: 'rule', options: ['merged'], rule: 'merged', facts: {} })
    h.deps.conflicts.fix = async (action, _report, journal) => {
      await journal?.('a', { option: 'merged', done: 1 }, 'text')
      return { kind: 'applied', action: { ...action, conflictSet: { ...h.set,
        entries: h.set.entries.map((entry) => ({ ...entry, state: 'settled', settledWith: 'merged', journal: { option: 'merged', done: 1 } })) } } }
    }
    h.deps.conflicts.remembered = async (_action, memory) => ({ ok: true, value: { memory, reasons: [], set: { ...h.set, entries: [] } } })
    expect(await h.step.run('worker', 'ready')).toMatchObject({ ok: true })
    const directory = dirname(dirname(h.path))
    const reloaded = await SessionRecordsStore.load(join(directory, 'records.json'), { snapshotsDirectory: join(directory, 'snapshots'), report: () => {} })
    expect(reloaded.get('worker')?.worktreeLifecycle).toMatchObject({
      syncConflictSet: { entries: [{ path: 'a', options: ['merged'], state: 'settled', settledWith: 'merged', journal: { option: 'merged', done: 1 } }] },
    })
  })

  it('coalesces simultaneous triggers and holds input through HEAD preflight', async () => {
    const h = await harness()
    let finishHead!: () => void
    h.deps.svn.headRevisionOf = async () => { expect(h.held()).toBe(1); await new Promise<void>((done) => { finishHead = done }); return { ok: true, value: 2 } }
    const first = h.step.run('worker', 'ready')
    const second = h.step.run('worker', 'finish')
    const third = h.step.run('worker', 'worker')
    expect(second).toBe(first)
    expect(third).toBe(first)
    await vi.waitFor(() => expect(finishHead).toBeDefined())
    expect(h.held()).toBe(1)
    finishHead()
    await first
    expect(h.runner.run).toHaveBeenCalledOnce()
    expect(h.held()).toBe(0)
  })

  it('queues real gateway input arriving while the HEAD read awaits', async () => {
    const h = await harness()
    const messages: HostWsClientMsg[] = []
    let socket!: TerminalAttachSocketDeps
    const gateway = new TerminalGateway({
      descriptorOf: () => ({ hostInstanceId: 'host' }) as HostDescriptor,
      leaseIdOf: () => 'controller', refOf: () => ({ ok: true, ref: { hostInstanceId: 'host', runtimeSessionId: 'worker', generation: 1 }, alive: true }),
      onError: (detail) => { throw new Error(detail) },
      socketFactory: (deps) => { socket = deps; return { connect: () => {}, send: (message) => { messages.push(message) }, close: () => {} } },
    })
    gateway.attach('view', { sessionId: 'worker', size: null }, { source: 'local', onFrame: () => {} })
    socket.onFrame({ type: 'terminal.attached', writer: true, session: { runtimeSessionId: 'worker', generation: 1, alive: true,
      cols: 80, rows: 24, outputSeq: 0, outputEpoch: 1, startedAt: 0, lastOutputAt: null } })
    h.deps.holdInput = (id) => gateway.holdInput(id)
    let finishHead!: () => void
    h.deps.svn.headRevisionOf = async () => { await new Promise<void>((done) => { finishHead = done }); return { ok: true, value: 2 } }
    const sync = h.step.run('worker', 'ready')
    await vi.waitFor(() => expect(finishHead).toBeDefined())
    expect(gateway.input('view', 'next task\r')).toEqual({ kind: 'sent' })
    expect(gateway.pendingInput('worker')).toBe(1)
    expect(messages.filter((message) => message.type === 'terminal.input')).toEqual([])
    finishHead()
    expect(await sync).toMatchObject({ ok: true })
    expect(messages.filter((message) => message.type === 'terminal.input')).toEqual([{ type: 'terminal.input', data: 'next task\r' }])
    gateway.closeAll()
  })

  it.each([undefined, { revision: 1, at: 123, headMovedBy: 0 }])('keeps remembered status-clean loss out of the next update, preserving sync evidence %j', async (syncedAt) => {
    const h = await harness()
    const memory = { actionId: 'old', readAt: 1, paths: [{ path: 'a', saved: '/saved', sidecars: [], kind: 'text' as const }] }
    await h.records.update('worker', (record) => ({ ...record, worktree: { ...record.worktree!, conflictMemory: memory },
      worktreeLifecycle: { ...record.worktreeLifecycle!, facts: { ...record.worktreeLifecycle!.facts, syncedAt } } }))
    h.deps.conflicts.remembered = async () => ({ ok: true, value: { memory, reasons: ['a drops the session side'],
      set: { ...h.set, entries: [{ path: 'a', kind: 'text', shape: 'unrecognized', state: 'person', options: [], facts: {} }] } } })
    expect(await h.step.run('worker', 'finish')).toMatchObject({ ok: true, value: { conflicts: [{ path: 'a', kind: 'text' }] } })
    expect(h.runner.run).not.toHaveBeenCalled()
    expect(h.records.get('worker')?.worktreeLifecycle?.syncConflictSet?.entries).toHaveLength(1)
    expect(h.records.get('worker')?.worktreeLifecycle?.facts.syncedAt).toEqual(syncedAt)
    expect(h.records.get('worker')?.worktreeLifecycle?.actionId).toBeTruthy()
    h.deps.conflicts.resolve = async (action) => ({ ok: true, value: { action: { ...action,
      conflictSet: { ...action.conflictSet!, entries: action.conflictSet!.entries.map((entry) => ({ ...entry, state: 'settled' })) } }, state: 'settled', left: 0 } })
    h.deps.conflicts.remembered = async () => ({ ok: true, value: { memory: { ...memory, paths: [] }, reasons: [], set: { ...h.set, entries: [] } } })
    expect(await h.step.resolve('worker', { path: 'a', option: 'merged', requestedBy: 'cli', confirm: false })).toMatchObject({ ok: true, value: { left: 0 } })
    expect(h.records.get('worker')?.worktreeLifecycle?.step).toBe('syncing')
  })

  it.each([undefined, { actionId: 'kept', completed: true }])('updates to the current HEAD before checks once remembered conflicts of a Finish resumed after Keep settle, prior update %j', async (prior) => {
    const h = await harness()
    const memory = { actionId: 'kept', readAt: 1, paths: [{ path: 'a', saved: '/saved', sidecars: [], kind: 'text' as const }] }
    const target = await emptyUpdateTargets.owner(h.path, 1)
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, actionId: 'resumed', conflictMemory: memory,
      facts: { ...record.worktreeLifecycle!.facts, syncedAt: { revision: 1, at: 1, headMovedBy: 0 } },
      update: prior === undefined ? undefined : { ...prior, generation: 'old', root: h.path, revision: 1, cursor: 1, units: [{ target, phase: 'done' }] } } }))
    h.deps.conflicts.remembered = async () => ({ ok: true, value: { memory, reasons: ['a is still conflicted'],
      set: { ...h.set, entries: [{ path: 'a', kind: 'text', shape: 'text-overlap', state: 'person', options: ['merged'], facts: {} }] } } })
    expect(await h.step.run('worker', 'finish')).toMatchObject({ ok: true, value: { revision: 1, conflicts: [{ path: 'a', kind: 'text' }] } })
    expect(h.runner.run).not.toHaveBeenCalled()
    h.deps.conflicts.resolve = async (action) => ({ ok: true, value: { action: { ...action,
      conflictSet: { ...action.conflictSet!, entries: action.conflictSet!.entries.map((entry) => ({ ...entry, state: 'settled' })) } }, state: 'settled', left: 0 } })
    h.deps.conflicts.remembered = async () => ({ ok: true, value: { memory: { ...memory, paths: [] }, reasons: [], set: { ...h.set, entries: [] } } })
    expect(await h.step.resolve('worker', { path: 'a', option: 'merged', requestedBy: 'window', confirm: false })).toMatchObject({ ok: true, value: { left: 0 } })
    expect(h.records.get('worker')?.worktreeLifecycle?.step).toBe('syncing')
    expect(await h.step.run('worker', 'finish')).toMatchObject({ ok: true, value: { revision: 2, conflicts: [] } })
    expect(h.runner.run).toHaveBeenCalledOnce()
    expect(h.runner.run.mock.calls[0]).toEqual(expect.arrayContaining([['update', '-r', '2', '--ignore-externals', '--accept', 'postpone', '--', '.']]))
    expect(h.records.get('worker')?.worktreeLifecycle).toMatchObject({ step: 'checking', update: { actionId: 'resumed', revision: 2, completed: true },
      facts: { syncedAt: { revision: 2 } } })
    expect(h.records.get('worker')?.worktreeLifecycle?.update?.generation).not.toBe('old')
  })

  it('starts checks after the last settlement once this Finish\'s own update has reached its target', async () => {
    const h = await harness()
    const target = await emptyUpdateTargets.owner(h.path, 2)
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, actionId: 'sync',
      update: { actionId: 'sync', generation: 'saved', root: h.path, revision: 2, cursor: 1, completed: true, units: [{ target, phase: 'done' }] } } }))
    h.set.entries.push({ path: 'a', kind: 'diverged', shape: 'diverged', state: 'person', options: ['merged'], facts: {} })
    await h.step.run('worker', 'worker')
    h.deps.conflicts.resolve = async (action) => ({ ok: true, value: { action: { ...action,
      conflictSet: { ...action.conflictSet!, entries: action.conflictSet!.entries.map((entry) => ({ ...entry, state: 'settled' })) } }, state: 'settled', left: 0 } })
    h.deps.conflicts.remembered = async (_action, memory) => ({ ok: true, value: { memory, reasons: [], set: { ...h.set, entries: [] } } })
    expect(await h.step.resolve('worker', { path: 'a', option: 'merged', requestedBy: 'window', confirm: false })).toMatchObject({ ok: true, value: { left: 0 } })
    expect(h.records.get('worker')?.worktreeLifecycle?.step).toBe('checking')
  })

  it('never accepts a new baseline on a pre-existing review after a real outside svn revert', async () => {
    const h = await harness()
    const directory = dirname(dirname(h.path))
    const repository = join(directory, 'repository')
    expect(await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repository], cwd: directory, env: process.env }))
      .toMatchObject({ code: 0, failure: null })
    await mkdir(dirname(h.path), { recursive: true })
    const svn = new SvnInvoker()
    expect(await svn.run(directory, ['checkout', pathToFileURL(repository).href, h.path])).toMatchObject({ code: 0 })
    await writeFile(join(h.path, 'a'), 'original')
    expect(await svn.run(h.path, ['add', 'a'])).toMatchObject({ code: 0 })
    expect(await svn.run(h.path, ['commit', '-m', 'Fixture baseline'])).toMatchObject({ code: 0 })
    await writeFile(join(h.path, 'a'), 'proposed change')
    const commands = new WorktreeSvnCommands(svn, h.deps.commands.lease, async () => 'stop' as const)
    await commands.accept(h.path)
    await h.records.update('worker', (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, review: {
      version: 1, selection: ['a'], hashes: { a: 'approved' }, message: '[Test] Change', source: 'person-local', acknowledged: [], headMovedBy: 0 } } }))
    expect(await svn.run(h.path, ['revert', 'a'])).toMatchObject({ code: 0 })
    h.deps.commands.verify = (root) => commands.verify(root)
    expect(await h.step.run('worker', 'finish')).toMatchObject({ ok: false, detail: expect.stringContaining('changed outside') })
    expect(h.deps.commands.accept).not.toHaveBeenCalled()
    expect(h.runner.run).not.toHaveBeenCalled()
  })
})
