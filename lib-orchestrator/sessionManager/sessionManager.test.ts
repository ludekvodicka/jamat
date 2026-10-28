import { AgentAccounts, type StoredAccount } from '../agentAccounts/agentAccounts'
import { WorkerReady } from '../worktrees/worktreeFinish'
import { SyncStep } from '../worktrees/worktreeFinish'
import { FinishDriver } from '../worktrees/finish/finishDriver'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  RuntimeInspectResult,
  RuntimeLaunchSpec,
  RuntimeListResult,
  RuntimeMutationAck,
  RuntimeRef,
  RuntimeResult,
  RuntimeSessionInfo,
} from '../../app-host/app/wire/hostWire.js'
import { CheckpointLayout } from '../git/checkpointLayout'
import { GitInvoker } from '../git/gitInvoker'
import { FakeHost } from '../hostClient/fixtures/fakeHost'
import { HostDescriptorPaths } from '../hostClient/hostDescriptorPaths'
import { CommandInvoker } from '../shared/commandInvoker'
import { OrchestratorPaths } from '../shared/orchestratorPaths'
import { SvnInvoker } from '../svn/svnInvoker'
import { SvnWorktreeManager } from '../svn/svnWorktreeManager'
import { LandedRows } from '../worktrees/worktreeLanding'
import { WorktreeLease } from '../worktrees/worktreeLease'
import type { WorktreeResultRecord } from '../worktrees/worktreeResults'
import type { SessionRecord, SessionRecordsDocument } from './records/sessionRecord.types'
import type { SessionInfo, SessionsOpResult, WorktreeResultsFilter } from './sessionManagerApi.types'
import { SessionLifecycle } from './lifecycle/sessionLifecycle'
import { SessionManager, type SessionManagerDeps } from './sessionManager'
import { WorkFixtures } from './workState/fixtures/workFixtures'
import { ScreenTail } from './workState/screenTail'

describe('lib-orchestrator/sessionManager/sessionManager', () => {
  const roots: string[] = []
  const hosts: FakeHost[] = []
  const managers: SessionManager[] = []
  let previousStateRoot: string | undefined

  beforeEach(() => {
    previousStateRoot = process.env.JAMAT_V3_LOCAL_STATE_DIR
  })

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.stop()
    for (const host of hosts.splice(0)) await host.stop()
    if (previousStateRoot === undefined) delete process.env.JAMAT_V3_LOCAL_STATE_DIR
    else process.env.JAMAT_V3_LOCAL_STATE_DIR = previousStateRoot
    // A test here runs real git; on Windows a handle from the child that just exited can outlive
    // it by a moment, and the recursive delete then fails with EPERM. rmSync retries exactly that.
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  /**
   * A machine with one catalog category and one fake Host on loopback. The Host's descriptor is
   * written where `HostDescriptorPaths` looks for it, so the manager finds it exactly as it finds a
   * real one - nothing here reaches into the client to hand it a connection.
   */
  interface World {
    root: string
    configDir: string
    configIdentity: string
    categoryRoot: string
    host: FakeHost
    runtimes: Map<string, RuntimeSessionInfo>
    /** What `runtime.inspect` renders for a runtime, which is all the monitor ever reads. */
    screens: Map<string, string>
    publishDescriptor: () => void
  }

  interface Client {
    manager: SessionManager
    errors: string[]
    emits: () => number
    spawns: () => number
  }

  function runtime(runtimeSessionId: string, overrides?: Partial<RuntimeSessionInfo>): RuntimeSessionInfo {
    return {
      runtimeSessionId,
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

  /**
   * The precondition of a mutation, and it is NOT that the Host is reachable. `presence` proves the
   * descriptor and the events socket; controller authority is acquired independently, so a test that
   * mutates on presence alone is refused with `no-lease` whenever the acquire answer has not landed
   * yet. Measured on 2026-08-25 by holding only that answer: presence read `running` with no lease.
   */
  async function writable(client: Client): Promise<void> {
    await vi.waitFor(() => {
      expect(client.manager.snapshot().host.presence).toBe('running')
      expect(client.manager.debugStatus().lease.leaseId).not.toBeNull()
    }, { timeout: 5_000 })
  }

  /**
   * The precondition of acting on a runtime, and `writable` is NOT it. The reconcile inside `start()`
   * runs before the descriptor watcher has read the file, so it lists nothing; what binds a seeded
   * record to its runtime is the resync refresh the events socket fires when it subscribes. That
   * subscribe turns `presence` to `running` FIRST and dispatches the refresh after it, so `writable`
   * can return one listing early, and nothing else asks for one until the two second poll. Anything
   * off the operation queue - `terminalAttach` is the one - then reads a snapshot with no runtimes
   * and is refused `not-live`. A queued operation cannot: it lands behind that same refresh.
   */
  async function reconciled(client: Client): Promise<void> {
    await vi.waitFor(() => expect(client.manager.snapshot().reconciled).toBe(true), { timeout: 5_000 })
  }

  /**
   * The exit budget measured without spending it. `wait` advances the clock instead of the process,
   * so the five second product value is proven rather than waited out, and the elapsed total is what
   * says the loop really reached its boundary.
   */
  function virtualClock(): { clock: SessionManagerDeps['exitClock']; elapsed: () => number } {
    let elapsed = 0
    return {
      clock: {
        now: () => elapsed,
        wait: (milliseconds) => {
          elapsed += milliseconds
          return Promise.resolve()
        },
      },
      elapsed: () => elapsed,
    }
  }

  async function world(managed = true): Promise<World> {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-session-manager-'))
    roots.push(root)
    process.env.JAMAT_V3_LOCAL_STATE_DIR = join(root, 'state')
    const configDir = join(root, 'config')
    const categoryRoot = join(root, 'projects')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(categoryRoot, { recursive: true })
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        schemaVersion: 1,
        categories: [{ id: 'code', label: 'Code', path: categoryRoot }],
      }),
      'utf8',
    )
    const host = await FakeHost.start({ hostInstanceId: 'fake-host-1', capabilities: ['events.replay.v1', 'runtime.lifecycle.v1', 'pty.release.v2', ...managed ? ['runtime.managed-descendants.v1'] : []] })
    hosts.push(host)
    const runtimes = new Map<string, RuntimeSessionInfo>()
    const screens = new Map<string, string>()
    host.handle('runtime.list', () => ({
      body: {
        sessions: [...runtimes.values()],
        throughRevision: 0,
        hostInstanceId: host.descriptor().hostInstanceId,
      } satisfies RuntimeListResult,
    }))
    // The Host's own idempotence, mirrored from `app-host/app/sessions/sessionStore.ts`: an
    // operationId it already ran answers with what it did instead of starting a second runtime.
    const operations = new Map<string, RuntimeSessionInfo>()
    host.handle('runtime.create', (body) => {
      const operationId = String(body.operationId)
      const session = operations.get(operationId) ?? runtime(String(body.runtimeSessionId))
      operations.set(operationId, session)
      runtimes.set(session.runtimeSessionId, session)
      return {
        body: {
          session,
          hostInstanceId: host.descriptor().hostInstanceId,
        } satisfies RuntimeResult,
      }
    })
    host.handle('runtime.remove', (body) => {
      const target = body.target as RuntimeRef
      if (runtimes.get(target.runtimeSessionId)?.alive) return { status: 409, body: { error: 'Runtime is still alive' } }
      runtimes.delete(target.runtimeSessionId)
      return { body: { servedByHostInstanceId: host.descriptor().hostInstanceId, target, diagnostic: 'removed' } satisfies RuntimeMutationAck }
    })
    // What the work-state monitor reads. The screen is whatever the test put there for that runtime.
    host.handle('runtime.inspect', (body) => {
      const target = body.target as RuntimeRef
      const session = runtimes.get(target.runtimeSessionId)
      if (session === undefined) return { status: 404, body: { error: 'no such runtime' } }
      return {
        body: {
          session,
          projection: {
            ...session,
            raw: '',
            screen: screens.get(target.runtimeSessionId) ?? '',
          },
        } satisfies RuntimeInspectResult,
      }
    })
    const configIdentity = 'session-manager-test'
    const descriptorFile = HostDescriptorPaths.descriptorFile(configIdentity, 'development')
    return {
      root,
      configDir,
      configIdentity,
      categoryRoot,
      host,
      runtimes,
      screens,
      publishDescriptor: () => {
        mkdirSync(join(descriptorFile, '..'), { recursive: true })
        writeFileSync(descriptorFile, JSON.stringify(host.descriptor()), 'utf8')
      },
    }
  }

  function clientOf(
    context: World,
    options?: {
      accounts?: SessionManagerDeps['accounts']
      rates?: SessionManagerDeps['rates']
      autoStartHost?: boolean
      spawnPublishes?: boolean
      codexHome?: string
      exitClock?: SessionManagerDeps['exitClock']
      transcripts?: SessionManagerDeps['transcripts']
      versioningModeOf?: SessionManagerDeps['versioningModeOf']
      terminalSocketFactory?: SessionManagerDeps['terminalSocketFactory']
      onRemovedItself?: SessionManagerDeps['onRemovedItself']
      onScriptCollapsed?: SessionManagerDeps['onScriptCollapsed']
    },
  ): Client {
    const errors: string[] = []
    const counters = { emits: 0, spawns: 0 }
    const manager = new SessionManager({
      accounts: options?.accounts,
      rates: options?.rates,
      applicationRoot: join(import.meta.dirname, '..', '..'),
      resourcesRoot: null,
      configDir: context.configDir,
      configIdentity: context.configIdentity,
      channel: 'development',
      autoStartHost: options?.autoStartHost ?? false,
      exitClock: options?.exitClock,
      onChanged: () => { counters.emits += 1 },
      onError: (message) => errors.push(message),
      // A Host is never really launched from a test. The stand-in publishes the descriptor the way a
      // Host that booted would, so the controller's own success condition is what decides.
      spawnImpl: ((): ChildProcess => {
        counters.spawns += 1
        if (options?.spawnPublishes) context.publishDescriptor()
        return Object.assign(new EventEmitter(), { unref: () => undefined }) as unknown as ChildProcess
      }) as unknown as SessionManagerDeps['spawnImpl'],
      codexHome: options?.codexHome,
      transcripts: options?.transcripts,
      versioningModeOf: options?.versioningModeOf,
      terminalSocketFactory: options?.terminalSocketFactory,
      onRemovedItself: options?.onRemovedItself,
      onScriptCollapsed: options?.onScriptCollapsed,
      // The machine's real name would put the host running the suite into an asserted block.
      computerName: () => 'TEST-PC',
    })
    managers.push(manager)
    return { manager, errors, emits: () => counters.emits, spawns: () => counters.spawns }
  }

  function valueOf<T>(result: SessionsOpResult<T>): T {
    if (!result.ok) throw new Error(`the operation was refused with ${result.code}: ${result.detail}`)
    return result.value
  }

  it('refuses account removal while the real session chain waits for Host create', async () => {
    const context = await world()
    const main = join(context.root, 'main-profile')
    mkdirSync(main)
    let stored: readonly StoredAccount[] = []
    let client: Client
    const accounts = new AgentAccounts({ mainHomes: { claude: main, codex: main },
      specs: [{ agentId: 'claude', mainHome: () => main, homeVariable: 'CLAUDE_CONFIG_DIR', extraEnv: () => ({}),
        shareTable: { directories: [], files: [], neverShared: [] }, loginCommand: 'fixture', probe: async () => ({ kind: 'logged-in', identity: { key: 'org/busy', label: 'busy' } }) }],
      accountsRoot: join(context.root, 'accounts'), stored: () => stored, store: value => { stored = value },
      hasRunningSession: (agentId, accountId) => client.manager.hasAccountSession(agentId, accountId), onChanged: () => {},
    })
    const { accountId } = await accounts.add('claude', 'Busy')
    stored = stored.map(account => ({ ...account, identity: { key: 'org/busy', label: 'busy' } }))
    const home = accounts.homeOf('claude', accountId)
    const marker = join(home, 'private-fixture')
    writeFileSync(marker, 'unchanged')
    client = clientOf(context, { accounts })
    context.publishDescriptor()
    await client.manager.start()
    await writable(client)
    await reconciled(client)
    const cached = client.manager.snapshot()
    const hold = context.host.hold('runtime.create')
    const pending = client.manager.createSession({ kind: 'agent', directory: { mode: 'adHoc', path: main },
      agent: { agentId: 'claude', mode: 'new', accountId } })
    try {
      await vi.waitFor(() => expect(context.host.calls.some(call => call.name === 'runtime.create')).toBe(true))
      expect(cached.sessions).toHaveLength(0)
      expect(client.manager.hasAccountSession('claude', accountId)).toBe(true)
      await expect(accounts.remove(accountId)).rejects.toThrow('a session runs on Busy')
      expect(readFileSync(marker, 'utf8')).toBe('unchanged')
    } finally { hold.release() }
    const created = valueOf(await pending)
    expect(client.manager.hasAccountSession('claude', accountId)).toBe(true)
    await expect(accounts.remove(accountId)).rejects.toThrow('a session runs on Busy')
    expect(created.sessionId).toBeTruthy()
  })

  it.each([
    { exitCode: 0, exitReason: 'process-exit' as const, result: 0 },
    { exitCode: 1, exitReason: 'process-exit' as const, result: 1 },
    { exitCode: 0, exitReason: 'stopped' as const, result: null },
    { exitCode: 0, exitReason: undefined, result: null },
  ])('reports the authoritative login terminal exit $exitCode with reason $exitReason', async ({ exitCode, exitReason, result }) => {
    const context = await world()
    const client = clientOf(context)
    context.publishDescriptor()
    await client.manager.start()
    await writable(client)
    await reconciled(client)
    const created = valueOf(await client.manager.createCommandSession({
      directory: { mode: 'adHoc', path: context.categoryRoot },
      account: { agentId: 'claude', accountId: 'main' }, title: 'Login',
    }, 'fixture-login'))
    expect(client.manager.terminalResult(created.sessionId)).toEqual({ ended: false })
    expect(client.manager.hasAccountSession('claude', 'main')).toBe(true)
    const running = context.runtimes.get(created.sessionId)!
    context.runtimes.set(created.sessionId, { ...running, alive: false, exitCode, exitReason, exitedAt: Date.now() })
    await client.manager.removeSession('never-existed')
    expect(client.manager.terminalResult(created.sessionId)).toEqual({ ended: true, exitCode: result })
    expect(client.manager.hasAccountSession('claude', 'main')).toBe(false)
    expect(client.errors).toEqual([])
  })

  it('composes current account labels for added sessions and leaves main labels absent', async () => {
    const context = await world()
    seedRecords(context, [recordOf(context, 'added', { kind: 'agent', agent: { agentId: 'claude', launchMode: 'new', accountId: 'work' } }),
      recordOf(context, 'main', { kind: 'agent', agent: { agentId: 'claude', launchMode: 'new' } })])
    const client = clientOf(context, { accounts: { exists: () => true, launchEnv: async () => ({}),
      defaultAccount: () => ({ accountId: 'main', noFreeAccount: false }), labelOf: () => 'Work subscription' } })
    await client.manager.start()
    expect(client.manager.snapshot().sessions.find(session => session.sessionId === 'added')?.agent)
      .toMatchObject({ accountId: 'work', accountLabel: 'Work subscription' })
    expect(client.manager.snapshot().sessions.find(session => session.sessionId === 'main')?.agent).not.toHaveProperty('accountLabel')
  })

  it('R4: an old Host refuses worktree setup before any session or runtime is created', async () => {
    const context = await world(false)
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)
    const result = await client.manager.createSession({ kind: 'shell', directory: { mode: 'adHoc', path: context.categoryRoot }, worktree: { slug: 'old-host' } })
    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining('Restart the Host') })
    expect(client.manager.snapshot().sessions).toEqual([])
    expect(context.host.calls.some((call) => call.name === 'runtime.create')).toBe(false)
  })

  async function replacementHost(context: World): Promise<FakeHost> {
    const replacement = await FakeHost.start({ hostInstanceId: 'replacement-host', capabilities: ['events.replay.v1', 'runtime.lifecycle.v1', 'pty.release.v2', 'runtime.managed-descendants.v1'] })
    hosts.push(replacement)
    const runtimes = new Map<string, RuntimeSessionInfo>()
    replacement.handle('runtime.list', () => ({ body: {
      sessions: [...runtimes.values()], throughRevision: 0, hostInstanceId: 'replacement-host',
    } satisfies RuntimeListResult }))
    replacement.handle('runtime.create', (body) => {
      const session = runtime(String(body.runtimeSessionId))
      runtimes.set(session.runtimeSessionId, session)
      return { body: { session, hostInstanceId: 'replacement-host' } satisfies RuntimeResult }
    })
    const file = HostDescriptorPaths.descriptorFile(context.configIdentity, 'development')
    context.host.handle('host.stop', () => {
      context.host.publish({ kind: 'host-stopping' })
      rmSync(file)
      return { body: { stopping: true, live: context.runtimes.size } }
    })
    context.publishDescriptor = () => writeFileSync(file, JSON.stringify(replacement.descriptor()), 'utf8')
    return replacement
  }

  it('stops the Host on request, refuses a Host that changed and launches no replacement', async () => {
    const context = await world()
    seedRecords(context, [recordOf(context, 'shell', { life: 'live' })])
    context.runtimes.set('shell', runtime('shell'))
    context.publishDescriptor()
    const client = clientOf(context, { spawnPublishes: true })
    await client.manager.start()
    await writable(client)
    const file = HostDescriptorPaths.descriptorFile(context.configIdentity, 'development')
    context.host.handle('host.stop', () => {
      context.host.publish({ kind: 'host-stopping' })
      rmSync(file)
      return { body: { stopping: true, live: context.runtimes.size } }
    })
    expect(await client.manager.stopHost('other-host')).toMatchObject({ ok: false, code: 'host-unreachable' })
    expect(context.host.calls.some((call) => call.name === 'host.stop')).toBe(false)
    expect(await client.manager.stopHost('fake-host-1')).toEqual({ ok: true, value: { warnings: [] } })
    expect(context.host.calls.filter((call) => call.name === 'host.stop')).toHaveLength(1)
    await vi.waitFor(() => expect(client.manager.snapshot().host.presence).toBe('unreachable'))
    expect(client.spawns()).toBe(0)
  }, 20_000)

  it('restores only runtimes alive before an explicit Host restart, using the same agent conversations', async () => {
    const context = await world()
    seedRecords(context, [
      recordOf(context, 'claude', { kind: 'agent', life: 'live', agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'claude-conversation', initialPrompt: 'do not replay this' } }),
      recordOf(context, 'codex', { kind: 'agent', life: 'live', agent: { agentId: 'codex', launchMode: 'fork', nativeSessionId: 'codex-conversation', nativeSessionIdSource: 'codex-app-server' } }),
      recordOf(context, 'shell', { life: 'live', color: 'green', note: 'keep me' }),
      recordOf(context, 'ended', {}),
      recordOf(context, 'lost', { life: 'lost' }),
    ])
    for (const id of ['claude', 'codex', 'shell']) context.runtimes.set(id, runtime(id))
    context.runtimes.set('ended', runtime('ended', { alive: false }))
    context.publishDescriptor()
    const client = clientOf(context, { spawnPublishes: true })
    await client.manager.start()
    await writable(client)
    const replacement = await replacementHost(context)
    const held = replacement.hold('controller.acquire')
    const restarting = client.manager.restartHost('fake-host-1')
    try {
      await vi.waitFor(() => expect(client.manager.snapshot().host.hostInstanceId).toBe('replacement-host'), { timeout: 5_000 })
      expect(replacement.calls.filter((call) => call.name === 'runtime.create')).toEqual([])
    } finally {
      held.release()
    }
    expect(await restarting).toEqual({ ok: true, value: { warnings: [] } })
    const launches = replacement.calls.filter((call) => call.name === 'runtime.create')
    expect(launches.map((call) => call.body.runtimeSessionId)).toEqual(['claude', 'codex', 'shell'])
    expect(JSON.stringify(launches[0]?.body.launch)).toContain('claude-conversation')
    const codexLaunch = launches[1]?.body.launch as RuntimeLaunchSpec
    const launchFile = JSON.parse(readFileSync(codexLaunch.args.at(-1)!, 'utf8')) as {client: {args: string[]}}
    expect(launchFile.client.args).toContain('codex-conversation')
    expect(JSON.stringify(launches)).not.toContain('do not replay this')
    for (const id of ['claude', 'codex', 'shell']) expect(sessionOf(client, id)?.life).toBe('live')
    expect(sessionOf(client, 'ended')?.life).toBe('ended')
    expect(sessionOf(client, 'lost')?.life).toBe('lost')
    expect(sessionOf(client, 'shell')).toMatchObject({ color: 'green', note: 'keep me' })
    expect(await client.manager.restartHost('fake-host-1')).toMatchObject({ ok: false, code: 'host-unreachable' })
    expect(client.spawns()).toBe(1)
  }, 20_000)

  it('continues restoring other sessions when one replacement launch is refused', async () => {
    const context = await world()
    seedRecords(context, ['bad', 'good'].map((id) => recordOf(context, id, { life: 'live' })))
    for (const id of ['bad', 'good']) context.runtimes.set(id, runtime(id))
    context.publishDescriptor()
    const client = clientOf(context, { spawnPublishes: true })
    await client.manager.start()
    await writable(client)
    const replacement = await replacementHost(context)
    const runtimes: RuntimeSessionInfo[] = []
    replacement.handle('runtime.create', (body) => {
      if (body.runtimeSessionId === 'bad') return { status: 400, body: { error: 'launch rejected' } }
      const session = runtime(String(body.runtimeSessionId))
      runtimes.push(session)
      return { body: { session, hostInstanceId: 'replacement-host' } satisfies RuntimeResult }
    })
    replacement.handle('runtime.list', () => ({ body: { sessions: runtimes, throughRevision: 0, hostInstanceId: 'replacement-host' } }))
    expect(await client.manager.restartHost('fake-host-1')).toMatchObject({ ok: false, code: 'op-rejected', detail: expect.stringContaining('bad') })
    expect(sessionOf(client, 'good')?.life).toBe('live')
    expect(sessionOf(client, 'bad')?.life).toBe('lost')
  }, 20_000)

  // The worker lived until the restart, so the restore continues its lifetime (UA1-J13-3).
  it('keeps the history and script runs of a restored worktree session in any phase, kept included', async () => {
    const context = await world()
    const worktreePath = join(context.root, '.worktrees', 'kept')
    mkdirSync(worktreePath, { recursive: true })
    const entry = (runId: string) => ({ runId, phase: 'after' as const, scriptId: 'checks' as const, name: 'tests', title: `tests ${runId}`,
      commands: ['node check.js'], startedAt: 1_000, endedAt: 2_000, exitCode: 1, outcome: 'failed' as const,
      log: { state: 'saved' as const, bytes: 4, truncated: false } })
    // The current Keep section and its buttons are drawn from this outcome (UA1-J14-6).
    const kept = { result: 'not-committed' as const, revisions: [], main: 'none' as const, worktree: 'kept' as const,
      lines: ['Worktree kept. Nothing published'], at: 3_000 }
    seedRecords(context, [
      recordOf(context, 'kept', { kind: 'agent', life: 'live', agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'kept-conversation' },
        worktree: { kind: 'svn', repositoryRoot: context.root, worktreePath, branch: 'url', baseCommit: 'r1' },
        worktreeLifecycle: { version: 3, actionId: 'kept-action', phase: 'kept', outOfDate: 0, journal: [], facts: { worker: { liveness: 'alive', resumeFailures: 0 } } },
        worktreeOutcome: kept, scriptRuns: [entry('kept-run')] }),
    ])
    context.runtimes.set('kept', runtime('kept'))
    context.publishDescriptor()
    const client = clientOf(context, { spawnPublishes: true })
    await client.manager.start()
    await writable(client)
    await replacementHost(context)
    expect(await client.manager.restartHost('fake-host-1')).toEqual({ ok: true, value: { warnings: [] } })
    expect(sessionOf(client, 'kept')?.life).toBe('live')
    expect(storedRecord(context, 'kept')?.scriptRuns?.map((run) => run.runId)).toEqual(['kept-run'])
    expect(storedRecord(context, 'kept')?.pendingKeepsHistory).toBeUndefined()
    expect(storedRecord(context, 'kept')?.worktreeOutcome).toEqual(kept)
  }, 20_000)

  /*
   * A worktree worker comes back through its liveness inside the restart's own reconcile. The restore
   * after it read that session again, was refused by the running Finish and called the restart failed
   * although the worker was live (UA1-J10-6). What the old Host could not stop is in the answer.
   */
  it('reads a worker its liveness already resumed as restored and carries what the old Host could not stop', async () => {
    const context = await world()
    const worktreePath = join(context.root, '.worktrees', 'w1')
    mkdirSync(worktreePath, { recursive: true })
    seedRecords(context, [recordOf(context, 'w1', {
      kind: 'agent', life: 'live', agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'w1-conversation' },
      worktree: { kind: 'svn', repositoryRoot: context.root, worktreePath, branch: 'url', baseCommit: 'r1' },
      worktreeLifecycle: { version: 0, actionId: null, phase: 'active', outOfDate: 0, journal: [], facts: {
        worker: { liveness: 'alive', resumeFailures: 0 },
      } },
    })])
    context.runtimes.set('w1', runtime('w1'))
    context.publishDescriptor()
    const client = clientOf(context, { spawnPublishes: true })
    await client.manager.start()
    await writable(client)
    await replacementHost(context)
    const file = HostDescriptorPaths.descriptorFile(context.configIdentity, 'development')
    context.host.handle('host.stop', () => {
      context.host.publish({ kind: 'host-stopping' })
      rmSync(file)
      return { body: { stopping: true, live: 1, warnings: ['run-1: descendant 88824 survived'] } }
    })
    // The Finish holds the worktree, which refuses a plain reopen and lets the worker's own resume through.
    const finishing = vi.spyOn(SessionLifecycle.prototype as unknown as { finishingRefusal(record: SessionRecord): unknown },
      'finishingRefusal').mockImplementation((record) => record.sessionId === 'w1'
      ? { ok: false, code: 'merge-pending', detail: 'Session w1: the finish of its worktree is checks; wait for it to end' }
      : null)
    try {
      expect(await client.manager.restartHost('fake-host-1'))
        .toEqual({ ok: true, value: { warnings: ['run-1: descendant 88824 survived'] } })
    } finally { finishing.mockRestore() }
    expect(sessionOf(client, 'w1')?.life).toBe('live')
  }, 20_000)

  it.each([
    { kind: 'agent' as const, agent: { agentId: 'codex' as const, launchMode: 'new' as const } },
    {
      commands: [{ command: 'install', cwd: 'unused' }],
      scriptOf: { sessionId: 'parent', phase: 'before' as const, scriptId: 'setup' as const, name: 'setup' },
    },
  ])('keeps the old Host alive if a running session cannot be restored: %j', async (overrides) => {
    const context = await world()
    seedRecords(context, [recordOf(context, 's1', { life: 'live', ...overrides })])
    context.runtimes.set('s1', runtime('s1'))
    context.publishDescriptor()
    const client = clientOf(context, { codexHome: join(context.root, 'empty-codex') })
    await client.manager.start()
    await writable(client)
    expect(await client.manager.restartHost('fake-host-1')).toMatchObject({ ok: false, code: 'live-refused' })
    expect(context.host.calls.some((call) => call.name === 'host.stop')).toBe(false)
    expect(sessionOf(client, 's1')?.life).toBe('live')
    expect(client.spawns()).toBe(0)
  })

  it('reports every non-resumable session and leaves every runtime running', async () => {
    const context = await world()
    seedRecords(context, [
      recordOf(context, 'legacy', { kind: 'agent', life: 'live', title: 'Legacy Codex', agent: {
        agentId: 'codex', launchMode: 'new', unverifiedNativeSessionId: 'old-guessed-id',
      } }),
      recordOf(context, 'unnamed', { kind: 'agent', life: 'live', title: 'Unnamed Codex', agent: {
        agentId: 'codex', launchMode: 'new',
      } }),
      recordOf(context, 'shell', { life: 'live' }),
    ])
    for (const id of ['legacy', 'unnamed', 'shell']) context.runtimes.set(id, runtime(id))
    context.publishDescriptor()
    const client = clientOf(context, { codexHome: join(context.root, 'empty-codex') })
    await client.manager.start()
    await writable(client)
    const result = await client.manager.restartHost('fake-host-1')
    expect(result).toMatchObject({ ok: false, code: 'live-refused' })
    if (result.ok) throw new Error('Restart should have been refused')
    expect(result.detail).toContain('Legacy Codex (legacy)')
    expect(result.detail).toContain('old inferred Codex identity is unverified')
    expect(result.detail).toContain('Unnamed Codex (unnamed)')
    expect(result.detail).toContain('Codex never reported the id')
    expect(context.host.calls.some((call) => call.name === 'host.stop')).toBe(false)
    for (const id of ['legacy', 'unnamed', 'shell']) expect(sessionOf(client, id)?.life).toBe('live')
    expect(client.spawns()).toBe(0)
  })

  it('answers the path of a saved log only for a run its parent history names', async () => {
    const context = await world()
    const entry = {
      runId: 'r-saved', phase: 'before' as const, scriptId: 'setup' as const, name: 'setup', title: 'Setup p',
      commands: ['pnpm install'], startedAt: 1_000, endedAt: 2_000, exitCode: 0, outcome: 'succeeded' as const,
      log: { state: 'saved' as const, bytes: 4, truncated: false },
    }
    seedRecords(context, [recordOf(context, 'p', { life: 'live', scriptRuns: [entry] })])
    const folder = join(OrchestratorPaths.scriptLogsDirectory(context.configIdentity, 'development'), 'p')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'r-saved.log'), 'done', 'utf8')
    writeFileSync(join(folder, 'r-stray.log'), 'never settled', 'utf8')
    const client = clientOf(context)

    expect(await client.manager.scriptLogOf('p', 'r-saved')).toEqual({ ok: true, value: { path: join(folder, 'r-saved.log') } })
    expect(await client.manager.scriptLogOf('p', 'r-stray')).toMatchObject({ ok: false, code: 'not-found' })
    expect(await client.manager.scriptLogOf('gone', 'r-saved')).toMatchObject({ ok: false, code: 'not-found' })
  })

  it('answers the worktree results of sessions that are gone, sweeps the stale ones and acknowledges one', async () => {
    const context = await world()
    const directory = OrchestratorPaths.worktreeResultsDirectory(context.configIdentity, 'development')
    mkdirSync(directory, { recursive: true })
    const resultOf = (actionId: string, at: number): Record<string, unknown> => ({
      actionId, action: 'discard', result: 'discarded', sessionId: 'removed-long-ago', title: 'gone', tag: 'run-7',
      worktreePath: 'Q:/Work/App/.worktrees/014-gone', mainCopy: 'Q:/Work/App', directoryId: null, removal: 'removed',
      revisions: [], lines: [], logs: [], notify: null, at, acknowledgedAt: null,
    })
    writeFileSync(join(directory, 'fresh.json'), JSON.stringify(resultOf('fresh', Date.now())), 'utf8')
    writeFileSync(join(directory, 'stale.json'), JSON.stringify(resultOf('stale', Date.now() - 31 * 86_400_000)), 'utf8')
    const client = clientOf(context)

    expect(valueOf(await client.manager.worktreeResults({ tag: 'run-7' })).results).toEqual([
      expect.objectContaining({ actionId: 'fresh', sessionId: 'removed-long-ago', holdsLanded: null }),
    ])
    expect(existsSync(join(directory, 'stale.json'))).toBe(false)
    expect(await client.manager.acknowledgeWorktreeResult('fresh')).toEqual({ ok: true, value: { actionId: 'fresh' } })
    expect(valueOf(await client.manager.worktreeResults({ unacknowledged: true })).results).toEqual([])
    expect(client.manager.worktreeResultsStore().list({}).map((result) => result.actionId)).toEqual(['fresh'])
  })

  it('shares proofs within one response, keeps a proven landing on the result and proves a changed one again', async () => {
    const context = await world()
    const client = clientOf(context)
    const result: WorktreeResultRecord = {
      actionId: 'landed', action: 'finish', result: 'committed', sessionId: 'gone', title: 'gone', tag: 'first',
      worktreePath: join(context.root, '.worktrees', 'gone'), mainCopy: context.root, directoryId: null, removal: 'removed',
      revisions: [{ repository: 'https://svn.test/app', revision: 50, label: 'receipt', paths: ['/a'] }],
      lines: [], logs: [], notify: null, at: Date.now(), acknowledgedAt: null,
    }
    const proof = vi.spyOn(SvnWorktreeManager.prototype, 'landingProof').mockResolvedValue({ ok: true, value: { holds: false, reason: 'a still at r40 (normal)' } })
    const holds = async (filter: WorktreeResultsFilter = {}) => valueOf(await client.manager.worktreeResults(filter)).results.map((row) => row.holdsLanded)
    try {
      await client.manager.worktreeResultsStore().put(result)
      await client.manager.worktreeResultsStore().put({ ...result, actionId: 'duplicate', tag: 'second' })
      expect(await holds({ includeLandingProof: false })).toEqual([null, null])
      expect(proof).not.toHaveBeenCalled()
      expect(await holds()).toEqual([false, false])
      expect(proof).toHaveBeenCalledTimes(1)
      proof.mockResolvedValue({ ok: true, value: { holds: true } })
      expect(await holds()).toEqual([true, true])
      expect(proof).toHaveBeenCalledTimes(2)
      expect(client.manager.worktreeResultsStore().list({}).map((row) => row.landedAt)).toEqual([expect.any(Number), expect.any(Number)])

      proof.mockResolvedValue({ ok: true, value: { holds: false, reason: 'a still at r40 (normal)' } })
      expect(await holds()).toEqual([true, true])
      expect(valueOf(await clientOf(context).manager.worktreeResults({ tag: 'second' })).results[0].holdsLanded).toBe(true)
      await client.manager.worktreeResultsStore().put({ ...result, actionId: 'duplicate', tag: 'second', lines: ['removed'] })
      expect(await holds({ tag: 'second' })).toEqual([true])
      expect(proof).toHaveBeenCalledTimes(2)

      const poll = new LandedRows({ svn: new SvnWorktreeManager(new SvnInvoker()), now: () => 1_000 })
      expect(poll.claimHolds(result.mainCopy)).toBe(true)
      expect(await poll.holds(result.mainCopy, result.revisions)).toBe(false)
      expect(poll.infoOf(result.mainCopy, result.revisions).reason).toBe('a still at r40 (normal)')
      expect(poll.claimHolds(result.mainCopy)).toBe(false)

      for (const changed of [
        { mainCopy: join(context.root, 'another') },
        { revisions: [{ ...result.revisions[0], revision: 51 }] },
        { revisions: [{ ...result.revisions[0], paths: ['/b'] }] },
        { revisions: [{ ...result.revisions[0], repository: 'https://svn.test/other' }] },
        { revisions: [{ ...result.revisions[0], paths: undefined }] },
      ]) {
        await client.manager.worktreeResultsStore().put({ ...result, ...changed })
        expect(await holds({ tag: 'first' })).toEqual([false])
      }
      expect(proof).toHaveBeenCalledTimes(8)
    } finally { proof.mockRestore() }
  })

  it.each([false, null])('retries a result proof of %s on the next read until it holds, then keeps it', async (holds) => {
    const context = await world()
    const client = clientOf(context)
    const proof = vi.spyOn(SvnWorktreeManager.prototype, 'landingProof').mockResolvedValue(holds === null
      ? { ok: false, code: 'svn-failed', detail: 'offline' }
      : { ok: true, value: { holds, reason: 'not updated' } })
    try {
      await client.manager.worktreeResultsStore().put({
        actionId: 'pending', action: 'finish', result: 'committed', sessionId: 'gone', title: 'gone', tag: null,
        worktreePath: join(context.root, '.worktrees', 'gone'), mainCopy: context.root, directoryId: null, removal: 'removed',
        revisions: [{ repository: 'https://svn.test/app', revision: 50, label: 'receipt' }],
        lines: [], logs: [], notify: null, at: Date.now(), acknowledgedAt: null,
      })
      for (let read = 0; read < 2; read++)
        expect(valueOf(await client.manager.worktreeResults({})).results[0].holdsLanded).toBe(holds)
      expect(proof).toHaveBeenCalledTimes(2)
      proof.mockResolvedValue({ ok: true, value: { holds: true } })
      for (let read = 0; read < 2; read++)
        expect(valueOf(await client.manager.worktreeResults({})).results[0].holdsLanded).toBe(true)
      expect(proof).toHaveBeenCalledTimes(3)
    } finally { proof.mockRestore() }
  })

  it('starts a requested run under a live session on the operation queue, and draws it as its child', async () => {
    const context = await world()
    seedRecords(context, [recordOf(context, 'p', { life: 'live' })])
    context.runtimes.set('p', runtime('p'))
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)
    await reconciled(client)

    const { runId } = valueOf(await client.manager.runScript('p', { command: 'pnpm test', title: 'tests' }))

    expect(context.host.calls.filter((call) => call.name === 'runtime.create')).toHaveLength(1)
    // The snapshot is true by the time the call returns: the operation queue reconciled after it.
    expect(sessionOf(client, runId)).toMatchObject({
      life: 'live',
      title: 'tests',
      script: { parentId: 'p', phase: 'inner', scriptId: 'requested' },
      setupFor: 'p',
    })
    expect(sessionOf(client, 'p')?.scripts?.runs).toEqual([expect.objectContaining({ runId, state: 'running', row: true })])
    expect(sessionOf(client, 'p')?.scripts?.badge).toBeUndefined()
    expect(await client.manager.runScript('nobody', { command: 'pnpm test' })).toMatchObject({ ok: false, code: 'not-found' })
  })

  it('composes the last output line of a running run as its step, and never one for its parent', async () => {
    const context = await world()
    seedRecords(context, [recordOf(context, 'p', { life: 'live' })])
    context.runtimes.set('p', runtime('p'))
    const rows = new Map<string, string[]>()
    context.host.handle('runtime.inspect', (body) => {
      const target = body.target as RuntimeRef
      const session = context.runtimes.get(target.runtimeSessionId)
      if (session === undefined) return { status: 404, body: { error: 'no such runtime' } }
      return {
        body: {
          session,
          projection: { ...session, raw: '', screen: '', screenLines: rows.get(target.runtimeSessionId) ?? [] },
        } satisfies RuntimeInspectResult,
      }
    })
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)
    await reconciled(client)

    const { runId } = valueOf(await client.manager.runScript('p', { command: 'ping -n 30 127.0.0.1', title: 'Ping' }))
    const running = context.runtimes.get(runId)
    if (running === undefined) throw new Error('the fake Host lost the run it created')
    rows.set(runId, ['Pinging 127.0.0.1', '\x1b[1mReply from 127.0.0.1: bytes=32\x1b[0m', ''])
    rows.set('p', ['parent output'])
    context.runtimes.set(runId, { ...running, outputSeq: 3, lastOutputAt: Date.now() })
    context.runtimes.set('p', { ...runtime('p'), outputSeq: 3, lastOutputAt: Date.now() })

    await vi.waitFor(() => expect(sessionOf(client, runId)?.step)
      .toEqual({ text: 'Reply from 127.0.0.1: bytes=32', detail: null, progress: null, startedAt: null }), { timeout: 10_000 })
    expect(sessionOf(client, 'p')).not.toHaveProperty('step')

    context.runtimes.set(runId, { ...running, outputSeq: 3, alive: false, exitCode: 0 })
    await vi.waitFor(() => expect(sessionOf(client, runId)).not.toHaveProperty('step'), { timeout: 10_000 })
    expect(client.errors).toEqual([])
  }, 20_000)

  it('drops the live line of a run that ended while the inspect of another run is still out', async () => {
    const context = await world()
    seedRecords(context, [recordOf(context, 'p', { life: 'live' })])
    context.runtimes.set('p', runtime('p'))
    const rows = new Map<string, string[]>()
    context.host.handle('runtime.inspect', (body) => {
      const target = body.target as RuntimeRef
      const session = context.runtimes.get(target.runtimeSessionId)
      if (session === undefined) return { status: 404, body: { error: 'no such runtime' } }
      return {
        body: {
          session,
          projection: { ...session, raw: '', screen: '', screenLines: rows.get(target.runtimeSessionId) ?? [] },
        } satisfies RuntimeInspectResult,
      }
    })
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)
    await reconciled(client)

    const ended = valueOf(await client.manager.runScript('p', { command: 'ping -n 30 127.0.0.1', title: 'Ping' })).runId
    const slow = valueOf(await client.manager.runScript('p', { command: 'pnpm test', title: 'Tests' })).runId
    const endedRuntime = context.runtimes.get(ended)
    const slowRuntime = context.runtimes.get(slow)
    if (endedRuntime === undefined || slowRuntime === undefined) throw new Error('the fake Host lost a run it created')
    rows.set(ended, ['Reply from 127.0.0.1'])
    rows.set(slow, ['test 1'])
    context.runtimes.set(ended, { ...endedRuntime, outputSeq: 3, lastOutputAt: Date.now() })
    context.runtimes.set(slow, { ...slowRuntime, outputSeq: 3, lastOutputAt: Date.now() })
    await vi.waitFor(() => {
      expect(sessionOf(client, ended)?.step?.text).toBe('Reply from 127.0.0.1')
      expect(sessionOf(client, slow)?.step?.text).toBe('test 1')
    }, { timeout: 10_000 })

    const inspectsOf = (runtimeSessionId: string): number => context.host.calls
      .filter((call) => call.name === 'runtime.inspect' && (call.body.target as RuntimeRef).runtimeSessionId === runtimeSessionId).length
    const before = inspectsOf(slow)
    const held = context.host.hold('runtime.inspect')
    rows.set(slow, ['test 2'])
    context.runtimes.set(slow, { ...slowRuntime, outputSeq: 4, lastOutputAt: Date.now() })
    await vi.waitFor(() => expect(inspectsOf(slow)).toBe(before + 1), { timeout: 10_000 })
    context.runtimes.set(ended, { ...endedRuntime, outputSeq: 3, alive: false, exitCode: 0 })

    await vi.waitFor(() => expect(sessionOf(client, ended)?.life).toBe('ended'), { timeout: 10_000 })
    expect(sessionOf(client, ended)).not.toHaveProperty('step')
    expect(sessionOf(client, slow)?.step?.text).toBe('test 1')
    held.release()
    await vi.waitFor(() => expect(sessionOf(client, slow)?.step?.text).toBe('test 2'), { timeout: 10_000 })
    expect(sessionOf(client, ended)).not.toHaveProperty('step')
    expect(client.errors).toEqual([])
  }, 30_000)

  function sessionOf(client: Client, sessionId: string): SessionInfo | undefined {
    return client.manager.snapshot().sessions.find((session) => session.sessionId === sessionId)
  }

  function screenOf(file: string): string {
    const fixture = WorkFixtures.all().find((candidate) => candidate.file === file)
    if (fixture === undefined) throw new Error(`missing work fixture ${file}`)
    return fixture.frame.screenTail
  }

  function recordsFileOf(context: World): string {
    return OrchestratorPaths.sessionRecordsFile(context.configIdentity, 'development')
  }

  /**
   * The records the manager will find when it loads, written where it looks for them. Seeding is the
   * only way to reach some of these shapes: a setup that failed, one that was lost and one still on a
   * record the Host is running are three different pasts of the same field, and no single call on
   * this class produces them all.
   */
  function seedRecords(context: World, records: SessionRecord[]): void {
    const file = recordsFileOf(context)
    mkdirSync(join(file, '..'), { recursive: true })
    const document: SessionRecordsDocument = { schemaVersion: 1, savedAt: Date.now(), records }
    writeFileSync(file, JSON.stringify(document), 'utf8')
  }

  function recordOf(
    context: World,
    sessionId: string,
    overrides: Partial<SessionRecord>,
  ): SessionRecord {
    return {
      sessionId,
      kind: 'shell',
      title: sessionId,
      directory: { mode: 'adHoc', path: context.root },
      binding: null,
      life: 'ended',
      createdAt: 1_000,
      ...overrides,
    }
  }

  /** What is on disk after the manager has run, which is where "the wait survived" can be read. */
  function storedRecord(context: World, sessionId: string): SessionRecord | undefined {
    const document = JSON.parse(readFileSync(recordsFileOf(context), 'utf8')) as SessionRecordsDocument
    return document.records.find((record) => record.sessionId === sessionId)
  }

  function writeCodexRollout(
    context: World,
    codexHome: string,
    sessionId: string,
    createdAt: number,
    provenance: { source?: unknown },
  ): void {
    const at = new Date(createdAt)
    const pad = (value: number): string => String(value).padStart(2, '0')
    const year = String(at.getFullYear())
    const month = pad(at.getMonth() + 1)
    const day = pad(at.getDate())
    const stamp = `${year}-${month}-${day}T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
    const directory = join(codexHome, 'sessions', year, month, day)
    mkdirSync(directory, { recursive: true })
    const timestamp = at.toISOString()
    writeFileSync(
      join(directory, `rollout-${stamp}-${sessionId}.jsonl`),
      `${JSON.stringify({
        timestamp,
        type: 'session_meta',
        payload: {
          id: sessionId,
          timestamp,
          cwd: context.root,
          originator: 'codex_cli_rs',
          cli_version: 'test',
          ...provenance,
        },
      })}\n`,
      'utf8',
    )
  }

  it.each([
    { source: 'cli', captured: false },
    { source: undefined, captured: false },
    { source: 'exec', captured: false },
    { source: { subagent: 'review' }, captured: false },
  ])('never associates a legacy tab with a rollout found on startup: %j', async ({ source, captured }) => {
    const context = await world()
    const codexHome = join(context.root, 'codex-home')
    const conversationId = '019f4bf7-b5d8-74b0-9175-a5a5938a4082'
    const createdAt = Date.now() - 3_600_000
    writeCodexRollout(context, codexHome, conversationId, createdAt + 1_000, { source })
    seedRecords(context, [recordOf(context, 'codex-old', {
      kind: 'agent',
      agent: { agentId: 'codex', launchMode: 'new' },
      life: 'lost',
      createdAt,
    })])
    const client = clientOf(context, { codexHome })

    await client.manager.start()

    expect(client.manager.debugStatus().reconcile.lastReason).toBe('poll')
    expect(storedRecord(context, 'codex-old')?.agent?.nativeSessionId).toBe(captured ? conversationId : undefined)
    expect(client.errors).toEqual([])
  }, 20_000)

  it('lists recorded agent history without finding transcripts or starting the Host', async () => {
    const context = await world()
    const directory = { mode: 'project' as const, categoryId: 'code', projectPath: join(context.categoryRoot, 'Alpha') }
    const agent = { agentId: 'claude' as const, launchMode: 'new' as const, nativeSessionId: 'native', model: 'saved-model' }
    seedRecords(context, [
      recordOf(context, 'recorded', { kind: 'agent', directory, agent, title: 'Recorded title', createdAt: 1_000, endedAt: 3_000 }),
      recordOf(context, 'nested', {
        kind: 'agent', agent: { ...agent, nativeSessionId: 'nested-native' },
        directory: { ...directory, projectPath: join(context.categoryRoot, 'Container', 'Nested') },
      }),
      recordOf(context, 'lost', { kind: 'agent', directory, agent: { ...agent, nativeSessionId: 'lost-native', model: undefined }, life: 'lost', createdAt: 500 }),
      recordOf(context, 'shell', { directory }),
      recordOf(context, 'unnamed', { kind: 'agent', directory, agent: { agentId: 'codex', launchMode: 'new' } }),
      recordOf(context, 'outside', { kind: 'agent', agent }),
    ])
    const resolveTranscript = vi.fn()
    const client = clientOf(context, { transcripts: { resolve: resolveTranscript } })
    const history = await client.manager.localHistory()
    expect(history).toHaveLength(3)
    expect(history.find((row) => row.nativeSessionId === 'native')).toEqual({
      category: { id: 'code', label: 'Code', path: context.categoryRoot },
      project: { kind: 'project', categoryId: 'code', projectName: 'Alpha', projectPath: directory.projectPath },
      agentId: 'claude', nativeSessionId: 'native', title: 'Recorded title', model: 'saved-model',
      createdAt: 1_000, lastActivity: null, endedAt: 3_000, active: false,
    })
    expect(history.find((row) => row.nativeSessionId === 'lost-native')).toMatchObject({ lastActivity: null, model: null, active: false })
    expect(history.find((row) => row.nativeSessionId === 'nested-native')?.project).toMatchObject({
      projectName: 'Container/Nested', projectPath: join(context.categoryRoot, 'Container', 'Nested'),
    })
    expect(resolveTranscript).not.toHaveBeenCalled()
    expect(client.spawns()).toBe(0)
    expect(context.runtimes.size).toBe(0)
  })

  it('uses persisted user input and ignores newer runtime starts and output in history', async () => {
    const context = await world()
    context.publishDescriptor()
    context.runtimes.set('running-history', runtime('running-history', { startedAt: 5_000, lastOutputAt: 9_000 }))
    seedRecords(context, [recordOf(context, 'running-history', {
      kind: 'agent', life: 'live',
      lastUserInputAt: 2_000,
      binding: { hostInstanceId: context.host.descriptor().hostInstanceId, generation: 1 },
      directory: { mode: 'project', categoryId: 'code', projectPath: join(context.categoryRoot, 'Alpha') },
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'live-native', model: 'saved-model' },
    })])
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)
    await reconciled(client)
    const revision = client.manager.snapshot().revision
    expect(await client.manager.localHistory()).toEqual([expect.objectContaining({
      nativeSessionId: 'live-native', createdAt: 1_000, lastActivity: 2_000, active: true,
    })])
    expect(client.manager.snapshot().revision).toBe(revision)
  })

  it('keeps accepted terminal input in history immediately and flushes it when the client closes', async () => {
    const context = await world()
    context.publishDescriptor()
    const live = runtime('history-input')
    context.runtimes.set(live.runtimeSessionId, live)
    seedRecords(context, [recordOf(context, live.runtimeSessionId, {
      kind: 'agent', life: 'live',
      binding: { hostInstanceId: context.host.descriptor().hostInstanceId, generation: 1 },
      directory: { mode: 'project', categoryId: 'code', projectPath: join(context.categoryRoot, 'Alpha') },
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'history-native' },
    })])
    const client = clientOf(context, {
      terminalSocketFactory: (deps) => ({
        connect: () => undefined,
        close: () => undefined,
        send: (message) => {
          if (message.type === 'terminal.attach')
            deps.onFrame({ type: 'terminal.attached', writer: true, session: live })
        },
      }),
    })
    // The first listing is held so the attach is asked for after `writable` and before anything has
    // bound `history-input` to its runtime. That ordering used to arrive only under a loaded full
    // suite, and failed there; held, it arrives on every run.
    const listing = context.host.hold('runtime.list')
    await client.manager.start()
    await writable(client)
    listing.release()
    await reconciled(client)
    expect(client.manager.terminalAttach('history-panel', { sessionId: live.runtimeSessionId, size: null }, {
      source: 'local', onFrame: () => undefined,
    })).toEqual({ ok: true })
    client.manager.terminalInput('history-panel', '\x1b[1;2R')
    expect((await client.manager.localHistory())[0]?.lastActivity).toBeNull()
    const before = Date.now()
    expect(client.manager.terminalInput('history-panel', 'actual prompt\r')).toEqual({ kind: 'sent' })
    const lastUsed = (await client.manager.localHistory())[0]?.lastActivity
    expect(lastUsed).toBeGreaterThanOrEqual(before)
    client.manager.terminalResize('history-panel', 110, 30)
    client.manager.terminalInput('history-panel', '\x1b[I')
    expect((await client.manager.localHistory())[0]?.lastActivity).toBe(lastUsed)
    await client.manager.stop()
    expect(storedRecord(context, live.runtimeSessionId)?.lastUserInputAt).toBe(lastUsed)
    expect((await clientOf(context).manager.localHistory())[0]?.lastActivity).toBe(lastUsed)
    expect(client.errors).toEqual([])
  })

  it('reads an agent session\'s input box off the Host projection and refuses what has none', async () => {
    const context = await world()
    context.publishDescriptor()
    const binding = { hostInstanceId: context.host.descriptor().hostInstanceId, generation: 1 }
    const directory = { mode: 'project' as const, categoryId: 'code', projectPath: join(context.categoryRoot, 'Alpha') }
    for (const id of ['composer-agent', 'composer-shell', 'composer-blind'])
      context.runtimes.set(id, runtime(id))
    seedRecords(context, [
      recordOf(context, 'composer-agent', {
        kind: 'agent', life: 'live', binding, directory,
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'composer-native' },
      }),
      recordOf(context, 'composer-shell', { kind: 'shell', life: 'live', binding, directory }),
      recordOf(context, 'composer-blind', {
        kind: 'agent', life: 'live', binding, directory,
        agent: { agentId: 'codex', launchMode: 'new' },
      }),
      recordOf(context, 'composer-gone', {
        kind: 'agent', life: 'lost', binding: null, directory,
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'composer-gone-native' },
      }),
    ])
    const fixture = WorkFixtures.all().find((candidate) => candidate.file === 'claude-live-composer-text.json')
    if (fixture === undefined) throw new Error('missing work fixture claude-live-composer-text.json')
    context.screens.set('composer-agent', fixture.frame.wideScreenTail)
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)
    await reconciled(client)
    // The listing keeps the runtime; only `runtime.inspect` refuses it.
    context.host.handle('runtime.inspect', (body) => {
      const target = body.target as RuntimeRef
      const session = context.runtimes.get(target.runtimeSessionId)
      if (session === undefined || target.runtimeSessionId === 'composer-blind')
        return { status: 404, body: { error: 'no such runtime' } }
      return {
        body: {
          session,
          projection: { ...session, raw: '', screen: context.screens.get(target.runtimeSessionId) ?? '' },
        } satisfies RuntimeInspectResult,
      }
    })

    expect(await client.manager.terminalComposer('composer-agent')).toEqual({
      ok: true,
      reading: {
        agentId: 'claude',
        alive: true,
        hint: 'idle',
        composer: { state: 'text', text: 'Reply with the single word pong and nothing else.' },
        queuedRow: false,
        echoHead: null,
        pastePlaceholders: 0,
        onlyPlaceholders: false,
      },
    })
    expect(await client.manager.terminalComposer('nobody')).toEqual({ ok: false, code: 'unknown-session' })
    expect(await client.manager.terminalComposer('composer-gone')).toEqual({ ok: false, code: 'not-live' })
    expect(await client.manager.terminalComposer('composer-shell')).toEqual({ ok: false, code: 'not-agent' })
    expect(await client.manager.terminalComposer('composer-blind')).toEqual({ ok: false, code: 'no-projection' })
  })

  it('reads an agent session\'s whole draft off one viewport inspect and refuses what has none', async () => {
    const context = await world()
    context.publishDescriptor()
    const binding = { hostInstanceId: context.host.descriptor().hostInstanceId, generation: 1 }
    const directory = { mode: 'project' as const, categoryId: 'code', projectPath: join(context.categoryRoot, 'Alpha') }
    for (const id of ['content-agent', 'content-shell', 'content-blind', 'content-plain', 'content-dialog'])
      context.runtimes.set(id, runtime(id))
    const claude = (id: string) => recordOf(context, id, {
      kind: 'agent', life: 'live', binding, directory,
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: `${id}-native` },
    })
    seedRecords(context, [
      claude('content-agent'),
      recordOf(context, 'content-shell', { kind: 'shell', life: 'live', binding, directory }),
      claude('content-blind'),
      claude('content-plain'),
      claude('content-dialog'),
      recordOf(context, 'content-gone', {
        kind: 'agent', life: 'lost', binding: null, directory,
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'content-gone-native' },
      }),
    ])
    const fixtureOf = (file: string) => {
      const found = WorkFixtures.all().find((candidate) => candidate.file === file)
      if (found === undefined) throw new Error(`missing work fixture ${file}`)
      return found
    }
    const text = fixtureOf('claude-live-composer-text.json')
    const dialog = fixtureOf('claude-live-permission-prompt.json')
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)
    await reconciled(client)
    const views: ({ screenScrollbackRows?: number } | undefined)[] = []
    context.host.handle('runtime.inspect', (body) => {
      const target = body.target as RuntimeRef
      const session = context.runtimes.get(target.runtimeSessionId)
      if (session === undefined || target.runtimeSessionId === 'content-blind')
        return { status: 404, body: { error: 'no such runtime' } }
      views.push(body.view as { screenScrollbackRows?: number } | undefined)
      const rows = target.runtimeSessionId === 'content-dialog'
        ? dialog.frame.wideScreenTail.split('\n')
        : text.frame.wideScreenTail.split('\n')
      // An older Host sends rows without the style marker; they cannot tell a dim placeholder.
      const styled = target.runtimeSessionId !== 'content-plain'
      return {
        body: {
          session,
          projection: { ...session, raw: '', screen: '', screenLines: rows, ...(styled ? { screenLinesStyled: true } : {}) },
        } satisfies RuntimeInspectResult,
      }
    })

    expect(await client.manager.terminalComposerContent('content-agent')).toEqual({
      ok: true,
      reading: {
        agentId: 'claude',
        alive: true,
        hint: 'idle',
        content: text.expected.content,
      },
    })
    // The work-state monitor inspects too, with its own scrollback; only the read asks for none.
    expect(views.filter((view) => view?.screenScrollbackRows === 0)).toEqual([ScreenTail.viewportViewConst])
    expect(await client.manager.terminalComposerContent('content-dialog')).toMatchObject({
      ok: true,
      reading: { hint: 'blocked' },
    })
    expect(await client.manager.terminalComposerContent('nobody')).toEqual({ ok: false, code: 'unknown-session' })
    expect(await client.manager.terminalComposerContent('content-gone')).toEqual({ ok: false, code: 'not-live' })
    expect(await client.manager.terminalComposerContent('content-shell')).toEqual({ ok: false, code: 'not-agent' })
    expect(await client.manager.terminalComposerContent('content-blind')).toEqual({ ok: false, code: 'no-projection' })
    expect(await client.manager.terminalComposerContent('content-plain')).toEqual({ ok: false, code: 'no-viewport' })
  })

  it('classifies setup origins by current content and property hashes', async () => {
    const context = await world()
    const worktreePath = join(context.root, '.worktrees', 'setup')
    mkdirSync(worktreePath, { recursive: true })
    const file = join(worktreePath, 'lock')
    writeFileSync(file, 'setup')
    let properties = 'setup'
    const svn = vi.spyOn(SvnInvoker.prototype, 'run').mockImplementation(async (_cwd, args) => ({ code: 0, failure: null, stderr: '',
      stdout: args[0] === 'proplist' ? `<properties><target path="lock"><property name="fixture">${properties}</property></target></properties>` : '<status><target path="." /></status>' }))
    const baseline = await new SvnWorktreeManager(new SvnInvoker()).commitHashes(worktreePath, ['lock'])
    if (!baseline.ok) throw new Error(baseline.detail)
    seedRecords(context, [recordOf(context, 'setup', { worktree: { kind: 'svn', worktreePath, repositoryRoot: context.root,
      branch: 'https://svn.test/app', baseCommit: 'r1', setupBaseline: { at: 1, hashes: baseline.value } } })])
    const client = clientOf(context)
    try {
      await client.manager.start()
      expect(await client.manager.setupPaths('setup', [file, join(context.root, 'outside')])).toEqual({ ok: true, value: [file] })
      properties = 'worker'
      expect(await client.manager.setupPaths('setup', [file])).toEqual({ ok: true, value: [] })
      properties = 'setup'
      writeFileSync(file, 'worker')
      expect(await client.manager.setupPaths('setup', [file])).toEqual({ ok: true, value: [] })
    }
    finally { svn.mockRestore() }
  })

  it('names the Host, the catalog and where every session belongs', async () => {
    const context = await world()
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    const inProject = valueOf(await client.manager.createSession({
      kind: 'shell',
      directory: { mode: 'project', categoryId: 'code', projectPath: join(context.categoryRoot, 'Alpha') },
    }))
    const elsewhere = valueOf(await client.manager.createSession({
      kind: 'shell',
      directory: { mode: 'adHoc', path: join(context.root, 'elsewhere') },
    }))

    const snapshot = client.manager.snapshot()
    expect(snapshot.categories).toEqual([{ id: 'code', label: 'Code', path: context.categoryRoot }])
    expect(snapshot.host).toMatchObject({
      presence: 'running',
      hostVersion: '0.0.0-fake',
      hostInstanceId: 'fake-host-1',
      liveCount: 2,
      lastStartError: null,
    })
    const project = snapshot.sessions.find((session) => session.sessionId === inProject.sessionId)
    expect(project?.project).toEqual({
      kind: 'project',
      categoryId: 'code',
      projectName: 'Alpha',
      projectPath: join(context.categoryRoot, 'Alpha'),
    })
    expect(project?.life).toBe('live')
    // Nothing classifies a plain terminal, and no worktree was asked for.
    expect(project?.activity).toBeNull()
    expect(project?.worktree).toBeUndefined()
    const adHoc = snapshot.sessions.find((session) => session.sessionId === elsewhere.sessionId)
    expect(adHoc?.project.kind).toBe('adHoc')
    expect(await client.manager.workingContext(inProject.sessionId)).toEqual({
      ok: true,
      value: {
        sessionId: inProject.sessionId,
        cwd: join(context.categoryRoot, 'Alpha'),
        agent: null,
        worktree: null,
      },
    })
    expect(await client.manager.workingContext('unknown')).toMatchObject({
      ok: false,
      code: 'unknown-session',
    })
    expect(client.errors).toEqual([])
  }, 20_000)

  /**
   * The block a person copies to tell a SECOND agent which conversation is meant. The transcript is
   * the one line a snapshot cannot answer, so what is checked here is that it is looked for against
   * the cwd the agent was really started in - a transcript found for another directory would name
   * somebody else's conversation.
   */
  it('writes down a session so another agent knows which conversation it is', async () => {
    const context = await world()
    context.publishDescriptor()
    const asked: { cwd: string; nativeSessionId: string }[] = []
    const client = clientOf(context, {
      transcripts: {
        resolve: (input) => {
          asked.push({ cwd: input.cwd, nativeSessionId: input.nativeSessionId })
          return Promise.resolve({
            agentId: 'claude' as const,
            nativeSessionId: input.nativeSessionId,
            file: `C:/transcripts/${input.nativeSessionId}.jsonl`,
            mtimeMs: 1,
            size: 2,
          })
        },
      },
    })
    await client.manager.start()
    await writable(client)

    const created = valueOf(await client.manager.createSession({
      kind: 'agent',
      agent: { agentId: 'claude', mode: 'new', nativeSessionId: 'native-9' },
      directory: { mode: 'project', categoryId: 'code', projectPath: join(context.categoryRoot, 'Alpha') },
    }))
    const reference = valueOf(await client.manager.sessionReference(created.sessionId))

    expect(reference.text).toBe([
      'AppJamatV3 session',
      'reference version: 2',
      'computer: "TEST-PC"',
      'route: local',
      `controller config identity: ${JSON.stringify(context.configIdentity)}`,
      'controller channel: development',
      `session: ${JSON.stringify(sessionOf(client, created.sessionId)?.title)}`,
      'agent: claude',
      'agent session id: "native-9"',
      `working directory: ${JSON.stringify(join(context.categoryRoot, 'Alpha'))}`,
      'transcript: "C:/transcripts/native-9.jsonl"',
      `jamat session id: ${JSON.stringify(created.sessionId)}`,
    ].join('\n'))
    expect(asked).toEqual([{
      cwd: join(context.categoryRoot, 'Alpha'),
      nativeSessionId: 'native-9',
    }])
    expect(await client.manager.sessionReference('unknown'))
      .toMatchObject({ ok: false, code: 'not-found' })
    expect(client.errors).toEqual([])
  }, 20_000)

  it('keeps transcript provenance after a worktree is gone and falls back for old records', async () => {
    const context = await world()
    const originalWorktree = join(context.root, '.worktrees', 'merged-away')
    seedRecords(context, [
      recordOf(context, 'provenance', {
        kind: 'agent',
        agent: {
          agentId: 'claude',
          launchMode: 'new',
          nativeSessionId: 'native-1',
          model: 'claude-opus-5[1m]',
        },
        directory: {
          mode: 'project',
          categoryId: 'code',
          projectPath: join(context.categoryRoot, 'Alpha'),
        },
        transcriptCwd: originalWorktree,
        worktree: undefined,
        life: 'ended',
        binding: null,
      }),
      recordOf(context, 'old-record', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'new', nativeSessionId: 'native-2' },
        directory: { mode: 'adHoc', path: join(context.root, 'legacy-cwd') },
        life: 'ended',
        binding: null,
      }),
    ])
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()

    expect(await client.manager.transcriptContext('provenance')).toEqual({
      ok: true,
      value: {
        agentId: 'claude',
        cwd: originalWorktree,
        nativeSessionId: 'native-1',
        // The tier this session was founded on, which its transcript never states: the status bar
        // draws a fifth of the window without it.
        launchModel: 'claude-opus-5[1m]',
        startedAt: 1_000,
      },
    })
    expect(await client.manager.workingContext('provenance')).toMatchObject({
      ok: true,
      value: { cwd: join(context.categoryRoot, 'Alpha') },
    })
    expect(await client.manager.transcriptContext('old-record')).toEqual({
      ok: true,
      value: {
        agentId: 'codex',
        cwd: join(context.root, 'legacy-cwd'),
        nativeSessionId: null,
        launchModel: null,
        startedAt: 1_000,
      },
    })
  }, 20_000)

  /**
   * The name a tab takes, composed here and nowhere else: four surfaces open a tab for a session,
   * and a title alone - `001` - names nothing a person can pick a tab by. It travels twice, on the
   * create for whoever opens the tab straight away and on the snapshot for whoever opens it later.
   */
  it('names a tab after the place a session runs in, then the session', async () => {
    const context = await world()
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    // Taken before the create, the way the create card takes it: a title may carry a number only
    // once the counter has handed that number out.
    const alpha = join(context.categoryRoot, 'Alpha')
    const token = valueOf(await client.manager.allocateSessionNumber(alpha)).token
    const numbered = valueOf(await client.manager.createSession({
      kind: 'shell',
      directory: { mode: 'project', categoryId: 'code', projectPath: alpha },
      title: token,
    }))
    const adHoc = valueOf(await client.manager.createSession({
      kind: 'shell',
      directory: { mode: 'adHoc', path: join(context.root, 'elsewhere') },
      title: 'scratch',
    }))
    // Nothing names a place here, and the account the home directory belongs to is not one.
    const home = valueOf(await client.manager.createSession({
      kind: 'shell',
      directory: { mode: 'default' },
      title: 'quick look',
    }))

    expect(numbered.tabTitle).toBe('Alpha - 001')
    expect(sessionOf(client, numbered.sessionId)?.tabTitle).toBe('Alpha - 001')
    expect(adHoc.tabTitle).toBe('elsewhere - scratch')
    expect(home.tabTitle).toBe('Terminal - quick look')
    expect(client.errors).toEqual([])
  }, 20_000)

  it.each(['Alpha', 'ProductivityTools/Jamat'])('numbers a directory create at catalog root %s and recovers its counter', async (projectName) => {
    const context = await world()
    writeFileSync(join(context.configDir, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      categories: [{ id: 'code', label: 'Code', path: context.categoryRoot, flattenFolders: ['ProductivityTools'] }],
    }))
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)
    const projectPath = join(context.categoryRoot, projectName)
    const directory = { mode: 'adHoc', path: `${projectPath.replaceAll('\\', '/')}/` } as const
    const created = valueOf(await client.manager.createSession({
      kind: 'agent', directory, agent: { agentId: 'codex', mode: 'new' }, title: 'Fix the parser',
    }))

    expect(created).toMatchObject({ sessionId: expect.any(String), number: '001', tabTitle: `${projectName} - 001 - Fix the parser` })
    expect(storedRecord(context, created.sessionId)?.directory)
      .toEqual({ mode: 'project', categoryId: 'code', projectPath })
    expect(sessionOf(client, created.sessionId)?.titleParts).toEqual({ number: '001', name: 'Fix the parser' })
    expect(await client.manager.workingContext(created.sessionId)).toMatchObject({ ok: true, value: { cwd: projectPath } })
    expect(directory.mode).toBe('adHoc')

    const refused = await client.manager.createSession({ kind: 'shell', directory, title: '2026 plan' })
    expect(refused).toMatchObject({ ok: false, code: 'invalid-spec' })
    const custom = valueOf(await client.manager.createSession({ kind: 'shell', directory, number: 'i76', title: 'Ticket' }))
    expect(custom.number).toBe('i76')

    await client.manager.stop()
    rmSync(OrchestratorPaths.sessionNumbersFile(context.configIdentity, 'development'))
    const restarted = clientOf(context)
    await restarted.manager.start()
    await writable(restarted)
    const next = valueOf(await restarted.manager.createSession({ kind: 'shell', directory, title: 'Next task' }))
    expect(next.number).toBe('002')
  }, 20_000)

  it('keeps directory creates below a project or outside the catalog in their requested directory', async () => {
    const context = await world()
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)
    for (const path of [join(context.categoryRoot, 'Alpha', 'src'), context.categoryRoot, join(context.root, 'elsewhere')]) {
      const directory = { mode: 'adHoc', path } as const
      const created = valueOf(await client.manager.createSession({ kind: 'shell', directory, title: 'Inspect' }))
      expect(created.number).toBeUndefined()
      expect(storedRecord(context, created.sessionId)?.directory).toEqual(directory)
      expect(await client.manager.workingContext(created.sessionId)).toMatchObject({ ok: true, value: { cwd: path } })
    }
  }, 20_000)

  it('opens a provider history conversation through the derived operation and names its tab',
    async () => {
      const context = await world()
      context.publishDescriptor()
      const client = clientOf(context)
      await client.manager.start()
      await writable(client)

      const opened = valueOf(await client.manager.openHistorySession({
        directory: {
          mode: 'project',
          categoryId: 'code',
          projectPath: join(context.categoryRoot, 'Alpha'),
        },
        agentId: 'claude',
        nativeSessionId: 'native-1',
        providerName: 'Provider task',
        providerActive: false,
      }))

      expect(opened.tabTitle).toBe('Alpha - 001 - Provider task')
      expect(storedRecord(context, opened.sessionId)?.agent).toEqual({
        agentId: 'claude',
        accountId: 'main',
        launchMode: 'resume',
        nativeSessionId: 'native-1',
        identityLaunchId: expect.any(String),
      })
      expect(valueOf(await client.manager.historyReferences({
        mode: 'project',
        categoryId: 'code',
        projectPath: join(context.categoryRoot, 'Alpha'),
      })).references).toEqual([expect.objectContaining({
        sessionId: opened.sessionId,
        agentId: 'claude',
        nativeSessionId: 'native-1',
        title: '001 - Provider task',
      })])
      expect(client.errors).toEqual([])
    }, 20_000)

  // Nothing is finished the moment it is created, and a session that is still running has no
  // ending to read either.
  it('answers a fresh session with a reconciled snapshot and no ending', async () => {
    const context = await world()
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    const created = valueOf(await client.manager.createSession({
      kind: 'shell',
      directory: { mode: 'adHoc', path: join(context.root, 'elsewhere') },
    }))

    // Nobody has looked yet is a different answer from nothing is running, and one surface acts on
    // the difference: before the first answered listing this is false.
    expect(client.manager.snapshot().reconciled).toBe(true)
    expect(sessionOf(client, created.sessionId)?.completed).toBeUndefined()
    expect(sessionOf(client, created.sessionId)?.outcome).toBeUndefined()
    expect(client.errors).toEqual([])
  }, 20_000)

  it('registers notify only after a successful create and reads durable events by session id', async () => {
    const context = await world()
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)
    const notify = { sessionId: 'parent', text: 'child moved or ended', onGroups: ['waiting', 'unknown-group'] }
    expect(await client.manager.createSession({ kind: 'agent', directory: { mode: 'default' }, notify }))
      .toMatchObject({ ok: false })
    expect(valueOf(await client.manager.notifies({})).notifies).toEqual([])
    const plain = valueOf(await client.manager.createSession({ kind: 'shell', directory: { mode: 'default' } }))
    expect(valueOf(await client.manager.notifies({ sessionId: plain.sessionId })).notifies).toEqual([])
    const first = valueOf(await client.manager.createSession({ kind: 'shell', directory: { mode: 'default' }, notify }))
    const second = valueOf(await client.manager.createSession({ kind: 'shell', directory: { mode: 'default' }, notify: { ...notify, onGroups: [] } }))
    const store = client.manager.sessionNotifyStore()
    await store.watch(first.sessionId, { ...notify, text: 'must not replace the original watch' })
    await store.observe(first.sessionId, { life: 'live', group: 'waiting' }, 10)
    await store.note(store.pending().map((event) => event.id), 'delivered', 11)
    await store.observe(first.sessionId, { life: 'live', group: 'completed' }, 12)
    await store.observe(first.sessionId, { life: 'gone', group: 'completed' }, Date.now())
    await store.note(store.pending().map((event) => event.id), 'delivered', Date.now())
    const expected = { sessionId: first.sessionId, target: 'parent', text: notify.text, onGroups: notify.onGroups, events: [
      { cause: 'group:waiting', at: 10, state: 'delivered', attempts: 0, settledAt: 11 },
      { cause: 'ended', at: expect.any(Number), state: 'delivered', attempts: 0, settledAt: expect.any(Number) },
    ] }
    expect(valueOf(await client.manager.notifies({})).notifies).toEqual([
      expected, { sessionId: second.sessionId, target: 'parent', text: notify.text, onGroups: [], events: [] },
    ])
    expect(valueOf(await client.manager.notifies({ sessionId: first.sessionId })).notifies).toEqual([expected])
    expect(valueOf(await client.manager.notifies({ sessionId: 'unknown' })).notifies).toEqual([])
    const reloaded = clientOf(context)
    expect(valueOf(await reloaded.manager.notifies({ sessionId: first.sessionId })).notifies).toEqual([expected])
    expect(client.errors).toEqual([])
    expect(reloaded.errors).toEqual([])
  }, 20_000)

  // The replay may still start the record an undecided create left, and that session has to wake
  // the target like one whose create succeeded. A refused create ended its record and wakes nobody.
  it('registers notify for the record an undecided create left, never for a refused one', async () => {
    const context = await world()
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)
    const watch = vi.spyOn(client.manager.sessionNotifyStore(), 'watch')
    const notify = { sessionId: 'parent', text: 'left record woke', onGroups: [] }

    context.host.handle('runtime.create', () => ({ status: 400, body: { error: 'launch.cwd must be an existing directory' } }))
    const refused = await client.manager.createSession({ kind: 'shell', directory: { mode: 'default' }, notify })
    expect(refused).toMatchObject({ ok: false, code: 'op-rejected' })
    expect(refused).not.toHaveProperty('recordedSessionId')
    expect(watch).not.toHaveBeenCalled()
    expect(valueOf(await client.manager.notifies({})).notifies).toEqual([])

    context.host.handle('runtime.create', () => ({ status: 500, body: { error: 'internal error' } }))
    const left = await client.manager.createSession({ kind: 'shell', directory: { mode: 'default' }, notify })
    if (left.ok || left.recordedSessionId === undefined) throw new Error(`expected a left record, got ${JSON.stringify(left)}`)
    expect(left.code).toBe('op-rejected')
    expect(sessionOf(client, left.recordedSessionId)?.life).toBe('starting')
    expect(watch).toHaveBeenCalledTimes(1)
    expect(watch).toHaveBeenCalledWith(left.recordedSessionId, notify)
    expect(valueOf(await client.manager.notifies({ sessionId: left.recordedSessionId })).notifies).toEqual([
      { sessionId: left.recordedSessionId, target: 'parent', text: notify.text, onGroups: [], events: [] },
    ])
  }, 20_000)

  it('carries a colour to the snapshot, and takes it off the record when it is cleared', async () => {
    const context = await world()
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    const session = valueOf(await client.manager.createSession({
      kind: 'shell',
      directory: { mode: 'adHoc', path: join(context.root, 'elsewhere') },
    }))
    expect(sessionOf(client, session.sessionId)?.color).toBeUndefined()

    const painted = client.manager.snapshot().revision
    expect(await client.manager.setSessionColor(session.sessionId, 'teal'))
      .toEqual({ ok: true, value: undefined })
    expect(sessionOf(client, session.sessionId)?.color).toBe('teal')
    // The colour is content, so the revision it changed has to move with it or no window redraws.
    expect(client.manager.snapshot().revision).toBeGreaterThan(painted)

    expect(await client.manager.setSessionColor(session.sessionId, null))
      .toEqual({ ok: true, value: undefined })
    expect(sessionOf(client, session.sessionId)?.color).toBeUndefined()
    expect(storedRecord(context, session.sessionId)).not.toHaveProperty('color')
    expect(client.errors).toEqual([])
  }, 20_000)

  /**
   * A colour is decoration, so a name this build cannot draw costs the decoration and nothing else.
   * Dropping the record over it would lose somebody the session to save the paint.
   */
  it('loads a record whose colour it does not know, and leaves that session unpainted', async () => {
    const context = await world()
    seedRecords(context, [recordOf(context, 's1', { color: 'chartreuse' as never, life: 'lost' })])
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    expect(sessionOf(client, 's1')?.title).toBe('s1')
    expect(sessionOf(client, 's1')?.color).toBeUndefined()
    expect(client.errors).toEqual([])
  }, 20_000)

  it('splits every title into its parts, and carries a note to the snapshot', async () => {
    const context = await world()
    seedRecords(context, [
      recordOf(context, 's1', { title: '014 - alpha', note: 'why this one exists', life: 'lost' }),
      recordOf(context, 's2', { title: 'plain shell', life: 'lost' }),
    ])
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()

    expect(sessionOf(client, 's1')?.titleParts).toEqual({ number: '014', name: 'alpha' })
    expect(sessionOf(client, 's1')?.note).toBe('why this one exists')
    expect(sessionOf(client, 's2')?.titleParts).toEqual({ number: null, name: 'plain shell' })
    expect(sessionOf(client, 's2')).not.toHaveProperty('note')
  }, 20_000)

  it('carries the create operation id of a record to the snapshot, and leaves it absent otherwise', async () => {
    const context = await world()
    seedRecords(context, [
      recordOf(context, 's1', { callerOperationId: 'op-create', life: 'lost' }),
      recordOf(context, 's2', { life: 'lost' }),
    ])
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()

    expect(sessionOf(client, 's1')?.callerOperationId).toBe('op-create')
    expect(sessionOf(client, 's2')).not.toHaveProperty('callerOperationId')
  }, 20_000)

  it('composes the parent link with sameProject from both bindings, and leaves a session without one untouched', async () => {
    const context = await world()
    const alpha = join(context.categoryRoot, 'Alpha')
    const scratch = join(context.root, 'scratch')
    seedRecords(context, [
      recordOf(context, 'p', { directory: { mode: 'project', categoryId: 'code', projectPath: alpha }, life: 'lost' }),
      // Its directory lies outside the catalog; only the worktree's owner makes it Alpha's.
      recordOf(context, 'worktree-child', {
        directory: { mode: 'adHoc', path: join(context.root, 'Alpha-worktrees', 'fix') },
        worktree: { worktreePath: join(context.root, 'Alpha-worktrees', 'fix'), branch: 'jamat/fix', baseCommit: 'abc123', repositoryRoot: alpha },
        parent: { sessionId: 'p', kind: 'worktree' },
      }),
      recordOf(context, 'other-project', {
        directory: { mode: 'project', categoryId: 'code', projectPath: join(context.categoryRoot, 'Beta') },
        parent: { sessionId: 'p', kind: 'ticket' },
      }),
      recordOf(context, 'ad-hoc', { directory: { mode: 'adHoc', path: scratch } }),
      recordOf(context, 'ad-hoc-child', { directory: { mode: 'adHoc', path: scratch }, parent: { sessionId: 'ad-hoc', kind: 'worker' } }),
      recordOf(context, 'orphan', { directory: { mode: 'project', categoryId: 'code', projectPath: alpha }, parent: { sessionId: 'removed', kind: 'worker' } }),
    ])
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()

    expect(sessionOf(client, 'worktree-child')?.parent).toEqual({ sessionId: 'p', kind: 'worktree', sameProject: true })
    expect(sessionOf(client, 'other-project')?.parent).toEqual({ sessionId: 'p', kind: 'ticket', sameProject: false })
    expect(sessionOf(client, 'ad-hoc-child')?.parent).toEqual({ sessionId: 'ad-hoc', kind: 'worker', sameProject: true })
    expect(sessionOf(client, 'orphan')?.parent).toEqual({ sessionId: 'removed', kind: 'worker', sameProject: false })
    expect(sessionOf(client, 'p')).not.toHaveProperty('parent')
    expect(await client.manager.children('p')).toEqual({ ok: true, value: { children: [
      expect.objectContaining({ sessionId: 'worktree-child', kind: 'worktree', sameProject: true, life: sessionOf(client, 'worktree-child')?.life }),
      expect.objectContaining({ sessionId: 'other-project', kind: 'ticket', sameProject: false }),
    ] } })
    expect(await client.manager.children('removed'))
      .toEqual({ ok: true, value: { children: [expect.objectContaining({ sessionId: 'orphan', kind: 'worker', sameProject: false })] } })
    expect(await client.manager.children('worktree-child')).toEqual({ ok: true, value: { children: [] } })
    // No record binds to `none` (an empty cwd), so the rule is asked directly.
    expect(SessionManager['sameProject']({ kind: 'none' }, { kind: 'none' })).toBe(false)
    expect(client.errors).toEqual([])
  }, 20_000)

  it('refuses a colour that is not in the palette', async () => {
    const context = await world()
    seedRecords(context, [recordOf(context, 's1', { life: 'lost' })])
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()

    const refusal = await client.manager.setSessionColor('s1', 'chartreuse' as never)
    expect(refusal.ok).toBe(false)
    if (!refusal.ok) expect(refusal.code).toBe('invalid-spec')
    expect(storedRecord(context, 's1')).not.toHaveProperty('color')
  }, 20_000)

  it('saves the details as one revision, and answers whether the title moved', async () => {
    const context = await world()
    seedRecords(context, [recordOf(context, 's1', { title: '014 - alpha', life: 'lost' })])
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()

    const before = client.manager.snapshot().revision
    expect(await client.manager.setSessionDetails('s1', {
      name: 'beta',
      note: 'why this one exists',
      color: 'teal',
    })).toEqual({ ok: true, value: { titleChanged: true, notifyAgent: null } })
    expect(sessionOf(client, 's1')?.title).toBe('014 - beta')
    expect(sessionOf(client, 's1')?.note).toBe('why this one exists')
    expect(sessionOf(client, 's1')?.color).toBe('teal')
    // The details are content, so the revision has to move with them or no window redraws.
    expect(client.manager.snapshot().revision).toBeGreaterThan(before)
    expect(storedRecord(context, 's1')?.title).toBe('014 - beta')
    expect(client.errors).toEqual([])
  }, 20_000)

  /**
   * The one place the rules live. Every row here is a refusal the library would make anyway, asked
   * before the item is drawn instead of after it is clicked.
   */
  it('says which operations each session admits, off the record alone', async () => {
    const context = await world()
    seedRecords(context, [
      recordOf(context, 'claude-live', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
        life: 'live',
        binding: { hostInstanceId: 'fake-host-1', generation: 1 },
      }),
      recordOf(context, 'codex-nameless', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'new' },
        life: 'lost',
      }),
      recordOf(context, 'claude-forked', {
        kind: 'agent',
        agent: {
          agentId: 'claude', launchMode: 'fork', forkParentId: 'native-1', nativeSessionId: 'native-3',
        },
        life: 'lost',
      }),
      recordOf(context, 'claude-forked-legacy', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'fork', forkParentId: 'native-1' },
        life: 'lost',
      }),
      recordOf(context, 'claude-resolver', {
        kind: 'agent',
        agent: {
          agentId: 'claude', launchMode: 'fork', forkParentId: 'native-1',
          nativeSessionId: 'native-4', oneShot: true,
        },
        life: 'ended',
        scriptOf: { sessionId: 'claude-live', phase: 'after', scriptId: 'merge-resolve', name: 'resolver' },
      }),
      recordOf(context, 'shell-lost', { life: 'lost' }),
      recordOf(context, 'shell-installing', {
        life: 'live',
        scriptOf: { sessionId: 'claude-waiting', phase: 'before', scriptId: 'setup', name: 'setup' },
        binding: { hostInstanceId: 'fake-host-1', generation: 1 },
      }),
      recordOf(context, 'claude-waiting', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-2' },
        life: 'ended',
        pendingSetup: { setupSessionId: 'shell-installing' },
        worktree: {
          worktreePath: join(context.root, 'repo', '.worktrees', 'waiting'),
          branch: 'jamat/waiting',
          baseCommit: 'abc1234',
          repositoryRoot: join(context.root, 'repo'),
        },
      }),
    ])
    // Without a runtime behind it the reconciler relabels that record `lost`, and the compact this
    // row is here to show would go with it.
    context.runtimes.set('claude-live', runtime('claude-live'))
    // A runtime for the installer too, or the reconciler relabels it mid-assertion and its
    // admits depend on which pass won.
    context.runtimes.set('shell-installing', runtime('shell-installing'))
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    /*
     * The last four of each list are the sessions tree's row actions, here since 2026-08-24. They
     * were decided by the row until then, out of four fields of `SessionInfo`, and had drifted
     * twice - a Rerun every fork refused, and a Discard worktree offered while a resolver was still
     * standing in that directory.
     */
    // Restart is the stop-and-reopen operation, so it applies while the session is live. A lost
    // screen still gets Reconnect because the terminal panel branches on `life` before `admits`.
    expect(sessionOf(client, 'claude-live')?.admits)
      .toEqual(['newBeside', 'fork', 'compact', 'restart', 'finalize'])
    // Codex reports its id afterwards or not at all, and resuming "the most recent session on this
    // machine" would land on an unrelated one, so neither fork nor restart is offered.
    expect(sessionOf(client, 'codex-nameless')?.admits).toEqual(['newBeside', 'remove'])
    // A fork names its own conversation now, so it forks and restarts like anything else.
    expect(sessionOf(client, 'claude-forked')?.admits)
      .toEqual(['newBeside', 'fork', 'restart', 'remove'])
    // A fork taken before forks were given ids stays refused: nothing can name its conversation
    // after the fact, so the way on is to remove the row and fork the parent again.
    expect(sessionOf(client, 'claude-forked-legacy')?.admits).toEqual(['newBeside', 'remove'])
    // A resolver carries an id like any other fork, and is still not forkable: the worktree it
    // stands in goes when the merge it is settling is done.
    expect(sessionOf(client, 'claude-resolver')?.admits).toEqual(['newBeside', 'remove'])
    expect(sessionOf(client, 'shell-lost')?.admits).toEqual(['restart', 'remove'])
    // Both halves of an install are held by that flow: the installer, and the session waiting on it.
    // The installer is LIVE, so the only thing to do with it is the finish that stops it: the
    // setup flow holds the record, which is what keeps `restart` off it.
    expect(sessionOf(client, 'shell-installing')?.admits).toEqual(['finalize'])
    // And the session waiting on a failed install: no finish, because there is nothing to bring
    // home from a worktree the install never finished, and the retry that is the way out of it.
    expect(sessionOf(client, 'claude-waiting')?.admits)
      .toEqual(['newBeside', 'fork', 'remove', 'retrySetup'])
    expect(client.errors).toEqual([])
  }, 20_000)

  // The record is `ended` with no runtime, yet nothing ran: the surfaces say it waits rather than failed.
  it('composes a setup waiting for command approval as a wait without a verdict', async () => {
    const context = await world()
    seedRecords(context, [recordOf(context, 'approval', {
      kind: 'agent',
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-approval' },
      life: 'ended',
      endedReason: 'Setup waits for command approval',
      pendingSetup: { setupSessionId: 'setup-approval', agreement: { hash: 'hash-1', commands: ['pnpm install'] } },
      worktree: {
        worktreePath: join(context.root, 'repo', '.worktrees', 'approval'),
        branch: 'jamat/approval',
        baseCommit: 'abc1234',
        repositoryRoot: join(context.root, 'repo'),
      },
    })])
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    const info = sessionOf(client, 'approval')
    expect(info?.awaitsSetupApproval).toBe(true)
    expect(info?.outcome).toBeUndefined()
    expect(client.errors).toEqual([])
  }, 20_000)

  /*
   * The one row action that needs a SECOND record, and the defect that sent the other four here:
   * `WorktreeMergeFlow.refuse` also refuses a discard while the RESOLVER is live - an agent standing
   * in that same directory, whose life the primary record says nothing about. A conflicted merge is
   * `ended` by then. The row drew "Discard worktree…", the two clicks it takes were answered
   * `live-refused`, and a button whose only answer is a refusal is worse than no button.
   */
  it('admits no discard while a resolver is still standing in that worktree', async () => {
    const context = await world()
    const worktree = {
      worktreePath: join(context.root, '.worktrees', '015'),
      branch: 'jamat/015',
      baseCommit: 'abc123',
      repositoryRoot: context.root,
    }
    seedRecords(context, [
      recordOf(context, 'merging', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
        life: 'ended',
        worktree,
        worktreeMerge: {
          phase: 'resolving',
          resolveSessionId: 'resolver',
          startedAt: 1,
        },
      }),
      recordOf(context, 'resolver', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'fork', oneShot: true },
        scriptOf: { sessionId: 'merging', phase: 'after', scriptId: 'merge-resolve', name: 'resolver' },
        life: 'live',
        binding: { hostInstanceId: 'fake-host-1', generation: 1 },
      }),
      recordOf(context, 'settled', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-2' },
        life: 'ended',
        worktree,
      }),
      recordOf(context, 'installed-for', { life: 'ended', worktree }),
      recordOf(context, 'install', {
        scriptOf: { sessionId: 'installed-for', phase: 'before', scriptId: 'setup', name: 'setup' },
        commands: [{ command: 'pnpm install', cwd: worktree.worktreePath }],
        life: 'live',
        binding: { hostInstanceId: 'fake-host-1', generation: 1 },
      }),
    ])
    // The resolver needs a RUNTIME, or the reconciler relabels it and the guard has nothing
    // live to refuse for.
    context.runtimes.set('resolver', runtime('resolver'))
    context.runtimes.set('install', runtime('install'))
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    expect(sessionOf(client, 'merging')?.admits).not.toContain('discardWorktree')
    // And the same record with nobody resolving it does admit one, so this is the resolver's doing
    // rather than the worktree's.
    expect(sessionOf(client, 'settled')?.admits).toContain('discardWorktree')
    // Any run of the session, not only the resolver: an install still running stands in it too.
    expect(sessionOf(client, 'installed-for')?.admits).not.toContain('discardWorktree')
    // The wire keeps the old name for the link the record now carries as `scriptOf`.
    expect(sessionOf(client, 'resolver')?.resolveFor).toBe('merging')
    expect(sessionOf(client, 'resolver')?.setupFor).toBeUndefined()
    expect(client.errors).toEqual([])
  }, 20_000)

  // An install waiting out a refused launch names nothing on the Host, and its gate still waits on it:
  // `dismiss` refuses it, so the row must not offer Remove.
  it('admits no remove on a run its gate still waits for', async () => {
    const context = await world()
    seedRecords(context, [
      recordOf(context, 'waiting', {
        life: 'starting',
        pendingSetup: { setupSessionId: 'install' },
        pendingOperationId: 'operation-waiting',
        pendingOperationKind: 'create',
      }),
      recordOf(context, 'install', {
        life: 'starting',
        commands: [{ command: 'pnpm install', cwd: context.root }],
        scriptOf: { sessionId: 'waiting', phase: 'before', scriptId: 'setup', name: 'setup' },
        pendingOperationId: 'operation-install',
        pendingOperationKind: 'create',
        launchWait: { attempts: 6, lastAttemptAt: Date.now(), reason: 'the Host refused the launch' },
      }),
    ])
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    const install = sessionOf(client, 'install')
    expect(install?.life).toBe('starting')
    expect(install?.admits).not.toContain('remove')
    expect(await client.manager.removeSession('install')).toMatchObject({ ok: false, code: 'live-refused' })
    expect(client.errors).toEqual([])
  }, 20_000)

  /*
   * A tombstone names a directory that is gone, so nothing may start its conversation again: the
   * project directory would be the only place left, and the work was never there.
   */
  it('offers no restart or fork for a tombstone, shows where its work went, and refuses the restart', async () => {
    const context = await world()
    const revision = 'https://svn.example.test/repos/app:r42'
    seedRecords(context, [
      recordOf(context, 'retired', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
        directory: { mode: 'project', categoryId: 'c1', projectPath: context.root },
        completed: true,
        retiredWorktree: {
          worktreePath: join(context.root, '.worktrees', '014-fix'),
          kind: 'svn',
          revisions: [revision],
          removedAt: 2_000,
        },
      }),
      recordOf(context, 'interrupted', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-2' },
        directory: { mode: 'project', categoryId: 'c1', projectPath: context.root },
        worktree: {
          worktreePath: join(context.root, '.worktrees', '015-next'),
          branch: 'https://svn.example.test/repos/app/trunk',
          baseCommit: 'r41',
          repositoryRoot: context.root,
          kind: 'svn',
        },
        worktreeFinish: { phase: 'reviewing', startedAt: 1_500 },
      }),
    ])
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    const retired = sessionOf(client, 'retired')
    expect(retired?.admits).not.toContain('restart')
    expect(retired?.admits).not.toContain('fork')
    expect(retired?.admits).toContain('remove')
    expect(retired?.retiredWorktree).toEqual({
      worktreePath: join(context.root, '.worktrees', '014-fix'),
      revisions: [revision],
    })
    const refused = await client.manager.restartSession('retired')
    expect(refused).toMatchObject({ ok: false, code: 'worktree-removed' })
    expect(refused.ok ? '' : refused.detail).toContain(revision)

    // The finish that was running when the last client went is gone with it, so the record holds
    // an outcome rather than a phase, and the session is no longer held by a finish.
    expect(sessionOf(client, 'interrupted')?.worktree?.kind).toBe('svn')
    expect(sessionOf(client, 'interrupted')?.admits).toContain('remove')
    expect(storedRecord(context, 'interrupted')?.worktreeFinish).toBeUndefined()
    expect(storedRecord(context, 'interrupted')?.worktreeOutcome?.result).toBe('interrupted')
  }, 20_000)

  /*
   * A committed Finish leaves a landed row until its main copy holds what it committed. The main copy
   * here is no working copy, so svn answers nothing: the row stays, "behind" is unknown, and an
   * UPDATE that starts waits for the person. Which live sessions an UPDATE would change files under
   * is the part this test is about.
   */
  it('keeps a landed row with UPDATE and Remove, names the live sessions of its main copy and starts an UPDATE without confirming them (Finish 072)', async () => {
    const context = await world()
    const owner = join(context.root, 'owner')
    mkdirSync(join(owner, 'src'), { recursive: true })
    mkdirSync(join(context.root, 'elsewhere'), { recursive: true })
    const landed = { repository: 'https://svn.example.test/repos/app', revision: 52, label: 'receipt' as const }
    seedRecords(context, [recordOf(context, 'landed', {
      kind: 'agent',
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
      directory: { mode: 'adHoc', path: owner },
      retiredWorktree: {
        worktreePath: join(owner, '.worktrees', '014-fix'), kind: 'svn', revisions: ['https://svn.example.test/repos/app:r52'],
        removedAt: 2_000, ownerDir: owner, landed: [landed],
      },
    })])
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    const row = sessionOf(client, 'landed')
    let releaseWrite: () => void = () => {}
    const heldWrite = new Promise<void>((done) => { releaseWrite = done })
    let ownerHeld = false
    const mainLease = client.manager.svnCommands.lease.within(owner, 'update', async () => { ownerHeld = true; await heldWrite })
    await vi.waitFor(() => expect(ownerHeld).toBe(true), { timeout: 8000 })
    const externalWrite = vi.fn(async () => {})
    const pendingWrite = client.manager.withinSvnWrite(join(owner, 'src'), [], externalWrite)
    await Promise.resolve()
    expect(externalWrite).not.toHaveBeenCalled()
    releaseWrite()
    await mainLease
    await pendingWrite
    expect(externalWrite).toHaveBeenCalledTimes(1)
    expect(row?.retiredWorktree?.landing).toEqual({ mainCopy: owner, behind: null, newest: ['https://svn.example.test/repos/app:r52'] })
    expect(row?.completed).toBeUndefined()
    expect(row?.admits).toEqual(expect.arrayContaining(['updateMain', 'remove']))
    for (const operation of ['finalize', 'restart', 'fork'] as const) expect(row?.admits).not.toContain(operation)

    const first = valueOf(await client.manager.createSession({ kind: 'shell', directory: { mode: 'adHoc', path: owner }, title: 'one' }))
    const second = valueOf(await client.manager.createSession({ kind: 'shell', directory: { mode: 'adHoc', path: join(owner, 'src') }, title: 'two' }))
    valueOf(await client.manager.createSession({ kind: 'shell', directory: { mode: 'adHoc', path: join(context.root, 'elsewhere') }, title: 'away' }))
    const live = [
      { sessionId: first.sessionId, title: 'one', number: null },
      { sessionId: second.sessionId, title: 'two', number: null },
    ]
    const wait = valueOf(await client.manager.updateMain('landed', undefined, 'window'))
    expect(storedRecord(context, 'landed')?.svnAction).toMatchObject({ actionId: wait.actionId, stage: 'main-update' })
    const waitingStep = sessionOf(client, 'landed')?.actions?.sections.at(-1)?.rounds.at(-1)?.steps.at(-1)
    expect(waitingStep).toMatchObject({ title: 'Update main copy', state: 'waits', body: { kind: 'sessions', sessions: live } })
    const third = valueOf(await client.manager.createSession({ kind: 'shell', directory: { mode: 'adHoc', path: owner }, title: 'three' }))
    expect(sessionOf(client, 'landed')?.actions?.sections.at(-1)?.actions[0].confirmLive).toEqual([first.sessionId, second.sessionId, third.sessionId])
    expect(storedRecord(context, 'landed')?.svnAction?.stage).toBe('main-update')

    // A press starts it with three sessions live; an older caller's list that names only one is not compared.
    // svn cannot read this main copy, so it waits for the person.
    expect(await client.manager.updateMain('landed', [first.sessionId], 'cli'))
      .toMatchObject({ ok: true, value: { sessionId: 'landed' } })
    await vi.waitFor(() => expect(storedRecord(context, 'landed')?.svnAction).toMatchObject({ actionId: wait.actionId, kind: 'update-main', root: owner, needs: { kind: 'svn-failed' } }), { timeout: 10_000 })
    expect(sessionOf(client, 'landed')?.svnAction).toMatchObject({ kind: 'update-main', needsKind: 'svn-failed' })

    // A live session in the main copy has no landed row; svn decides whether its directory is a main copy.
    expect(await client.manager.updateMain(first.sessionId, [], 'cli')).toMatchObject({ ok: false, code: 'invalid-spec' })

    for (const id of [first.sessionId, second.sessionId, third.sessionId]) context.runtimes.delete(id)
    await client.manager.stopSession(first.sessionId)
    expect(sessionOf(client, 'landed')?.actions?.sections.at(-1)?.actions[0].confirmLive).toEqual([])
    expect(await client.manager.updateMain('landed', [first.sessionId, second.sessionId, third.sessionId], 'window'))
      .toMatchObject({ ok: true, value: { sessionId: 'landed' } })
    await vi.waitFor(() => expect(storedRecord(context, 'landed')?.svnAction?.needs?.kind).toBe('svn-failed'), { timeout: 10_000 })

    // Remove takes the landed row away at once.
    expect(await client.manager.removeSession('landed')).toEqual({ ok: true, value: undefined })
    expect(sessionOf(client, 'landed')).toBeUndefined()
  }, 20_000)

  it('names no session live in the main copy of an UPDATE while the Host is stopped, and says that is unknown (UA1-J08-6)', async () => {
    const context = await world()
    const owner = join(context.root, 'owner')
    mkdirSync(owner, { recursive: true })
    seedRecords(context, [recordOf(context, 'landed', {
      kind: 'agent',
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
      directory: { mode: 'adHoc', path: owner },
      retiredWorktree: {
        worktreePath: join(owner, '.worktrees', '014-fix'), kind: 'svn', revisions: ['https://svn.example.test/repos/app:r52'],
        removedAt: 2_000, ownerDir: owner, landed: [{ repository: 'https://svn.example.test/repos/app', revision: 52, label: 'receipt' }],
      },
    })])
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)
    const shell = valueOf(await client.manager.createSession({ kind: 'shell', directory: { mode: 'adHoc', path: owner }, title: 'shell' }))
    valueOf(await client.manager.updateMain('landed', undefined, 'window'))
    const update = () => sessionOf(client, 'landed')?.actions?.sections.at(-1)
    expect(update()?.rounds.at(-1)?.steps.at(-1)?.body).toEqual({ kind: 'sessions', sessions: [{ sessionId: shell.sessionId, title: 'shell', number: null }] })

    const file = HostDescriptorPaths.descriptorFile(context.configIdentity, 'development')
    context.host.handle('host.stop', () => {
      context.host.publish({ kind: 'host-stopping' })
      rmSync(file)
      return { body: { stopping: true, live: context.runtimes.size } }
    })
    expect(await client.manager.stopHost('fake-host-1')).toEqual({ ok: true, value: { warnings: [] } })
    await vi.waitFor(() => expect(client.manager.snapshot().host.presence).toBe('unreachable'))
    expect(storedRecord(context, shell.sessionId)?.life).toBe('live')
    expect(update()?.rounds.at(-1)?.steps.at(-1)?.body).toEqual({ kind: 'sessions', sessions: [], liveUnknown: true })
    expect(update()?.actions[0]).toMatchObject({ id: 'update-main', confirmLive: [] })
    expect(await client.manager.updateMain('landed', [shell.sessionId], 'cli')).toMatchObject({ ok: true, value: { sessionId: 'landed' } })
  }, 20_000)

  /*
   * A reviewed commit from a working-copy root that holds several projects is one coordinated commit:
   * it waits for and holds the lease of each project its paths lie in, and the root's own lease for a
   * file that lies in none. Without paths such a root still owns nothing. Real svn; skipped where
   * svnadmin is missing.
   */
  it('leases every project of a coordinated commit from a working-copy root that holds them', { timeout: 30_000 }, async (runner) => {
    const context = await world()
    const repository = join(context.root, 'repository')
    const created = await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repository], cwd: context.root, env: process.env })
    if (created.failure !== null || created.code !== 0) return runner.skip()
    const checkout = await new SvnInvoker().run(context.root, ['checkout', '--non-interactive', pathToFileURL(repository).href, context.categoryRoot])
    expect(checkout.code, checkout.stderr).toBe(0)
    const zone = context.categoryRoot
    const product = join(zone, 'Portfolio')
    const member = join(zone, 'Tools', 'Member')
    mkdirSync(product, { recursive: true })
    mkdirSync(member, { recursive: true })
    writeFileSync(join(product, '.appgroup'), '{"kind":"product"}')
    writeFileSync(join(zone, 'Tools', '.appgroup'), '{"kind":"collection"}')
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    await expect(client.manager.withinSvnWrite(zone, [], async () => {})).rejects.toThrow(/holds other projects/)
    let releaseUpdate: () => void = () => {}
    const heldUpdate = new Promise<void>((done) => { releaseUpdate = done })
    let productHeld = false
    const update = client.manager.svnCommands.lease.within(product, 'update', async () => { productHeld = true; await heldUpdate })
    await vi.waitFor(() => expect(productHeld).toBe(true), { timeout: 8000 })
    const leases: boolean[] = []
    const commit = client.manager.withinSvnWrite(zone, [join(product, 'Web', 'app.ts'), join(member, 'src', 'a.ts'), join(zone, 'CLAUDE.md')],
      async () => { for (const root of [product, member, zone]) leases.push(existsSync(WorktreeLease.fileOf(root))) })
    await Promise.resolve()
    expect(leases).toEqual([])
    releaseUpdate()
    await update
    await commit
    expect(leases).toEqual([true, true, true])
  })

  /*
   * The person updates the main copy with another client. The poll reads "behind" from the server
   * and whether the main copy holds the landed revision locally; once it does, the row goes the way
   * a Remove takes it. Real svn on a disposable repository; skipped where svnadmin is missing.
   */
  it('removes a landed row on its own once its main copy holds the landed revision, whoever updated it', { timeout: 60_000 }, async (runner) => {
    const context = await world()
    const repository = join(context.root, 'repository')
    const created = await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repository], cwd: context.root, env: process.env })
    if (created.failure !== null || created.code !== 0) return runner.skip()
    const svn = new SvnInvoker()
    const run = async (cwd: string, args: string[]): Promise<string> => {
      const outcome = await svn.run(cwd, [args[0], '--non-interactive', ...args.slice(1)])
      expect(outcome.code, outcome.stderr).toBe(0)
      return outcome.stdout
    }
    const owner = join(context.root, 'owner')
    const other = join(context.root, 'other')
    const url = pathToFileURL(repository).href
    await run(context.root, ['checkout', url, owner])
    await run(context.root, ['checkout', url, other])
    writeFileSync(join(other, 'a.txt'), 'landed\n')
    await run(other, ['add', '--', 'a.txt'])
    await run(other, ['commit', '--username', 'fixture', '-m', 'landed', '--', '.'])
    const root = (await run(owner, ['info', '--show-item', 'repos-root-url', '--', '.'])).trim()
    const landedRecord = recordOf(context, 'landed', {
      directory: { mode: 'adHoc', path: owner },
      retiredWorktree: {
        worktreePath: join(owner, '.worktrees', '014-fix'), kind: 'svn', revisions: [`${root}:r1`], removedAt: 2_000,
        ownerDir: owner, landed: [{ repository: root, revision: 1, label: 'receipt' }],
      },
    })
    const waiting = (sessionId: string, evidence: typeof landedRecord.retiredWorktree): SessionRecord => ({ ...landedRecord, sessionId,
      retiredWorktree: evidence,
      svnAction: { kind: 'finish', flowVersion: 1, actionId: sessionId, stage: 'main-update', root: join(owner, '.worktrees', sessionId),
        checks: [], checkCursor: 0, rootCursor: 0, rounds: { incoming: 0, outOfDate: 0, lock: 0 }, evidence: [], requestedBy: 'window', startedAt: 1 },
    })
    seedRecords(context, [landedRecord, waiting('waiting-landed', landedRecord.retiredWorktree),
      waiting('waiting-clean', { ...landedRecord.retiredWorktree!, landed: [] })])
    context.publishDescriptor()
    const removedItself: string[] = []
    const client = clientOf(context, { onRemovedItself: (sessionId) => removedItself.push(sessionId) })
    await client.manager.start()
    await writable(client)

    await vi.waitFor(() => expect(sessionOf(client, 'landed')?.retiredWorktree?.landing?.behind).toBe(1), { timeout: 15_000 })
    expect(removedItself).toEqual([])
    await run(owner, ['update'])
    await vi.waitFor(() => expect(sessionOf(client, 'landed')).toBeUndefined(), { timeout: 30_000, interval: 250 })
    expect(removedItself).toEqual(['landed'])
    expect(storedRecord(context, 'landed')).toBeUndefined()
    for (const sessionId of ['waiting-landed', 'waiting-clean']) {
      expect(storedRecord(context, sessionId)?.svnAction?.stage).toBe('main-update')
      expect(sessionOf(client, sessionId)?.actions?.sections.at(-1)?.actions[0]).toMatchObject({ id: 'update-main', confirmLive: [] })
    }
    expect(await client.manager.removeSession('waiting-clean')).toMatchObject({ ok: true })
    expect(sessionOf(client, 'waiting-clean')).toBeUndefined()
  })

  /*
   * The record is the only thing that names a worktree, so a Remove takes a clean one with the
   * session, keeps a changed one with its session, and takes a session whose worktree is already
   * gone. Real svn on a disposable repository; skipped where svnadmin is missing.
   */
  it('removes an ended session with its clean SVN worktree, and refuses one whose worktree holds changes', { timeout: 60_000 }, async (runner) => {
    const context = await world()
    const repository = join(context.root, 'repository')
    const created = await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repository], cwd: context.root, env: process.env })
    if (created.failure !== null || created.code !== 0) return runner.skip()
    const svn = new SvnInvoker()
    const run = async (cwd: string, args: string[]): Promise<string> => {
      const outcome = await svn.run(cwd, [args[0], '--non-interactive', ...args.slice(1)])
      expect(outcome.code, outcome.stderr).toBe(0)
      return outcome.stdout
    }
    const owner = join(context.root, 'owner')
    const url = pathToFileURL(repository).href
    await run(context.root, ['checkout', url, owner])
    await run(owner, ['propset', 'svn:global-ignores', '.worktrees', '--', '.'])
    writeFileSync(join(owner, 'a.txt'), 'base\n')
    await run(owner, ['add', '--', 'a.txt'])
    await run(owner, ['commit', '--username', 'fixture', '-m', 'base', '--', '.'])
    const clean = join(owner, '.worktrees', '014-clean')
    const dirty = join(owner, '.worktrees', '015-dirty')
    await run(context.root, ['checkout', url, clean])
    await run(context.root, ['checkout', url, dirty])
    writeFileSync(join(dirty, 'a.txt'), 'changed\n')
    const worktreeOf = (worktreePath: string): SessionRecord['worktree'] => ({
      worktreePath, branch: url, baseCommit: 'r1', repositoryRoot: owner, kind: 'svn',
    })
    seedRecords(context, [
      recordOf(context, 'clean', { directory: { mode: 'adHoc', path: owner }, worktree: worktreeOf(clean) }),
      recordOf(context, 'dirty', { directory: { mode: 'adHoc', path: owner }, worktree: worktreeOf(dirty) }),
      recordOf(context, 'absent', { directory: { mode: 'adHoc', path: owner }, worktree: worktreeOf(join(owner, '.worktrees', '016-absent')) }),
    ])
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    expect(await client.manager.removeSession('clean')).toEqual({ ok: true, value: undefined })
    expect(storedRecord(context, 'clean')).toBeUndefined()
    expect(existsSync(clean)).toBe(false)

    expect(await client.manager.removeSession('dirty')).toMatchObject({
      ok: false,
      code: 'dirty',
      detail: expect.stringMatching(/keeps its worktree .*015-dirty \(1 change\); Finish it/),
    })
    expect(storedRecord(context, 'dirty')?.worktreeCleanup).toMatchObject({ phase: 'kept', reason: '1 change' })
    expect(readFileSync(join(dirty, 'a.txt'), 'utf8')).toBe('changed\n')

    expect(await client.manager.removeSession('absent')).toEqual({ ok: true, value: undefined })
    expect(storedRecord(context, 'absent')).toBeUndefined()
    // Nothing was left behind, so no Remove reports a leftover worktree.
    expect(client.errors.join('\n')).not.toContain('for you to keep or remove')
  })

  /*
   * A stopped session's cleanup is due at once, so the reconcile pass after the Remove's own request
   * starts it before the Remove applies it. The Remove waits for that cleanup instead of answering
   * that a finish is starting (UA1-J11-8). Real svn on a disposable repository.
   */
  it('removes a stopped session with its clean SVN worktree through the cleanup its own request started', { timeout: 60_000 }, async (runner) => {
    const context = await world()
    const repository = join(context.root, 'repository')
    const created = await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repository], cwd: context.root, env: process.env })
    if (created.failure !== null || created.code !== 0) return runner.skip()
    const svn = new SvnInvoker()
    const run = async (cwd: string, args: string[]): Promise<string> => {
      const outcome = await svn.run(cwd, [args[0], '--non-interactive', ...args.slice(1)])
      expect(outcome.code, outcome.stderr).toBe(0)
      return outcome.stdout
    }
    const owner = join(context.root, 'owner')
    const url = pathToFileURL(repository).href
    await run(context.root, ['checkout', url, owner])
    await run(owner, ['propset', 'svn:global-ignores', '.worktrees', '--', '.'])
    const clean = join(owner, '.worktrees', '014-clean')
    await run(context.root, ['checkout', url, clean])
    seedRecords(context, [recordOf(context, 'clean', { directory: { mode: 'adHoc', path: owner }, endedAt: 1_000, exitReason: 'stopped',
      worktree: { worktreePath: clean, branch: url, baseCommit: 'r0', repositoryRoot: owner, kind: 'svn' } })])
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    expect(await client.manager.removeSession('clean')).toEqual({ ok: true, value: undefined })
    expect(storedRecord(context, 'clean')).toBeUndefined()
    expect(existsSync(clean)).toBe(false)
    expect(client.errors.join('\n')).not.toContain('merge-pending')
  })

  /*
   * Any directory of a product group: the worktree is the whole group, its checkout is a local run of
   * the session, and the session starts at its place below. A session working in the main copy of the
   * same member updates the whole group. Real svn for the reservation; the Host is the fake.
   */
  it('creates the worktree of a group member directory as the group, with a local checkout run, and updates the group from a member', { timeout: 60_000 }, async (runner) => {
    const context = await world()
    const repository = join(context.root, 'repository')
    const created = await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repository], cwd: context.root, env: process.env })
    if (created.failure !== null || created.code !== 0) return runner.skip()
    const svn = new SvnInvoker()
    const run = async (cwd: string, args: string[]): Promise<string> => {
      const outcome = await svn.run(cwd, [args[0], '--non-interactive', ...args.slice(1)])
      expect(outcome.code, outcome.stderr).toBe(0)
      return outcome.stdout
    }
    const url = pathToFileURL(repository).href
    await run(context.root, ['mkdir', '--parents', '--username', 'fixture', '-m', 'layout', '--', `${url}/Group/Member/src`])
    const group = join(context.root, 'Group')
    await run(context.root, ['checkout', '-q', '--', `${url}/Group`, group])
    await run(group, ['propset', 'svn:global-ignores', '.worktrees', '--', '.'])
    writeFileSync(join(group, '.appgroup'), '{"kind":"product"}')
    const directory = join(group, 'Member', 'src')
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    const session = valueOf(await client.manager.createSession({ kind: 'shell', directory: { mode: 'adHoc', path: directory }, worktree: { slug: 'fix' } }))
    const stored = storedRecord(context, session.sessionId)
    const worktreePath = join(group, '.worktrees', 'fix')
    expect(stored?.worktree).toMatchObject({ worktreePath, branch: `${url}/Group`, baseCommit: 'r1', repositoryRoot: group, kind: 'svn', cwdSubpath: 'Member/src' })
    await vi.waitFor(() => expect(storedRecord(context, session.sessionId)?.worktreeLifecycle?.journal).toContainEqual(expect.objectContaining({
      kind: 'checkout', targetRevision: 1, outcome: 'ok', args: ['--non-interactive', 'checkout', '--', `${url}/Group@1`, '.'],
    })), { timeout: 15_000 })
    expect(existsSync(join(worktreePath, '.svn'))).toBe(true)
    expect(client.manager.snapshot().sessions.find((info) => info.script?.parentId === session.sessionId)).toBeUndefined()
    expect(storedRecord(context, session.sessionId)?.scriptRuns).toContainEqual(expect.objectContaining({
      title: 'Checkout', phase: 'before', scriptId: 'svn', outcome: 'succeeded', log: expect.objectContaining({ state: 'saved' }),
    }))
    expect(sessionOf(client, session.sessionId)?.worktree).toMatchObject({ worktreePath, cwdSubpath: 'Member/src' })
    await vi.waitFor(() => expect(storedRecord(context, session.sessionId)?.pendingSetup).toBeUndefined(), { timeout: 15_000 })
    await vi.waitFor(() => expect(context.host.calls.find((call) => call.name === 'runtime.create' && call.body.runtimeSessionId === session.sessionId)?.body.launch)
      .toMatchObject({ cwd: join(worktreePath, 'Member', 'src') }), { timeout: 15_000 })

    const plain = valueOf(await client.manager.createSession({ kind: 'shell', directory: { mode: 'adHoc', path: directory }, title: 'plain' }))
    expect(await client.manager.updateMain(plain.sessionId, [], 'cli')).toMatchObject({ ok: true })
    expect(storedRecord(context, plain.sessionId)?.svnAction).toMatchObject({ kind: 'update-main', root: group })
  })

  it('notes a commit as a receipt and answers the receipts of a session without a worktree', async () => {
    const context = await world()
    seedRecords(context, [recordOf(context, 'plain', {
      commitReceipts: [{ scopeRoot: context.root, revision: 7, paths: ['a.txt'], at: 5 }],
    })])
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    client.manager.noteCommitted({ sessionId: 'plain', scopes: [{ scopeRoot: context.root, revision: null }], paths: [] })

    await vi.waitFor(async () => expect(await client.manager.worktreeOf('plain')).toEqual({
      ok: true,
      value: {
        sessionId: 'plain', worktree: null, retired: null, finish: null, action: null, outcome: null, cleanup: null,
        receipts: [{ scopeRoot: context.root, revision: 7, at: 5 }, { scopeRoot: context.root, revision: null, at: expect.any(Number) }],
        step: null,
        workflow: null,
        actions: { sections: [] },
      },
    }), { timeout: 5_000 })
  })

  it('composes the step of an action only while it has one, in the snapshot and in the worktree answer', async () => {
    const context = await world()
    const worktreePath = join(context.root, 'owner', '.worktrees', '014-fix')
    const svnWorktree = {
      worktreePath, branch: 'https://svn.example.test/repos/app/trunk', baseCommit: 'r41', repositoryRoot: join(context.root, 'owner'), kind: 'svn' as const,
    }
    // An update a lock stopped, relaunched in an hour; its run record still starts, so nothing judges it meanwhile.
    const locked: NonNullable<SessionRecord['svnAction']> = {
      kind: 'finish', flowVersion: 1, actionId: 'action-1', stage: 'updating', runId: 'update-run', root: worktreePath, checks: [], checkCursor: 0,
      rootCursor: 0, rounds: { incoming: 0, outOfDate: 0, lock: 1 }, evidence: [], requestedBy: 'window', startedAt: 5,
      retryAt: Date.now() + 3_600_000,
    }
    seedRecords(context, [
      recordOf(context, 'acting', { life: 'ended', worktree: svnWorktree, svnAction: locked }),
      recordOf(context, 'update-run', { life: 'starting', binding: null, pendingOperationId: 'op-u', pendingOperationKind: 'create',
        process: { tool: 'svn', args: ['--non-interactive', 'update', '--accept', 'postpone', '--', '.'] },
        scriptOf: { sessionId: 'acting', phase: 'after', scriptId: 'svn', name: 'update' } }),
      recordOf(context, 'plain', { life: 'ended', worktree: { ...svnWorktree, worktreePath: join(context.root, 'owner', '.worktrees', '015-idle') } }),
    ])
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    const step = { text: 'Waiting for the svn lock', detail: 'relaunch 1 of 3', progress: null, startedAt: null }
    expect(sessionOf(client, 'acting')?.step).toEqual(step)
    expect(await client.manager.worktreeOf('acting')).toMatchObject({ ok: true, value: { step } })
    expect(sessionOf(client, 'plain')).not.toHaveProperty('step')
    expect(sessionOf(client, 'update-run')).not.toHaveProperty('step')
    expect(await client.manager.worktreeOf('plain')).toMatchObject({ ok: true, value: { step: null } })
    // The workflow travels beside the step, the same in the snapshot and in the worktree answer.
    const workflow = sessionOf(client, 'acting')?.workflow
    expect(workflow).toMatchObject({ workflowId: 'action-1', badge: 'waits for the lock', summary: 'Waiting for the svn lock', open: true })
    expect(workflow?.rounds[0]?.steps[0]).toMatchObject({ title: 'svn update', state: 'running', target: { kind: 'run', runId: 'update-run' } })
    expect(await client.manager.worktreeOf('acting')).toMatchObject({ ok: true, value: { workflow } })
    expect(sessionOf(client, 'plain')).not.toHaveProperty('workflow')
    expect(await client.manager.worktreeOf('plain')).toMatchObject({ ok: true, value: { workflow: null } })
  })

  it('answers the full conflict list of a waiting action, also to a run of it, and not-found without a set', async () => {
    const context = await world()
    const worktreePath = join(context.root, 'owner', '.worktrees', '014-fix')
    const svnWorktree = {
      worktreePath, branch: 'https://svn.example.test/repos/app/trunk', baseCommit: 'r41', repositoryRoot: join(context.root, 'owner'), kind: 'svn' as const,
    }
    const entries = Array.from({ length: 60 }, (_, index): NonNullable<NonNullable<SessionRecord['svnAction']>['conflictSet']>['entries'][number] => ({
      path: `src/f${index}.ts`, kind: 'text', shape: 'text-overlap', state: 'person', options: ['merged', 'take-incoming', 'keep-mine'],
      facts: { incomingRevision: 42 },
    }))
    const waiting: NonNullable<SessionRecord['svnAction']> = {
      kind: 'finish', flowVersion: 1, actionId: 'action-1', stage: 'updating', runId: 'update-run', root: worktreePath, checks: [], checkCursor: 0,
      rootCursor: 0, rounds: { incoming: 0, outOfDate: 0, lock: 0 }, evidence: [], requestedBy: 'window', startedAt: 5,
      needs: { kind: 'conflict', reason: '60 conflicts need you', at: 6 },
      conflictSet: { readAt: 6, baseRevision: 41, revision: 42, entries, more: 0 },
    }
    seedRecords(context, [
      recordOf(context, 'waiting', { life: 'ended', worktree: svnWorktree, svnAction: waiting }),
      recordOf(context, 'update-run', { life: 'ended', binding: null, exitCode: 0, endedAt: 6,
        process: { tool: 'svn', args: ['--non-interactive', 'update', '--accept', 'postpone', '--', '.'] },
        scriptOf: { sessionId: 'waiting', phase: 'after', scriptId: 'svn', name: 'update' } }),
      recordOf(context, 'plain', { life: 'ended', worktree: { ...svnWorktree, worktreePath: join(context.root, 'owner', '.worktrees', '015-idle') } }),
    ])
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    const list = await client.manager.conflictsOf('waiting')
    expect(list).toMatchObject({ ok: true, value: { sessionId: 'waiting', actionId: 'action-1', stage: 'updating', summary: '60 conflicts need you', more: 0 } })
    expect(list.ok && list.value.entries).toHaveLength(60)
    expect(list.ok && list.value.entries[59]).toMatchObject({ path: 'src/f59.ts', description: 'Your session and r42 changed the same lines of this file.' })
    expect(await client.manager.conflictsOf('update-run')).toEqual(list)
    expect(await client.manager.conflictsOf('plain')).toMatchObject({ ok: false, code: 'not-found' })
    expect(await client.manager.conflictsOf('nobody')).toMatchObject({ ok: false, code: 'not-found' })
    // The snapshot carries every open entry, past the 50 it bounds settled ones at.
    expect(sessionOf(client, 'waiting')?.svnAction).toMatchObject({ summary: '60 conflicts need you', conflicts: { more: 0 } })
    expect(sessionOf(client, 'waiting')?.svnAction?.conflicts?.entries).toHaveLength(60)
  })

  /*
   * The finisher is chosen by the worktree's kind: an SVN one goes to the SVN twin, which needs the
   * person's Changes review for Commit and a proven absent tree for Discard. Every path here stays inside the
   * test's own directory, and the owner does not exist, so nothing reaches a real working copy.
   */
  it('finishes an SVN worktree through its own finisher and composes its choices', async () => {
    const context = await world()
    const worktreePath = join(context.root, 'owner', '.worktrees', '014-fix')
    seedRecords(context, [
      recordOf(context, 'svn', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
        directory: { mode: 'project', categoryId: 'c1', projectPath: context.root },
        life: 'ended',
        worktree: {
          worktreePath,
          agentStartedAt: 1,
          branch: 'https://svn.example.test/repos/app/trunk',
          baseCommit: 'r41',
          repositoryRoot: join(context.root, 'owner'),
          kind: 'svn',
        },
      }),
      recordOf(context, 'git', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-2' },
        life: 'ended',
        worktree: {
          worktreePath: join(context.root, 'repo', '.worktrees', 'task'),
          branch: 'jamat/task',
          baseCommit: 'abc1234',
          repositoryRoot: join(context.root, 'repo'),
        },
      }),
      recordOf(context, 'svn-kept', {
        kind: 'shell',
        life: 'ended',
        worktree: {
          worktreePath: join(context.root, 'owner', '.worktrees', '015-kept'),
          branch: 'https://svn.example.test/repos/app/trunk',
          baseCommit: 'r41',
          repositoryRoot: join(context.root, 'owner'),
          kind: 'svn',
        },
        worktreeCleanup: { phase: 'kept', trigger: 'committed', reason: '2 changes', requestedAt: 1, attempts: 1, lastAttemptAt: 2 },
      }),
      // Ended just now, so the cleanup's grace keeps the reconciler from judging it during the test.
      recordOf(context, 'svn-auto', {
        kind: 'shell',
        life: 'ended',
        exitReason: 'stopped',
        endedAt: Date.now(),
        worktree: {
          worktreePath: join(context.root, 'owner', '.worktrees', '017-auto'),
          branch: 'https://svn.example.test/repos/app/trunk',
          baseCommit: 'r41',
          repositoryRoot: join(context.root, 'owner'),
          kind: 'svn',
        },
        worktreeCleanup: { phase: 'pending', trigger: 'remove-when-ended', requestedAt: 1, attempts: 0 },
      }),
      recordOf(context, 'svn-unconfirmed', {
        kind: 'shell',
        life: 'ended',
        exitReason: 'host-lost',
        worktree: {
          worktreePath: join(context.root, 'owner', '.worktrees', '016-unconfirmed'),
          branch: 'https://svn.example.test/repos/app/trunk',
          baseCommit: 'r41',
          repositoryRoot: join(context.root, 'owner'),
          kind: 'svn',
        },
        worktreeCleanup: { phase: 'pending', trigger: 'remove-when-ended', reason: 'in use', requestedAt: 1, attempts: 1, lastAttemptAt: 2 },
      }),
    ])
    context.publishDescriptor()
    const removedItself: string[] = []
    const client = clientOf(context, { onRemovedItself: (sessionId) => removedItself.push(sessionId) })
    await client.manager.start()
    await writable(client)

    expect(sessionOf(client, 'svn')?.worktree?.choices).toEqual(['commit', 'keep', 'discard'])
    expect(sessionOf(client, 'git')?.worktree?.choices).toEqual(['merge', 'keep', 'discard'])
    // The cleanup after the end removes this worktree by itself and nothing is known to land, so no Commit.
    expect(sessionOf(client, 'svn-auto')?.worktree?.choices).toEqual(['keep', 'discard'])
    expect(sessionOf(client, 'svn-auto')?.worktree?.cleanup)
      .toEqual({ phase: 'pending', summary: 'removed once the session has ended and nothing is left in it' })
    expect(sessionOf(client, 'svn')?.worktreeView).toEqual({ version: 0, phase: 'active', outOfDate: 0, conflicts: 0, summary: 'active v0',
      title: 'Worktree active', tone: 'running', actions: [] })
    expect(await client.manager.worktreeOf('svn')).toEqual({
      ok: true,
      value: {
        sessionId: 'svn',
        worktreeView: { version: 0, phase: 'active', outOfDate: 0, conflicts: 0, summary: 'active v0', title: 'Worktree active', tone: 'running', actions: [] },
        worktree: { kind: 'svn', worktreePath, url: 'https://svn.example.test/repos/app/trunk', baseRevision: 41 },
        retired: null,
        finish: null,
        action: null,
        outcome: null,
        cleanup: null,
        receipts: [],
        step: null,
        workflow: null,
        actions: { sections: [] },
      },
    })
    expect(await client.manager.worktreeOf('git')).toMatchObject({
      ok: true,
      value: { worktree: { kind: 'git', url: null, baseRevision: null } },
    })
    expect(await client.manager.worktreeOf('nobody')).toMatchObject({ ok: false, code: 'not-found' })
    // The removal after the end says why the worktree stayed, to a script and to the row.
    expect(await client.manager.worktreeOf('svn-kept')).toMatchObject({
      ok: true, value: { cleanup: { phase: 'kept', reason: '2 changes' } },
    })
    expect(sessionOf(client, 'svn-kept')?.worktree?.cleanup)
      .toEqual({ phase: 'kept', reason: '2 changes', summary: 'kept: 2 changes' })
    expect(sessionOf(client, 'svn')?.worktree?.cleanup).toBeUndefined()
    // No verdict comes for an end the Host could not confirm, and the row says so instead of a stale reason.
    expect(sessionOf(client, 'svn-unconfirmed')?.worktree?.cleanup)
      .toEqual({ phase: 'pending', reason: 'in use', summary: 'waiting: the end of the session is not confirmed' })

    // A script that only means to stop a session never starts the Finish of one that already ended.
    expect(await client.manager.finalizeSession('svn', { expect: 'stop' })).toMatchObject({
      ok: false,
      code: 'live-refused',
      detail: expect.stringContaining('finish-worktree'),
    })
    expect(sessionOf(client, 'svn')?.worktree?.outcome).toBeUndefined()

    expect(await client.manager.finalizeSession('svn')).toMatchObject({ ok: false, code: 'svn-failed' })
    expect(await client.manager.finishWorktreeSession('svn', { choice: 'commit', requestedBy: 'window' })).toMatchObject({ ok: false, code: 'svn-failed' })
    expect(sessionOf(client, 'svn')?.worktreeView?.phase).toBe('active')
    expect(sessionOf(client, 'svn')?.worktree?.finish).toBeUndefined()
    expect(sessionOf(client, 'svn')?.admits).toContain('finalize')
    expect(removedItself).toEqual([])

    // A successful ending removes the session the way Remove does, before the answer comes back.
    expect(await client.manager.discardWorktree('svn')).toEqual({ ok: true, value: undefined })
    expect(sessionOf(client, 'svn')).toBeUndefined()
    expect(await client.manager.worktreeOf('svn')).toMatchObject({ ok: false, code: 'not-found' })
    expect(storedRecord(context, 'svn')).toBeUndefined()
    expect(removedItself).toEqual(['svn'])

    // A Remove that is refused keeps the session with its tombstone, and says why.
    const remove = vi.spyOn(client.manager, 'removeSession')
      .mockResolvedValueOnce({ ok: false, code: 'records-latched', detail: 'the disk is full' })
    expect(await client.manager.discardWorktree('svn-kept')).toEqual({ ok: true, value: undefined })
    remove.mockRestore()
    expect(sessionOf(client, 'svn-kept')?.retiredWorktree?.worktreePath).toBe(join(context.root, 'owner', '.worktrees', '015-kept'))
    expect(storedRecord(context, 'svn-kept')?.completed).toBe(true)
    expect(client.errors.join('\n')).toContain('Session svn-kept: its worktree ended as asked, and the session stays because it could not be removed: the disk is full')
    expect(removedItself).toEqual(['svn'])
  }, 20_000)

  /*
   * The press of the Finish dialog and the review a review run asks for. The review port is a fake
   * that counts what it opens; the owner does not exist, so no svn reaches a real working copy.
   */
  it('migrates an old Finish, refuses review runs and preserves worker message proposals', async () => {
    const context = await world()
    const worktreePath = join(context.root, 'owner', '.worktrees', '014-fix')
    const svnWorktree = {
      agentStartedAt: 1,
      worktreePath, branch: 'https://svn.example.test/repos/app/trunk', baseCommit: 'r41', repositoryRoot: join(context.root, 'owner'), kind: 'svn' as const,
    }
    const reviewing: NonNullable<SessionRecord['svnAction']> = {
      kind: 'finish', actionId: 'action-1', stage: 'reviewing', runId: 'review-run', root: worktreePath, checks: [], checkCursor: 0,
      roots: [{ path: worktreePath, own: '', changed: ['a.txt'] }], rootCursor: 0, rounds: { incoming: 0, outOfDate: 0, lock: 0 },
      evidence: [], requestedBy: 'window', startedAt: 5,
    }
    // A Finish a script pressed: its first review is a mount, and the worker proposed for the whole worktree.
    const scriptedPath = join(context.root, 'Mirabia', '.worktrees', 'i42-orders')
    const mountPath = join(scriptedPath, 'shared')
    const scripted: NonNullable<SessionRecord['svnAction']> = {
      ...reviewing, actionId: 'action-2', runId: 'review-run-cli', root: scriptedPath, requestedBy: 'cli',
      roots: [{ path: mountPath, own: 'shared', changed: ['b.txt'] }, { path: scriptedPath, own: '', changed: ['a.txt'] }],
    }
    seedRecords(context, [
      recordOf(context, 'acting', { kind: 'agent', agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-a' },
        life: 'ended', title: '014 - fix login', worktree: svnWorktree, svnAction: reviewing }),
      recordOf(context, 'review-run', { life: 'starting', binding: null, pendingOperationId: 'op-r', pendingOperationKind: 'create',
        process: { tool: 'jamat-cli', args: ['sessions', 'worktree-review', '--self', '--wait'] },
        scriptOf: { sessionId: 'acting', phase: 'after', scriptId: 'review', name: '.' } }),
      recordOf(context, 'acting-cli', { kind: 'agent', agent: { agentId: 'codex', launchMode: 'new', nativeSessionId: 'native-c' },
        life: 'ended', title: 'i42 - orders', svnAction: scripted,
        worktree: { ...svnWorktree, worktreePath: scriptedPath, repositoryRoot: join(context.root, 'Mirabia'), cwdSubpath: 'WebMirabiaAdmin' } }),
      recordOf(context, 'review-run-cli', { life: 'starting', binding: null, pendingOperationId: 'op-c', pendingOperationKind: 'create',
        process: { tool: 'jamat-cli', args: ['sessions', 'worktree-review', '--self', '--wait'] },
        scriptOf: { sessionId: 'acting-cli', phase: 'after', scriptId: 'review', name: 'shared' } }),
      recordOf(context, 'plain', {}),
      recordOf(context, 'git', {
        kind: 'agent', agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-2' }, life: 'ended',
        worktree: { worktreePath: join(context.root, 'repo', '.worktrees', 'task'), branch: 'jamat/task', baseCommit: 'abc1234', repositoryRoot: join(context.root, 'repo') },
      }),
    ])
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)
    const opened: { sessionId: string; parentId: string; scopeRoot: string; proposal: string }[] = []
    const proposed: { sessionId: string; directory: string; message: string }[] = []
    const proposals = new Map([[`acting-cli|${scriptedPath}`, 'Fix the orders page']])
    expect(await client.manager.proposeCommit('acting', 'Fix login')).toMatchObject({ ok: false, code: 'review-unavailable' })
    client.manager.setReviewPort({
      open: async (input) => {
        opened.push(input)
        return { ok: true, value: { commitSessionId: `commit-${opened.length}` } }
      },
      known: () => true,
      propose: async (input) => {
        proposed.push(input)
        return { ok: true, value: { scopeRoot: input.directory } }
      },
      proposalOf: (sessionId, scopeRoot) => proposals.get(`${sessionId}|${scopeRoot}`) ?? null,
      forgetProposal: (sessionId, scopeRoot) => { proposals.delete(`${sessionId}|${scopeRoot}`) },
    })

    expect(sessionOf(client, 'acting')?.svnAction).toMatchObject({ kind: 'finish', stage: 'changes' })
    expect(sessionOf(client, 'acting')?.worktree?.finish).toBeUndefined()
    expect('openActionReview' in client.manager).toBe(false)
    expect(opened).toEqual([])
    expect(storedRecord(context, 'acting')?.svnAction?.runId).toBeUndefined()

    // A proposal is kept for the worktree root, never the member the session works in; without a worktree, for its directory.
    expect(await client.manager.proposeCommit('acting-cli', 'Fix the orders page')).toEqual({ ok: true, value: { scopeRoot: scriptedPath } })
    expect(await client.manager.proposeCommit('plain', 'Tidy')).toEqual({ ok: true, value: { scopeRoot: context.root } })
    expect(proposed).toEqual([
      { sessionId: 'acting-cli', directory: scriptedPath, message: 'Fix the orders page' },
      { sessionId: 'plain', directory: context.root, message: 'Tidy' },
    ])
    const external = join(context.root, 'shared', 'external')
    mkdirSync(external, { recursive: true })
    expect(await client.manager.proposeCommit('plain', '[external] Update library', external)).toEqual({ ok: true, value: { scopeRoot: external } })
    expect(proposed.at(-1)).toEqual({ sessionId: 'plain', directory: external, message: '[external] Update library' })
    expect(await client.manager.proposeCommit('plain', 'outside', join(context.root, '..', 'elsewhere'))).toMatchObject({ ok: false })
    expect(await client.manager.proposeCommit('nobody', 'x')).toMatchObject({ ok: false, code: 'not-found' })

    expect(await client.manager.finishWorktreeSession('acting', { choice: 'commit', requestedBy: 'window' }))
      .toMatchObject({ ok: false, code: 'svn-failed', detail: expect.stringContaining('not a working copy') })
    expect(await client.manager.finishWorktreeSession('git', { choice: 'commit', requestedBy: 'window' }))
      .toMatchObject({ ok: true })
    expect(await client.manager.finishWorktreeSession('nobody', { choice: 'keep', requestedBy: 'cli' })).toMatchObject({ ok: false, code: 'not-found' })
  }, 20_000)

  /*
   * A failed setup never ran a process of its own, so the cleanup of a session removed when it ends
   * judges the worktree like any ended session. The session stays with the tombstone, because its row
   * and its reason are the only evidence of why it never started. The worktrees here do not exist, so
   * the removal reaches no real working copy.
   */
  it('removes the worktree of a failed setup and keeps the session, and an ordinary ended session goes as before', async () => {
    const context = await world()
    const svnWorktree = (folder: string): SessionRecord['worktree'] => ({
      worktreePath: join(context.root, 'owner', '.worktrees', folder),
      branch: 'https://svn.example.test/repos/app/trunk',
      baseCommit: 'r41',
      repositoryRoot: join(context.root, 'owner'),
      kind: 'svn',
    })
    const failedSetup = (sessionId: string, folder: string, endedAt: number): SessionRecord => recordOf(context, sessionId, {
      kind: 'agent',
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: `native-${sessionId}` },
      directory: { mode: 'project', categoryId: 'c1', projectPath: context.root },
      endedAt,
      endedReason: 'setup failed: the setup exited with 1',
      pendingSetup: { setupSessionId: `${sessionId}-install` },
      worktree: svnWorktree(folder),
      worktreeCleanup: { phase: 'pending', trigger: 'remove-when-ended', reason: 'in use', requestedAt: 1, attempts: 1, lastAttemptAt: 2 },
    })
    const install = (parentId: string): SessionRecord => recordOf(context, `${parentId}-install`, {
      exitCode: 1,
      exitReason: 'process-exit',
      endedAt: 1_500,
      commands: [{ command: 'pnpm install', cwd: context.root }],
      scriptOf: { sessionId: parentId, phase: 'before', scriptId: 'setup', name: 'setup' },
    })
    seedRecords(context, [
      failedSetup('failed', '018-failed', 2_000),
      install('failed'),
      // Ended just now, so the cleanup's grace keeps the reconciler from judging it during the test.
      failedSetup('failed-recent', '019-recent', Date.now()),
      install('failed-recent'),
      recordOf(context, 'plain', {
        exitReason: 'process-exit',
        endedAt: 2_000,
        worktree: svnWorktree('020-plain'),
        worktreeCleanup: { phase: 'pending', trigger: 'remove-when-ended', requestedAt: 1, attempts: 0 },
      }),
    ])
    context.publishDescriptor()
    const removedItself: string[] = []
    const client = clientOf(context, { onRemovedItself: (sessionId) => removedItself.push(sessionId) })
    await client.manager.start()
    await writable(client)

    await vi.waitFor(() => {
      expect(storedRecord(context, 'failed')?.retiredWorktree?.worktreePath).toBe(join(context.root, 'owner', '.worktrees', '018-failed'))
      expect(removedItself).toEqual(['plain'])
    }, { timeout: 5_000 })
    expect(storedRecord(context, 'failed')?.worktree).toBeUndefined()
    expect(storedRecord(context, 'plain')).toBeUndefined()
    const failed = sessionOf(client, 'failed')
    expect(failed?.endedReason).toBe('setup failed: the setup exited with 1')
    expect(failed?.admits).not.toContain('retrySetup')
    expect(failed?.admits).toContain('remove')
    expect(await client.manager.retrySetup('failed')).toMatchObject({
      ok: false, code: 'worktree-removed', detail: expect.stringContaining(join(context.root, 'owner', '.worktrees', '018-failed')),
    })
    // The session never ran, so its end needs no confirmation, and the row says what the cleanup waits for.
    expect(sessionOf(client, 'failed-recent')?.worktree?.cleanup)
      .toEqual({ phase: 'pending', reason: 'in use', summary: 'waiting to remove (in use)' })
    expect(sessionOf(client, 'failed-recent')?.admits).toContain('retrySetup')
  }, 20_000)

  it('tells the composer where the tab of each collapsed run goes', async () => {
    const context = await world()
    const install = (sessionId: string, parentId: string): SessionRecord => recordOf(context, sessionId, {
      exitCode: 0,
      exitReason: 'process-exit',
      endedAt: 1_500,
      commands: [{ command: 'pnpm install', cwd: context.root }],
      scriptOf: { sessionId: parentId, phase: 'before', scriptId: 'setup', name: 'setup' },
    })
    seedRecords(context, [
      recordOf(context, 'parent', { exitReason: 'process-exit', endedAt: 2_000 }),
      install('parent-install', 'parent'),
      install('orphan-install', 'gone'),
    ])
    context.publishDescriptor()
    const collapsed: Parameters<NonNullable<SessionManagerDeps['onScriptCollapsed']>>[0][] = []
    const client = clientOf(context, { onScriptCollapsed: (event) => collapsed.push(event) })
    await client.manager.start()
    await writable(client)

    await vi.waitFor(() => expect(collapsed).toHaveLength(2), { timeout: 5_000 })
    expect(collapsed).toEqual(expect.arrayContaining([
      { runId: 'parent-install', parentId: 'parent', handoff: 'parent-tab', handoffTo: 'parent' },
      // Nobody is left to take it over.
      { runId: 'orphan-install', parentId: 'gone', handoff: 'close', handoffTo: 'gone' },
    ]))
    expect(storedRecord(context, 'parent-install')).toBeUndefined()
  }, 20_000)

  /** `runtime.stop`, with a switch for whether the process actually goes away afterwards. */
  function handleStop(context: World, options: { exits: boolean }): { calls: () => number } {
    let calls = 0
    context.host.handle('runtime.stop', (body) => {
      calls += 1
      const target = body.target as RuntimeRef
      if (options.exits) context.runtimes.delete(target.runtimeSessionId)
      return {
        body: {
          servedByHostInstanceId: context.host.descriptor().hostInstanceId,
          target,
          // `stopped` either way: the Host acknowledges the stop before the process is gone, and
          // whether it then goes is what the listing says. That gap is what the wait exists for.
          diagnostic: 'stopped',
        } satisfies RuntimeMutationAck,
      }
    })
    return { calls: () => calls }
  }

  it.each([false, true])('switches a live account once and keeps the new account when restart fails: %s', async fails => {
    const context = await world()
    seedRecords(context, [recordOf(context, 'switch', { kind: 'agent', life: 'live',
      binding: { hostInstanceId: 'fake-host-1', generation: 1 },
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'conversation', accountId: 'a', identityLaunchId: 'launch-a' },
      accountSegments: [{ accountId: 'a', from: 1000, to: null }] })])
    context.runtimes.set('switch', runtime('switch'))
    context.publishDescriptor()
    const client = clientOf(context, { accounts: { exists: () => true, defaultAccount: () => ({ accountId: 'main', noFreeAccount: false }),
      launchEnv: async () => ({}), usable: async (_agent, id) => id === 'b' } })
    await client.manager.start()
    await writable(client)
    await reconciled(client)
    expect(client.manager.accountForLaunch('switch', 'launch-a', 2000)).toEqual({ agentId: 'claude', accountId: 'a' })
    const restart = vi.spyOn(client.manager, 'restartSession').mockResolvedValue(fails
      ? { ok: false, code: 'spawn-failed', detail: 'fixture restart refused' } : { ok: true, value: undefined })
    const result = await client.manager.switchAccount('switch', 'b')
    expect(result.ok).toBe(!fails)
    expect(restart.mock.calls).toEqual([['switch']])
    const record = storedRecord(context, 'switch')!
    expect(record.agent?.accountId).toBe('b')
    expect(record.agent?.nativeSessionId).toBe('conversation')
    expect(record.accountSegments).toEqual([
      { accountId: 'a', from: 1000, to: record.accountSegments![1].from },
      { accountId: 'b', from: record.accountSegments![1].from, to: null },
    ])
    expect(client.manager.accountForLaunch('switch', 'launch-a', Date.now())).toBeNull()
    if (fails) expect(client.manager.snapshot().sessions.find(session => session.sessionId === 'switch')?.endedReason).toBe('fixture restart refused')
  })

  it.each(['before-stop', 'during-stop'] as const)('resumes the latest conversation confirmed %s without reassigning old quota', async timing => {
    const context = await world()
    const home = join(context.root, 'profile')
    mkdirSync(home)
    seedRecords(context, [recordOf(context, 'switch', { kind: 'agent', life: 'live',
      binding: { hostInstanceId: 'fake-host-1', generation: 1 },
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'old-conversation', accountId: 'a', identityLaunchId: 'launch-a' },
      accountSegments: [{ accountId: 'a', from: 1000, to: null }] })])
    context.runtimes.set('switch', runtime('switch'))
    context.publishDescriptor()
    const client = clientOf(context, { accounts: { exists: () => true, defaultAccount: () => ({ accountId: 'main', noFreeAccount: false }),
      launchEnv: async () => ({ CLAUDE_CONFIG_DIR: home }), usable: async () => true } })
    await client.manager.start()
    await writable(client)
    await reconciled(client)
    const identities = OrchestratorPaths.claudeIdentitiesDirectory(context.configIdentity, 'development')
    mkdirSync(identities, { recursive: true })
    const confirm = () => writeFileSync(join(identities, 'switch.json'), JSON.stringify({ schemaVersion: 1,
      jamatSessionId: 'switch', launchId: 'launch-a', nativeSessionId: 'displayed-conversation', sequence: 2 }))
    if (timing === 'before-stop') confirm()
    else if (timing !== 'during-stop') throw new Error(`Unknown confirmation timing: ${timing}`)
    handleStop(context, { exits: true })
    const hold = context.host.hold('runtime.stop')
    const switched = client.manager.switchAccount('switch', 'b')
    try {
      await vi.waitFor(() => expect(context.host.calls.some(call => call.name === 'runtime.stop')).toBe(true))
      expect(storedRecord(context, 'switch')?.agent?.identityLaunchId).toBe('launch-a')
      expect(client.manager.accountForLaunch('switch', 'launch-a', Date.now())).toBeNull()
      if (timing === 'during-stop') confirm()
      else if (timing !== 'before-stop') throw new Error(`Unknown confirmation timing: ${timing}`)
    } finally { hold.release() }
    expect(await switched).toEqual({ ok: true, value: undefined })
    const record = storedRecord(context, 'switch')!
    expect(record.agent?.nativeSessionId).toBe('displayed-conversation')
    expect(record.agent?.launchAccountId).toBe('b')
    const launches = context.host.calls.filter(call => call.name === 'runtime.create')
    expect(launches).toHaveLength(1)
    expect((launches[0].body.launch as RuntimeLaunchSpec).args).toEqual(expect.arrayContaining(['--resume', 'displayed-conversation']))
    expect(client.manager.accountForLaunch('switch', 'launch-a', Date.now())).toBeNull()
    expect(client.manager.accountForLaunch('switch', record.agent!.identityLaunchId!, Date.now()))
      .toEqual({ agentId: 'claude', accountId: 'b' })
    expect(client.manager.accountForLaunch('switch', record.agent!.identityLaunchId!, 999)).toBeNull()
  })

  it.each(['ended', 'missing'] as const)('resumes the final conversation when switching back after stop refusal with an %s runtime', async afterStop => {
    const context = await world()
    const home = join(context.root, 'profile')
    mkdirSync(home)
    seedRecords(context, [recordOf(context, 'switch', { kind: 'agent', life: 'live',
      binding: { hostInstanceId: 'fake-host-1', generation: 1 },
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'old-conversation', accountId: 'a', identityLaunchId: 'launch-a' },
      accountSegments: [{ accountId: 'a', from: 1000, to: null }] })])
    context.runtimes.set('switch', runtime('switch'))
    context.publishDescriptor()
    const client = clientOf(context, { accounts: { exists: () => true, defaultAccount: () => ({ accountId: 'main', noFreeAccount: false }),
      launchEnv: async () => ({ CLAUDE_CONFIG_DIR: home }), usable: async () => true } })
    await client.manager.start()
    await writable(client)
    await reconciled(client)
    context.host.handle('runtime.stop', () => ({ status: 409, body: { error: 'first stop refused' } }))
    expect((await client.manager.switchAccount('switch', 'b')).ok).toBe(false)
    expect(storedRecord(context, 'switch')?.agent).toMatchObject({ accountId: 'b', launchAccountId: 'a', nativeSessionId: 'old-conversation' })
    expect(client.manager.accountForLaunch('switch', 'launch-a', Date.now())).toBeNull()
    context.host.handle('runtime.stop', body => {
      if (afterStop === 'ended') context.runtimes.set('switch', { ...context.runtimes.get('switch')!, alive: false, exitedAt: Date.now(), exitCode: 0 })
      else if (afterStop === 'missing') context.runtimes.delete('switch')
      else throw new Error(`Unknown runtime state: ${afterStop}`)
      return { body: { servedByHostInstanceId: context.host.descriptor().hostInstanceId,
        target: body.target, diagnostic: 'stopped' } }
    })
    context.host.handle('runtime.replace', () => {
      const session = runtime('switch', { generation: 2 })
      context.runtimes.set('switch', session)
      return { body: { session, hostInstanceId: context.host.descriptor().hostInstanceId } satisfies RuntimeResult }
    })
    const hold = context.host.hold('runtime.stop')
    const switched = client.manager.switchAccount('switch', 'a')
    try {
      await vi.waitFor(() => expect(context.host.calls.filter(call => call.name === 'runtime.stop')).toHaveLength(2))
      const pending = storedRecord(context, 'switch')!
      expect(pending.agent).toMatchObject({ accountId: 'a', launchAccountId: 'a', identityLaunchId: 'launch-a', nativeSessionId: 'old-conversation' })
      expect(pending.endedReason).toContain('first stop refused')
      expect(client.manager.accountForLaunch('switch', 'launch-a', 999)).toBeNull()
      expect(client.manager.accountForLaunch('switch', 'other-launch', Date.now())).toBeNull()
      const identities = OrchestratorPaths.claudeIdentitiesDirectory(context.configIdentity, 'development')
      mkdirSync(identities, { recursive: true })
      writeFileSync(join(identities, 'switch.json'), JSON.stringify({ schemaVersion: 1, jamatSessionId: 'switch',
        launchId: 'launch-a', nativeSessionId: 'second-stop-conversation', sequence: 2 }))
    } finally { hold.release() }
    expect(await switched).toEqual({ ok: true, value: undefined })
    expect(storedRecord(context, 'switch')?.agent?.nativeSessionId).toBe('second-stop-conversation')
    const launches = context.host.calls.filter(call => call.name === 'runtime.create' || call.name === 'runtime.replace')
    expect(launches).toHaveLength(1)
    const args = (launches[0].body.launch as RuntimeLaunchSpec).args
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', 'second-stop-conversation'])
    expect(args).not.toContain('old-conversation')
    expect(client.manager.accountForLaunch('switch', 'launch-a', Date.now())).toBeNull()
  })

  it.each(['refusal', 'timeout'] as const)('protects the actual profile during stop, after %s and after manager recovery', async failure => {
    const context = await world()
    const main = join(context.root, 'main-profile')
    mkdirSync(main)
    let stored: readonly StoredAccount[] = []
    let client: Client
    const accounts = new AgentAccounts({ mainHomes: { claude: main, codex: main },
      specs: [{ agentId: 'claude', mainHome: () => main, homeVariable: 'CLAUDE_CONFIG_DIR', extraEnv: () => ({}),
        shareTable: { directories: [], files: [], neverShared: [] }, loginCommand: 'fixture',
        probe: async home => ({ kind: 'logged-in', identity: { key: home, label: home } }) }],
      accountsRoot: join(context.root, 'accounts'), stored: () => stored, store: value => { stored = value },
      hasRunningSession: (agentId, accountId) => client.manager.hasAccountSession(agentId, accountId), onChanged: () => {},
    })
    const a = await accounts.add('claude', 'A')
    const b = await accounts.add('claude', 'B')
    stored = stored.map(account => ({ ...account, identity: { key: accounts.homeOf('claude', account.id), label: account.label } }))
    const marker = join(accounts.homeOf('claude', a.accountId), 'private-fixture')
    writeFileSync(marker, 'unchanged')
    const at = Date.now()
    seedRecords(context, [recordOf(context, 'switch', { kind: 'agent', life: 'live',
      binding: { hostInstanceId: 'fake-host-1', generation: 1 },
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'conversation', accountId: a.accountId, identityLaunchId: 'launch-a' },
      accountSegments: [{ accountId: a.accountId, from: at, to: null }] })])
    context.runtimes.set('switch', runtime('switch', { startedAt: at }))
    context.publishDescriptor()
    client = clientOf(context, { accounts, exitClock: virtualClock().clock })
    await client.manager.start()
    await writable(client)
    await reconciled(client)
    if (failure === 'refusal') context.host.handle('runtime.stop', () => ({ status: 409, body: { error: 'fixture stop refused' } }))
    else if (failure === 'timeout') handleStop(context, { exits: false })
    else throw new Error(`Unknown stop failure: ${failure}`)
    const hold = context.host.hold('runtime.stop')
    const switched = client.manager.switchAccount('switch', b.accountId)
    try {
      await vi.waitFor(() => expect(context.host.calls.some(call => call.name === 'runtime.stop')).toBe(true))
      expect(storedRecord(context, 'switch')?.agent?.accountId).toBe(b.accountId)
      await expect(accounts.remove(a.accountId)).rejects.toThrow('a session runs on A')
      expect(readFileSync(marker, 'utf8')).toBe('unchanged')
    } finally { hold.release() }
    expect((await switched).ok).toBe(false)
    expect(context.runtimes.get('switch')?.alive).toBe(true)
    await expect(accounts.remove(a.accountId)).rejects.toThrow('a session runs on A')
    await client.manager.stop()
    client = clientOf(context, { accounts, exitClock: virtualClock().clock })
    await client.manager.start()
    await writable(client)
    await reconciled(client)
    expect(storedRecord(context, 'switch')?.agent?.accountId).toBe(b.accountId)
    await expect(accounts.remove(a.accountId)).rejects.toThrow('a session runs on A')
    context.runtimes.set('switch', { ...context.runtimes.get('switch')!, alive: false, exitedAt: Date.now(), exitCode: 0 })
    await client.manager.removeSession('never-existed')
    expect(client.manager.hasAccountSession('claude', a.accountId)).toBe(false)
    await accounts.remove(a.accountId)
    expect(existsSync(marker)).toBe(false)
    context.runtimes.delete('switch')
    expect(await client.manager.restartSession('switch')).toEqual({ ok: true, value: undefined })
    expect(storedRecord(context, 'switch')?.agent?.launchAccountId).toBe(b.accountId)
    expect(client.manager.hasAccountSession('claude', b.accountId)).toBe(true)
    accounts.stop()
  }, 20_000)

  it('refuses the current or an unusable account before any record change or restart', async () => {
    const context = await world()
    seedRecords(context, [recordOf(context, 'switch', { kind: 'agent',
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'conversation', accountId: 'a' } })])
    const client = clientOf(context, { accounts: { exists: () => true, defaultAccount: () => ({ accountId: 'main', noFreeAccount: false }),
      launchEnv: async () => ({}), usable: async () => false } })
    await client.manager.start()
    const before = storedRecord(context, 'switch')
    const restart = vi.spyOn(client.manager, 'restartSession')
    expect(await client.manager.switchAccount('switch', 'a')).toEqual({ ok: false, code: 'invalid-spec', detail: 'already on this account' })
    expect(await client.manager.switchAccount('switch', 'disabled')).toEqual({ ok: false, code: 'invalid-spec', detail: 'account not usable' })
    expect(storedRecord(context, 'switch')).toEqual(before)
    expect(restart).not.toHaveBeenCalled()
  })

  it('keeps the selected account and reports a fresh preflight refusal during a real switch restart', async () => {
    const context = await world()
    seedRecords(context, [recordOf(context, 'switch', { kind: 'agent',
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'conversation', accountId: 'a' } })])
    context.publishDescriptor()
    const launchEnv = vi.fn(async () => { throw new Error('registered identity no longer matches') })
    const client = clientOf(context, { accounts: { exists: () => true,
      defaultAccount: () => ({ accountId: 'main', noFreeAccount: false }), launchEnv, usable: async () => true } })
    await client.manager.start()
    await writable(client)
    const result = await client.manager.switchAccount('switch', 'b')
    expect(result.ok).toBe(false)
    expect(launchEnv).toHaveBeenCalledWith('claude', 'b', context.root, { yolo: false, model: undefined, effort: undefined })
    expect(storedRecord(context, 'switch')?.agent?.accountId).toBe('b')
    expect(storedRecord(context, 'switch')?.agent?.nativeSessionId).toBe('conversation')
    expect(sessionOf(client, 'switch')?.endedReason).toContain('registered identity no longer matches')
    expect(context.host.calls.filter(call => call.name === 'runtime.create')).toHaveLength(0)
  })

  it('marks only the session account exhausted and clears the marker after a fresh rate change', async () => {
    const context = await world()
    seedRecords(context, ['a', 'b'].map(accountId => recordOf(context, accountId, { kind: 'agent',
      agent: { agentId: 'claude', launchMode: 'new', accountId } })))
    let usedPercent = 100
    const client = clientOf(context, { rates: () => [{ key: { agentId: 'claude', accountId: 'b' }, label: 'B',
      state: { kind: 'ok', fetchedAt: 1000, windows: [{ durationMinutes: 300, usedPercent, resetsAt: null }] },
      estimated: null, source: 'statusline' }] })
    await client.manager.start()
    expect(sessionOf(client, 'a')?.agent?.accountExhausted).toBeUndefined()
    expect(sessionOf(client, 'b')?.agent?.accountExhausted).toBe(true)
    usedPercent = 10
    client.manager.ratesChanged()
    expect(sessionOf(client, 'b')?.agent?.accountExhausted).toBeUndefined()
  })

  it('restarts a live session by stopping it, waiting for it to go, and resuming it', async () => {
    const context = await world()
    const stop = handleStop(context, { exits: true })
    seedRecords(context, [recordOf(context, 's1', {
      life: 'live',
      binding: { hostInstanceId: 'fake-host-1', generation: 1 },
    })])
    context.runtimes.set('s1', runtime('s1'))
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    expect(await client.manager.restartSession('s1')).toEqual({ ok: true, value: undefined })
    expect(stop.calls()).toBe(1)
    expect(sessionOf(client, 's1')?.life).toBe('live')
    // The stop writes the finished mark and the reopen takes it off: running a session is the
    // opposite of being done with it, and a restart must not leave it filed as finished. The
    // witnesses of the old ending go with it, so the row reads as what it is - live.
    expect(sessionOf(client, 's1')?.completed).toBeUndefined()
    expect(sessionOf(client, 's1')?.outcome).toBeUndefined()
    expect(client.errors).toEqual([])
  }, 20_000)

  /**
   * Slow by design: it spends the whole exit budget, which is the only way to prove the wait is
   * bounded and that the refusal names the right problem rather than the reopen's.
   */
  /**
   * The precondition defect, made deterministic by holding ONE answer. `presence` says the events
   * socket subscribed; controller authority is a separate call, and a mutation started between the
   * two is refused with `no-lease` - which is how the budget test below read `no-lease` where it
   * expects `live-refused`, blaming a five second budget it never entered.
   */
  it('has running presence with no authority while the acquire answer is held', async () => {
    const context = await world()
    const stop = handleStop(context, { exits: false })
    seedRecords(context, [recordOf(context, 's1', {
      life: 'live',
      binding: { hostInstanceId: 'fake-host-1', generation: 1 },
    })])
    context.runtimes.set('s1', runtime('s1'))
    context.publishDescriptor()
    const held = context.host.hold('controller.acquire')
    // This test is about the precondition, not about the budget: the virtual clock keeps the
    // five seconds the second restart spends off the wall clock.
    const client = clientOf(context, { exitClock: virtualClock().clock })
    await client.manager.start()
    const waiting = writable(client).then(() => 'writable' as const)
    await vi.waitFor(
      () => expect(client.manager.snapshot().host.presence).toBe('running'),
      { timeout: 5_000 },
    )

    // Presence is up and the Host has already granted; only the answer is still on the wire.
    expect(client.manager.debugStatus().lease.leaseId).toBeNull()
    const early = await client.manager.restartSession('s1')
    expect(early.ok).toBe(false)
    if (!early.ok) expect(early.code).toBe('no-lease')
    expect(stop.calls()).toBe(0)

    // A bounded wait is the only way to assert that something does NOT happen. It cannot expire
    // wrongly: the gate is shut, so the authority this waits against cannot arrive at all.
    const raced = await Promise.race([
      waiting,
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 300)),
    ])
    expect(raced).toBe('still waiting')

    held.release()
    await waiting
    const refusal = await client.manager.restartSession('s1')
    expect(refusal.ok).toBe(false)
    if (!refusal.ok) expect(refusal.code).toBe('live-refused')
    expect(stop.calls()).toBe(1)
  }, 30_000)

  it('refuses when the stopped process is still running after the budget', async () => {
    const context = await world()
    const stop = handleStop(context, { exits: false })
    seedRecords(context, [recordOf(context, 's1', {
      life: 'live',
      binding: { hostInstanceId: 'fake-host-1', generation: 1 },
    })])
    context.runtimes.set('s1', runtime('s1'))
    context.publishDescriptor()
    const virtual = virtualClock()
    const client = clientOf(context, { exitClock: virtual.clock })
    await client.manager.start()
    await writable(client)

    const refusal = await client.manager.restartSession('s1')
    expect(refusal.ok).toBe(false)
    if (!refusal.ok) expect(refusal.code).toBe('live-refused')
    expect(stop.calls()).toBe(1)
    // The budget really was spent, on the virtual clock: the refusal is the end of a five second
    // wait and not something that gave up earlier for another reason.
    expect(virtual.elapsed()).toBeGreaterThanOrEqual(5_000)
    // One create for the original session and none for a resume that was never reached.
    expect(client.errors).toEqual([])
  }, 30_000)

  it('resumes a session that was not running without asking the Host to stop anything', async () => {
    const context = await world()
    const stop = handleStop(context, { exits: true })
    seedRecords(context, [recordOf(context, 's1', { life: 'lost', binding: null })])
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    expect(await client.manager.restartSession('s1')).toEqual({ ok: true, value: undefined })
    expect(stop.calls()).toBe(0)
    expect(sessionOf(client, 's1')?.life).toBe('live')
  }, 20_000)

  it('answers not-found when there is no such session to restart', async () => {
    const context = await world()
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()

    const refusal = await client.manager.restartSession('nobody')
    expect(refusal.ok).toBe(false)
    if (!refusal.ok) expect(refusal.code).toBe('not-found')
  }, 20_000)

  it('reports a live runtime nobody recorded as an orphan, and adopts it into a record', async () => {
    const context = await world()
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    const stray = runtime('stray-1', { startedAt: 4_242 })
    context.runtimes.set(stray.runtimeSessionId, stray)
    // The event is what a Host really sends; the manager is expected to go and look for itself.
    context.host.publish({ kind: 'runtime-created', session: stray })
    await vi.waitFor(
      () => expect(client.manager.snapshot().orphans).toEqual([
        { runtimeSessionId: 'stray-1', alive: true, startedAt: 4_242 },
      ]),
      { timeout: 5_000 },
    )

    valueOf(await client.manager.adoptOrphan('stray-1'))
    const snapshot = client.manager.snapshot()
    expect(snapshot.orphans).toEqual([])
    expect(snapshot.sessions.map((session) => session.sessionId)).toEqual(['stray-1'])
    expect(snapshot.sessions[0]).toMatchObject({ kind: 'shell', life: 'live' })
    expect(client.errors).toEqual([])
  }, 20_000)

  it('composes what it holds about the Host, carrying neither the token nor the environment', async () => {
    const context = await world()
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await vi.waitFor(
      () => expect(client.manager.debugStatus().reconcile.lastListingOk).toBe(true),
      { timeout: 5_000 },
    )

    process.env.JAMAT_V3_DEBUG_MARKER = 'no-window-may-see-this'
    const status = client.manager.debugStatus()
    const serialized = JSON.stringify(status)
    delete process.env.JAMAT_V3_DEBUG_MARKER

    // The two things that must never reach a renderer, asserted over the whole document rather than
    // over the fields that happen to carry them today.
    expect(serialized).not.toContain(context.host.descriptor().token)
    expect(serialized).not.toContain('no-window-may-see-this')

    expect(status.presence).toBe('running')
    expect(status.descriptor).toMatchObject({
      port: context.host.descriptor().port,
      hostInstanceId: 'fake-host-1',
      hostVersion: '0.0.0-fake',
    })
    expect(status.clientProtocol).toEqual({ major: 1, minor: 1 })
    // Read here by a different route than the one under test, from the file the Host's own build
    // info falls back to.
    expect(status.expectedHostVersion).toBe((JSON.parse(readFileSync(
      join(import.meta.dirname, '..', '..', 'app-host', 'package.json'),
      'utf8',
    )) as { version: string }).version)
    expect(status.watcher.identity).toBe(`fake-host-1:${context.host.descriptor().port}`)
    expect(status.watcher.descriptorFile).toContain('descriptor')
    expect(status.eventsSocket.connected).toBe(true)
    expect(status.eventsSocket.lastSubscribed).not.toBeNull()
    expect(status.lease.leaseId).toBe(context.host.currentLeaseId())
    expect(status.reconcile.lastReason).not.toBeNull()
    expect(status.poll).toMatchObject({ windowVisible: true, cadenceMilliseconds: 2_000 })
    expect(status.launch.ok).toBe(true)
    expect(status.launch.command).not.toBeNull()
    expect(Object.keys(status.launch)).not.toContain('env')
    expect(client.errors).toEqual([])
  }, 20_000)

  it('joins the Host runtimes to its records, keeping the dead ones and marking the orphans', async () => {
    const context = await world()
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    const created = valueOf(await client.manager.createSession({
      kind: 'shell',
      directory: { mode: 'adHoc', path: context.root },
      title: 'A recorded session',
    }))
    const stray = runtime('stray-1', { startedAt: 4_242 })
    context.runtimes.set(stray.runtimeSessionId, stray)
    const dead = runtime('dead-1', {
      alive: false,
      exitedAt: 5_000,
      exitCode: 3,
      exitReason: 'process-exit',
    })
    context.runtimes.set(dead.runtimeSessionId, dead)
    context.host.publish({ kind: 'runtime-created', session: stray })
    await vi.waitFor(
      () => expect(client.manager.snapshot().orphans.map((orphan) => orphan.runtimeSessionId))
        .toContain('stray-1'),
      { timeout: 5_000 },
    )

    const status = client.manager.debugStatus()
    const rows = new Map(status.runtimes.map((row) => [row.runtimeSessionId, row]))
    expect(rows.get(created.sessionId)).toMatchObject({
      sessionTitle: 'A recorded session',
      orphan: false,
      alive: true,
    })
    // No record, so no title: the row with nothing on the left is what an orphan looks like.
    expect(rows.get('stray-1')).toMatchObject({ sessionTitle: null, orphan: true, alive: true })
    // A dead runtime stays in the table. It is the difference between a session this client calls
    // ended and a process the Host is still holding.
    expect(rows.get('dead-1')).toMatchObject({
      alive: false,
      exitedAt: 5_000,
      exitCode: 3,
      exitReason: 'process-exit',
    })
    expect(status.counts).toEqual({
      live: 2,
      dead: 1,
      orphans: client.manager.snapshot().orphans.length,
    })
    expect(client.errors).toEqual([])
  }, 20_000)

  it('pings the Host and carries only the fields the surface draws', async () => {
    const context = await world()
    context.publishDescriptor()
    context.host.setHello({ runtimes: { live: 2, dead: 1 }, eventRevision: 9 })
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    const pinged = await client.manager.pingHost()
    expect(pinged.ok).toBe(true)
    if (!pinged.ok) throw new Error(pinged.detail)
    expect(pinged.latencyMilliseconds).toBeGreaterThanOrEqual(0)
    expect(pinged.hello).toEqual({
      protocol: { major: 1, minor: 0 },
      buildVersion: '0.0.0-fake',
      sourceRevision: 'fake-revision',
      platform: 'fake-platform',
      arch: 'fake-arch',
      hostGeneration: 'fake-generation',
      pid: process.pid,
      runtimesLive: 2,
      runtimesDead: 1,
      eventRevision: 9,
    })
    expect(client.errors).toEqual([])
  }, 20_000)

  it('answers a ping with the reason while no Host is there, and asks nothing of the network', async () => {
    const context = await world()
    const client = clientOf(context)
    await client.manager.start()

    const pinged = await client.manager.pingHost()
    expect(pinged.ok).toBe(false)
    if (pinged.ok) throw new Error('a ping with no Host answered ok')
    expect(pinged.detail).toContain('host-unreachable')
    expect(context.host.helloCount()).toBe(0)
  }, 20_000)

  it('moves the revision only where the content moved, and emits exactly once for it', async () => {
    const context = await world()
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)
    const created = valueOf(await client.manager.createSession({
      kind: 'shell',
      directory: { mode: 'adHoc', path: context.root },
    }))

    // A refused operation still reconciles, which is a full pass over unchanged content.
    expect(await client.manager.removeSession('never-existed')).toMatchObject({ code: 'not-found' })
    const settled = client.manager.snapshot().revision
    const emitted = client.emits()
    expect(await client.manager.removeSession('never-existed')).toMatchObject({ code: 'not-found' })
    expect(client.manager.snapshot().revision).toBe(settled)
    expect(client.emits()).toBe(emitted)

    /*
     * Output moving is NOT a change to this snapshot, and the number here is the opposite of what it
     * was until 2026-08-24. `SessionInfo` carried `outputSeq` and `lastOutputAt` then, so a working
     * agent minted a revision on every poll, pushed the snapshot to every window and rebuilt the
     * whole tree over a screen nobody was touching. Nothing had drawn either field since the
     * `unread` half of the attention model was deleted, so they left the composition.
     *
     * The counters are still on the diagnostic surface, which is read when somebody asks for it.
     */
    const running = context.runtimes.get(created.sessionId)
    if (!running) throw new Error('the fake Host lost the runtime it created')
    context.runtimes.set(created.sessionId, { ...running, outputSeq: 12, lastOutputAt: 5_000 })
    expect(await client.manager.removeSession('never-existed')).toMatchObject({ code: 'not-found' })
    expect(client.manager.snapshot().revision).toBe(settled)
    expect(client.emits()).toBe(emitted)
    expect(client.manager.debugStatus().runtimes[0])
      .toMatchObject({ outputSeq: 12, lastOutputAt: 5_000 })

    // And a change that IS drawn still moves it, so the identity has not simply gone quiet.
    context.runtimes.set(created.sessionId, { ...running, alive: false, exitCode: 0 })
    expect(await client.manager.removeSession('never-existed')).toMatchObject({ code: 'not-found' })
    expect(client.manager.snapshot().revision).toBe(settled + 1)
    expect(client.emits()).toBe(emitted + 1)
    expect(client.errors).toEqual([])
  }, 20_000)

  /*
   * One poll, one listing. The work-state monitor holds no timer and cannot ask for a listing at
   * all: it is handed the one the manager already fetched, and everything it learns arrives through
   * that. A session classified here is the proof that the hand-over happens.
   */
  it('continues ready sync for another worktree when one hash read refuses', async () => {
    const context = await world()
    seedRecords(context, ['broken', 'ready'].map((id) => recordOf(context, id, {
      life: 'live', worktree: { kind: 'svn', repositoryRoot: context.root, worktreePath: join(context.root, '.worktrees', id), branch: 'url', baseCommit: 'r1' },
      worktreeLifecycle: { version: 0, actionId: null, phase: 'active', outOfDate: 0, journal: [], facts: {
        worker: { liveness: 'alive', resumeFailures: 0, ready: { at: 1, hashes: {} } },
      } },
    })))
    for (const id of ['broken', 'ready']) context.runtimes.set(id, runtime(id))
    const ready = vi.spyOn(WorkerReady.prototype, 'current').mockImplementation(async (id) => {
      if (id === 'broken') throw new Error('Cannot prove the complete directory hash')
      return true
    })
    const idle = vi.spyOn(SessionManager.prototype, 'workerIdle').mockReturnValue(true)
    const sync = vi.spyOn(SyncStep.prototype, 'run').mockResolvedValue({ ok: true, value: { revision: 2, conflicts: [] } })
    try {
      context.publishDescriptor()
      const client = clientOf(context)
      await client.manager.start()
      await vi.waitFor(() => expect(sync).toHaveBeenCalledWith('ready', 'ready'))
      expect(client.errors).toContain('Ready sync for broken: Cannot prove the complete directory hash')
      expect(sync).not.toHaveBeenCalledWith('broken', 'ready')
    } finally { ready.mockRestore(); idle.mockRestore(); sync.mockRestore() }
  })

  // A Finish waited 1 min 25 s on Sync now after its worker was idle (UA1-J14-4).
  it('hands a sync that waits for a busy worker on to the Finish once the look finds the worker idle', async () => {
    const context = await world()
    const worktreePath = join(context.root, '.worktrees', 'busy')
    seedRecords(context, [recordOf(context, 'busy', {
      kind: 'agent', life: 'live', agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'busy-conversation' },
      worktree: { kind: 'svn', repositoryRoot: context.root, worktreePath, branch: 'url', baseCommit: 'r1' },
      worktreeLifecycle: { version: 2, actionId: 'busy-action', phase: 'waiting', step: 'syncing', outOfDate: 0, journal: [],
        wait: { kind: 'worker-busy', reason: 'Sync waits for an idle worker or your confirmation: the worker is working', at: 1 },
        execution: { root: worktreePath, checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 1 },
        facts: { worker: { liveness: 'alive', resumeFailures: 0 } } },
    })])
    context.runtimes.set('busy', runtime('busy'))
    let idle = false
    const idleness = vi.spyOn(SessionManager.prototype, 'workerIdle').mockImplementation(() => idle)
    const resumed = vi.spyOn(FinishDriver.prototype, 'workerIdle').mockResolvedValue(undefined)
    try {
      context.publishDescriptor()
      const client = clientOf(context)
      await client.manager.start()
      await writable(client)
      expect(resumed).not.toHaveBeenCalled()
      idle = true
      await vi.waitFor(() => expect(resumed).toHaveBeenCalledWith('busy'), { timeout: 10_000 })
    } finally { idleness.mockRestore(); resumed.mockRestore() }
  }, 20_000)

  it('reports a detached Finish drive whose lifecycle cannot be saved instead of rejecting unhandled', async () => {
    const context = await world()
    const worktreePath = join(context.root, '.worktrees', 'unsaved')
    seedRecords(context, [recordOf(context, 'unsaved', {
      kind: 'agent', life: 'live', agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'unsaved-conversation' },
      worktree: { kind: 'svn', repositoryRoot: context.root, worktreePath, branch: 'url', baseCommit: 'r1' },
      worktreeLifecycle: { version: 2, actionId: 'unsaved-action', phase: 'waiting', step: 'syncing', outOfDate: 0, journal: [],
        wait: { kind: 'worker-busy', reason: 'Sync waits for an idle worker or your confirmation: the worker is working', at: 1 },
        execution: { root: worktreePath, checks: [], checkCursor: 0, rootCursor: 0, evidence: [], requestedBy: 'window', startedAt: 1 },
        facts: { worker: { liveness: 'alive', resumeFailures: 0 } } },
    })])
    context.runtimes.set('unsaved', runtime('unsaved'))
    const idleness = vi.spyOn(SessionManager.prototype, 'workerIdle').mockReturnValue(true)
    const resumed = vi.spyOn(FinishDriver.prototype, 'workerIdle').mockRejectedValue(new Error('The Finish lifecycle could not be saved'))
    try {
      context.publishDescriptor()
      const client = clientOf(context)
      await client.manager.start()
      await vi.waitFor(() => expect(client.errors).toContain(
        'Finishing session unsaved after its worker became idle failed: The Finish lifecycle could not be saved'), { timeout: 10_000 })
    } finally { idleness.mockRestore(); resumed.mockRestore() }
  }, 20_000)

  it('classifies an agent session from the listing it already fetched', async () => {
    const context = await world()
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)
    const created = valueOf(await client.manager.createSession({
      kind: 'agent',
      directory: { mode: 'adHoc', path: context.root },
      agent: { agentId: 'claude', mode: 'new' },
    }))
    // Nothing has looked like work yet, and an agent nothing has classified is `unknown`.
    expect(sessionOf(client, created.sessionId)?.activity).toBe('unknown')

    const running = context.runtimes.get(created.sessionId)
    if (!running) throw new Error('the fake Host lost the runtime it created')
    context.screens.set(created.sessionId, screenOf('claude-working-spinner.json'))
    context.runtimes.set(created.sessionId, {
      ...running,
      outputSeq: 7,
      lastOutputAt: Date.now(),
    })

    await vi.waitFor(
      () => expect(sessionOf(client, created.sessionId)?.activity).toBe('working'),
      { timeout: 10_000 },
    )

    context.screens.set(created.sessionId, screenOf('claude-live-background-tasks.json'))
    context.runtimes.set(created.sessionId, {
      ...running,
      outputSeq: 8,
      lastOutputAt: Date.now(),
    })
    await vi.waitFor(() => {
      expect(sessionOf(client, created.sessionId)).toMatchObject({
        activity: 'working',
        activityDetail: 'background',
      })
      expect(client.manager.workerIdle(created.sessionId)).toBe(false)
    }, { timeout: 10_000 })
    context.screens.set(created.sessionId, screenOf('claude-compacting-conversation.json'))
    context.runtimes.set(created.sessionId, {
      ...running,
      outputSeq: 9,
      lastOutputAt: Date.now(),
    })
    await vi.waitFor(() => {
      expect(sessionOf(client, created.sessionId)).toMatchObject({ activity: 'working', compacting: true })
      expect(sessionOf(client, created.sessionId)?.activityDetail).toBeUndefined()
    }, { timeout: 10_000 })
    expect(client.errors).toEqual([])
  }, 20_000)

  /*
   * A create the Host refused is a session that never started, and the snapshot says so with the
   * Host's own words. Nothing is left pending, so the poll behind this does not replay the refusal
   * for the life of the process, and the record is removable rather than stuck.
   */
  it('shows a refused create as an ended session, and never replays it', async () => {
    const context = await world()
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)
    context.host.handle('runtime.create', () => ({
      status: 400,
      body: { error: 'launch.cwd must be an existing directory' },
    }))

    const refused = await client.manager.createSession({
      kind: 'shell',
      directory: { mode: 'adHoc', path: join(context.root, 'nowhere') },
    })
    expect(refused).toMatchObject({ ok: false, code: 'op-rejected' })
    const [session] = client.manager.snapshot().sessions
    expect(session).toMatchObject({ life: 'ended' })
    expect(session.endedReason).toContain('launch.cwd must be an existing directory')

    // Two polls' worth of silence: a replayed refusal would show up here as a second create.
    const creates = (): number =>
      context.host.calls.filter((call) => call.name === 'runtime.create').length
    const attempted = creates()
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    expect(creates()).toBe(attempted)

    valueOf(await client.manager.removeSession(session.sessionId))
    expect(client.manager.snapshot().sessions).toEqual([])
    expect(client.errors).toEqual([])
  }, 30_000)

  /*
   * The poll runs on a timer nobody awaits, and the work it does ends in `AtomicJsonFile.write`,
   * which is synchronous `fs` and fails on EPERM, ENOSPC or a locked file. That must reach the
   * client's error channel; as an unhandled rejection it would take down the main process instead.
   *
   * The store is what names it: a write that cannot land is reported and answered `false`, so it
   * travels as the ordinary "this did not land" its callers are written around rather than as a
   * throw the poll's catch has to turn into a sentence about the poll.
   */
  it('reports a poll that could not write, instead of rejecting into the process', async () => {
    const context = await world()
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)
    const created = valueOf(await client.manager.createSession({
      kind: 'shell',
      directory: { mode: 'adHoc', path: context.root },
    }))

    // Every write from here on throws inside node:fs: the records file is a directory now.
    const recordsFile = OrchestratorPaths.sessionRecordsFile(context.configIdentity, 'development')
    rmSync(recordsFile, { force: true })
    mkdirSync(recordsFile, { recursive: true })
    // The next poll finds the runtime dead and tries to write the record that says so.
    const running = context.runtimes.get(created.sessionId)
    if (!running) throw new Error('the fake Host lost the runtime it created')
    context.runtimes.set(created.sessionId, { ...running, alive: false, exitCode: 1 })

    await vi.waitFor(
      () => expect(client.errors.join(' | ')).toMatch(/could not be written/),
      { timeout: 10_000 },
    )
    // Still polling: a reported failure is not a manager that gave up.
    expect(client.manager.snapshot().host.presence).toBe('running')
  }, 20_000)

  it('launches no Host at all unless it was asked to', async () => {
    const context = await world()
    context.publishDescriptor()
    const client = clientOf(context, { autoStartHost: false })
    await client.manager.start()
    await writable(client)
    expect(client.spawns()).toBe(0)
    expect(client.errors).toEqual([])
  }, 20_000)

  it('makes exactly one automatic attempt when it was', async () => {
    const context = await world()
    const client = clientOf(context, { autoStartHost: true, spawnPublishes: true })
    await client.manager.start()
    expect(client.spawns()).toBe(1)
    expect(client.manager.snapshot().host.presence).toBe('running')
    expect(client.errors).toEqual([])
  }, 30_000)

  /*
   * The setup marker is composed, never stored: the record says what a session is WAITING for and
   * never that the wait is over, so the life beside it is what turns that wait into a state. The
   * session doing the installing carries the other half of the pair, `setupFor`, and nothing else.
   */
  it('says what each session is waiting for, out of the wait and the life beside it', async () => {
    const context = await world()
    seedRecords(context, [
      recordOf(context, 'waiting-1', {
        life: 'starting',
        pendingSetup: { setupSessionId: 'setup-1' },
        pendingOperationId: 'operation-waiting-1',
        pendingOperationKind: 'create',
      }),
      recordOf(context, 'setup-1', {
        life: 'starting',
        commands: [{ command: 'echo installed', cwd: context.root }],
        scriptOf: { sessionId: 'waiting-1', phase: 'before', scriptId: 'setup', name: 'setup' },
        pendingOperationId: 'operation-setup-1',
        pendingOperationKind: 'create',
      }),
      recordOf(context, 'failed-1', {
        pendingSetup: { setupSessionId: 'setup-2' },
        endedReason: 'setup failed: the setup exited with 7',
      }),
      recordOf(context, 'lost-1', { life: 'lost', pendingSetup: { setupSessionId: 'setup-3' } }),
      recordOf(context, 'skipped-1', {
        setupSkipped: { reason: 'the project declares an empty setup in .worktree.json' },
      }),
      recordOf(context, 'live-1', {
        life: 'live',
        binding: { hostInstanceId: 'fake-host-1', generation: 1 },
        pendingSetup: { setupSessionId: 'setup-4' },
      }),
      recordOf(context, 'plain-1', {}),
    ])
    // The Host has exactly the runtime `live-1` is bound to, so the reconcile writes nothing over
    // that record and its wait survives as the hand-edited file it stands for.
    context.runtimes.set('live-1', runtime('live-1'))
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)
    // A refused operation is still a full reconcile pass, which is what the `live-1` claim needs.
    expect(await client.manager.removeSession('never-existed')).toMatchObject({ code: 'not-found' })

    expect(sessionOf(client, 'waiting-1')?.setup)
      .toEqual({ state: 'running', setupSessionId: 'setup-1', commands: ['echo installed'] })
    expect(sessionOf(client, 'setup-1')?.setupFor).toBe('waiting-1')
    expect(sessionOf(client, 'setup-1')?.setup).toBeUndefined()
    expect(sessionOf(client, 'failed-1')?.setup)
      .toEqual({ state: 'failed', setupSessionId: 'setup-2', commands: [] })
    expect(sessionOf(client, 'lost-1')?.setup)
      .toEqual({ state: 'failed', setupSessionId: 'setup-3', commands: [] })
    expect(sessionOf(client, 'skipped-1')?.setup).toEqual({
      state: 'skipped',
      reason: 'the project declares an empty setup in .worktree.json',
    })
    // A session the Host is demonstrably running is past its install, whatever the record still says
    // - and what it says is checked on disk, so a reconcile that had cleared it could not pass here.
    expect(sessionOf(client, 'live-1')?.setup).toBeUndefined()
    expect(storedRecord(context, 'live-1')?.pendingSetup).toEqual({ setupSessionId: 'setup-4' })
    const plain = sessionOf(client, 'plain-1')
    if (plain === undefined) throw new Error('the seeded record is missing from the snapshot')
    expect(Object.keys(plain)).not.toContain('setup')
    expect(Object.keys(plain)).not.toContain('setupFor')

    // The same waits in the words this build's tree draws, composed beside the legacy fields.
    expect(sessionOf(client, 'setup-1')?.script).toEqual({ parentId: 'waiting-1', phase: 'before', scriptId: 'setup' })
    expect(sessionOf(client, 'waiting-1')?.scripts).toMatchObject({
      runs: [{ runId: 'setup-1', state: 'running', row: true, summary: 'setup-1 · running' }],
      badge: { phase: 'before', state: 'running', text: 'installing dependencies', runId: 'setup-1' },
      waitingOn: 'setup-1',
    })
    expect(sessionOf(client, 'failed-1')?.scripts).toEqual({
      runs: [],
      badge: {
        phase: 'before',
        state: 'failed',
        text: 'setup failed',
        title: 'Setup failed: the setup exited with 7',
        runId: 'setup-2',
      },
    })
    expect(sessionOf(client, 'skipped-1')?.scripts?.badge).toMatchObject({ state: 'skipped', text: 'setup skipped' })
    expect(sessionOf(client, 'live-1')?.scripts).toBeUndefined()
    expect(Object.keys(plain)).not.toContain('scripts')
    expect(Object.keys(plain)).not.toContain('script')

    // Another full pass over a setup still running changes nothing the snapshot says.
    const revision = client.manager.snapshot().revision
    expect(await client.manager.removeSession('never-existed')).toMatchObject({ code: 'not-found' })
    expect(client.manager.snapshot().revision).toBe(revision)
    expect(client.errors).toEqual([])
  }, 20_000)

  /*
   * The marker is content, so it is part of what the revision identifies: a client told
   * `sessions:changed` because an install decided against a session has to be able to see that in the
   * snapshot that revision names.
   */
  it('moves the revision when the install a session was waiting for decides against it', async () => {
    const context = await world()
    seedRecords(context, [
      recordOf(context, 'waiting-2', {
        life: 'starting',
        pendingSetup: { setupSessionId: 'setup-5' },
        pendingOperationId: 'operation-waiting-2',
        pendingOperationKind: 'create',
      }),
      recordOf(context, 'setup-5', {
        life: 'live',
        binding: { hostInstanceId: 'fake-host-1', generation: 1 },
        commands: [{ command: 'exit 7', cwd: context.root }],
        scriptOf: { sessionId: 'waiting-2', phase: 'before', scriptId: 'setup', name: 'setup' },
      }),
    ])
    context.runtimes.set('setup-5', runtime('setup-5'))
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await vi.waitFor(
      () => expect(sessionOf(client, 'waiting-2')?.setup)
        .toEqual({ state: 'running', setupSessionId: 'setup-5', commands: ['exit 7'] }),
      { timeout: 5_000 },
    )
    const installing = client.manager.snapshot().revision

    const running = context.runtimes.get('setup-5')
    if (!running) throw new Error('the fake Host lost the setup runtime')
    context.runtimes.set('setup-5', { ...running, alive: false, exitCode: 7 })

    await vi.waitFor(
      () => expect(sessionOf(client, 'waiting-2')?.setup)
        .toEqual({ state: 'failed', setupSessionId: 'setup-5', commands: ['exit 7'] }),
      { timeout: 10_000 },
    )
    expect(sessionOf(client, 'waiting-2')).toMatchObject({
      life: 'ended',
      endedReason: 'setup failed: the setup exited with 7',
    })
    expect(client.manager.snapshot().revision).toBeGreaterThan(installing)
    expect(client.errors).toEqual([])
  }, 20_000)

  describe('which repository worktrees are cut from', () => {
    /**
     * The wiring is asserted on DISK rather than by reading a private field, because the disk is the
     * only place where a provisioner that was built but never handed down looks different from one
     * that reached the lifecycle.
     */
    async function worktreeProject(context: World): Promise<string> {
      const project = join(context.categoryRoot, 'Wiring')
      mkdirSync(project, { recursive: true })
      writeFileSync(join(project, 'a.txt'), 'v1\n', 'utf8')
      return project
    }

    /** The project's own repository, one commit deep, with an identity of its own for Finish. */
    async function gitProject(context: World): Promise<string> {
      const project = await worktreeProject(context)
      const git = new GitInvoker()
      for (const args of [
        ['init', '-b', 'main'],
        ['config', 'user.name', 'Session Manager Test'],
        ['config', 'user.email', 'session-manager@example.invalid'],
        ['config', 'commit.gpgsign', 'false'],
        ['add', '-A'],
        ['commit', '-m', 'base'],
      ]) {
        const outcome = await git.run(project, args)
        expect(outcome.code, outcome.stderr).toBe(0)
      }
      return project
    }

    async function skipWithoutGit(runner: { skip: () => void }): Promise<void> {
      const version = await new GitInvoker().run(tmpdir(), ['--version'])
      if (version.failure !== null || version.code !== 0)
        runner.skip()
    }

    /** No `versioningModeOf` passed: the default is checkpoints, and the store-cut worktree is retired. */
    it('refuses a project with no SVN and no Git of its own in the default mode, creating nothing', {
      timeout: 120_000,
    }, async (runner) => {
      await skipWithoutGit(runner)
      const context = await world()
      context.publishDescriptor()
      const client = clientOf(context)
      await client.manager.start()
      await writable(client)
      const project = await worktreeProject(context)

      const refused = await client.manager.createSession({
        kind: 'shell',
        directory: { mode: 'project', categoryId: 'code', projectPath: project },
        worktree: { slug: 'wiring' },
      })

      expect(refused).toMatchObject({ ok: false, code: 'invalid-spec', detail: expect.stringMatching(/no SVN working copy and no Git repository/) })
      expect(existsSync(join(project, CheckpointLayout.folderNameConst))).toBe(false)
      expect(existsSync(join(project, '.worktrees'))).toBe(false)
      expect(existsSync(join(project, '.git'))).toBe(false)
    })

    /**
     * A project with its own Git repository gets the worktree of `git` mode in `checkpoints` mode,
     * numbered, and Finish lands it in that repository whichever mode is set when it runs: the merge
     * flow reads no mode.
     */
    it('gives a project with its own Git the git-mode worktree, and finishes it the same under both modes', {
      timeout: 120_000,
    }, async (runner) => {
      await skipWithoutGit(runner)
      const context = await world()
      handleStop(context, { exits: true })
      context.publishDescriptor()
      let mode: 'checkpoints' | 'git' = 'checkpoints'
      const client = clientOf(context, { versioningModeOf: () => mode })
      await client.manager.start()
      await writable(client)
      const project = await gitProject(context)

      const finishUnder = async (finishMode: 'checkpoints' | 'git', file: string) => {
        mode = 'checkpoints'
        const created = valueOf(await client.manager.createSession({
          kind: 'agent',
          directory: { mode: 'project', categoryId: 'code', projectPath: project },
          agent: { agentId: 'claude', mode: 'new', nativeSessionId: `native-${file}` },
          worktree: { slug: file },
        }))
        const worktree = sessionOf(client, created.sessionId)?.worktree
        expect(worktree).toMatchObject({ kind: 'git', branch: expect.stringMatching(new RegExp(`^jamat/\\d{3}-${file}$`)) })
        // The answer names the number and the place, so a script never lists `.worktrees` to find it.
        expect(created).toMatchObject({
          number: expect.stringMatching(/^\d{3}$/),
          worktree: { kind: 'git', worktreePath: worktree?.worktreePath, url: null, baseRevision: null },
        })
        expect(statSync(join(worktree?.worktreePath ?? '', '.git')).isFile()).toBe(true)
        writeFileSync(join(worktree?.worktreePath ?? '', `${file}.txt`), 'from the session\n', 'utf8')
        valueOf(await client.manager.finalizeSession(created.sessionId))
        mode = finishMode
        expect(await client.manager.finalizeSession(created.sessionId)).toMatchObject({ ok: false, code: 'review-unavailable' })
        valueOf(await client.manager.finishWorktreeSession(created.sessionId, { choice: 'commit', requestedBy: 'window',
          selection: [join(worktree!.worktreePath, `${file}.txt`)], message: `Land ${file}` }))
        expect(existsSync(worktree?.worktreePath ?? '')).toBe(false)
        expect(sessionOf(client, created.sessionId)).toBeUndefined()
        expect(storedRecord(context, created.sessionId)).toBeUndefined()
      }

      await finishUnder('checkpoints', 'one')
      await finishUnder('git', 'two')

      expect(readFileSync(join(project, 'one.txt'), 'utf8')).toContain('from the session')
      expect(readFileSync(join(project, 'two.txt'), 'utf8')).toContain('from the session')
      const merges = await new GitInvoker().run(project, ['log', '--merges', '--format=%s'])
      expect(merges.stdout.trim().split('\n')).toHaveLength(2)
      expect(existsSync(join(project, CheckpointLayout.folderNameConst))).toBe(false)
    })

    /*
     * The after chain end to end through the manager: the press that starts the checks answers at
     * once and merges nothing, the worktree is held while they run, and their pass presses Finish
     * again, which merges and removes the session with its check run.
     */
    it('waits for the live Git runtime to exit before committing the window selection', { timeout: 120_000 }, async () => {
      const context = await world()
      const stopping = handleStop(context, { exits: false })
      context.publishDescriptor()
      const client = clientOf(context, { exitClock: virtualClock().clock })
      await client.manager.start()
      await writable(client)
      const project = await gitProject(context)
      const created = valueOf(await client.manager.createSession({ kind: 'shell',
        directory: { mode: 'project', categoryId: 'code', projectPath: project }, worktree: { slug: 'pp-u11-live' } }))
      const path = sessionOf(client, created.sessionId)!.worktree!.worktreePath
      writeFileSync(join(path, 'selected.txt'), 'approved work')
      const press = { choice: 'commit' as const, requestedBy: 'window' as const,
        selection: [join(path, 'selected.txt')], message: 'Approved after stopping' }
      valueOf(await client.manager.finishWorktreeSession(created.sessionId, { choice: 'commit', requestedBy: 'window' }))
      expect(stopping.calls()).toBe(0)
      expect(await client.manager.finishWorktreeSession(created.sessionId, press)).toMatchObject({ ok: false, code: 'live-refused' })
      expect(stopping.calls()).toBe(1)
      expect(existsSync(join(project, 'selected.txt'))).toBe(false)
      expect((await new GitInvoker().run(path, ['log', '-1', '--format=%s'])).stdout.trim()).toBe('base')
      context.runtimes.set(created.sessionId, runtime(created.sessionId, { alive: false, exitCode: 0, exitedAt: Date.now() }))
      valueOf(await client.manager.finishWorktreeSession(created.sessionId, press))
      expect(existsSync(path)).toBe(false)
      expect(readFileSync(join(project, 'selected.txt'), 'utf8')).toBe('approved work')
    })

    it('runs the declared after checks before a Finish, and merges once they pass', {
      timeout: 120_000,
    }, async (runner) => {
      await skipWithoutGit(runner)
      const context = await world()
      const stopping = handleStop(context, { exits: true })
      context.publishDescriptor()
      const client = clientOf(context)
      await client.manager.start()
      await writable(client)
      const project = await gitProject(context)
      writeFileSync(join(project, '.worktree.json'), JSON.stringify({
        scripts: { after: [{ name: 'tests', command: 'pnpm test' }] },
      }), 'utf8')
      const spec = {
        kind: 'shell' as const,
        directory: { mode: 'project' as const, categoryId: 'code', projectPath: project },
        worktree: { slug: 'checked' },
      }
      const asked = await client.manager.createSession(spec)
      if (asked.ok) throw new Error('a project with after checks was created without an agreement')
      expect(asked).toMatchObject({ code: 'setup-not-acknowledged', setup: { commands: ['after tests: pnpm test'] } })
      const created = valueOf(await client.manager.createSession({ ...spec, acknowledgeSetup: asked.setup?.hash }))
      const worktreePath = sessionOf(client, created.sessionId)?.worktree?.worktreePath ?? ''
      writeFileSync(join(worktreePath, 'checked.txt'), 'from the session\n', 'utf8')

      valueOf(await client.manager.finishWorktreeSession(created.sessionId, { choice: 'commit', requestedBy: 'window' }))
      expect(sessionOf(client, created.sessionId)?.life).toBe('live')
      expect(stopping.calls()).toBe(0)
      valueOf(await client.manager.finishWorktreeSession(created.sessionId, { choice: 'commit', requestedBy: 'window',
        selection: [join(worktreePath, 'checked.txt')], message: 'Checked changes' }))
      const runOf = () => client.manager.snapshot().sessions.find((session) => session.script?.parentId === created.sessionId)
      const runId = runOf()?.sessionId ?? ''
      expect(runOf()).toMatchObject({ script: { phase: 'after', scriptId: 'declared' }, life: 'live' })
      expect(existsSync(join(project, 'checked.txt'))).toBe(false)
      const parent = sessionOf(client, created.sessionId)
      expect(parent?.scripts?.badge).toMatchObject({ phase: 'after', state: 'running', text: 'checks: tests' })
      expect(parent?.admits).not.toContain('discardWorktree')
      expect(parent?.admits).not.toContain('restart')
      expect(await client.manager.discardWorktree(created.sessionId)).toMatchObject({ ok: false, code: 'merge-pending' })
      // A press while the checks run starts nothing more.
      valueOf(await client.manager.finalizeSession(created.sessionId))
      expect(client.manager.snapshot().sessions.filter((session) => session.script?.parentId === created.sessionId))
        .toHaveLength(1)

      context.runtimes.set(runId, runtime(runId, { alive: false, exitCode: 0, exitedAt: Date.now() }))
      await vi.waitFor(() => expect(sessionOf(client, created.sessionId)?.worktree).toBeUndefined(), { timeout: 20_000 })
      expect(readFileSync(join(project, 'checked.txt'), 'utf8')).toContain('from the session')
      expect(existsSync(worktreePath)).toBe(false)
      await vi.waitFor(() => expect(sessionOf(client, runId)).toBeUndefined())
      // This fake Host answers an inspect without rows, so the run is settled without a log.
      expect(client.errors.filter((message) => !message.includes('nothing was installed')
        && !message.includes('settled without a saved log'))).toEqual([])
    })

    /** The escape hatch, for somebody running AppJamatV3 without the shared instructions. */
    it('refuses in git mode when the project is not a repository', {
      timeout: 120_000,
    }, async (runner) => {
      await skipWithoutGit(runner)
      const context = await world()
      context.publishDescriptor()
      const client = clientOf(context, { versioningModeOf: () => 'git' })
      await client.manager.start()
      await writable(client)
      const project = await worktreeProject(context)

      const refused = await client.manager.createSession({
        kind: 'shell',
        directory: { mode: 'project', categoryId: 'code', projectPath: project },
        worktree: { slug: 'wiring' },
      })

      expect(refused).toMatchObject({ ok: false, code: 'not-a-repo' })
      expect(existsSync(join(project, CheckpointLayout.storeRelativeConst))).toBe(false)
      expect(existsSync(join(project, '.worktrees'))).toBe(false)
    })
  })
})
