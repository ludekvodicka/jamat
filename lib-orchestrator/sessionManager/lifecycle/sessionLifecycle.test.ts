import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  RuntimeLaunchSpec,
  RuntimeListResult,
  RuntimeSessionInfo,
} from '../../../app-host/app/wire/hostWire.js'
import type { GitErrorCode, GitResult, WorktreeFacts } from '../../git/git.types'
import type { CodexRolloutMatch } from '../../projectManager/codexRolloutView'
import type { HostCallFailure } from '../../hostClient/hostClient.types'
import type { DeclaredSetup, SetupResolution } from '../../projectSetup/projectSetup.types'
import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import { AgentPresets } from '../launch/agentPresets'
import type { SessionRecord } from '../records/sessionRecord.types'
import { SessionRecordsStore } from '../records/sessionRecordsStore'
import type {
  SessionCreateSpec,
  SessionHistoryOpenSpec,
  SessionsOpResult,
} from '../sessionManagerApi.types'
import {
  SessionLifecycle,
  type SessionClaudeTitlesPort,
  type SessionCodexRolloutsPort,
  type SessionHostPort,
  type SessionNumbersPort,
  type SessionSetupPort,
  type SessionWorktreePort,
} from './sessionLifecycle'

describe('lib-orchestrator/sessionManager/lifecycle/sessionLifecycle', () => {
  const created: string[] = []
  /** The project every worktree here is cut from, and where `fakeWorktrees` says it landed. */
  const projectRoot = join('Q:', 'apps', 'one')
  const worktreePath = join(projectRoot, '.worktrees', 'fix')

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  interface HostCall {
    name: string
    body: Record<string, unknown>
  }

  interface FakeHost {
    port: SessionHostPort
    calls: HostCall[]
    runtimes: Map<string, RuntimeSessionInfo>
    hostInstanceId: string
    /** What the Host answers, in the wire's own shape: an `op-rejected` has to name its status. */
    failure: HostCallFailure | null
    /** The same, for the launch calls only: a Host that answers `runtime.list` and refuses the rest. */
    launchFailure: HostCallFailure | null
    /**
     * The Host ran the operation and the client never heard the answer - the crash the whole pending
     * record exists for. The operation stays in the ledger, so a replay meets the real dedup.
     */
    loseAnswer: boolean
    onCreate: (() => void) | null
    listing(): RuntimeListResult
  }

  type FakeRun =
    | { ok: true; session: RuntimeSessionInfo }
    | { ok: false; detail: string }

  interface FakeWorktrees {
    port: SessionWorktreePort
    calls: { repositoryRoot: string; slug: string; baseRef?: string }[]
    outcome: GitResult<WorktreeFacts>
  }

  interface FakeSetup {
    port: SessionSetupPort
    calls: { projectRoot: string; repositoryRoot: string }[]
    /** What the member answers about every project; a test that cares about one replaces it. */
    resolution: SetupResolution
    /** Null is the common case: nothing is declared by the project itself, so no gate applies. */
    declared: DeclaredSetup | null
    acknowledged: { projectRoot: string; hash: string }[]
    /** Called after each answer, so a test can move the file between the two reads of it. */
    onDeclared: ((call: number) => void) | null
    declaredCalls: number
  }

  interface FakeNumbers {
    /** What `allocate` hands out; null is the store saying it could not take one. */
    token: string | null
    calls: { projectPath: string }[]
    port: SessionNumbersPort
  }

  interface Harness {
    lifecycle: SessionLifecycle
    store: SessionRecordsStore
    host: FakeHost
    worktrees: FakeWorktrees
    setup: FakeSetup
    numbers: FakeNumbers
    codexRollouts: FakeCodexRollouts
    claudeTitles: FakeClaudeTitles
    snapshotsDirectory: string
    /** The records file itself, so a case can make it unwritable AFTER it has been seeded. */
    recordsFile: string
    reports: string[]
    workDirectory: string
    /** Which agents the switch is on for, mutable so one harness can be read twice. */
    yolo: Set<'claude' | 'codex'>
    /** The stored default model per agent, mutable for the same reason. */
    models: Map<'claude' | 'codex', string>
    /** The stored default effort per agent, on the same footing as the model beside it. */
    efforts: Map<'claude' | 'codex', string>
    /** Every directory the Claude trust seed was asked to answer for. */
    seeded: string[]
    /** Every session id the reconciler asked to have its merge carried on. */
    resumed: string[]
    /** The lifecycle's clock, movable so a case can wait out a replay backoff. */
    clock: { now: number }
  }

  interface FakeCodexRollouts {
    /** What Codex is pretending to have written, keyed by the directory it ran in. */
    byDirectory: Map<string, CodexRolloutMatch[]>
    /** The directory and exact launch window each capture pass asked to read. */
    windowCalls: { directory: string; from: number; until: number }[]
    port: SessionCodexRolloutsPort
  }

  interface FakeClaudeTitles {
    /** What `appendTitle` answers; an Error here is thrown, which is the port's own I/O going wrong. */
    outcome: boolean | Error
    calls: { cwd: string; nativeSessionId: string; title: string }[]
    port: SessionClaudeTitlesPort
  }

  function fakeClaudeTitles(): FakeClaudeTitles {
    const calls: FakeClaudeTitles['calls'] = []
    const fake: FakeClaudeTitles = {
      outcome: true,
      calls,
      port: {
        async appendTitle(input) {
          calls.push({ ...input })
          if (fake.outcome instanceof Error) throw fake.outcome
          return fake.outcome
        },
      },
    }
    return fake
  }

  function fakeCodexRollouts(): FakeCodexRollouts {
    const byDirectory = new Map<string, CodexRolloutMatch[]>()
    const windowCalls: { directory: string; from: number; until: number }[] = []
    return {
      byDirectory,
      windowCalls,
      port: {
        async rolloutsBetween(directory, from, until) {
          windowCalls.push({ directory, from, until })
          return (byDirectory.get(directory) ?? [])
            .filter((match) => match.createdAt >= from && match.createdAt <= until)
        },
      },
    }
  }

  /** One rollout the fake store holds. A conversation nobody forked names no parent. */
  function rollout(
    sessionId: string,
    createdAt: number,
    forkedFromId: string | null = null,
  ): CodexRolloutMatch {
    return { sessionId, createdAt, forkedFromId }
  }

  function fakeNumbers(): FakeNumbers {
    const calls: FakeNumbers['calls'] = []
    const fake: FakeNumbers = {
      token: '007',
      calls,
      port: {
        async allocate(projectPath) {
          calls.push({ projectPath })
          return fake.token
        },
      },
    }
    return fake
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

  function fakeHost(): FakeHost {
    const calls: HostCall[] = []
    const runtimes = new Map<string, RuntimeSessionInfo>()
    const operations = new Map<string, {
      kind: 'create' | 'replace'
      requestKey: string
      runtimeSessionId: string
      generation: number
    }>()
    /**
     * The Host's own idempotence, mirrored from `app-host/app/sessions/sessionStore.ts` and its
     * caller: an operationId it already ran answers with what it did instead of running a second
     * time, an id reused for a different request is refused, and a recorded answer whose runtime is
     * no longer current is refused as `conflict` - which `ServiceSessions.status` answers as 409.
     */
    const ran = (
      kind: 'create' | 'replace',
      operationId: string,
      requestKey: string,
      perform: () => RuntimeSessionInfo,
    ): FakeRun => {
      const previous = operations.get(operationId)
      if (previous) {
        if (previous.kind !== kind || previous.requestKey !== requestKey)
          return { ok: false, detail: `operationId ${operationId} was reused for a different request` }
        const current = runtimes.get(previous.runtimeSessionId)
        if (!current || current.generation !== previous.generation)
          return {
            ok: false,
            detail: `Operation result ${previous.runtimeSessionId}:${previous.generation} is no longer current`,
          }
        return { ok: true, session: current }
      }
      const session = perform()
      operations.set(operationId, {
        kind,
        requestKey,
        runtimeSessionId: session.runtimeSessionId,
        generation: session.generation,
      })
      return { ok: true, session }
    }
    const fake: FakeHost = {
      calls,
      runtimes,
      hostInstanceId: 'host-1',
      failure: null,
      launchFailure: null,
      loseAnswer: false,
      onCreate: null,
      listing: () => ({
        sessions: [...runtimes.values()],
        throughRevision: 1,
        hostInstanceId: fake.hostInstanceId,
      }),
      port: {
        async runtimeCreate(request) {
          calls.push({ name: 'runtime.create', body: { ...request } })
          fake.onCreate?.()
          if (fake.failure) return fake.failure
          if (fake.launchFailure) return fake.launchFailure
          const outcome = ran(
            'create',
            request.operationId,
            JSON.stringify({ id: request.runtimeSessionId, launch: request.launch }),
            () => {
              const session = runtime(request.runtimeSessionId, {
                generation: (runtimes.get(request.runtimeSessionId)?.generation ?? 0) + 1,
              })
              runtimes.set(session.runtimeSessionId, session)
              return session
            },
          )
          if (!outcome.ok)
            return { ok: false, code: 'op-rejected', status: 409, detail: outcome.detail }
          if (fake.loseAnswer)
            return { ok: false, code: 'host-unreachable', detail: 'the answer never arrived' }
          return { ok: true, value: { session: outcome.session, hostInstanceId: fake.hostInstanceId } }
        },
        async runtimeReplace(request) {
          calls.push({ name: 'runtime.replace', body: { ...request } })
          if (fake.failure) return fake.failure
          if (fake.launchFailure) return fake.launchFailure
          const outcome = ran(
            'replace',
            request.operationId,
            JSON.stringify({ target: request.target, launch: request.launch }),
            () => {
              const session = runtime(request.target.runtimeSessionId, {
                generation: request.target.generation + 1,
              })
              runtimes.set(session.runtimeSessionId, session)
              return session
            },
          )
          if (!outcome.ok)
            return { ok: false, code: 'op-rejected', status: 409, detail: outcome.detail }
          if (fake.loseAnswer)
            return { ok: false, code: 'host-unreachable', detail: 'the answer never arrived' }
          return { ok: true, value: { session: outcome.session, hostInstanceId: fake.hostInstanceId } }
        },
        async runtimeList() {
          calls.push({ name: 'runtime.list', body: {} })
          if (fake.failure) return fake.failure
          return { ok: true, value: fake.listing() }
        },
        async runtimeStop(target) {
          calls.push({ name: 'runtime.stop', body: { target } })
          if (fake.failure) return fake.failure
          const found = runtimes.get(target.runtimeSessionId)
          if (found) runtimes.set(target.runtimeSessionId, { ...found, alive: false, exitCode: 0 })
          return {
            ok: true,
            value: { servedByHostInstanceId: fake.hostInstanceId, target, diagnostic: 'stopped' },
          }
        },
        async runtimeRemove(target) {
          calls.push({ name: 'runtime.remove', body: { target } })
          if (fake.failure) return fake.failure
          runtimes.delete(target.runtimeSessionId)
          return {
            ok: true,
            value: { servedByHostInstanceId: fake.hostInstanceId, target, diagnostic: 'removed' },
          }
        },
      },
    }
    return fake
  }

  function fakeWorktrees(): FakeWorktrees {
    const calls: FakeWorktrees['calls'] = []
    const fake: FakeWorktrees = {
      calls,
      outcome: {
        ok: true,
        value: {
          worktreePath,
          branch: 'jamat/fix',
          baseCommit: 'abc123',
          repositoryRoot: projectRoot,
        },
      },
      port: {
        async create(repositoryRoot, slug, baseRef) {
          calls.push({ repositoryRoot, slug, baseRef })
          return fake.outcome
        },
      },
    }
    return fake
  }

  function fakeSetup(): FakeSetup {
    const calls: FakeSetup['calls'] = []
    const acknowledged: FakeSetup['acknowledged'] = []
    const fake: FakeSetup = {
      calls,
      acknowledged,
      resolution: { kind: 'none', reason: 'no known project family detected' },
      declared: null,
      onDeclared: null,
      declaredCalls: 0,
      port: {
        async resolve(projectRoot, repositoryRoot) {
          calls.push({ projectRoot, repositoryRoot })
          return fake.resolution
        },
        async declaredSetup() {
          const answer = fake.declared
          fake.declaredCalls += 1
          fake.onDeclared?.(fake.declaredCalls)
          return answer
        },
        acknowledgeSetup(projectRoot, hash) {
          acknowledged.push({ projectRoot, hash })
          if (fake.declared) fake.declared = { ...fake.declared, acknowledged: true }
        },
      },
    }
    return fake
  }

  async function harness(
    options?: {
      damagedRecords?: boolean
      unwritableRecords?: boolean
      /** What the trust seed answers; the default is the quiet success of an already-trusted one. */
      seedProblem?: string
    },
  ): Promise<Harness> {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-session-lifecycle-'))
    created.push(root)
    const file = join(root, 'session-records.json')
    if (options?.damagedRecords) writeFileSync(file, '{ not json', 'utf8')
    // A DIRECTORY at the records path, which is how the store's own test stages a file that cannot
    // be written: absent as far as reading goes, so nothing latches, and impossible to write on
    // every platform. The store, the commit and the failure are all the real ones.
    if (options?.unwritableRecords) mkdirSync(file)
    const snapshotsDirectory = join(root, 'session-snapshots')
    const reports: string[] = []
    const store = await SessionRecordsStore.load(file, {
      snapshotsDirectory,
      report: (message) => reports.push(message),
    })
    const host = fakeHost()
    const worktrees = fakeWorktrees()
    const setup = fakeSetup()
    const numbers = fakeNumbers()
    const codexRollouts = fakeCodexRollouts()
    const claudeTitles = fakeClaudeTitles()
    let minted = 0
    // Movable, because the replay backoff is measured against it: a fixed clock makes every pass
    // land in the same instant, which is exactly the case the pacing is supposed to thin out.
    const clock = { now: 5_000 }
    const yolo = new Set<'claude' | 'codex'>()
    const models = new Map<'claude' | 'codex', string>()
    const efforts = new Map<'claude' | 'codex', string>()
    const seeded: string[] = []
    const resumed: string[] = []
    return {
      store,
      recordsFile: file,
      host,
      worktrees,
      setup,
      numbers,
      codexRollouts,
      claudeTitles,
      snapshotsDirectory,
      reports,
      workDirectory: root,
      yolo,
      models,
      efforts,
      seeded,
      resumed,
      clock,
      lifecycle: wire(new SessionLifecycle({
        controller: { configIdentity: 'controller-1', channel: 'development' },
        records: store,
        host: host.port,
        worktrees: worktrees.port,
        setup: setup.port,
        numbers: numbers.port,
        codexRollouts: codexRollouts.port,
        claudeTitles: claudeTitles.port,
        // The one channel the client has for a fact it cannot put in a result, and the store's own
        // damage report goes to the same place in production.
        report: (message) => reports.push(message),
        yoloFor: (agentId) => yolo.has(agentId),
        modelFor: (agentId) => models.get(agentId),
        effortFor: (agentId) => efforts.get(agentId),
        seedClaudeTrust: (cwd) => {
          seeded.push(cwd)
          return options?.seedProblem === undefined
            ? { changed: true, problem: null }
            : { changed: false, problem: options.seedProblem }
        },
        newId: () => `id-${++minted}`,
        now: () => clock.now,
      }), (sessionId) => resumed.push(sessionId)),
    }
  }

  /**
   * The setter the session manager calls after construction, because the merge flow needs the
   * lifecycle to exist first. Nothing tested it, and letting it go unwired is exactly the mistake
   * that leaves every automatically resolved conflict sitting at `resolving` for ever.
   */
  function wire(lifecycle: SessionLifecycle, resume: (sessionId: string) => void): SessionLifecycle {
    lifecycle.setResumeMerge(resume)
    return lifecycle
  }

  function shellSpec(path: string): SessionCreateSpec {
    return { kind: 'shell', directory: { mode: 'adHoc', path } }
  }

  /** A worktree is what asks for a setup, not the agent, so the plainest session carries one. */
  function worktreeSpec(): SessionCreateSpec {
    return {
      kind: 'shell',
      directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
      worktree: { slug: 'fix' },
    }
  }

  /** `machine` unless a test says otherwise: only the project's own tier meets the agreement gate. */
  function installing(
    steps: { command: string; cwd: string }[],
    origin: 'project' | 'machine' = 'machine',
  ): SetupResolution {
    return { kind: 'setup', origin, steps }
  }

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

  /**
   * The session waiting for a setup, and the setup preparing it - the pair `create` writes, in the
   * shape it leaves on disk, so a judgement can be driven from stored records the way the
   * reconciler's own matrix drives it.
   */
  function waiting(overrides?: Partial<SessionRecord>): SessionRecord {
    return record('p1', {
      directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
      life: 'starting',
      binding: null,
      pendingOperationId: 'op-7',
      pendingOperationKind: 'create',
      pendingSetup: { setupSessionId: 's1' },
      worktree: {
        worktreePath,
        branch: 'jamat/fix',
        baseCommit: 'abc123',
        repositoryRoot: projectRoot,
      },
      ...overrides,
    })
  }

  /** The same session after its setup failed: nothing pending, the wait kept as the retry's marker. */
  function failedWaiting(overrides?: Partial<SessionRecord>): SessionRecord {
    return waiting({
      life: 'ended',
      pendingOperationId: undefined,
      pendingOperationKind: undefined,
      endedAt: 4_500,
      endedReason: 'setup failed: the setup exited with 1',
      ...overrides,
    })
  }

  function setupRecord(overrides?: Partial<SessionRecord>): SessionRecord {
    return record('s1', {
      life: 'ended',
      binding: null,
      exitCode: 0,
      endedAt: 4_000,
      directory: { mode: 'adHoc', path: worktreePath },
      commands: [{ command: 'pnpm install', cwd: worktreePath }],
      setupFor: 'p1',
      ...overrides,
    })
  }

  function launchOf(call: HostCall): RuntimeLaunchSpec {
    return call.body.launch as RuntimeLaunchSpec
  }

  function callsNamed(host: FakeHost, name: string): HostCall[] {
    return host.calls.filter((call) => call.name === name)
  }

  function snapshotCount(directory: string): number {
    return existsSync(directory) ? readdirSync(directory).length : 0
  }

  function failureOf(result: SessionsOpResult<unknown>): { code: string; detail: string } {
    if (result.ok) throw new Error('expected a failure')
    return { code: result.code, detail: result.detail }
  }

  /** The other half: a refusal here is the test's own failure, reported with the reason attached. */
  function successOf<T>(result: SessionsOpResult<T>): T {
    if (!result.ok) throw new Error(`expected a success, got ${result.code}: ${result.detail}`)
    return result.value
  }

  // The crash-safe ordering, asserted from inside the wire call: what a client that dies right here
  // leaves behind is a record that names the operation the Host is being asked to run.
  it('writes the starting record with its pending operation BEFORE it calls the Host', async () => {
    const context = await harness()
    let observed: SessionRecord | null = null
    context.host.onCreate = () => { observed = context.store.get('id-1') }

    const result = await context.lifecycle.create(shellSpec(context.workDirectory))

    expect(result).toEqual({ ok: true, value: { sessionId: 'id-1' } })
    expect(observed).toEqual(expect.objectContaining({
      sessionId: 'id-1',
      life: 'starting',
      pendingOperationId: 'id-2',
      pendingOperationKind: 'create',
      binding: null,
    }))
    expect(context.host.calls[0].body.operationId).toBe('id-2')
  })

  it('binds the answer and clears the pending operation', async () => {
    const context = await harness()
    await context.lifecycle.create(shellSpec(context.workDirectory))
    const stored = context.store.get('id-1')
    expect(stored?.life).toBe('live')
    expect(stored?.binding).toEqual({ hostInstanceId: 'host-1', generation: 1 })
    expect(stored?.pendingOperationId).toBeUndefined()
    expect(launchOf(context.host.calls[0]).cwd).toBe(context.workDirectory)
    expect(stored?.transcriptCwd).toBeUndefined()
  })

  it('mints a native session id for a new claude session and launches with it', async () => {
    const context = await harness()
    await context.lifecycle.create({
      kind: 'agent',
      directory: { mode: 'adHoc', path: context.workDirectory },
      agent: { agentId: 'claude', mode: 'new' },
    })
    expect(context.store.get('id-1')?.agent)
      .toEqual({ agentId: 'claude', launchMode: 'new', nativeSessionId: 'id-1' })
    expect(launchOf(context.host.calls[0]).args.slice(-2)).toEqual(['--session-id', 'id-1'])
    expect(launchOf(context.host.calls[0]).env).toMatchObject({
      JAMAT_V3_SESSION_ID: 'id-1', JAMAT_V3_SESSION_CONTROLLER: 'controller-1',
      JAMAT_V3_SESSION_CHANNEL: 'development',
    })
    expect(context.store.get('id-1')?.title)
      .toBe(`${basename(context.workDirectory)} (claude)`)
    expect(context.store.get('id-1')?.transcriptCwd).toBe(context.workDirectory)
  })

  /*
   * The gate in front of a repository's own setup. `projectScanner` calls any directory a level or
   * two under a category root a project, so a clone dropped there is enough to get a `.worktree.json`
   * read - and its `setup` array is the one input this library executes that nobody here wrote.
   */
  describe('a setup the project itself declares', () => {
    const declared: DeclaredSetup = {
      commands: ['./bootstrap.sh'],
      hash: 'hash-1',
      acknowledged: false,
    }

    it('refuses the create, and leaves no worktree behind to be refused around', async () => {
      const context = await harness()
      context.setup.declared = declared

      const result = await context.lifecycle.create(worktreeSpec())

      expect(result).toMatchObject({
        ok: false,
        code: 'setup-not-acknowledged',
        setup: { commands: ['./bootstrap.sh'], hash: 'hash-1' },
      })
      // The whole reason the gate sits before `provisionWorktree` rather than beside the resolution.
      expect(context.worktrees.calls).toEqual([])
      expect(context.store.list()).toEqual([])
    })

    it('goes through when the answer travels back with the spec, and remembers it', async () => {
      const context = await harness()
      context.setup.declared = declared

      const result = await context.lifecycle.create({
        ...worktreeSpec(),
        acknowledgeSetup: 'hash-1',
      })

      expect(result.ok).toBe(true)
      expect(context.setup.acknowledged).toEqual([{ projectRoot, hash: 'hash-1' }])
      expect(context.worktrees.calls).toHaveLength(1)
    })

    // The hash is what was SHOWN. An answer to an older question is not an answer to this one.
    it('refuses an agreement that names a hash the file no longer has', async () => {
      const context = await harness()
      context.setup.declared = declared

      const result = await context.lifecycle.create({
        ...worktreeSpec(),
        acknowledgeSetup: 'hash-of-what-it-said-yesterday',
      })

      expect(result).toMatchObject({ ok: false, code: 'setup-not-acknowledged' })
      expect(context.setup.acknowledged).toEqual([])
    })

    it('lets an already agreed setup through without asking again', async () => {
      const context = await harness()
      context.setup.declared = { ...declared, acknowledged: true }

      expect((await context.lifecycle.create(worktreeSpec())).ok).toBe(true)
      expect(context.setup.acknowledged).toEqual([])
    })

    // Tiers two and three are this machine's own answers; there is nobody else to agree with.
    it('never asks about a command this machine chose', async () => {
      const context = await harness()
      context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])

      expect((await context.lifecycle.create(worktreeSpec())).ok).toBe(true)
    })

    /*
     * The file is read once before the worktree and once to resolve it, and the gap between the two
     * is somebody's chance to swap what runs. Asking again is what closes it; the worktree already
     * exists by then, so the answer is a skip rather than a refusal.
     */
    it('installs nothing when the file moves between the agreement and the resolution', async () => {
      const context = await harness()
      context.setup.declared = { ...declared, acknowledged: true }
      context.setup.resolution = installing([{ command: './bootstrap.sh', cwd: '' }], 'project')
      // The gate reads it agreed; by the time the resolution is checked, the file says something else.
      context.setup.onDeclared = (call) => {
        if (call === 1)
          context.setup.declared = { commands: ['./evil.sh'], hash: 'hash-2', acknowledged: false }
      }

      const result = await context.lifecycle.create(worktreeSpec())

      expect(result.ok).toBe(true)
      expect(context.store.get('id-1')?.setupSkipped?.reason).toContain('not agreed to run')
      expect(JSON.stringify(context.host.calls)).not.toContain('bootstrap')
    })
  })

  /*
   * The combination the whole feature exists for, and the one nothing used to create: an AGENT into a
   * fresh worktree that has to be installed first. Every other setup test uses a shell, so the path
   * this asserts - the session's own launch is not run at create time but replayed after the install
   * exits - was only ever walked with an agent by nobody.
   *
   * What it pins is a silent dependency: the replay rebuilds the launch from the RECORD through
   * `replayArgs`, while a plain create builds it from the SPEC through `createArgs`. They agree today
   * because the record carries everything the spec's agent said. A create-only argument added later
   * would be dropped here and only here - for worktree sessions, and for no other kind.
   */
  it('replays a worktree agent as the create it was, once its install is done', async () => {
    const context = await harness()
    context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])

    const created = await context.lifecycle.create({
      kind: 'agent',
      directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
      agent: { agentId: 'claude', mode: 'new' },
      worktree: { slug: 'fix' },
    })

    expect(created.ok).toBe(true)
    // One runtime so far, and it is the install: the agent waits on disk under its pending pair.
    expect(callsNamed(context.host, 'runtime.create')).toHaveLength(1)
    const installId = context.store.get('id-1')?.pendingSetup?.setupSessionId
    if (installId === undefined) throw new Error('the session waits for no install')

    const install = context.host.runtimes.get(installId)
    if (!install) throw new Error('the fake Host lost the install runtime')
    context.host.runtimes.set(installId, { ...install, alive: false, exitCode: 0 })

    // A succeeded setup does not report itself: it hands the waiting session to the replay, and what
    // comes back is the launch that ran - as the CREATE it was, under the operation id it was written
    // with. The install is a session too, so the pass ends that one beside it.
    expect(await context.lifecycle.reconcile(context.host.listing())).toContainEqual({
      kind: 'retry-launch',
      sessionId: 'id-1',
      operationId: 'id-2',
      operation: 'create',
    })

    const replayed = launchOf(callsNamed(context.host, 'runtime.create')[1])
    // The tail of the launch is the agent's own arguments; the head is the shell that runs it.
    const asCreated = AgentPresets.createArgs(
      { agentId: 'claude', mode: 'new' },
      context.store.get('id-1')?.agent?.nativeSessionId,
    )
    expect(replayed.args.slice(-asCreated.length)).toEqual(asCreated)
    expect(replayed.cwd).toBe(join(projectRoot, '.worktrees', 'fix'))
  })

  it('creates the worktree first and runs the session inside it', async () => {
    const context = await harness()
    const result = await context.lifecycle.create({
      kind: 'agent',
      directory: { mode: 'project', categoryId: 'c1', projectPath: join('Q:', 'apps', 'one') },
      agent: { agentId: 'codex', mode: 'new' },
      worktree: { slug: 'fix', baseRef: 'main' },
    })
    expect(result.ok).toBe(true)
    expect(context.worktrees.calls).toEqual([{
      repositoryRoot: join('Q:', 'apps', 'one'),
      slug: 'fix',
      baseRef: 'main',
    }])
    expect(context.store.get('id-1')?.worktree?.branch).toBe('jamat/fix')
    expect(context.store.get('id-1')?.transcriptCwd).toBe(worktreePath)
    expect(launchOf(context.host.calls[0]).cwd)
      .toBe(join('Q:', 'apps', 'one', '.worktrees', 'fix'))
  })

  // A git failure ends the create where it stands: no record, no runtime, nothing to reconcile.
  it('leaves no record at all when the worktree cannot be created', async () => {
    const context = await harness()
    context.worktrees.outcome = { ok: false, code: 'dirty', detail: 'the base repository is dirty' }
    const result = await context.lifecycle.create({
      kind: 'shell',
      directory: { mode: 'project', categoryId: 'c1', projectPath: join('Q:', 'apps', 'one') },
      worktree: { slug: 'fix' },
    })
    expect(failureOf(result).code).toBe('dirty')
    expect(context.store.list()).toEqual([])
    expect(context.host.calls).toEqual([])
  })

  // Git's codes are carried verbatim, but through a mapping: a code this library has no name for is
  // a loud failure rather than a code the caller cannot read.
  it('throws on a git failure it has no session code for', async () => {
    const context = await harness()
    context.worktrees.outcome = {
      ok: false,
      code: 'submodule-hell' as GitErrorCode,
      detail: 'a code from a later git manager',
    }
    await expect(context.lifecycle.create({
      kind: 'shell',
      directory: { mode: 'project', categoryId: 'c1', projectPath: join('Q:', 'apps', 'one') },
      worktree: { slug: 'fix' },
    })).rejects.toThrow(/Unknown git failure/)
  })

  it('refuses a spec that does not describe a session it could launch', async () => {
    const context = await harness()
    const refusals = await Promise.all([
      context.lifecycle.create({
        kind: 'shell',
        directory: { mode: 'adHoc', path: 'D:\\work' },
        worktree: { slug: 'fix' },
      }),
      context.lifecycle.create({ kind: 'agent', directory: { mode: 'default' } }),
      context.lifecycle.create({
        kind: 'shell',
        directory: { mode: 'default' },
        agent: { agentId: 'claude', mode: 'new' },
      }),
      context.lifecycle.create({
        kind: 'agent',
        directory: { mode: 'default' },
        agent: { agentId: 'claude', mode: 'resume' },
      }),
      context.lifecycle.create({
        kind: 'tmux' as SessionCreateSpec['kind'],
        directory: { mode: 'default' },
      }),
      context.lifecycle.create({ kind: 'shell', directory: { mode: 'adHoc', path: '  ' } }),
      // A flow composes a first instruction, and a shell has nobody to give one to.
      context.lifecycle.create({
        kind: 'shell',
        directory: { mode: 'default' },
        flowId: 'feature-request',
      }),
    ])
    for (const result of refusals)
      expect(failureOf(result).code).toBe('invalid-spec')
    expect(context.store.list()).toEqual([])
  })

  /**
   * Codex names its own conversations and reports the name afterwards, so an id handed in at create
   * names one nobody proved exists - and `reopenModeOf`, `admits.fork` and every transcript reader
   * would trust it. The refusal lives here rather than in the remote validator because what makes
   * the field wrong is the agent and the mode it arrived with, not the shape of the request.
   */
  it('refuses a conversation id on a codex create that starts one, and takes it everywhere else', async () => {
    const context = await harness()
    const refusals = await Promise.all([
      context.lifecycle.create({
        kind: 'agent',
        directory: { mode: 'default' },
        agent: { agentId: 'codex', mode: 'new', nativeSessionId: 'conv-1' },
      }),
      context.lifecycle.create({
        kind: 'agent',
        directory: { mode: 'default' },
        agent: { agentId: 'codex', mode: 'fork', forkParentId: 'conv-1', nativeSessionId: 'conv-2' },
      }),
    ])
    for (const result of refusals)
      expect(failureOf(result).code).toBe('invalid-spec')
    expect(context.store.list()).toEqual([])

    // Resuming names a conversation that already exists, and Claude is told its id at launch anyway.
    successOf(await context.lifecycle.create({
      kind: 'agent',
      directory: { mode: 'default' },
      agent: { agentId: 'codex', mode: 'resume', nativeSessionId: 'conv-1' },
    }))
    const claudeFork = successOf(await context.lifecycle.create({
      kind: 'agent',
      directory: { mode: 'default' },
      agent: { agentId: 'claude', mode: 'fork', forkParentId: 'native-1', nativeSessionId: 'native-2' },
    }))
    expect(context.store.get(claudeFork.sessionId)?.agent?.nativeSessionId).toBe('native-2')
    expect(launchOf(callsNamed(context.host, 'runtime.create')[1]).args.slice(-2))
      .toEqual(['--session-id', 'native-2'])
  })

  /**
   * Both fields ride into the record because both are part of what a replay has to repeat: the
   * prompt is a command-line argument, and the flow is what a later surface would filter by.
   */
  it('stores the flow and the prompt a flow-composed session was created with', async () => {
    const context = await harness()

    const created = await context.lifecycle.create({
      kind: 'agent',
      directory: { mode: 'adHoc', path: context.workDirectory },
      agent: { agentId: 'claude', mode: 'new', initialPrompt: 'Summary: merge a worktree back' },
      flowId: 'feature-request',
      title: '015 - session wizard',
    })

    const stored = context.store.get(successOf(created).sessionId)
    expect(stored?.flowId).toBe('feature-request')
    expect(stored?.agent?.initialPrompt).toBe('Summary: merge a worktree back')
    // And the launch carried it, last, where the CLI reads it as the thing to answer.
    const launch = callsNamed(context.host, 'runtime.create')[0]
    expect((launch.body as { launch: { args: string[] } }).launch.args.at(-1))
      .toBe('Summary: merge a worktree back')
  })

  it('leaves a session created without them unchanged', async () => {
    const context = await harness()

    const created = await context.lifecycle.create({
      kind: 'agent',
      directory: { mode: 'adHoc', path: context.workDirectory },
      agent: { agentId: 'claude', mode: 'new' },
    })

    const stored = context.store.get(successOf(created).sessionId)
    expect(stored?.flowId).toBeUndefined()
    expect(stored?.agent?.initialPrompt).toBeUndefined()
  })

  /**
   * A plain tab is a raw terminal in a directory, and the two shapes refused here are the two that
   * would make it something else. Refusing them at the spec is what keeps the field meaning one thing.
   */
  it('creates a plain tab, and refuses the two shapes a plain tab cannot be', async () => {
    const context = await harness()

    const created = await context.lifecycle.create({
      kind: 'agent',
      directory: { mode: 'adHoc', path: context.workDirectory },
      agent: { agentId: 'claude', mode: 'new' },
      presentation: 'tab',
    })
    expect(context.store.get(successOf(created).sessionId)?.presentation).toBe('tab')

    const refusals = await Promise.all([
      context.lifecycle.create({
        kind: 'agent',
        directory: { mode: 'project', categoryId: 'c', projectPath: context.workDirectory },
        agent: { agentId: 'claude', mode: 'new' },
        presentation: 'tab',
        worktree: { slug: 'isolated' },
      }),
      context.lifecycle.create({
        kind: 'agent',
        directory: { mode: 'adHoc', path: context.workDirectory },
        agent: { agentId: 'claude', mode: 'new' },
        presentation: 'tab',
        flowId: 'feature-request',
      }),
      context.lifecycle.create({
        kind: 'shell',
        directory: { mode: 'default' },
        presentation: 'window' as SessionCreateSpec['presentation'],
      }),
    ])
    for (const result of refusals)
      expect(failureOf(result).code).toBe('invalid-spec')
  })

  // Neither of these two reached a decision, so the pending record is the evidence a replay needs.
  it('keeps the pending record when the Host decided nothing, so it can be replayed', async () => {
    const context = await harness()
    context.host.failure = { ok: false, code: 'host-unreachable', detail: 'no descriptor' }
    expect(failureOf(await context.lifecycle.create(shellSpec(context.workDirectory))).code)
      .toBe('host-unreachable')
    context.host.failure = { ok: false, code: 'no-lease', detail: 'no live controller lease' }
    expect(failureOf(await context.lifecycle.create(shellSpec(context.workDirectory))).code)
      .toBe('no-lease')
    for (const [sessionId, operationId] of [['id-1', 'id-2'], ['id-3', 'id-4']])
      expect(context.store.get(sessionId)).toEqual(expect.objectContaining({
        life: 'starting',
        pendingOperationId: operationId,
        pendingOperationKind: 'create',
      }))
  })

  /*
   * The Host was reached, it judged the REQUEST, and it said no - a cwd that does not exist is the
   * everyday 400. That answer must not become a pending record: the reconciler would replay the
   * refusal every two seconds for the life of the process, and neither stop nor remove would take
   * it away. The record ends instead of being dropped, so the refusal is readable and the session
   * is still there to be removed with whatever the create left on disk.
   */
  it('ends a create the Host refused instead of replaying it for ever', async () => {
    const context = await harness()
    context.host.failure = {
      ok: false,
      code: 'op-rejected',
      status: 400,
      detail: 'launch.cwd must be an existing directory',
    }
    const rejected = failureOf(await context.lifecycle.create(shellSpec(context.workDirectory)))
    expect(rejected.code).toBe('op-rejected')
    expect(rejected.detail).toBe('launch.cwd must be an existing directory')
    expect(context.store.get('id-1')).toEqual(expect.objectContaining({
      life: 'ended',
      binding: null,
      pendingOperationId: undefined,
      pendingOperationKind: undefined,
      endedAt: 5_000,
      endedReason: 'launch.cwd must be an existing directory',
    }))

    context.host.failure = null
    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
    expect(context.host.calls.filter((call) => call.name === 'runtime.create')).toHaveLength(1)
  })

  it('removes the record a refused create left behind', async () => {
    const context = await harness()
    context.host.failure = {
      ok: false,
      code: 'op-rejected',
      status: 400,
      detail: 'the Host said no',
    }
    await context.lifecycle.create(shellSpec(context.workDirectory))
    expect(await context.lifecycle.remove('id-1')).toEqual({ ok: true, value: undefined })
    expect(context.store.get('id-1')).toBeNull()
    // Nothing on the Host corresponds to it, so nothing is asked of the Host.
    expect(callsNamed(context.host, 'runtime.remove')).toEqual([])
  })

  // A create the client never got an answer for leaves a record that names no runtime. It cannot be
  // stopped, so refusing to remove it would leave a session nothing could ever take away.
  it('removes a starting record that never reached the Host', async () => {
    const context = await harness()
    context.host.failure = { ok: false, code: 'host-unreachable', detail: 'no descriptor' }
    await context.lifecycle.create(shellSpec(context.workDirectory))
    expect(context.store.get('id-1')?.life).toBe('starting')
    expect(await context.lifecycle.remove('id-1')).toEqual({ ok: true, value: undefined })
    expect(context.store.get('id-1')).toBeNull()
  })

  it('writes nothing while the records file is unreadable', async () => {
    const context = await harness({ damagedRecords: true })
    expect(failureOf(await context.lifecycle.create(shellSpec(context.workDirectory))).code)
      .toBe('records-latched')
    expect(context.host.calls).toEqual([])
    expect(context.worktrees.calls).toEqual([])
  })

  /*
   * The other half of that, and the half the latch check above cannot reach: the file read cleanly,
   * so nothing latched and the worktree was cut, and it is the WRITE that fails. The `false` from the
   * store does not put the worktree back - nothing here throws away work nobody has looked at - so
   * what a create owes the user is where that worktree is, on the channel `remove` and a failed setup
   * already use, and a refusal that does not tell them the opposite.
   */
  it('names the worktree a create left behind when its record could not be written', async () => {
    const context = await harness({ unwritableRecords: true })
    // Nothing to install, said by the project itself: the one skip that announces nothing, so every
    // line on the error channel here belongs to the failed write.
    context.setup.resolution = { kind: 'empty' }

    const refused = failureOf(await context.lifecycle.create(worktreeSpec()))

    expect(refused.code).toBe('records-latched')
    expect(refused.detail).toContain(worktreePath)
    expect(refused.detail).toContain('jamat/fix')
    expect(refused.detail).not.toMatch(/nothing (here )?changed/)
    // Two lines: the store says the write failed, this says what that write left on disk.
    expect(context.reports).toHaveLength(2)
    expect(context.reports[0]).toContain('could not be written')
    expect(context.reports[1]).toContain(worktreePath)
    expect(context.reports[1]).toContain('jamat/fix')
    expect(context.reports[1]).toContain(projectRoot)

    // No half-record: nothing landed, so a reconcile pass has nothing to act on, and the session
    // never reached the Host.
    expect(context.store.list()).toEqual([])
    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
    expect(context.host.calls).toEqual([])
  })

  // Unreachable is not lost: no answer, no relabelling.
  it('changes nothing when reconciling without an answer from the Host', async () => {
    const context = await harness()
    await context.lifecycle.create(shellSpec(context.workDirectory))
    expect(await context.lifecycle.reconcile(null)).toEqual([])
    expect(context.store.get('id-1')?.life).toBe('live')
  })

  it('loses a session a restarted Host does not have, and reopens it under the same id', async () => {
    const context = await harness()
    await context.lifecycle.create(shellSpec(context.workDirectory))
    context.host.runtimes.clear()
    context.host.hostInstanceId = 'host-2'

    expect(await context.lifecycle.reconcile(context.host.listing()))
      .toEqual([{ kind: 'mark-lost', sessionId: 'id-1' }])
    expect(context.store.get('id-1')).toEqual(expect.objectContaining({
      life: 'lost',
      binding: null,
    }))

    expect(await context.lifecycle.reopen('id-1')).toEqual({ ok: true, value: undefined })
    // The Host had never heard of it, so a reopen is a create - with a new operation id.
    const creates = callsNamed(context.host, 'runtime.create')
    expect(creates).toHaveLength(2)
    expect(creates[1].body.runtimeSessionId).toBe('id-1')
    expect(creates[1].body.operationId).not.toBe(creates[0].body.operationId)
    expect(context.store.get('id-1')).toEqual(expect.objectContaining({
      life: 'live',
      binding: { hostInstanceId: 'host-2', generation: 1 },
    }))
  })

  it('replays a create the client died in the middle of, under the same operation id', async () => {
    const context = await harness()
    await context.store.put(record('s1', {
      life: 'starting',
      binding: null,
      pendingOperationId: 'op-7',
      pendingOperationKind: 'create',
    }))
    const applied = await context.lifecycle.reconcile(context.host.listing())
    expect(applied)
      .toEqual([{
        kind: 'retry-launch',
        sessionId: 's1',
        operationId: 'op-7',
        operation: 'create',
      }])
    expect(context.host.calls[0].body).toEqual(expect.objectContaining({
      operationId: 'op-7',
      runtimeSessionId: 's1',
    }))
    expect(context.store.get('s1')).toEqual(expect.objectContaining({
      life: 'live',
      pendingOperationId: undefined,
      binding: { hostInstanceId: 'host-1', generation: 1 },
    }))
  })

  /*
   * `launchMode` cannot tell these two apart - a create that never ran and a session that has run
   * for an hour both say `new` - and the difference decides the command line: the first has to be
   * replayed as the create it was, the second resumed by the id it left behind. What tells them
   * apart is `pendingOperationKind`, which names the operation that was in flight.
   */
  it('replays an agent create as the create it was, and reopens the same record as a resume',
    async () => {
      const context = await harness()
      const agentRecord = record('s1', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
        life: 'starting',
        binding: null,
        pendingOperationId: 'op-7',
        pendingOperationKind: 'create',
      })
      await context.store.put(agentRecord)

      await context.lifecycle.reconcile(context.host.listing())
      expect(launchOf(callsNamed(context.host, 'runtime.create')[0]).args.slice(-2))
        .toEqual(['--session-id', 'native-1'])

      context.host.runtimes.clear()
      await context.store.put({
        ...agentRecord,
        life: 'lost',
        pendingOperationId: undefined,
        pendingOperationKind: undefined,
      })
      await context.lifecycle.reopen('s1')
      expect(launchOf(callsNamed(context.host, 'runtime.create')[1]).args.slice(-2))
        .toEqual(['--resume', 'native-1'])
    })

  /*
   * The reopen the client died inside. On disk it looks exactly like an interrupted create, so
   * without the pending kind the replay would take the create's `--session-id <uuid>` to a
   * conversation that already exists under that uuid, instead of the `--resume <uuid>` the reopen
   * had already, correctly, chosen.
   */
  it('replays an interrupted reopen as the reopen it was, not as the create', async () => {
    const context = await harness()
    await context.store.put(record('s1', {
      kind: 'agent',
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
      life: 'lost',
      binding: null,
    }))
    context.host.launchFailure = {
      ok: false,
      code: 'host-unreachable',
      detail: 'the socket died mid-call',
    }
    expect(failureOf(await context.lifecycle.reopen('s1')).code).toBe('host-unreachable')
    expect(context.store.get('s1')).toEqual(expect.objectContaining({
      life: 'starting',
      pendingOperationId: 'id-1',
      pendingOperationKind: 'reopen',
    }))

    context.host.launchFailure = null
    const applied = await context.lifecycle.reconcile(context.host.listing())
    expect(applied).toEqual([{
      kind: 'retry-launch',
      sessionId: 's1',
      operationId: 'id-1',
      operation: 'reopen',
    }])
    expect(launchOf(callsNamed(context.host, 'runtime.create')[1]).args.slice(-2))
      .toEqual(['--resume', 'native-1'])
    expect(context.store.get('s1')).toEqual(expect.objectContaining({
      life: 'live',
      pendingOperationId: undefined,
      pendingOperationKind: undefined,
    }))
  })

  // A reopen the Host judged and refused changed nothing, so the record goes back to what it was and
  // there is nothing pending for the reconciler to repeat.
  it('leaves the record as it was when the Host refuses a reopen', async () => {
    const context = await harness()
    const stored = record('s1', { life: 'lost', binding: null })
    await context.store.put(stored)
    context.host.launchFailure = {
      ok: false,
      code: 'op-rejected',
      status: 400,
      detail: 'launch.cwd must be an existing directory',
    }
    expect(failureOf(await context.lifecycle.reopen('s1')).code).toBe('op-rejected')
    expect(context.store.get('s1')).toEqual(stored)
    context.host.launchFailure = null
    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
  })

  /*
   * The other half of that: a Host that refused for a condition of ITS own keeps the pending record,
   * because the next pass can get a different answer. The binding and the ended fields the record
   * arrived with are dropped either way - a `starting` record still naming a dead generation is the
   * one shape `remove` refuses and `stop` fires at, which is a session that can be neither started
   * nor deleted until some Host answers a listing again.
   */
  it('drops the dead binding and the ended fields when a reopen is left pending', async () => {
    const context = await harness()
    await context.store.put(record('s1', {
      life: 'ended',
      binding: { hostInstanceId: 'host-1', generation: 3 },
      endedAt: 9,
      exitCode: 1,
      endedReason: 'the Host refused the last launch',
    }))
    context.host.launchFailure = {
      ok: false,
      code: 'host-unreachable',
      detail: 'the socket died mid-call',
    }

    expect(failureOf(await context.lifecycle.reopen('s1')).code).toBe('host-unreachable')
    expect(context.store.get('s1')).toEqual(expect.objectContaining({
      life: 'starting',
      binding: null,
      pendingOperationId: 'id-1',
      pendingOperationKind: 'reopen',
      endedAt: undefined,
      exitCode: undefined,
      endedReason: undefined,
    }))

    // Neither of these is a trap any more: nothing names a runtime, so nothing is stopped, and the
    // record is the whole of what there is to remove.
    expect(failureOf(await context.lifecycle.stop('s1')).code).toBe('not-found')
    expect(await context.lifecycle.remove('s1')).toEqual({ ok: true, value: undefined })
    expect(callsNamed(context.host, 'runtime.stop')).toEqual([])
  })

  /*
   * A create that was never answered stays recoverable: the reconcile pass replays it under the id
   * the Host deduplicates by. A reopen over that record would mint a NEW id and stamp the kind
   * `reopen`, throwing the original id away and turning the replay into a `--resume` of a
   * conversation the create never created - one click turning recoverable into doomed, on disk.
   */
  it('refuses to reopen over a launch that is still waiting for the Host', async () => {
    const context = await harness()
    context.host.failure = { ok: false, code: 'no-lease', detail: 'no live controller lease' }
    await context.lifecycle.create({
      kind: 'agent',
      directory: { mode: 'adHoc', path: context.workDirectory },
      agent: { agentId: 'claude', mode: 'new' },
    })
    const pending = context.store.get('id-1')
    expect(pending).toEqual(expect.objectContaining({
      life: 'starting',
      pendingOperationId: 'id-2',
      pendingOperationKind: 'create',
    }))

    context.host.failure = null
    expect(failureOf(await context.lifecycle.reopen('id-1')).code).toBe('launch-pending')
    expect(context.store.get('id-1')).toEqual(pending)
    // Refused before the Host is touched at all: a reopen starts by listing, and there is no listing.
    expect(callsNamed(context.host, 'runtime.list')).toEqual([])

    // The pass that owns the pending launch finishes it, as the create it was: the minted id is
    // still what the agent is launched under, and it is still the operation the Host dedupes by.
    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([{
      kind: 'retry-launch',
      sessionId: 'id-1',
      operationId: 'id-2',
      operation: 'create',
    }])
    expect(launchOf(callsNamed(context.host, 'runtime.create')[1]).args.slice(-2))
      .toEqual(['--session-id', 'id-1'])
  })

  // The other half of the same replay: the effect landed and only the answer was lost. The fake Host
  // dedupes by operationId exactly as the real one does, so a second create would be visible here as
  // a second runtime.create call and as a generation that moved.
  it('binds a create whose answer was lost, without ever running it twice', async () => {
    const context = await harness()
    context.host.loseAnswer = true
    expect(failureOf(await context.lifecycle.create(shellSpec(context.workDirectory))).code)
      .toBe('host-unreachable')
    context.host.loseAnswer = false

    const applied = await context.lifecycle.reconcile(context.host.listing())
    expect(applied).toEqual([{
      kind: 'bind-live',
      sessionId: 'id-1',
      binding: { hostInstanceId: 'host-1', generation: 1 },
    }])
    expect(callsNamed(context.host, 'runtime.create')).toHaveLength(1)
    expect(context.store.get('id-1')?.pendingOperationId).toBeUndefined()
  })

  /*
   * The replay meets the Host's ledger rather than a fresh Host: the operation is remembered, its
   * runtime was removed, and the Host answers 409. A conflict is a state and not a judgement of the
   * request - the same Host forgets that operation when it restarts - so the record keeps its
   * pending pair and the next pass asks again. The price of that is this repeated call; the price of
   * ending the record instead is the session, for good.
   */
  it('keeps replaying a launch the Host refuses with a conflict, and stays removable', async () => {
    const context = await harness()
    context.host.loseAnswer = true
    await context.lifecycle.create(shellSpec(context.workDirectory))
    context.host.loseAnswer = false
    context.host.runtimes.clear()

    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
    expect(callsNamed(context.host, 'runtime.create')).toHaveLength(2)
    expect(context.store.get('id-1')).toEqual(expect.objectContaining({
      life: 'starting',
      pendingOperationId: 'id-2',
      pendingOperationKind: 'create',
    }))
    expect(context.store.get('id-1')?.endedReason).toBeUndefined()

    // The next pass is paced rather than immediate: two refusals stand behind this record, and the
    // replay that would go out on the reconciler's own two-second cadence is what turned a standing
    // refusal into 885 rejected creates in nine minutes.
    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
    expect(callsNamed(context.host, 'runtime.create')).toHaveLength(2)

    context.clock.now += 60_000
    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
    expect(callsNamed(context.host, 'runtime.create')).toHaveLength(3)

    // And it is not a session nothing can take away: no binding names a runtime, so it removes.
    expect(await context.lifecycle.remove('id-1')).toEqual({ ok: true, value: undefined })
    expect(context.store.get('id-1')).toBeNull()
  })

  /*
   * 429 is the Host's live-runtime ceiling and runtimes exit; 409 is a Host that is stopping or a
   * lease that lapsed between the Host's two checks; 500 is the transport's catch-all. None of them
   * judged the request, so none of them may end the record: an ended record is skipped by every
   * reconcile pass for ever, its worktree and branch stay on disk with nothing naming them, and
   * creating again with the same slug is refused as `worktree-exists`.
   */
  it('keeps a create pending when the Host refused it for a condition of its own', async () => {
    const conditions: HostCallFailure[] = [
      { ok: false, code: 'op-rejected', status: 429, detail: '64 live runtimes is the limit' },
      {
        ok: false,
        code: 'op-rejected',
        status: 409,
        detail: 'Host is stopping and rejects new mutations',
      },
      { ok: false, code: 'op-rejected', status: 500, detail: 'internal error' },
    ]
    for (const condition of conditions) {
      const context = await harness()
      context.host.failure = condition
      expect(failureOf(await context.lifecycle.create(shellSpec(context.workDirectory))).code)
        .toBe('op-rejected')
      expect(context.store.get('id-1')).toEqual(expect.objectContaining({
        life: 'starting',
        binding: null,
        pendingOperationId: 'id-2',
        pendingOperationKind: 'create',
        // The refusal is counted from the first attempt, which is what paces the replays and, once
        // enough of them stand, what the row shows instead of calling the session `starting`.
        launchWait: { attempts: 1, lastAttemptAt: 5_000, reason: condition.detail },
      }))

      // The condition passed, and the launch lands under the id it was written with all along.
      context.host.failure = null
      expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([{
        kind: 'retry-launch',
        sessionId: 'id-1',
        operationId: 'id-2',
        operation: 'create',
      }])
      expect(context.store.get('id-1')?.life).toBe('live')
      // Nothing is waiting for a launch that landed, so the wait goes with the pending pair.
      expect(context.store.get('id-1')?.launchWait).toBeUndefined()
    }
  })

  /**
   * The shape the ceiling leaves behind, and the two things that make it survivable: the refusals
   * are counted so the replays can be paced, and the record stays removable so the person waiting
   * for the session is not left with a row that can be neither started nor taken away.
   */
  it('counts a standing refusal and keeps the session removable', async () => {
    const context = await harness()
    context.host.failure = {
      ok: false,
      code: 'op-rejected',
      status: 429,
      detail: '64 live runtimes is the limit',
    }
    expect(failureOf(await context.lifecycle.create(shellSpec(context.workDirectory))).code)
      .toBe('op-rejected')

    for (const attempts of [2, 3, 4]) {
      context.clock.now += 60_000
      expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
      expect(context.store.get('id-1')?.launchWait).toEqual({
        attempts,
        lastAttemptAt: context.clock.now,
        reason: '64 live runtimes is the limit',
      })
    }

    expect(await context.lifecycle.remove('id-1')).toEqual({ ok: true, value: undefined })
    expect(context.store.get('id-1')).toBeNull()
  })

  /*
   * A hand-edited or half-written record: a pending `reopen` whose agent can name no conversation.
   * Building that launch throws inside `AgentPresets`, and a throw out of the replay abandons the
   * whole pass - every change queued behind this record included, as the second session here shows.
   * The record is lost instead, the way one with no pending kind already is.
   */
  it('loses a pending reopen whose launch cannot be built, without abandoning the pass', async () => {
    const context = await harness()
    await context.store.put(record('s1', {
      kind: 'agent',
      agent: { agentId: 'codex', launchMode: 'new' },
      life: 'starting',
      binding: null,
      pendingOperationId: 'op-7',
      pendingOperationKind: 'reopen',
    }))
    await context.store.put(record('s2'))
    context.host.runtimes.set('s2', runtime('s2', { alive: false, exitCode: 3, exitedAt: 8_000 }))

    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([
      { kind: 'mark-lost', sessionId: 's1' },
      { kind: 'mark-ended', sessionId: 's2', exitCode: 3, endedAt: 8_000 },
    ])
    expect(context.store.get('s1')).toEqual(expect.objectContaining({
      life: 'lost',
      pendingOperationId: undefined,
      pendingOperationKind: undefined,
    }))
    expect(context.store.get('s2')?.life).toBe('ended')
    expect(callsNamed(context.host, 'runtime.create')).toEqual([])
  })

  it('ends a record whose runtime died, and takes the Host generation for a live one', async () => {
    const context = await harness()
    await context.store.put(record('dead'))
    await context.store.put(record('moved'))
    context.host.runtimes.set('dead', runtime('dead', {
      alive: false,
      exitCode: 2,
      exitedAt: 8_000,
    }))
    context.host.runtimes.set('moved', runtime('moved', { generation: 6 }))

    await context.lifecycle.reconcile(context.host.listing())
    expect(context.store.get('dead')).toEqual(expect.objectContaining({
      life: 'ended',
      exitCode: 2,
      endedAt: 8_000,
    }))
    expect(context.store.get('moved')?.binding).toEqual({
      hostInstanceId: 'host-1',
      generation: 6,
    })
  })

  it('does not rewrite the records when a reconcile finds nothing moved', async () => {
    const context = await harness()
    await context.lifecycle.create(shellSpec(context.workDirectory))
    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
  })

  it('reports a live runtime with no record and adopts it as a shell, spending a recovery point',
    async () => {
      const context = await harness()
      await context.lifecycle.create(shellSpec(context.workDirectory))
      context.host.runtimes.set('orphan-1', runtime('orphan-1', { generation: 3, startedAt: 4_200 }))

      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toEqual([{ kind: 'orphan', runtimeSessionId: 'orphan-1' }])
      expect(snapshotCount(context.snapshotsDirectory)).toBe(0)

      expect(await context.lifecycle.adoptOrphan('orphan-1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('orphan-1')).toEqual(expect.objectContaining({
        kind: 'shell',
        life: 'live',
        binding: { hostInstanceId: 'host-1', generation: 3 },
        createdAt: 4_200,
      }))
      expect(snapshotCount(context.snapshotsDirectory)).toBe(1)
    })

  it('refuses to adopt what is already tracked or is not a live runtime', async () => {
    const context = await harness()
    await context.store.put(record('s1'))
    expect(failureOf(await context.lifecycle.adoptOrphan('s1')).code).toBe('invalid-spec')
    context.host.runtimes.set('gone', runtime('gone', { alive: false }))
    expect(failureOf(await context.lifecycle.adoptOrphan('gone')).code).toBe('not-found')
    expect(failureOf(await context.lifecycle.adoptOrphan('never')).code).toBe('not-found')
  })

  // The Host still holds the dead runtime, so the reopen is a replace against the generation it
  // reports - the mutation fence is written for exactly this shape.
  it('reopens an ended session with a replace against the generation the Host lists', async () => {
    const context = await harness()
    await context.store.put(record('s1', {
      life: 'ended',
      endedAt: 9,
      exitCode: 1,
      binding: { hostInstanceId: 'host-1', generation: 3 },
    }))
    context.host.runtimes.set('s1', runtime('s1', { generation: 3, alive: false, exitCode: 1 }))

    expect(await context.lifecycle.reopen('s1')).toEqual({ ok: true, value: undefined })
    const replaces = callsNamed(context.host, 'runtime.replace')
    expect(replaces).toHaveLength(1)
    expect(replaces[0].body.target).toEqual({
      hostInstanceId: 'host-1',
      runtimeSessionId: 's1',
      generation: 3,
    })
    expect(replaces[0].body.operationId).toBe('id-1')
    expect(context.store.get('s1')).toEqual(expect.objectContaining({
      life: 'live',
      binding: { hostInstanceId: 'host-1', generation: 4 },
      endedAt: undefined,
      exitCode: undefined,
    }))
  })

  it('rebuilds an agent launch from the record when it reopens one', async () => {
    const context = await harness()
    await context.store.put(record('s1', {
      kind: 'agent',
      agent: { agentId: 'codex', launchMode: 'resume', nativeSessionId: 'native-1' },
      life: 'lost',
      binding: null,
    }))
    await context.lifecycle.reopen('s1')
    expect(launchOf(callsNamed(context.host, 'runtime.create')[0]).args.slice(-2))
      .toEqual(['resume', 'native-1'])
  })

  // Codex never reports the id it chose and its `resume --last` is the newest session on the whole
  // machine, so this record can name no conversation: it is refused before the Host is touched.
  it('refuses to reopen a codex session that cannot name its conversation', async () => {
    const context = await harness()
    await context.store.put(record('s1', {
      kind: 'agent',
      agent: { agentId: 'codex', launchMode: 'new' },
      life: 'lost',
      binding: null,
    }))
    const refusal = failureOf(await context.lifecycle.reopen('s1'))
    expect(refusal.code).toBe('invalid-spec')
    expect(refusal.detail).toMatch(/unrelated one/)
    expect(context.host.calls).toEqual([])
    expect(context.store.get('s1')?.life).toBe('lost')
  })

  /*
   * Two Claude sessions in one directory, neither carrying an id of its own. `--continue` takes the
   * newest conversation IN THAT DIRECTORY, so reopening the first would attach it to whatever the
   * second left behind - silently, with its own record, title, cwd and worktree all still looking
   * right. Directory scoping is a narrower net than Codex's machine-wide `resume --last` and it is
   * still not an identity, so it earns the same refusal.
   */
  it('refuses to reopen a claude session that would continue a sibling in the same directory',
    async () => {
      const context = await harness()
      for (const sessionId of ['s1', 's2'])
        await context.store.put(record(sessionId, {
          kind: 'agent',
          agent: { agentId: 'claude', launchMode: 'continue' },
          directory: { mode: 'adHoc', path: context.workDirectory },
          life: 'lost',
          binding: null,
        }))

      const refusal = failureOf(await context.lifecycle.reopen('s1'))
      expect(refusal.code).toBe('invalid-spec')
      expect(refusal.detail).toMatch(/newest conversation in this directory/)
      expect(context.host.calls).toEqual([])
      expect(context.store.get('s1')?.life).toBe('lost')
    })

  it('refuses to reopen a session the Host is still running', async () => {
    const context = await harness()
    await context.store.put(record('s1', { life: 'lost', binding: null }))
    context.host.runtimes.set('s1', runtime('s1'))
    expect(failureOf(await context.lifecycle.reopen('s1')).code).toBe('live-refused')
    expect(callsNamed(context.host, 'runtime.create')).toEqual([])
    expect(callsNamed(context.host, 'runtime.replace')).toEqual([])
  })

  it('answers not-found for a session id nothing records', async () => {
    const context = await harness()
    expect(failureOf(await context.lifecycle.reopen('nope')).code).toBe('not-found')
    expect(failureOf(await context.lifecycle.stop('nope')).code).toBe('not-found')
    expect(failureOf(await context.lifecycle.remove('nope')).code).toBe('not-found')
  })

  it('stops through the binding, and does nothing for a session that is not running', async () => {
    const context = await harness()
    await context.lifecycle.create(shellSpec(context.workDirectory))
    expect(await context.lifecycle.stop('id-1')).toEqual({ ok: true, value: undefined })
    expect(callsNamed(context.host, 'runtime.stop')[0].body.target).toEqual({
      hostInstanceId: 'host-1',
      runtimeSessionId: 'id-1',
      generation: 1,
    })

    await context.store.put(record('ended-1', { life: 'ended', endedAt: 4 }))
    expect(await context.lifecycle.stop('ended-1')).toEqual({ ok: true, value: undefined })
    expect(callsNamed(context.host, 'runtime.stop')).toHaveLength(1)
  })

  it('has nothing to stop while a create has not been answered', async () => {
    const context = await harness()
    await context.store.put(record('s1', { life: 'starting', binding: null }))
    expect(failureOf(await context.lifecycle.stop('s1')).code).toBe('not-found')
  })

  it('refuses to remove a session that is still live, or starting over a runtime it names', async () => {
    const context = await harness()
    await context.lifecycle.create(shellSpec(context.workDirectory))
    expect(failureOf(await context.lifecycle.remove('id-1')).code).toBe('live-refused')
    expect(context.store.get('id-1')?.life).toBe('live')

    // A reopen in flight: the record is `starting` again but its binding still names a runtime.
    await context.store.put(record('s2', {
      life: 'starting',
      binding: { hostInstanceId: 'host-1', generation: 2 },
    }))
    expect(failureOf(await context.lifecycle.remove('s2')).code).toBe('live-refused')
    expect(context.store.get('s2')).not.toBeNull()
  })

  it('removes an ended session and lets the Host drop its dead runtime with it', async () => {
    const context = await harness()
    await context.store.put(record('s1', {
      life: 'ended',
      endedAt: 4,
      binding: { hostInstanceId: 'host-1', generation: 2 },
    }))
    expect(await context.lifecycle.remove('s1')).toEqual({ ok: true, value: undefined })
    expect(callsNamed(context.host, 'runtime.remove')[0].body.target).toEqual({
      hostInstanceId: 'host-1',
      runtimeSessionId: 's1',
      generation: 2,
    })
    expect(context.store.get('s1')).toBeNull()
    expect(snapshotCount(context.snapshotsDirectory)).toBe(1)
  })

  it('removes a lost session without asking the Host about a runtime it does not have', async () => {
    const context = await harness()
    await context.store.put(record('s1', { life: 'lost', binding: null }))
    expect(await context.lifecycle.remove('s1')).toEqual({ ok: true, value: undefined })
    expect(callsNamed(context.host, 'runtime.remove')).toEqual([])
    expect(context.store.get('s1')).toBeNull()
    expect(context.reports).toEqual([])
  })

  /*
   * The record is the only thing that names the worktree and the branch, and removing it is not the
   * place to decide what happens to work that was never committed - `git worktree remove` refuses a
   * dirty worktree and `--force` throws it away. So they stay, and the removal SAYS they stay,
   * rather than letting a directory and a branch disappear from view with the record that named them.
   */
  it('names the worktree and the branch it leaves behind', async () => {
    const context = await harness()
    await context.store.put(record('s1', {
      life: 'lost',
      binding: null,
      worktree: {
        worktreePath: join('Q:', 'apps', 'one', '.worktrees', 'fix'),
        branch: 'jamat/fix',
        baseCommit: 'abc123',
        repositoryRoot: join('Q:', 'apps', 'one'),
      },
    }))
    expect(await context.lifecycle.remove('s1')).toEqual({ ok: true, value: undefined })
    expect(context.reports).toHaveLength(1)
    expect(context.reports[0]).toContain(join('Q:', 'apps', 'one', '.worktrees', 'fix'))
    expect(context.reports[0]).toContain('jamat/fix')
  })

  /*
   * The whole point of the operation id: the Host deduplicates by it, so the launch that waited for
   * the install is the create the record was written with rather than a second one under a new id.
   */
  it('launches the waiting session under the operation id its create wrote, and only once',
    async () => {
      const context = await harness()
      await context.store.put(waiting())
      await context.store.put(setupRecord())

      expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([{
        kind: 'retry-launch',
        sessionId: 'p1',
        operationId: 'op-7',
        operation: 'create',
      }])
      expect(context.host.calls[0].body).toEqual(expect.objectContaining({
        operationId: 'op-7',
        runtimeSessionId: 'p1',
      }))
      expect(context.store.get('p1')).toEqual(expect.objectContaining({
        life: 'live',
        binding: { hostInstanceId: 'host-1', generation: 1 },
        pendingOperationId: undefined,
      }))
      expect(context.store.get('p1')?.pendingSetup).toBeUndefined()

      // Idempotent: the next pass finds a running session and starts nothing a second time.
      expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
      expect(callsNamed(context.host, 'runtime.create')).toHaveLength(1)
    })

  /*
   * The crash the clear-first order is written for. The record write landed and the launch never
   * went out, so what is on disk is an ordinary interrupted create - no wait, both halves of the
   * pending pair intact - and the next pass finishes it under that same id, as it would any other.
   */
  it('leaves an ordinary interrupted launch behind when the replay never reaches the Host',
    async () => {
      const context = await harness()
      await context.store.put(waiting())
      await context.store.put(setupRecord())
      context.host.launchFailure = {
        ok: false,
        code: 'host-unreachable',
        detail: 'the socket died mid-call',
      }

      expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
      expect(context.store.get('p1')).toEqual(expect.objectContaining({
        life: 'starting',
        pendingOperationId: 'op-7',
        pendingOperationKind: 'create',
      }))
      expect(context.store.get('p1')?.pendingSetup).toBeUndefined()

      context.host.launchFailure = null
      expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([{
        kind: 'retry-launch',
        sessionId: 'p1',
        operationId: 'op-7',
        operation: 'create',
      }])
      expect(context.store.get('p1')?.life).toBe('live')
      expect(callsNamed(context.host, 'runtime.create')).toHaveLength(2)
    })

  it('ends the waiting session when the setup failed, and names what that leaves on disk', async () => {
    const context = await harness()
    await context.store.put(waiting())
    await context.store.put(setupRecord({ exitCode: 1 }))

    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([{
      kind: 'setup-failed',
      sessionId: 'p1',
      reason: expect.stringContaining('1'),
    }])
    expect(context.store.get('p1')).toEqual(expect.objectContaining({
      life: 'ended',
      binding: null,
      pendingOperationId: undefined,
      pendingOperationKind: undefined,
      endedAt: 5_000,
      // The link to the setup session outlives the failure: it is what a retry has to work from.
      pendingSetup: { setupSessionId: 's1' },
    }))
    expect(context.store.get('p1')?.endedReason).toMatch(/^setup failed: /)
    expect(context.reports).toHaveLength(1)
    expect(context.reports[0]).toContain(join('Q:', 'apps', 'one', '.worktrees', 'fix'))
    expect(context.reports[0]).toContain('jamat/fix')

    // Ended is where it stops: the pass after it decides nothing and launches nothing.
    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
    expect(context.host.calls).toEqual([])
  })

  /*
   * Reality against the record, both ways round: the Host has a runtime under the waiting session's
   * own id, so the general rules run and the wait is cleared as they land. A session that is
   * demonstrably running - or demonstrably over - must not go on being judged by an install.
   */
  it('clears the wait when the Host has a runtime for the waiting session itself', async () => {
    const context = await harness()
    await context.store.put(waiting())
    await context.store.put(setupRecord({ exitCode: 1 }))
    context.host.runtimes.set('p1', runtime('p1', { generation: 4 }))

    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([{
      kind: 'bind-live',
      sessionId: 'p1',
      binding: { hostInstanceId: 'host-1', generation: 4 },
    }])
    expect(context.store.get('p1')?.life).toBe('live')
    expect(context.store.get('p1')?.pendingSetup).toBeUndefined()
    expect(context.host.calls).toEqual([])

    context.host.runtimes.set('p1', runtime('p1', {
      generation: 4,
      alive: false,
      exitCode: 2,
      exitedAt: 8_000,
    }))
    await context.store.put(waiting({ life: 'starting', binding: null }))
    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([{
      kind: 'mark-ended',
      sessionId: 'p1',
      exitCode: 2,
      endedAt: 8_000,
    }])
    expect(context.store.get('p1')?.pendingSetup).toBeUndefined()
  })

  /*
   * A record that waits for a setup but names no launch of its own cannot be started by any verdict,
   * however cleanly the setup finished. Nothing here writes that shape - the pending pair is written
   * with the wait - but the records come back off a file, so it is answered rather than ignored: an
   * endless silent no-op would be a session that never moves and says nothing about it anywhere.
   */
  it('loses a waiting record that names no launch of its own, however the setup went', async () => {
    const context = await harness()
    await context.store.put(waiting({
      pendingOperationId: undefined,
      pendingOperationKind: undefined,
    }))
    await context.store.put(setupRecord())

    expect(await context.lifecycle.reconcile(context.host.listing()))
      .toEqual([{ kind: 'mark-lost', sessionId: 'p1' }])
    expect(context.store.get('p1')?.life).toBe('lost')
    expect(context.host.calls).toEqual([])
  })

  /*
   * The whole shape of a create with an install: two records, ONE runtime, and the session's id back
   * before anything has been installed. The session's own launch is not attempted here at all - it is
   * the pending pair on a record that says what it is waiting for, and a later reconcile pass is what
   * runs it.
   */
  it('writes the waiting session and its install, and answers with the session id at once', async () => {
    const context = await harness()
    context.setup.resolution = installing([
      { command: 'pnpm install', cwd: '' },
      { command: 'uv sync', cwd: 'services/api' },
    ])

    const result = await context.lifecycle.create(worktreeSpec())

    expect(result).toEqual({ ok: true, value: { sessionId: 'id-1' } })
    // Read in the main copy, run in the worktree: that is why the steps come back relative.
    expect(context.setup.calls).toEqual([{ projectRoot, repositoryRoot: projectRoot }])
    expect(context.store.get('id-1')).toEqual(expect.objectContaining({
      life: 'starting',
      binding: null,
      pendingOperationId: 'id-2',
      pendingOperationKind: 'create',
      pendingSetup: { setupSessionId: 'id-3' },
    }))
    expect(context.store.get('id-3')).toEqual(expect.objectContaining({
      kind: 'shell',
      life: 'live',
      setupFor: 'id-1',
      // adHoc and no worktree field: `cwdOf` prefers a worktree and would move the first step.
      directory: { mode: 'adHoc', path: worktreePath },
      commands: [
        { command: 'pnpm install', cwd: worktreePath },
        { command: 'uv sync', cwd: join(worktreePath, 'services', 'api') },
      ],
    }))
    expect(context.store.get('id-3')?.worktree).toBeUndefined()

    const creates = callsNamed(context.host, 'runtime.create')
    expect(creates).toHaveLength(1)
    expect(creates[0].body.runtimeSessionId).toBe('id-3')
    expect(launchOf(creates[0]).args.join(' ')).toContain('pnpm install')
  })

  // The same worktree left with nothing naming it, reached through the install path: it is the first
  // of the pair of writes that fails, so not one record exists and the worktree is only in the words.
  it('names the worktree when the session waiting for an install cannot be written', async () => {
    const context = await harness({ unwritableRecords: true })
    context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])

    const refused = failureOf(await context.lifecycle.create(worktreeSpec()))

    expect(refused.code).toBe('records-latched')
    expect(refused.detail).toContain(worktreePath)
    expect(refused.detail).toContain('jamat/fix')
    expect(context.reports[1]).toContain(worktreePath)
    expect(context.reports[1]).toContain('jamat/fix')
    expect(context.store.list()).toEqual([])
    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
    expect(context.host.calls).toEqual([])
  })

  /*
   * The OTHER write of that pair, and what it leaves is a different thing that needs different words.
   * The waiting session landed, so the worktree is named by a record after all and nothing is
   * orphaned; only the install is missing, which is a shape `setupJudgement` already reads. So the
   * refusal says where the session stands instead of naming a leftover - and the reconcile pass at
   * the end is that sentence being true rather than reassuring.
   *
   * The failure is staged at `AtomicJsonFile.write`, the seam the store really fails at, because that
   * is the only way to fail the SECOND of two writes made inside one call - an unwritable path fails
   * the first. Everything else is the real store: the same validation, the same commit, the same
   * `false`.
   */
  it('says where the session stands when only its install could not be written', async () => {
    const context = await harness()
    context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])
    const original = AtomicJsonFile.write
    const write = vi.spyOn(AtomicJsonFile, 'write')
    // The queue is read in call order: the waiting session's write lands, the install's does not.
    write.mockImplementationOnce(original)
    write.mockImplementationOnce(() => { throw new Error('EBUSY: the records file is locked') })

    const refused = failureOf(await context.lifecycle.create(worktreeSpec())
      .finally(() => write.mockRestore()))

    expect(refused.code).toBe('records-latched')
    expect(refused.detail).toContain('id-1')
    expect(refused.detail).toContain(worktreePath)
    expect(refused.detail).not.toMatch(/nothing (here )?changed/)
    // The session is on disk and names the worktree itself; the install is not on disk at all.
    expect(context.store.get('id-1')).toEqual(expect.objectContaining({
      life: 'starting',
      pendingSetup: { setupSessionId: 'id-3' },
    }))
    expect(context.store.get('id-1')?.worktree?.branch).toBe('jamat/fix')
    expect(context.store.get('id-3')).toBeNull()
    expect(context.host.calls).toEqual([])

    // What the refusal promises, carried out: the pass reads the missing install for what it is and
    // ends the session, naming the worktree a retry needs exactly where it is.
    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([{
      kind: 'setup-failed',
      sessionId: 'id-1',
      reason: expect.stringContaining('setup session record is gone'),
    }])
    expect(context.store.get('id-1')?.life).toBe('ended')
    expect(context.reports.at(-1)).toContain('jamat/fix')
  })

  /*
   * A refusal of the INSTALL is the setup session's own affair, exactly as it is for any other
   * create: its record ends carrying the Host's words. The waiting session is left where it stands
   * for the reconcile pass, which judges it by that ended record and ends it with the reason - no
   * special case anywhere in the create path.
   */
  it('ends an install the Host refused and leaves the session to the reconciler', async () => {
    const context = await harness()
    context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])
    context.host.failure = {
      ok: false,
      code: 'op-rejected',
      status: 400,
      detail: 'launch.cwd must be an existing directory',
    }

    expect(await context.lifecycle.create(worktreeSpec()))
      .toEqual({ ok: true, value: { sessionId: 'id-1' } })
    expect(context.store.get('id-3')).toEqual(expect.objectContaining({
      life: 'ended',
      binding: null,
      pendingOperationId: undefined,
      endedReason: 'launch.cwd must be an existing directory',
    }))
    expect(context.store.get('id-1')?.life).toBe('starting')

    context.host.failure = null
    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([{
      kind: 'setup-failed',
      sessionId: 'id-1',
      reason: expect.stringContaining('no exit code'),
    }])
    expect(context.store.get('id-1')).toEqual(expect.objectContaining({
      life: 'ended',
      pendingSetup: { setupSessionId: 'id-3' },
    }))
    expect(callsNamed(context.host, 'runtime.create')).toHaveLength(1)
  })

  /*
   * Nothing known to install is not a reason to refuse the session - it is a reason to say so. The
   * marker is what stops a worktree that had nothing installed into it from looking exactly like one
   * that did, and the sentence names the file that decides it.
   */
  it('creates the session with a marker when nothing installs the project', async () => {
    const context = await harness()
    context.setup.resolution = { kind: 'none', reason: 'no known project family detected' }

    expect(await context.lifecycle.create(worktreeSpec()))
      .toEqual({ ok: true, value: { sessionId: 'id-1' } })
    expect(context.store.list()).toHaveLength(1)
    expect(context.store.get('id-1')).toEqual(expect.objectContaining({
      life: 'live',
      setupSkipped: { reason: 'no known project family detected' },
      pendingSetup: undefined,
    }))
    expect(callsNamed(context.host, 'runtime.create')[0].body.runtimeSessionId).toBe('id-1')
    expect(context.reports).toHaveLength(1)
    expect(context.reports[0]).toContain(join(projectRoot, '.worktree.json'))
    expect(context.reports[0]).toContain('no known project family detected')
  })

  // The project said it needs nothing, in a file that travels with it. Repeating that back would be
  // a warning about a decision the user has already written down.
  it('marks an explicitly empty setup without saying anything about it', async () => {
    const context = await harness()
    context.setup.resolution = { kind: 'empty' }

    expect(await context.lifecycle.create(worktreeSpec()))
      .toEqual({ ok: true, value: { sessionId: 'id-1' } })
    expect(context.store.get('id-1')?.setupSkipped?.reason).toMatch(/empty setup/)
    expect(context.store.list()).toHaveLength(1)
    expect(context.reports).toEqual([])
  })

  /*
   * The member answers with a LIST, and a list can be empty - `steps: []` is a shape its own type
   * allows and only its code decides against. Planned as a launch it would be a shell with no script,
   * which is an interactive terminal that never exits, so the session waiting for it would wait for
   * ever with nothing said anywhere. It is a skip with a reason, like every other nothing-to-install.
   */
  it('installs nothing when the resolution names no step at all', async () => {
    const context = await harness()
    context.setup.resolution = installing([])

    expect(await context.lifecycle.create(worktreeSpec()))
      .toEqual({ ok: true, value: { sessionId: 'id-1' } })
    expect(context.store.list()).toHaveLength(1)
    expect(context.store.get('id-1')?.setupSkipped?.reason).toContain('no steps')
    expect(context.store.get('id-1')?.pendingSetup).toBeUndefined()
    expect(context.reports[0]).toContain('no steps')
    expect(callsNamed(context.host, 'runtime.create')[0].body.runtimeSessionId).toBe('id-1')
  })

  it('asks nothing about a create with no worktree', async () => {
    const context = await harness()
    await context.lifecycle.create(shellSpec(context.workDirectory))
    expect(context.setup.calls).toEqual([])
    expect(context.store.get('id-1')?.life).toBe('live')
    expect(context.store.get('id-1')?.setupSkipped).toBeUndefined()
    expect(context.store.get('id-1')?.pendingSetup).toBeUndefined()
  })

  /*
   * A step directory is `relative(repositoryRoot, projectRoot)`, so a `..` in one means the project
   * is not inside the repository git named for it. Joined onto the worktree it would run the install
   * in the user's REAL checkout, which is the one place the whole feature exists to keep out of. It
   * is answered the way `none` is - the session is created, nothing is installed, and the reason
   * names the step - rather than by refusing a create whose worktree is already on disk.
   */
  it('installs nothing when a step would run outside the repository, and says which step', async () => {
    const context = await harness()
    context.setup.resolution = installing([{ command: 'pnpm install', cwd: '../..' }])

    expect(await context.lifecycle.create(worktreeSpec()))
      .toEqual({ ok: true, value: { sessionId: 'id-1' } })
    expect(context.store.list()).toHaveLength(1)
    expect(context.store.get('id-1')?.setupSkipped?.reason).toContain('outside the repository')
    expect(context.store.get('id-1')?.pendingSetup).toBeUndefined()
    expect(context.reports[0]).toContain('pnpm install')
    // And it does not send the user to `.worktree.json`: every step of a project outside its own
    // repository escapes, whoever wrote it, so that file is not where this one is fixed.
    expect(context.reports[0]).not.toContain('.worktree.json')
    expect(callsNamed(context.host, 'runtime.create')[0].body.runtimeSessionId).toBe('id-1')
  })

  /*
   * The reopen that used to throw the user's click away. The record is ended and still carries the
   * wait, so its worktree exists and is NOT installed: reopening would start the session in exactly
   * the half-provisioned directory the setup exists to prevent, and carrying the wait forward would
   * let the next reconcile end the session over the OLD failure without a word.
   */
  it('refuses to reopen a session whose setup never finished, and names the way back', async () => {
    const context = await harness()
    await context.store.put(failedWaiting())
    await context.store.put(setupRecord({ exitCode: 1 }))

    const refusal = failureOf(await context.lifecycle.reopen('p1'))
    expect(refusal.code).toBe('invalid-spec')
    expect(refusal.detail).toContain('retrySetup')
    expect(context.host.calls).toEqual([])
    expect(context.store.get('p1')).toEqual(failedWaiting())
  })

  /*
   * The same refusal, and it has to be reached BEFORE the pending-launch one: a session still waiting
   * for its install does have a launch pending, but that launch is not what a reconcile pass is about
   * to replay. Telling the user it runs as soon as the Host can answer is the one thing that will
   * never happen - it runs when the install exits 0, and never at all if the install fails.
   */
  it('answers a session waiting on an install with the setup refusal, not the pending one', async () => {
    const context = await harness()
    await context.store.put(waiting())
    await context.store.put(setupRecord({
      life: 'live',
      binding: { hostInstanceId: 'host-1', generation: 1 },
      exitCode: undefined,
      endedAt: undefined,
    }))

    const refusal = failureOf(await context.lifecycle.reopen('p1'))
    expect(refusal.code).toBe('invalid-spec')
    expect(refusal.detail).toContain('setup')
    expect(refusal.detail).toContain('retrySetup')
    expect(context.host.calls).toEqual([])
    expect(context.store.get('p1')).toEqual(waiting())
  })

  /*
   * The retry resolves again rather than replaying what is stored: the user's fix IS a different
   * resolution, usually a `.worktree.json` that was not there the first time, and repeating the
   * commands that failed would walk into the same wall for ever.
   */
  it('re-resolves the install, rewrites it and arms the waiting session again', async () => {
    const context = await harness()
    await context.store.put(failedWaiting())
    await context.store.put(setupRecord({ exitCode: 1 }))
    context.setup.resolution = installing([
      { command: 'pnpm install --frozen-lockfile', cwd: 'packages/app' },
    ])

    expect(await context.lifecycle.retrySetup('p1')).toEqual({ ok: true, value: undefined })
    expect(context.setup.calls).toEqual([{ projectRoot, repositoryRoot: projectRoot }])
    expect(context.store.get('s1')).toEqual(expect.objectContaining({
      life: 'live',
      commands: [{
        command: 'pnpm install --frozen-lockfile',
        cwd: join(worktreePath, 'packages', 'app'),
      }],
      directory: { mode: 'adHoc', path: join(worktreePath, 'packages', 'app') },
    }))
    // The install is armed first, so the ids run the other way: `id-1` is its launch, `id-2` the
    // waiting session's own.
    expect(context.store.get('p1')).toEqual(expect.objectContaining({
      life: 'starting',
      binding: null,
      pendingOperationId: 'id-2',
      pendingOperationKind: 'create',
      pendingSetup: { setupSessionId: 's1' },
      endedAt: undefined,
      endedReason: undefined,
    }))

    const creates = callsNamed(context.host, 'runtime.create')
    expect(creates).toHaveLength(1)
    expect(creates[0].body.runtimeSessionId).toBe('s1')
    expect(creates[0].body.operationId).toBe('id-1')
    expect(launchOf(creates[0]).args.join(' ')).toContain('--frozen-lockfile')

    // And it lands where the first install would have: the setup exits 0 and the session runs.
    context.host.runtimes.set('s1', runtime('s1', { alive: false, exitCode: 0, exitedAt: 9_000 }))
    await context.lifecycle.reconcile(context.host.listing())
    expect(context.store.get('p1')).toEqual(expect.objectContaining({
      life: 'live',
      pendingSetup: undefined,
    }))
    expect(callsNamed(context.host, 'runtime.create')[1].body.operationId).toBe('id-2')
  })

  /*
   * The window a retry must never leave open, and the one the reviewers walked into: the Host is
   * briefly unreachable, so nothing can be relaunched. Arming the waiting session anyway - over a
   * setup record still saying `ended` with the exit code that failed - hands the next reconcile pass
   * a session to condemn on that old exit code, and the user's retry is thrown away in silence.
   * Nothing is written at all instead, so the records stay exactly as the failure left them and the
   * retry is still there to be asked for again.
   */
  it('writes nothing when the Host cannot answer the retry', async () => {
    const context = await harness()
    await context.store.put(failedWaiting())
    await context.store.put(setupRecord({ exitCode: 1 }))
    context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])
    context.host.failure = { ok: false, code: 'host-unreachable', detail: 'no descriptor' }

    expect(failureOf(await context.lifecycle.retrySetup('p1')).code).toBe('host-unreachable')
    expect(context.store.get('p1')).toEqual(failedWaiting())
    expect(context.store.get('s1')).toEqual(setupRecord({ exitCode: 1 }))

    // And the pass that follows decides nothing about either of them, so the retry can be repeated.
    context.host.failure = null
    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
    expect(await context.lifecycle.retrySetup('p1')).toEqual({ ok: true, value: undefined })
  })

  /*
   * The other half of the same hazard, on the side that can see who asked: stopping an install is a
   * decision, and the record says so before any exit code is read. The fake Host answers a stop with
   * exit 0 exactly as a real one may, which is what makes the marker the thing that decides.
   */
  it('marks an install that was stopped, so its exit code cannot speak for it', async () => {
    const context = await harness()
    await context.store.put(record('p1', {
      life: 'starting',
      pendingSetup: { setupSessionId: 's1' },
      pendingOperationId: 'op-1',
      pendingOperationKind: 'create',
    }))
    await context.store.put(record('s1', {
      life: 'live',
      binding: { hostInstanceId: 'fake-host-1', generation: 1 },
      commands: [{ command: 'pnpm install', cwd: context.workDirectory }],
      setupFor: 'p1',
    }))
    context.host.runtimes.set('s1', runtime('s1'))

    expect(await context.lifecycle.stop('s1')).toEqual({ ok: true, value: undefined })

    expect(context.store.get('s1')?.stopRequested).toBe(true)
    // The fake stops a runtime with exit 0, which is the dangerous answer; the marker outranks it.
    expect(context.host.runtimes.get('s1')?.exitCode).toBe(0)
    expect(await context.lifecycle.reconcile(context.host.listing())).toContainEqual({
      kind: 'setup-failed',
      sessionId: 'p1',
      reason: 'its setup was stopped',
    })
  })

  /*
   * A retry resolves afresh, so without the same gate in front of it, it would be the way around the
   * one on `create`: a `.worktree.json` that appeared, or changed, after the session was made would
   * run on the next click of Retry.
   *
   * It is refused rather than skipped, and that is the difference between this and the create path's
   * second look: there is a caller here who can answer. It matters more than it sounds, because the
   * edit that fixes a failed install is the very edit that moves the hash - skipping would make a
   * failed install unrecoverable except by starting the session over.
   */
  it('asks again before retrying into a setup this machine never agreed to', async () => {
    const context = await harness()
    await context.store.put(failedWaiting())
    await context.store.put(setupRecord({ exitCode: 1 }))
    context.setup.resolution = installing([{ command: './evil.sh', cwd: '' }], 'project')
    context.setup.declared = { commands: ['./evil.sh'], hash: 'hash-1', acknowledged: false }

    expect(await context.lifecycle.retrySetup('p1')).toMatchObject({
      ok: false,
      code: 'setup-not-acknowledged',
      setup: { commands: ['./evil.sh'], hash: 'hash-1' },
    })
    expect(JSON.stringify(context.host.calls)).not.toContain('evil')

    expect(await context.lifecycle.retrySetup('p1', 'hash-1'))
      .toEqual({ ok: true, value: undefined })
    expect(context.setup.acknowledged).toEqual([{ projectRoot, hash: 'hash-1' }])
    expect(JSON.stringify(context.host.calls)).toContain('evil')
  })

  /*
   * The order the whole retry hangs on, asserted from inside the wire call: at the moment the Host is
   * asked to run the install, the install's own record is already `starting` under the pair that
   * launch carries. That is the shape `setupJudgement` WAITS for - a client that dies here leaves a
   * session waiting on a launch to be replayed, never one waiting on a setup that is over.
   */
  it('arms the install under its own launch before the session that waits for it', async () => {
    const context = await harness()
    await context.store.put(failedWaiting())
    await context.store.put(setupRecord({ exitCode: 1 }))
    context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])
    let observedSetup: SessionRecord | null = null
    let observedPrimary: SessionRecord | null = null
    context.host.onCreate = () => {
      observedSetup = context.store.get('s1')
      observedPrimary = context.store.get('p1')
    }

    expect(await context.lifecycle.retrySetup('p1')).toEqual({ ok: true, value: undefined })
    expect(observedSetup).toEqual(expect.objectContaining({
      life: 'starting',
      binding: null,
      pendingOperationId: 'id-1',
      pendingOperationKind: 'create',
      exitCode: undefined,
      commands: [{ command: 'pnpm install', cwd: worktreePath }],
    }))
    expect(observedPrimary).toEqual(expect.objectContaining({
      life: 'starting',
      pendingOperationId: 'id-2',
      pendingSetup: { setupSessionId: 's1' },
    }))
  })

  /*
   * A retry the Host judged and refused ends the install carrying its words, exactly as a refused
   * install at create time does - and the waiting session, which is armed and waiting on it, is
   * condemned by the next pass with those same words rather than with the old exit code.
   */
  it('ends the install the Host refused and names its words to the session waiting on it', async () => {
    const context = await harness()
    await context.store.put(failedWaiting())
    await context.store.put(setupRecord({ exitCode: 1 }))
    context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])
    context.host.launchFailure = {
      ok: false,
      code: 'op-rejected',
      status: 400,
      detail: 'launch.cwd must be an existing directory',
    }

    expect(failureOf(await context.lifecycle.retrySetup('p1')).code).toBe('op-rejected')
    expect(context.store.get('s1')).toEqual(expect.objectContaining({
      life: 'ended',
      pendingOperationId: undefined,
      endedReason: 'launch.cwd must be an existing directory',
    }))

    context.host.launchFailure = null
    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([{
      kind: 'setup-failed',
      sessionId: 'p1',
      reason: expect.stringContaining('no exit code'),
    }])
  })

  it('refuses a retry for a session that has no failed setup to retry', async () => {
    const context = await harness()
    await context.store.put(record('plain', { life: 'ended', endedAt: 4 }))
    await context.store.put(waiting())

    expect(failureOf(await context.lifecycle.retrySetup('nope')).code).toBe('not-found')
    expect(failureOf(await context.lifecycle.retrySetup('plain')).code).toBe('invalid-spec')
    // Still starting: its install is either running or about to be replayed, and nothing is over.
    expect(failureOf(await context.lifecycle.retrySetup('p1')).code).toBe('invalid-spec')
    expect(context.host.calls).toEqual([])
  })

  /*
   * The setup record is evidence, not the session: it can be removed from the list by hand, and a
   * client that died between the two writes of a create never wrote it at all. Refusing the retry for
   * it shut the last door on a session that `reopen` already refuses for its wait and that a fresh
   * create refuses the slug of. The install is built again instead, from what the waiting record
   * itself says - which is everything the create had.
   */
  it('mints a fresh install when the setup session record is gone', async () => {
    const context = await harness()
    await context.store.put(failedWaiting())
    context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])

    expect(await context.lifecycle.retrySetup('p1')).toEqual({ ok: true, value: undefined })
    // `id-1` is the new install, `id-2` its launch, `id-3` the launch the session waits under.
    expect(context.store.get('id-1')).toEqual(expect.objectContaining({
      kind: 'shell',
      life: 'live',
      setupFor: 'p1',
      directory: { mode: 'adHoc', path: worktreePath },
      commands: [{ command: 'pnpm install', cwd: worktreePath }],
    }))
    expect(context.store.get('id-1')?.worktree).toBeUndefined()
    expect(context.store.get('p1')).toEqual(expect.objectContaining({
      life: 'starting',
      binding: null,
      pendingOperationId: 'id-3',
      pendingOperationKind: 'create',
      pendingSetup: { setupSessionId: 'id-1' },
      endedReason: undefined,
    }))
    const creates = callsNamed(context.host, 'runtime.create')
    expect(creates).toHaveLength(1)
    expect(creates[0].body).toEqual(expect.objectContaining({
      runtimeSessionId: 'id-1',
      operationId: 'id-2',
    }))

    // And it lands like any other install: it exits 0 and the session it prepared runs.
    context.host.runtimes.set('id-1', runtime('id-1', { alive: false, exitCode: 0, exitedAt: 9_000 }))
    await context.lifecycle.reconcile(context.host.listing())
    expect(context.store.get('p1')).toEqual(expect.objectContaining({
      life: 'live',
      pendingSetup: undefined,
    }))
    expect(callsNamed(context.host, 'runtime.create')[1].body.operationId).toBe('id-3')
  })

  /*
   * Both halves of a record come off a file the store checks field by field and never for agreement
   * between two of them, so a wait that names no project worktree to install into is answered rather
   * than resolved against nothing.
   */
  it('refuses a retry for a record that names no worktree or no project directory', async () => {
    const context = await harness()
    await context.store.put(failedWaiting({ worktree: undefined }))
    await context.store.put(failedWaiting({
      sessionId: 'p2',
      directory: { mode: 'adHoc', path: worktreePath },
    }))

    for (const sessionId of ['p1', 'p2']) {
      const refusal = failureOf(await context.lifecycle.retrySetup(sessionId))
      expect(refusal.code).toBe('invalid-spec')
      expect(refusal.detail).toContain('no project worktree')
    }
    // Nothing was resolved and nothing was written: there was nothing to resolve against.
    expect(context.setup.calls).toEqual([])
    expect(context.host.calls).toEqual([])
  })

  /*
   * The door the retry exists to keep open. A user who reads a failed install, decides the project
   * needs none and writes `"setup": []` would otherwise have every way out shut at once: the retry
   * saying "nothing to run", `reopen` refusing the wait, and a fresh create refused the slug it
   * already took. Nothing to install is not a failed retry - it is the session being told it may
   * start, and the re-armed record is picked up by the reconciler's ordinary replay, the same
   * machinery a setup that exited 0 reaches from the other side.
   */
  it('starts the waiting session when the retry finds the project needs no install', async () => {
    const context = await harness()
    await context.store.put(failedWaiting())
    await context.store.put(setupRecord({ exitCode: 1 }))
    context.setup.resolution = { kind: 'empty' }

    expect(await context.lifecycle.retrySetup('p1')).toEqual({ ok: true, value: undefined })
    expect(context.store.get('p1')).toEqual(expect.objectContaining({
      life: 'starting',
      binding: null,
      pendingOperationId: 'id-1',
      pendingOperationKind: 'create',
      pendingSetup: undefined,
      setupSkipped: { reason: 'the project declares an empty setup in .worktree.json' },
      endedReason: undefined,
    }))
    // It launches nothing itself, and it says nothing: the project declared this in its own file.
    expect(context.host.calls).toEqual([])
    expect(context.reports).toEqual([])

    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([{
      kind: 'retry-launch',
      sessionId: 'p1',
      operationId: 'id-1',
      operation: 'create',
    }])
    expect(context.store.get('p1')?.life).toBe('live')
    expect(callsNamed(context.host, 'runtime.create')[0].body.operationId).toBe('id-1')
  })

  // The same answer for the other half of it: nobody knows how to install this. Refusing to start a
  // session whose worktree is already on disk helps no one, so it starts and the marker says why.
  it('starts the waiting session when the retry can no longer say what installs it', async () => {
    const context = await harness()
    await context.store.put(failedWaiting())
    await context.store.put(setupRecord({ exitCode: 1 }))
    context.setup.resolution = { kind: 'none', reason: 'the .worktree.json is not valid JSON' }

    expect(await context.lifecycle.retrySetup('p1')).toEqual({ ok: true, value: undefined })
    expect(context.store.get('p1')).toEqual(expect.objectContaining({
      life: 'starting',
      pendingOperationId: 'id-1',
      pendingSetup: undefined,
      setupSkipped: { reason: 'the .worktree.json is not valid JSON' },
    }))
    expect(context.host.calls).toEqual([])
    // Unlike the empty setup, this one is said out loud: nobody asked for a worktree with nothing in it.
    expect(context.reports).toHaveLength(1)
    expect(context.reports[0]).toContain('not valid JSON')
    expect(context.reports[0]).toContain(join(projectRoot, '.worktree.json'))

    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([{
      kind: 'retry-launch',
      sessionId: 'p1',
      operationId: 'id-1',
      operation: 'create',
    }])
    expect(context.store.get('p1')?.life).toBe('live')
  })

  /*
   * The install was only ever preparing this one session, so removing the session stops it. Best
   * effort and nothing more: the setup's own record stays, ends like any other shell session, and
   * keeps what it printed readable.
   */
  it('stops the install when the session it was preparing is removed', async () => {
    const context = await harness()
    context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])
    await context.lifecycle.create(worktreeSpec())

    expect(await context.lifecycle.remove('id-1')).toEqual({ ok: true, value: undefined })
    expect(context.store.get('id-1')).toBeNull()
    expect(callsNamed(context.host, 'runtime.stop')[0].body.target).toEqual({
      hostInstanceId: 'host-1',
      runtimeSessionId: 'id-3',
      generation: 1,
    })
    expect(context.store.get('id-3')).not.toBeNull()
  })

  /*
   * The install the Host never answered has no runtime, so stopping reaches nothing at all - and what
   * is left on disk is a `starting` record with a pending pair, which is precisely what the next
   * reconcile pass REPLAYS. It would run `pnpm install` in a worktree that belongs to no session any
   * more. The pair is what has to go, so the record ends here instead, saying why.
   */
  it('takes away an install the Host never answered when its session is removed', async () => {
    const context = await harness()
    context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])
    context.host.failure = { ok: false, code: 'host-unreachable', detail: 'no descriptor' }
    await context.lifecycle.create(worktreeSpec())
    expect(context.store.get('id-3')).toEqual(expect.objectContaining({
      life: 'starting',
      binding: null,
      pendingOperationId: 'id-4',
      pendingOperationKind: 'create',
    }))

    expect(await context.lifecycle.remove('id-1')).toEqual({ ok: true, value: undefined })
    expect(context.store.get('id-3')).toEqual(expect.objectContaining({
      life: 'ended',
      pendingOperationId: undefined,
      pendingOperationKind: undefined,
      endedAt: 5_000,
      endedReason: expect.stringContaining('removed'),
    }))
    // Nothing to stop, so nothing was asked of the Host about it.
    expect(callsNamed(context.host, 'runtime.stop')).toEqual([])

    context.host.failure = null
    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
    expect(callsNamed(context.host, 'runtime.create')).toHaveLength(1)
  })

  /**
   * A plain tab is presented by its tab and by nothing else, which is what makes closing it different
   * from closing any other tab, and what makes promoting it the one way to keep it.
   */
  describe('plain tabs, promotion and the completed mark', () => {
    it('stops the runtime and takes the record with it when a plain tab is closed', async () => {
      const context = await harness()
      await context.store.put(record('t1', { presentation: 'tab' }))

      expect(await context.lifecycle.discardPlain('t1')).toEqual({ ok: true, value: undefined })
      expect(callsNamed(context.host, 'runtime.stop')).toHaveLength(1)
      expect(context.store.get('t1')).toBeNull()
    })

    /**
     * Marked before the stop rather than after it: what this has to survive is a crash between the
     * stop and the removal, and a record left behind by that reads as a session that fell over
     * unless the mark got there first.
     */
    it('marks the stop as asked for before it asks, so a half-closed tab still reads finished',
      async () => {
        const context = await harness()
        await context.store.put(record('t1', { presentation: 'tab' }))
        const original = AtomicJsonFile.write
        const write = vi.spyOn(AtomicJsonFile, 'write')
        // The mark lands; the removal that should have followed it does not.
        write.mockImplementationOnce(original)
        write.mockImplementationOnce(() => { throw new Error('EBUSY: the records file is locked') })

        await context.lifecycle.discardPlain('t1').finally(() => write.mockRestore())

        expect(context.store.get('t1')?.stopRequested).toBe(true)
      })

    // Closing the tab of a session of the tree still only detaches, which is the rule this one
    // narrow exception is written beside.
    it('refuses a session of the tree, so closing its tab ends nothing', async () => {
      const context = await harness()
      await context.store.put(record('s1'))

      expect(failureOf(await context.lifecycle.discardPlain('s1')).code).toBe('invalid-spec')
      expect(context.store.get('s1')).not.toBeNull()
      expect(callsNamed(context.host, 'runtime.stop')).toEqual([])
    })

    // The tab must not disappear while something may still be running behind it.
    it('keeps the record when the Host could not be asked to stop', async () => {
      const context = await harness()
      await context.store.put(record('t1', { presentation: 'tab' }))
      context.host.failure = { ok: false, code: 'host-unreachable', detail: 'no descriptor' }

      expect(failureOf(await context.lifecycle.discardPlain('t1')).code).toBe('host-unreachable')
      expect(context.store.get('t1')).not.toBeNull()
    })

    // 404 is the runtime having finished by itself, which is not a reason to keep the record.
    it('removes the record when the Host no longer has that runtime', async () => {
      const context = await harness()
      await context.store.put(record('t1', { presentation: 'tab' }))
      context.host.failure = {
        ok: false,
        code: 'op-rejected',
        status: 404,
        detail: 'no such runtime',
      }

      expect(await context.lifecycle.discardPlain('t1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('t1')).toBeNull()
    })

    it('asks the Host for nothing when the plain tab was already dead', async () => {
      const context = await harness()
      await context.store.put(record('t1', { presentation: 'tab', life: 'lost', binding: null }))

      expect(await context.lifecycle.discardPlain('t1')).toEqual({ ok: true, value: undefined })
      expect(callsNamed(context.host, 'runtime.stop')).toEqual([])
      expect(context.store.get('t1')).toBeNull()
    })

    it('numbers a promoted tab from its project and takes the mark away', async () => {
      const context = await harness()
      await context.store.put(record('t1', {
        presentation: 'tab',
        title: 'AppJamatV3',
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
      }))

      expect(await context.lifecycle.promotePlain('t1')).toEqual({ ok: true, value: undefined })
      expect(context.numbers.calls).toEqual([{ projectPath: projectRoot }])
      expect(context.store.get('t1')?.presentation).toBeUndefined()
      expect(context.store.get('t1')?.title).toBe('007 - AppJamatV3')
    })

    // Exactly what the create card does with the same two directories: a session without a number.
    it('promotes a tab that belongs to no project without asking for a number', async () => {
      const context = await harness()
      await context.store.put(record('t1', { presentation: 'tab', title: 'home' }))

      expect(await context.lifecycle.promotePlain('t1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('t1')?.title).toBe('home')
      expect(context.numbers.calls).toEqual([])
    })

    // A number nobody could take is not a reason to leave the session where it cannot be kept.
    it('promotes without a number when the numbers could not be taken', async () => {
      const context = await harness()
      context.numbers.token = null
      await context.store.put(record('t1', {
        presentation: 'tab',
        title: 'AppJamatV3',
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
      }))

      expect(await context.lifecycle.promotePlain('t1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('t1')?.title).toBe('AppJamatV3')
      expect(context.store.get('t1')?.presentation).toBeUndefined()
    })

    it('refuses to promote what is already a session of the tree', async () => {
      const context = await harness()
      await context.store.put(record('s1'))

      expect(failureOf(await context.lifecycle.promotePlain('s1')).code).toBe('invalid-spec')
    })

    /**
     * Stopping a session IS finishing with it: two clicks for one thought was the thing this
     * replaced. The exception is a session with after-steps still waiting on it.
     */
    it('marks a session finished as part of stopping it', async () => {
      const context = await harness()
      await context.store.put(record('s1'))

      expect(await context.lifecycle.stop('s1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('s1')?.completed).toBe(true)
    })

    /**
     * The mark used to be written for an install only. Every session needs it now, because it is the
     * one fact a killed process cannot carry itself and the whole reading of the ending rests on it.
     */
    it('records that the stop was asked for, whatever kind of session it was', async () => {
      const context = await harness()
      await context.store.put(record('s1'))
      await context.store.put(record('t1', { presentation: 'tab' }))

      await context.lifecycle.stop('s1')
      await context.lifecycle.stop('t1')

      expect(context.store.get('s1')?.stopRequested).toBe(true)
      expect(context.store.get('t1')?.stopRequested).toBe(true)
    })

    /**
     * The Host refusing is not the person changing their mind. It answers `did not confirm its death`
     * for a process that is dying slowly, and the exit lands a second later; without the mark that
     * ending reads as a crash, which is what this action exists to prevent.
     */
    it('records that the stop was asked for even when the Host refused it', async () => {
      const context = await harness()
      await context.store.put(record('s1'))
      context.host.failure = { ok: false, code: 'op-rejected', status: 409, detail: 'did not confirm' }

      expect(failureOf(await context.lifecycle.stop('s1')).code).toBe('op-rejected')
      expect(context.store.get('s1')?.stopRequested).toBe(true)
      // Only the asking. Whether it FINISHED is a different sentence, and nothing confirmed it.
      expect(context.store.get('s1')?.completed).toBeUndefined()
    })

    /**
     * The other half of that, and the reason the mark is not written by the stop alone: the process
     * the Host would not vouch for dies a second later, and its exit is what files the session.
     * Left unfiled it stays in the daily view as unfinished business no click can finish - measured
     * on 2026-08-20 on two sessions the person then deleted to be rid of them, which is the one
     * action here that takes the record away for good.
     */
    it('files the session when the exit of a refused stop arrives', async () => {
      const context = await harness()
      await context.store.put(record('s1'))
      context.host.runtimes.set('s1', runtime('s1'))
      context.host.failure = { ok: false, code: 'op-rejected', status: 409, detail: 'did not confirm' }

      expect(failureOf(await context.lifecycle.stop('s1')).code).toBe('op-rejected')
      expect(context.store.get('s1')?.completed).toBeUndefined()

      context.host.failure = null
      context.host.runtimes.set('s1', runtime('s1', {
        alive: false,
        exitCode: 0,
        exitReason: 'process-exit',
        exitedAt: 5_000,
      }))
      await context.lifecycle.reconcile(context.host.listing())

      expect(context.store.get('s1')).toEqual(expect.objectContaining({
        life: 'ended',
        completed: true,
      }))
    })

    /**
     * The second witness on its own. A client that died between the stop and its own write, or one
     * that never made the call, still reads the ending right: the Host remembers being asked.
     */
    it('files the session on the Host word for the ending alone', async () => {
      const context = await harness()
      await context.store.put(record('s1'))
      context.host.runtimes.set('s1', runtime('s1', {
        // What a killed process reports on Windows, and what makes the code useless as a witness.
        alive: false,
        exitCode: -1073741510,
        exitReason: 'stopped',
      }))

      await context.lifecycle.reconcile(context.host.listing())

      expect(context.store.get('s1')?.completed).toBe(true)
    })

    // The daily view is the person's verdict and not the Host's, so an ending nobody asked for is
    // still unfinished business: a session interrupted by a reboot reads exactly like this one.
    it('leaves an ending nobody asked for unfiled', async () => {
      const context = await harness()
      await context.store.put(record('s1'))
      context.host.runtimes.set('s1', runtime('s1', {
        alive: false,
        exitCode: 0,
        exitReason: 'process-exit',
      }))

      await context.lifecycle.reconcile(context.host.listing())

      expect(context.store.get('s1')?.life).toBe('ended')
      expect(context.store.get('s1')?.completed).toBeUndefined()
    })

    // The worktree exception holds on this path too: the branch still has to go home or be thrown
    // away, and until it does, this session is what the daily view is FOR.
    it('leaves a worktree session unfiled when the exit of a refused stop arrives', async () => {
      const context = await harness()
      await context.store.put(record('s1', {
        stopRequested: true,
        worktree: {
          worktreePath: join(projectRoot, '.worktrees', 'fix'),
          branch: 'jamat/fix',
          baseCommit: 'abc',
          repositoryRoot: projectRoot,
        },
      }))
      context.host.runtimes.set('s1', runtime('s1', { alive: false, exitCode: 0 }))

      await context.lifecycle.reconcile(context.host.listing())

      expect(context.store.get('s1')?.life).toBe('ended')
      expect(context.store.get('s1')?.completed).toBeUndefined()
    })

    /**
     * The other way a refused stop ends: the Host restarts before the exit is ever reported, so the
     * runtime is unfindable rather than dead. `lost` is what became of it; being done with it is
     * what the person said, and losing the Host does not take that back.
     */
    it('files a session the Host lost after a stop somebody asked for', async () => {
      const context = await harness()
      await context.store.put(record('s1', { stopRequested: true }))

      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toEqual([{ kind: 'mark-lost', sessionId: 's1' }])
      expect(context.store.get('s1')).toEqual(expect.objectContaining({
        life: 'lost',
        completed: true,
      }))
    })

    // ... and a session nobody asked to stop is lost and still unfinished, which is the whole point
    // of the two being different questions.
    it('leaves a session the Host lost on its own unfiled', async () => {
      const context = await harness()
      await context.store.put(record('s1'))

      await context.lifecycle.reconcile(context.host.listing())

      expect(context.store.get('s1')?.life).toBe('lost')
      expect(context.store.get('s1')?.completed).toBeUndefined()
    })

    /**
     * The two roles somebody else is waiting on. A refused stop may have reached neither of them, and
     * a marked install fails the session it was preparing while that install is still running.
     */
    it('leaves the install and the resolver unmarked when the Host refused', async () => {
      const context = await harness()
      await context.store.put(record('setup-1', { setupFor: 'primary-1' }))
      await context.store.put(record('resolve-1', { resolveFor: 'primary-1' }))
      context.host.failure = { ok: false, code: 'op-rejected', status: 409, detail: 'did not confirm' }

      await context.lifecycle.stop('setup-1')
      await context.lifecycle.stop('resolve-1')

      expect(context.store.get('setup-1')?.stopRequested).toBeUndefined()
      expect(context.store.get('resolve-1')?.stopRequested).toBeUndefined()
    })

    /*
     * The stop happened - the Host confirmed it - so this is not a refusal, and answering one would
     * say the runtime is still there. What did not land is the fact that makes the ending readable:
     * `stopRequested` is asked BEFORE the exit code by the install gate and the merge resolver, and
     * on POSIX a signalled process reports 0.
     */
    it('says so when a stop landed but its record could not be written', async () => {
      const context = await harness()
      await context.store.put(record('s1'))
      // Unwritable only NOW: the record has to exist for there to be a stop at all, and it is
      // the write AFTER the Host's answer that this is about. A directory at the path is how
      // the store's own test stages a file that cannot be written.
      rmSync(context.recordsFile, { force: true })
      mkdirSync(context.recordsFile)
      context.reports.length = 0

      expect(await context.lifecycle.stop('s1')).toEqual({ ok: true, value: undefined })

      expect(context.reports.some((message) => message.includes('was stopped, but the record')))
        .toBe(true)
    })

    /*
     * Built through `stop()` rather than by writing the mark into a literal, which is the whole
     * point: the writer once covered only records carrying `setupFor`, so a resolver somebody
     * stopped kept no mark and `childJudgement` read it by the exit code the platform gives a
     * killed process - 0 on POSIX - and called the resolution clean. The merge then went on from
     * whatever half-resolved tree the killed agent had left.
     */
    it('marks a stopped resolver the way it marks a stopped install', async () => {
      const context = await harness()
      await context.store.put(record('setup-1', { setupFor: 'primary-1' }))
      await context.store.put(record('resolve-1', { resolveFor: 'primary-1' }))

      expect(await context.lifecycle.stop('setup-1')).toEqual({ ok: true, value: undefined })
      expect(await context.lifecycle.stop('resolve-1')).toEqual({ ok: true, value: undefined })

      expect(context.store.get('setup-1')?.stopRequested).toBe(true)
      expect(context.store.get('resolve-1')?.stopRequested).toBe(true)
    })

    it('leaves a session with a worktree unfinished until its ending is chosen', async () => {
      const context = await harness()
      await context.store.put(record('s1', {
        worktree: {
          worktreePath: join(projectRoot, '.worktrees', 'fix'),
          branch: 'jamat/fix',
          baseCommit: 'abc',
          repositoryRoot: projectRoot,
        },
      }))

      expect(await context.lifecycle.stop('s1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('s1')?.completed).toBeUndefined()
      // ... but the ending was still asked for, which is what keeps the row from reading as a crash
      // while it waits for its merge.
      expect(context.store.get('s1')?.stopRequested).toBe(true)
    })

    // Running it again is the opposite of being done with it: a reopened session that kept the mark
    // would be live and still filed as finished, which is to say invisible.
    it('takes the finished mark off a session it reopens', async () => {
      const context = await harness()
      await context.store.put(record('s1', {
        life: 'ended',
        binding: null,
        completed: true,
      }))

      expect(await context.lifecycle.reopen('s1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('s1')?.completed).toBeUndefined()
    })

    // The new run has its own ending; inheriting the last one's would have it read as finished from
    // the second it starts.
    it('takes both witnesses of the last ending off a session it reopens', async () => {
      const context = await harness()
      await context.store.put(record('s1', {
        life: 'ended',
        binding: null,
        stopRequested: true,
        exitReason: 'stopped',
        exitCode: -1073741510,
      }))

      expect(await context.lifecycle.reopen('s1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('s1')?.stopRequested).toBeUndefined()
      expect(context.store.get('s1')?.exitReason).toBeUndefined()
    })

    it('finds a Codex id from the rollout and reopens by it', async () => {
      const context = await harness()
      context.codexRollouts.byDirectory.set(context.workDirectory, [
        rollout('conv-1', 5_000),
      ])
      await context.store.put(record('s1', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'new' },
        directory: { mode: 'adHoc', path: context.workDirectory },
        life: 'lost',
        binding: null,
        createdAt: 5_000,
      }))

      expect(await context.lifecycle.reopen('s1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('s1')?.agent?.nativeSessionId).toBe('conv-1')
      expect(launchOf(callsNamed(context.host, 'runtime.create')[0]).args.slice(-2))
        .toEqual(['resume', 'conv-1'])
    })

    it('names old Codex records on startup and skips records that cannot need a lookup', async () => {
      const context = await harness()
      const createdAt = -3_600_000
      context.codexRollouts.byDirectory.set(context.workDirectory, [
        rollout('conv-1', createdAt + 1_000),
        rollout('conv-3', createdAt + 2_000, 'conv-2'),
      ])
      await context.store.put(record('s1', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'new' },
        directory: { mode: 'adHoc', path: context.workDirectory },
        life: 'lost',
        binding: null,
        createdAt,
      }))
      // The fork this pass exists for: taken long ago, never named, and its rollout says whose it is.
      await context.store.put(record('s5', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'fork', forkParentId: 'conv-2' },
        directory: { mode: 'adHoc', path: context.workDirectory },
        life: 'lost',
        binding: null,
        createdAt,
      }))
      await context.store.put(record('s2', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'new', nativeSessionId: 'conv-2' },
        directory: { mode: 'adHoc', path: context.workDirectory },
      }))
      await context.store.put(record('s3', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new' },
        directory: { mode: 'adHoc', path: context.workDirectory },
      }))
      await context.store.put(record('s4', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'continue' },
        directory: { mode: 'adHoc', path: context.workDirectory },
      }))

      await context.lifecycle.nameCodexOnStartup()

      expect(context.store.get('s1')?.agent?.nativeSessionId).toBe('conv-1')
      expect(context.store.get('s5')?.agent?.nativeSessionId).toBe('conv-3')
      // Two records were looked for and the other three were not: the Claude one, the one that
      // already has an id, and the `continue` that no id could name.
      expect(context.codexRollouts.windowCalls).toEqual([
        { directory: context.workDirectory, from: createdAt - 60_000, until: createdAt + 300_000 },
        { directory: context.workDirectory, from: createdAt - 60_000, until: createdAt + 300_000 },
      ])
    })

    it('makes only one startup naming attempt in a process', async () => {
      const context = await harness()
      context.codexRollouts.byDirectory.set(context.workDirectory, [
        rollout('conv-1', 5_000),
        rollout('conv-2', 5_100),
      ])
      await context.store.put(record('s1', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'new' },
        directory: { mode: 'adHoc', path: context.workDirectory },
        life: 'lost',
        binding: null,
        createdAt: 5_000,
      }))
      await context.lifecycle.nameCodexOnStartup()
      context.codexRollouts.byDirectory.set(context.workDirectory, [
        rollout('conv-1', 5_000),
      ])

      await context.lifecycle.nameCodexOnStartup()

      expect(context.codexRollouts.windowCalls).toHaveLength(1)
      expect(context.store.get('s1')?.agent?.nativeSessionId).toBeUndefined()
    })

    /**
     * The pass's own look, which is what makes the id knowable for a session nobody reopens. Before
     * it, the status bar could draw no model and no context for any Codex session, File Changes had
     * no conversation to reconstruct and the tab menu offered no fork.
     */
    it('names the conversation of a live Codex session on the reconcile pass', async () => {
      const context = await harness()
      context.host.runtimes.set('s1', runtime('s1'))
      context.codexRollouts.byDirectory.set(context.workDirectory, [
        rollout('conv-1', 5_000),
      ])
      await context.store.put(record('s1', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'new' },
        directory: { mode: 'adHoc', path: context.workDirectory },
        createdAt: 4_000,
      }))

      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toContainEqual({ kind: 'name-codex-conversation', sessionId: 's1' })
      expect(context.store.get('s1')?.agent?.nativeSessionId).toBe('conv-1')
      // Read from the moment the record started, minus the slack a rollout may lag by, so the walk
      // covers the days that window touches and nothing else.
      expect(context.codexRollouts.windowCalls).toEqual([{
        directory: context.workDirectory,
        from: context.store.get('s1')!.createdAt - 60_000,
        until: context.store.get('s1')!.createdAt + 300_000,
      }])
    })

    /** The second pass has nothing left to do, and says so rather than writing the record again. */
    it('names it once and then stops asking', async () => {
      const context = await harness()
      context.host.runtimes.set('s1', runtime('s1'))
      context.codexRollouts.byDirectory.set(context.workDirectory, [
        rollout('conv-1', 5_000),
      ])
      await context.store.put(record('s1', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'new' },
        directory: { mode: 'adHoc', path: context.workDirectory },
        createdAt: 4_000,
      }))
      await context.lifecycle.reconcile(context.host.listing())

      expect(await context.lifecycle.reconcile(context.host.listing()))
        .not.toContainEqual({ kind: 'name-codex-conversation', sessionId: 's1' })
      expect(context.codexRollouts.windowCalls).toHaveLength(1)
    })

    // Landing on somebody else's conversation is the harm the whole capture is written to avoid.
    it('claims nothing on the pass when two rollouts could be the session', async () => {
      const context = await harness()
      context.host.runtimes.set('s1', runtime('s1'))
      context.codexRollouts.byDirectory.set(context.workDirectory, [
        rollout('conv-1', 5_000),
        rollout('conv-2', 5_000),
      ])
      await context.store.put(record('s1', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'new' },
        directory: { mode: 'adHoc', path: context.workDirectory },
        createdAt: 4_000,
      }))

      expect(await context.lifecycle.reconcile(context.host.listing()))
        .not.toContainEqual({ kind: 'name-codex-conversation', sessionId: 's1' })
      expect(context.store.get('s1')?.agent?.nativeSessionId).toBeUndefined()
    })

    it('leaves the record and the refusal alone when the rollout is ambiguous', async () => {
      const context = await harness()
      context.codexRollouts.byDirectory.set(context.workDirectory, [
        rollout('conv-1', 5_000),
        rollout('conv-2', 5_100),
      ])
      await context.store.put(record('s1', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'new' },
        directory: { mode: 'adHoc', path: context.workDirectory },
        life: 'lost',
        binding: null,
        createdAt: 5_000,
      }))

      expect(failureOf(await context.lifecycle.reopen('s1')).code).toBe('invalid-spec')
      expect(context.store.get('s1')?.agent?.nativeSessionId).toBeUndefined()
      expect(callsNamed(context.host, 'runtime.create')).toEqual([])
    })

    // A Claude session is launched under an id this client minted, so there is nothing to look for.
    it('reads no rollouts for an agent that already names its conversation', async () => {
      const context = await harness()
      await context.store.put(record('s1', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
        directory: { mode: 'adHoc', path: context.workDirectory },
        life: 'lost',
        binding: null,
      }))

      expect(await context.lifecycle.reopen('s1')).toEqual({ ok: true, value: undefined })
      expect(context.codexRollouts.windowCalls).toEqual([])
    })
  })

  describe('forking a session', () => {
    /** Robust against the ComSpec wrap and against a yolo flag appended behind the mode flags. */
    function argsOf(context: Harness): string[] {
      return launchOf(callsNamed(context.host, 'runtime.create')[0]).args
    }

    it('forks the conversation into a session of the tree, in the same project', async () => {
      const context = await harness()
      context.numbers.token = '015'
      await context.store.put(record('s1', {
        kind: 'agent',
        title: '007 - AppJamatV3',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
      }))

      const forked = successOf(await context.lifecycle.forkFrom('s1'))
      const child = context.store.get(forked.sessionId)
      // The fork starts a conversation of its own, so Claude is told the id it will run under.
      expect(child?.agent).toEqual({
        agentId: 'claude',
        launchMode: 'fork',
        forkParentId: 'native-1',
        nativeSessionId: expect.stringMatching(/^id-\d+$/) as unknown as string,
      })
      expect(argsOf(context).slice(-2))
        .toEqual(['--session-id', child?.agent?.nativeSessionId])
      // A fork is the tree's, never a plain tab: closing a plain tab discards its record.
      expect(child?.presentation).toBeUndefined()
      expect(child?.directory)
        .toEqual({ mode: 'project', categoryId: 'c1', projectPath: projectRoot })
      expect(child?.title).toBe('007-015 - AppJamatV3')

      const args = argsOf(context)
      expect(args[args.indexOf('--resume') + 1]).toBe('native-1')
      expect(args).toContain('--fork-session')
    })

    /*
     * The one thing a caller may say about a fork, because it is the one thing the record cannot:
     * the card that asks for the fork lets the name be typed over first. The numbers around it stay
     * this library's - a caller naming the whole title would be composing the pair itself.
     */
    it('takes a name over the parent’s and still composes the number pair', async () => {
      const context = await harness()
      context.numbers.token = '015'
      await context.store.put(record('s1', {
        kind: 'agent',
        title: '007 - the wire',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
      }))

      const forked = successOf(await context.lifecycle.forkFrom('s1', { name: '  the listener  ' }))

      expect(context.store.get(forked.sessionId)?.title).toBe('007-015 - the listener')
    })

    // An empty name is a name: it says "no name", and the fork is then called by its numbers alone.
    it('reads an empty name as no name rather than as the parent’s', async () => {
      const context = await harness()
      context.numbers.token = '015'
      await context.store.put(record('s1', {
        kind: 'agent',
        title: '007 - the wire',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
      }))

      const forked = successOf(await context.lifecycle.forkFrom('s1', { name: '' }))

      expect(context.store.get(forked.sessionId)?.title).toBe('007-015')
    })

    it('gives a project fork without a parent number the new ordinary number', async () => {
      const context = await harness()
      context.numbers.token = '015'
      await context.store.put(record('s1', {
        kind: 'agent',
        title: 'AppJamatV3',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
      }))

      const forked = successOf(await context.lifecycle.forkFrom('s1'))

      expect(context.store.get(forked.sessionId)?.title).toBe('015 - AppJamatV3')
    })

    // The one thing a client could never do for itself, which is the argument for the operation
    // living here at all.
    it('goes and finds a Codex id before deciding it has nothing to fork', async () => {
      const context = await harness()
      context.codexRollouts.byDirectory.set(context.workDirectory, [
        rollout('conv-1', 5_000),
      ])
      await context.store.put(record('s1', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'new' },
        directory: { mode: 'adHoc', path: context.workDirectory },
        createdAt: 5_000,
      }))

      const forked = successOf(await context.lifecycle.forkFrom('s1'))
      expect(context.store.get('s1')?.agent?.nativeSessionId).toBe('conv-1')
      expect(context.store.get(forked.sessionId)?.agent?.forkParentId).toBe('conv-1')
      const args = argsOf(context)
      expect(args[args.indexOf('fork') + 1]).toBe('conv-1')
    })

    it('refuses a conversation that never named itself, rather than forking the newest one', async () => {
      const context = await harness()
      await context.store.put(record('s1', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'new' },
        directory: { mode: 'adHoc', path: context.workDirectory },
      }))

      expect(failureOf(await context.lifecycle.forkFrom('s1')).code).toBe('invalid-spec')
      expect(callsNamed(context.host, 'runtime.create')).toEqual([])
    })

    it('refuses to fork a shell, and answers not-found for a session that is gone', async () => {
      const context = await harness()
      await context.store.put(record('s1'))

      expect(failureOf(await context.lifecycle.forkFrom('s1')).code).toBe('invalid-spec')
      expect(failureOf(await context.lifecycle.forkFrom('nobody')).code).toBe('not-found')
    })

    // The rollout of a fork names the conversation it was cut from, which is what tells it apart
    // from a fresh session started in the same directory a minute later.
    it('names a Codex fork from the rollout that says whose fork it is', async () => {
      const context = await harness()
      context.codexRollouts.byDirectory.set(context.workDirectory, [
        rollout('conv-2', 5_100, 'conv-1'),
        rollout('conv-3', 5_100),
      ])
      await context.store.put(record('f1', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'fork', forkParentId: 'conv-1' },
        directory: { mode: 'adHoc', path: context.workDirectory },
        life: 'live',
        createdAt: 5_000,
      }))

      await context.lifecycle.nameCodexOnStartup()

      expect(context.store.get('f1')?.agent?.nativeSessionId).toBe('conv-2')
    })

    it('leaves a Codex fork unnamed when the only candidate names another parent', async () => {
      const context = await harness()
      context.codexRollouts.byDirectory.set(context.workDirectory, [
        rollout('conv-2', 5_100, 'conv-9'),
      ])
      await context.store.put(record('f1', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'fork', forkParentId: 'conv-1' },
        directory: { mode: 'adHoc', path: context.workDirectory },
        life: 'live',
        createdAt: 5_000,
      }))

      await context.lifecycle.nameCodexOnStartup()

      expect(context.store.get('f1')?.agent?.nativeSessionId).toBeUndefined()
    })

    // The chain: the child's own id is what the grandchild is cut from, for either agent.
    it('forks a fork, taking the child\'s own conversation as the grandchild\'s parent', async () => {
      const context = await harness()
      await context.store.put(record('s1', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
        directory: { mode: 'adHoc', path: context.workDirectory },
      }))

      const child = successOf(await context.lifecycle.forkFrom('s1'))
      const childId = context.store.get(child.sessionId)?.agent?.nativeSessionId
      expect(childId).toMatch(/^id-\d+$/)

      const grandchild = successOf(await context.lifecycle.forkFrom(child.sessionId))
      expect(context.store.get(grandchild.sessionId)?.agent?.forkParentId).toBe(childId)
    })

    // The Codex half of the same chain: the child is named from its rollout first, then forked.
    it('captures an unnamed Codex fork before forking it again', async () => {
      const context = await harness()
      context.codexRollouts.byDirectory.set(context.workDirectory, [
        rollout('conv-2', 5_100, 'conv-1'),
      ])
      await context.store.put(record('f1', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'fork', forkParentId: 'conv-1' },
        directory: { mode: 'adHoc', path: context.workDirectory },
        createdAt: 5_000,
      }))

      const grandchild = successOf(await context.lifecycle.forkFrom('f1'))

      expect(context.store.get('f1')?.agent?.nativeSessionId).toBe('conv-2')
      expect(context.store.get(grandchild.sessionId)?.agent?.forkParentId).toBe('conv-2')
      const args = argsOf(context)
      expect(args[args.indexOf('fork') + 1]).toBe('conv-2')
    })

    // A resolver's worktree goes when the merge it is settling is done, and a fork of it would keep
    // standing there. `admitsOf` withholds the verb for the same shape.
    it('refuses to fork a session that is resolving somebody\'s merge', async () => {
      const context = await harness()
      await context.store.put(record('r1', {
        kind: 'agent',
        agent: {
          agentId: 'claude', launchMode: 'fork', forkParentId: 'native-1', nativeSessionId: 'native-2',
        },
        directory: { mode: 'adHoc', path: context.workDirectory },
        resolveFor: 's1',
      }))

      expect(failureOf(await context.lifecycle.forkFrom('r1')).code).toBe('invalid-spec')
      expect(callsNamed(context.host, 'runtime.create')).toEqual([])
    })

    /** A restart resumes the fork itself; forking the parent again would be a second fork. */
    it('restarts a named fork by resuming its own conversation', async () => {
      const context = await harness()
      await context.store.put(record('f1', {
        kind: 'agent',
        agent: {
          agentId: 'claude', launchMode: 'fork', forkParentId: 'native-1', nativeSessionId: 'native-2',
        },
        directory: { mode: 'adHoc', path: context.workDirectory },
        life: 'lost',
        binding: null,
      }))

      expect(await context.lifecycle.reopen('f1')).toEqual({ ok: true, value: undefined })
      const args = launchOf(callsNamed(context.host, 'runtime.create')[0]).args
      expect(args.slice(-2)).toEqual(['--resume', 'native-2'])
      expect(args).not.toContain('--fork-session')
    })
  })

  describe('opening a provider history conversation', () => {
    function spec(
      agentId: SessionHistoryOpenSpec['agentId'],
      nativeSessionId: string,
      providerActive = false,
    ): SessionHistoryOpenSpec {
      return {
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
        agentId,
        nativeSessionId,
        providerName: 'Provider task',
        providerActive,
      }
    }

    it('resumes an ended Claude or Codex conversation by its exact id', async () => {
      for (const agentId of ['claude', 'codex'] as const) {
        const context = await harness()
        const opened = successOf(await context.lifecycle.openHistory(spec(agentId, 'native-1')))
        expect(context.store.get(opened.sessionId)?.agent).toEqual({
          agentId,
          launchMode: 'resume',
          nativeSessionId: 'native-1',
        })
        expect(context.store.get(opened.sessionId)?.title).toBe('007 - Provider task')
      }
    })

    it('reopens the same ended V3 record with its number and name intact', async () => {
      const context = await harness()
      await context.store.put(record('s1', {
        kind: 'agent',
        title: '014 - Existing task',
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
        life: 'ended',
        binding: null,
      }))

      const opened = successOf(await context.lifecycle.openHistory(spec('claude', 'native-1')))

      expect(opened.sessionId).toBe('s1')
      expect(context.store.get('s1')?.title).toBe('014 - Existing task')
      expect(context.store.list()).toHaveLength(1)
      expect(context.numbers.calls).toEqual([])
    })

    it('forks when Claude reports the provider conversation active without a V3 record', async () => {
      const context = await harness()
      const opened = successOf(await context.lifecycle.openHistory(spec('claude', 'native-1', true)))
      expect(context.store.get(opened.sessionId)?.agent).toEqual({
        agentId: 'claude',
        launchMode: 'fork',
        forkParentId: 'native-1',
        nativeSessionId: expect.stringMatching(/^id-\d+$/) as unknown as string,
      })
      expect(context.store.get(opened.sessionId)?.title).toBe('007 - Provider task')
    })

    it('forks a conversation held by a starting or live V3 record without a provider active hint',
      async () => {
        for (const life of ['starting', 'live'] as const) {
          const context = await harness()
          context.numbers.token = '015'
          await context.store.put(record('s1', {
            kind: 'agent',
            title: '014 - Existing task',
            directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
            agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
            life,
          }))

          const opened = successOf(await context.lifecycle.openHistory(spec('claude', 'native-1')))
          expect(context.store.get(opened.sessionId)?.agent).toEqual({
            agentId: 'claude',
            launchMode: 'fork',
            forkParentId: 'native-1',
            nativeSessionId: expect.stringMatching(/^id-\d+$/) as unknown as string,
          })
          expect(context.store.get(opened.sessionId)?.title).toBe('014-015 - Existing task')
        }
      })

    it('captures a live Codex record before deciding to fork its conversation', async () => {
      const context = await harness()
      context.codexRollouts.byDirectory.set(projectRoot, [
        rollout('conv-1', 5_000),
      ])
      await context.store.put(record('s1', {
        kind: 'agent',
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
        agent: { agentId: 'codex', launchMode: 'new' },
        life: 'live',
        createdAt: 5_000,
      }))

      const opened = successOf(await context.lifecycle.openHistory(spec('codex', 'conv-1')))
      expect(context.store.get('s1')?.agent?.nativeSessionId).toBe('conv-1')
      expect(context.store.get(opened.sessionId)?.agent).toEqual({
        agentId: 'codex',
        launchMode: 'fork',
        forkParentId: 'conv-1',
      })
    })

    it('returns the exact local tree title and captures a missing Codex id first', async () => {
      const context = await harness()
      context.codexRollouts.byDirectory.set(projectRoot, [
        rollout('conv-1', 5_000),
      ])
      await context.store.put(record('s1', {
        kind: 'agent',
        title: '014 - Existing Codex task',
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
        agent: { agentId: 'codex', launchMode: 'new' },
        life: 'ended',
        createdAt: 5_000,
      }))

      const listed = successOf(await context.lifecycle.historyReferences({
        mode: 'project',
        categoryId: 'c1',
        projectPath: projectRoot,
      }))

      expect(listed.references).toEqual([{
        sessionId: 's1',
        agentId: 'codex',
        nativeSessionId: 'conv-1',
        title: '014 - Existing Codex task',
        titleParts: { number: '014', name: 'Existing Codex task' },
        life: 'ended',
      }])
    })

    it('refuses an invalid history request before creating a record', async () => {
      const context = await harness()
      const invalid = {
        ...spec('claude', 'native-1'),
        directory: { mode: 'adHoc', path: projectRoot },
      } as unknown as SessionHistoryOpenSpec

      expect(failureOf(await context.lifecycle.openHistory(invalid))).toMatchObject({
        code: 'invalid-spec',
        detail: 'history needs a catalog project',
      })
      expect(context.store.list()).toEqual([])
    })
  })

  describe('the colour on a session', () => {
    it('writes the name onto the record', async () => {
      const context = await harness()
      await context.store.put(record('s1'))

      expect(await context.lifecycle.setColor('s1', 'teal'))
        .toEqual({ ok: true, value: undefined })
      expect(context.store.get('s1')?.color).toBe('teal')
    })

    // None is the absence of a colour, so the field goes rather than holding a word for nothing.
    it('deletes the field when the colour is taken away', async () => {
      const context = await harness()
      await context.store.put(record('s1', { color: 'teal' }))

      expect(await context.lifecycle.setColor('s1', null))
        .toEqual({ ok: true, value: undefined })
      expect(context.store.get('s1')).not.toHaveProperty('color')
    })

    it('replaces a colour that is already there', async () => {
      const context = await harness()
      await context.store.put(record('s1', { color: 'teal' }))

      await context.lifecycle.setColor('s1', 'rose')
      expect(context.store.get('s1')?.color).toBe('rose')
    })

    // The write is where a name nobody can draw is worth answering: the record stays as it was.
    it('refuses a name that is not in the palette and leaves the record alone', async () => {
      const context = await harness()
      await context.store.put(record('s1', { color: 'teal' }))

      expect(failureOf(await context.lifecycle.setColor('s1', 'chartreuse' as never)).code)
        .toBe('invalid-spec')
      expect(context.store.get('s1')?.color).toBe('teal')
    })

    it('answers not-found for a session that does not exist', async () => {
      const context = await harness()

      expect(failureOf(await context.lifecycle.setColor('nobody', 'red')).code).toBe('not-found')
    })

    it('touches nothing on the Host', async () => {
      const context = await harness()
      await context.store.put(record('s1'))

      await context.lifecycle.setColor('s1', 'blue')
      expect(context.host.calls).toEqual([])
    })
  })

  describe('the details on a session', () => {
    it('writes the name, the note and the colour as one record', async () => {
      const context = await harness()
      await context.store.put(record('s1', { title: '014 - staré' }))
      const puts = vi.spyOn(context.store, 'put')

      expect(successOf(await context.lifecycle.setDetails('s1', {
        name: 'nové',
        note: 'why this one exists',
        color: 'teal',
      }))).toEqual({ titleChanged: true, notifyAgent: null })
      expect(puts).toHaveBeenCalledTimes(1)
      const stored = context.store.get('s1')
      expect(stored?.title).toBe('014 - nové')
      expect(stored?.note).toBe('why this one exists')
      expect(stored?.color).toBe('teal')
    })

    /*
     * The Codex half of one behaviour - the agent behind a session should learn its new name - was
     * a condition and a command string in the details overlay until 2026-08-24, while Claude's half
     * was the transcript write here. A third agent, or a change to when Codex takes the command, had
     * to be made in both places, and nothing joined them: the two files are never compiled as one
     * statement.
     *
     * The library answers it now. Typing into a TUI is still the client's - what travels back is the
     * text and never the typing.
     */
    it('says what a live codex session still has to be told', async () => {
      const context = await harness()
      await context.store.put(record('s1', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'new', nativeSessionId: 'native-1' },
        title: '014 - old',
        life: 'live',
      }))

      expect(successOf(await context.lifecycle.setDetails('s1', { name: 'new' }))).toEqual({
        titleChanged: true,
        notifyAgent: { text: '/rename new' },
      })
    })

    it('tells nobody where there is nothing to tell', async () => {
      const context = await harness()
      const codex = {
        kind: 'agent' as const,
        agent: { agentId: 'codex' as const, launchMode: 'new' as const, nativeSessionId: 'n1' },
        title: '014 - old',
      }

      // A name that did not move.
      await context.store.put(record('same', { ...codex, life: 'live' }))
      expect(successOf(await context.lifecycle.setDetails('same', { name: 'old' })).notifyAgent)
        .toBeNull()

      // A session that is not running has no TUI to type into.
      await context.store.put(record('ended', { ...codex, life: 'ended' }))
      expect(successOf(await context.lifecycle.setDetails('ended', { name: 'new' })).notifyAgent)
        .toBeNull()

      // Claude needs no notice: its half is the transcript write this library does itself.
      await context.store.put(record('claude', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'n2' },
        title: '014 - old',
        life: 'live',
      }))
      expect(successOf(await context.lifecycle.setDetails('claude', { name: 'new' })).notifyAgent)
        .toBeNull()

      // And a save that carries no name at all.
      await context.store.put(record('note', { ...codex, life: 'live' }))
      expect(successOf(await context.lifecycle.setDetails('note', { note: 'words' })).notifyAgent)
        .toBeNull()
    })

    it('answers titleChanged false when the name stays', async () => {
      const context = await harness()
      await context.store.put(record('s1', { title: '014 - same' }))

      expect(successOf(await context.lifecycle.setDetails('s1', {
        name: 'same',
        note: 'noted',
        color: null,
      }))).toEqual({ titleChanged: false, notifyAgent: null })
      expect(context.store.get('s1')?.note).toBe('noted')
    })

    // The update is a diff: a field that is absent is not touched, so a name-only save cannot
    // revert a colour the submenu wrote while the dialog was open.
    it('merges only the fields the update carries', async () => {
      const context = await harness()
      await context.store.put(record('s1', { title: '014 - old', note: 'kept', color: 'teal' }))

      expect(successOf(await context.lifecycle.setDetails('s1', { name: 'new' })))
        .toEqual({ titleChanged: true, notifyAgent: null })
      const stored = context.store.get('s1')
      expect(stored?.title).toBe('014 - new')
      expect(stored?.note).toBe('kept')
      expect(stored?.color).toBe('teal')
    })

    // A save that carries no changed name never rewrites the title: `014 jméno` is not canonized
    // to `014 - jméno` by a note edit, and no provider propagation fires over it.
    it('leaves a non-canonical title alone on a save that does not change the name', async () => {
      const context = await harness()
      await context.store.put(record('s1', {
        kind: 'agent',
        title: '014 jméno',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
      }))

      expect(successOf(await context.lifecycle.setDetails('s1', { note: 'a note' })))
        .toEqual({ titleChanged: false, notifyAgent: null })
      expect(context.store.get('s1')?.title).toBe('014 jméno')
      expect(context.claudeTitles.calls).toEqual([])
    })

    // On a record with no prefix the name becomes the whole title, and a name shaped like a
    // session number would be reparsed as one by the next save. Behind a prefix it is just words.
    it('refuses a name shaped like a session number on a record with no prefix', async () => {
      const context = await harness()
      await context.store.put(record('s1', { title: 'plain shell' }))
      await context.store.put(record('s2', { title: '014 - old' }))

      const refused = failureOf(await context.lifecycle.setDetails('s1', {
        name: '2026 planning notes',
      }))
      expect(refused.code).toBe('invalid-spec')
      expect(refused.detail).toBe('A name must not begin like a session number')
      expect(context.store.get('s1')?.title).toBe('plain shell')

      expect(successOf(await context.lifecycle.setDetails('s2', { name: '2026 planning notes' })))
        .toEqual({ titleChanged: true, notifyAgent: null })
      expect(context.store.get('s2')?.title).toBe('014 - 2026 planning notes')
    })

    it('makes the name the whole title on a record with no prefix', async () => {
      const context = await harness()
      await context.store.put(record('s1', { title: 'plain shell' }))

      expect(successOf(await context.lifecycle.setDetails('s1', {
        name: 'renamed',
        note: null,
        color: null,
      }))).toEqual({ titleChanged: true, notifyAgent: null })
      expect(context.store.get('s1')?.title).toBe('renamed')
    })

    it('refuses an empty name on a record with no prefix', async () => {
      const context = await harness()
      await context.store.put(record('s1', { title: 'plain shell' }))

      expect(failureOf(await context.lifecycle.setDetails('s1', {
        name: '   ',
        note: null,
        color: null,
      })).code).toBe('invalid-spec')
      expect(context.store.get('s1')?.title).toBe('plain shell')
    })

    // Empty and null both clear: absence is the field going, never a stored word for nothing.
    it('deletes the note and the colour when they are cleared', async () => {
      const context = await harness()
      await context.store.put(record('s1', { note: 'old', color: 'teal' }))
      await context.store.put(record('s2', { note: 'old', color: 'rose' }))

      successOf(await context.lifecycle.setDetails('s1', { name: 's1', note: null, color: null }))
      successOf(await context.lifecycle.setDetails('s2', { name: 's2', note: '', color: null }))
      expect(context.store.get('s1')).not.toHaveProperty('note')
      expect(context.store.get('s1')).not.toHaveProperty('color')
      expect(context.store.get('s2')).not.toHaveProperty('note')
    })

    it('refuses a colour nobody can draw and leaves the record alone', async () => {
      const context = await harness()
      await context.store.put(record('s1', { color: 'teal' }))

      expect(failureOf(await context.lifecycle.setDetails('s1', {
        name: 'renamed',
        note: null,
        color: 'chartreuse' as never,
      })).code).toBe('invalid-spec')
      expect(context.store.get('s1')?.title).toBe('s1')
      expect(context.store.get('s1')?.color).toBe('teal')
    })

    it('refuses a note past the limit and leaves the record alone', async () => {
      const context = await harness()
      await context.store.put(record('s1'))

      expect(failureOf(await context.lifecycle.setDetails('s1', {
        name: 'renamed',
        note: 'x'.repeat(4001),
        color: null,
      })).code).toBe('invalid-spec')
      expect(context.store.get('s1')?.title).toBe('s1')
    })

    it('answers not-found for a session that does not exist', async () => {
      const context = await harness()

      expect(failureOf(await context.lifecycle.setDetails('nobody', {
        name: 'renamed',
        note: null,
        color: null,
      })).code).toBe('not-found')
    })

    // The record never landed, so nothing may reach the transcript either: the append answers to a
    // landed record only.
    it('refuses a write that cannot land, and touches no transcript over it', async () => {
      const context = await harness()
      await context.store.put(record('s1', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
      }))
      // A DIRECTORY at the records path, the same staging the harness options use - impossible to
      // write on every platform - put there after the record was seeded.
      const file = join(context.workDirectory, 'session-records.json')
      rmSync(file)
      mkdirSync(file)

      expect(failureOf(await context.lifecycle.setDetails('s1', {
        name: 'renamed',
        note: null,
        color: null,
      })).code).toBe('records-latched')
      expect(context.claudeTitles.calls).toEqual([])
    })

    it('appends the bare name to the Claude transcript, at the directory the session ran in', async () => {
      const context = await harness()
      await context.store.put(record('s1', {
        kind: 'agent',
        title: '014 - old',
        directory: { mode: 'adHoc', path: projectRoot },
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
      }))

      expect(successOf(await context.lifecycle.setDetails('s1', {
        name: 'renamed',
        note: null,
        color: null,
      }))).toEqual({ titleChanged: true, notifyAgent: null })
      expect(context.claudeTitles.calls).toEqual([
        { cwd: projectRoot, nativeSessionId: 'native-1', title: 'renamed' },
      ])
      expect(context.reports).toEqual([])
    })

    // An ended session keeps its transcript, so the rename reaches it too - and at the worktree the
    // session actually ran in, never the project directory it was cut from.
    it('appends for an ended session too, at its worktree', async () => {
      const context = await harness()
      await context.store.put(record('s1', {
        kind: 'agent',
        title: '014 - old',
        life: 'ended',
        binding: null,
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
        worktree: {
          worktreePath,
          branch: 'jamat/fix',
          baseCommit: 'abc123',
          repositoryRoot: projectRoot,
        },
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-2' },
      }))

      successOf(await context.lifecycle.setDetails('s1', { name: 'renamed', note: null, color: null }))
      expect(context.claudeTitles.calls).toEqual([
        { cwd: worktreePath, nativeSessionId: 'native-2', title: 'renamed' },
      ])
    })

    it('leaves the transcript alone for codex, for a shell and for a claude with no native id', async () => {
      const context = await harness()
      await context.store.put(record('codex', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'new', nativeSessionId: 'thread-1' },
      }))
      await context.store.put(record('shell'))
      await context.store.put(record('unminted', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'continue' },
      }))

      for (const sessionId of ['codex', 'shell', 'unminted'])
        successOf(await context.lifecycle.setDetails(sessionId, {
          name: 'renamed',
          note: null,
          color: null,
        }))
      expect(context.claudeTitles.calls).toEqual([])
    })

    it('leaves the transcript alone when the title did not move', async () => {
      const context = await harness()
      await context.store.put(record('s1', {
        kind: 'agent',
        title: '014 - same',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
      }))

      expect(successOf(await context.lifecycle.setDetails('s1', {
        name: 'same',
        note: 'a note',
        color: null,
      }))).toEqual({ titleChanged: false, notifyAgent: null })
      expect(context.claudeTitles.calls).toEqual([])
    })

    it('keeps the save when the transcript write answers false, and says so', async () => {
      const context = await harness()
      context.claudeTitles.outcome = false
      await context.store.put(record('s1', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
      }))

      expect(successOf(await context.lifecycle.setDetails('s1', {
        name: 'renamed',
        note: null,
        color: null,
      }))).toEqual({ titleChanged: true, notifyAgent: null })
      expect(context.store.get('s1')?.title).toBe('renamed')
      expect(context.reports).toEqual([
        'The new name of s1 was not written to the Claude transcript',
      ])
    })

    it('keeps the save when the transcript write throws', async () => {
      const context = await harness()
      context.claudeTitles.outcome = new Error('disk full')
      await context.store.put(record('s1', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
      }))

      expect(successOf(await context.lifecycle.setDetails('s1', {
        name: 'renamed',
        note: null,
        color: null,
      }))).toEqual({ titleChanged: true, notifyAgent: null })
      expect(context.store.get('s1')?.title).toBe('renamed')
      expect(context.reports).toEqual([
        'The new name of s1 was not written to the Claude transcript',
      ])
    })

    it('touches nothing on the Host', async () => {
      const context = await harness()
      await context.store.put(record('s1'))

      await context.lifecycle.setDetails('s1', { name: 'renamed', note: null, color: null })
      expect(context.host.calls).toEqual([])
    })
  })

  describe('yolo', () => {
    const claudeFlagConst = '--dangerously-skip-permissions'
    const codexFlagConst = '--dangerously-bypass-approvals-and-sandbox'

    /**
     * The args the AGENT sees, with the win32 ComSpec wrap taken off. Every assertion here is about
     * the order the CLI reads, and this file runs on whichever platform the developer is on.
     */
    function agentArgsOf(launch: RuntimeLaunchSpec): string[] {
      return launch.args[0] === '/d' ? launch.args.slice(4) : launch.args
    }

    async function created(context: Harness, agentId: 'claude' | 'codex'): Promise<string> {
      const answer = await context.lifecycle.create({
        kind: 'agent',
        directory: { mode: 'adHoc', path: context.workDirectory },
        agent: { agentId, mode: 'new' },
      })
      return successOf(answer).sessionId
    }

    it('carries the switch into a create, one agent at a time', async () => {
      const context = await harness()
      context.yolo.add('claude')

      await created(context, 'claude')
      await created(context, 'codex')

      const [claude, codex] = callsNamed(context.host, 'runtime.create').map(launchOf)
      expect(agentArgsOf(claude)).toContain(claudeFlagConst)
      expect(agentArgsOf(codex)).not.toContain(codexFlagConst)
      expect(agentArgsOf(codex).some((argument) => argument.startsWith('projects='))).toBe(false)
    })

    it('leaves a launch exactly as it is while the switch is off', async () => {
      const gated = await harness()
      await created(gated, 'claude')
      const on = await harness()
      on.yolo.add('claude')
      await created(on, 'claude')

      const before = agentArgsOf(launchOf(callsNamed(gated.host, 'runtime.create')[0]))
      const after = agentArgsOf(launchOf(callsNamed(on.host, 'runtime.create')[0]))
      expect(after).toEqual([claudeFlagConst, ...before])
      expect(gated.seeded).toEqual([])
    })

    // The whole reason the switch is a live setting rather than a field on the record.
    it('reads the switch again on every launch of the same session', async () => {
      const context = await harness()
      const sessionId = await created(context, 'claude')
      expect(agentArgsOf(launchOf(callsNamed(context.host, 'runtime.create')[0])))
        .not.toContain(claudeFlagConst)

      context.yolo.add('claude')
      await context.lifecycle.stop(sessionId)
      expect(await context.lifecycle.reopen(sessionId)).toEqual({ ok: true, value: undefined })

      const reopened = [...callsNamed(context.host, 'runtime.create'),
        ...callsNamed(context.host, 'runtime.replace')].at(-1)!
      expect(agentArgsOf(launchOf(reopened))).toContain(claudeFlagConst)
    })

    it('replays a create that never answered with the switch still applied', async () => {
      const context = await harness()
      context.yolo.add('claude')
      await context.store.put(record('s1', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
        life: 'starting',
        binding: null,
        pendingOperationId: 'op-7',
        pendingOperationKind: 'create',
      }))

      await context.lifecycle.reconcile(context.host.listing())

      const args = agentArgsOf(launchOf(callsNamed(context.host, 'runtime.create')[0]))
      expect(args[0]).toBe(claudeFlagConst)
      expect(args.slice(-2)).toEqual(['--session-id', 'native-1'])
    })

    // Its kind decides, not the call site, so an install can never inherit an agent's policy.
    it('never reaches the shell that installs a worktree', async () => {
      const context = await harness()
      context.yolo.add('claude')
      context.yolo.add('codex')
      context.setup.resolution = installing([{ command: 'pnpm install', cwd: '.' }])

      await context.lifecycle.create(worktreeSpec())

      const launches = callsNamed(context.host, 'runtime.create').map(launchOf)
      expect(launches.length).toBeGreaterThan(0)
      for (const launch of launches) {
        expect(launch.args).not.toContain(claudeFlagConst)
        expect(launch.args).not.toContain(codexFlagConst)
      }
      expect(context.seeded).toEqual([])
    })

    it('answers the trust dialog for the directory the session runs in, and only for Claude',
      async () => {
        const context = await harness()
        context.yolo.add('claude')
        context.yolo.add('codex')

        await created(context, 'claude')
        await created(context, 'codex')

        expect(context.seeded).toEqual([context.workDirectory])
      })

    it('says so and starts the session anyway when the trust file cannot be written', async () => {
      const context = await harness({ seedProblem: 'EPERM' })
      context.yolo.add('claude')

      const answer = await context.lifecycle.create({
        kind: 'agent',
        directory: { mode: 'adHoc', path: context.workDirectory },
        agent: { agentId: 'claude', mode: 'new' },
      })

      expect(answer.ok).toBe(true)
      expect(context.reports.some((message) => message.includes('EPERM'))).toBe(true)
      expect(agentArgsOf(launchOf(callsNamed(context.host, 'runtime.create')[0])))
        .toContain(claudeFlagConst)
    })

    // The merge resolver is a launch like any other; nothing about being unattended exempts it.
    it('applies to the one-shot session the merge resolver runs', async () => {
      const context = await harness()
      context.yolo.add('claude')

      await context.lifecycle.createInternal(
        {
          kind: 'agent',
          directory: { mode: 'adHoc', path: context.workDirectory },
          agent: { agentId: 'claude', mode: 'new', initialPrompt: 'resolve it' },
        },
        { sessionId: 'resolve-1', oneShot: true, resolveFor: 's1' },
      )

      const args = agentArgsOf(launchOf(callsNamed(context.host, 'runtime.create')[0]))
      expect(args[0]).toBe(claudeFlagConst)
      expect(args).toContain('-p')
      expect(args.at(-1)).toBe('resolve it')
      expect(context.seeded).toEqual([context.workDirectory])
    })

    /*
     * Found while the switch was being wired, and fixed with it: `create` used to build its args
     * from the wire SPEC, which cannot carry `oneShot`, while only the record gets that mark. The
     * resolver's own launch therefore never carried `-p` - what should answer once and exit came up
     * interactive instead, and with yolo on it would have been an interactive agent with full
     * rights that nobody was watching. Only a REPLAY of it ever ran the way it was meant to.
     */
    it('starts the resolver in print mode on the FIRST launch, not only on a replay', async () => {
      const context = await harness()

      await context.lifecycle.createInternal(
        {
          kind: 'agent',
          directory: { mode: 'adHoc', path: context.workDirectory },
          agent: { agentId: 'claude', mode: 'new', initialPrompt: 'resolve it' },
        },
        { sessionId: 'resolve-2', oneShot: true, resolveFor: 's1' },
      )

      const args = agentArgsOf(launchOf(callsNamed(context.host, 'runtime.create')[0]))
      expect(args[0]).toBe('-p')
      expect(args.at(-1)).toBe('resolve it')
      expect(context.store.get('resolve-2')?.agent?.oneShot).toBe(true)
    })
  })

  describe('the automatic conflict resolver, end to end', () => {
    const worktreeConst = {
      worktreePath: 'C:\\repo\\.worktrees\\015',
      branch: 'jamat/015',
      baseCommit: 'abc123',
      repositoryRoot: 'C:\\repo',
    }

    /** The primary session mid-merge, with a resolver already launched and pointed at. */
    function merging(overrides?: Partial<SessionRecord>): SessionRecord {
      return record('m1', {
        life: 'ended',
        binding: null,
        worktree: worktreeConst,
        worktreeMerge: {
          phase: 'resolving',
          resolveSessionId: 'r1',
          startedAt: 1,
        },
        ...overrides,
      })
    }

    /** The resolver itself: a one-shot fork that has already exited. */
    function resolver(overrides?: Partial<SessionRecord>): SessionRecord {
      return record('r1', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'fork', oneShot: true },
        resolveFor: 'm1',
        life: 'ended',
        binding: null,
        exitCode: 0,
        ...overrides,
      })
    }

    /*
     * The three hops that make the feature work: the reconciler decides, `apply` turns the decision
     * into the callback, and the session manager had set that callback. Nothing tested the last two.
     * Leaving it unwired - or letting the `if (this.resumeMerge)` guard fall false - leaves every
     * automatically resolved conflict sitting at `resolving` for ever, with every gate green.
     */
    it('carries a resolved conflict back to the merge, naming the PRIMARY session', async () => {
      const context = await harness()
      await context.store.put(merging())
      await context.store.put(resolver())

      await context.lifecycle.reconcile(context.host.listing())

      expect(context.resumed).toEqual(['m1'])
    })

    it('writes the reason on a resolver that failed, and keeps the phase', async () => {
      const context = await harness()
      await context.store.put(merging())
      await context.store.put(resolver({ exitCode: 1 }))

      await context.lifecycle.reconcile(context.host.listing())

      expect(context.resumed).toEqual([])
      const merge = context.store.get('m1')?.worktreeMerge
      expect(merge?.phase).toBe('resolving')
      expect(merge?.failure).toContain('1')
      expect(merge?.resolveSessionId).toBe('r1')
    })

    /*
     * It fires again on the next pass, and that is the design rather than a leak: this is the one
     * reconcile change that writes NOTHING of its own, so its trigger - a `resolving` phase, a
     * pointer, and no failure - survives being applied. What ends it is the merge itself moving the
     * record off `resolving`, which is why `resumeMerge` has to be idempotent, and it is: it re-reads
     * the disk and does whatever is still left.
     */
    it('asks again while the record still says resolving, and stops when it does not', async () => {
      const context = await harness()
      await context.store.put(merging())
      await context.store.put(resolver())

      await context.lifecycle.reconcile(context.host.listing())
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.resumed).toEqual(['m1', 'm1'])

      // What the merge does when it finishes: the phase and the pointer go with the worktree.
      await context.store.put(record('m1', { life: 'ended', binding: null }))
      await context.lifecycle.reconcile(context.host.listing())

      expect(context.resumed).toEqual(['m1', 'm1'])
    })

    /*
     * `createInternal` is what the merge flow calls, and the whole judgement rests on `create`
     * honouring the id it was handed: a minted one would leave the flow pointing at a record that
     * does not exist, which the next pass reads as "its resolve session record is gone" - a failure
     * mode the reconciler asserts as a CRASH window, so the symptom would look designed.
     */
    it('creates the resolver under the id and the marks it was handed', async () => {
      const context = await harness()

      const answer = await context.lifecycle.createInternal(
        {
          kind: 'agent',
          directory: { mode: 'adHoc', path: context.workDirectory },
          agent: { agentId: 'claude', mode: 'new', initialPrompt: 'resolve it' },
        },
        { sessionId: 'resolve-9', oneShot: true, resolveFor: 'm1' },
      )

      expect(successOf(answer).sessionId).toBe('resolve-9')
      const written = context.store.get('resolve-9')
      expect(written?.resolveFor).toBe('m1')
      expect(written?.agent?.oneShot).toBe(true)
    })

    it('leaves an ordinary create carrying none of those marks', async () => {
      const context = await harness()

      const answer = await context.lifecycle.create({
        kind: 'agent',
        directory: { mode: 'adHoc', path: context.workDirectory },
        agent: { agentId: 'claude', mode: 'new' },
      })

      const written = context.store.get(successOf(answer).sessionId)
      expect(written?.resolveFor).toBeUndefined()
      expect(written?.agent?.oneShot).toBeUndefined()
    })
  })

  describe('default model and effort', () => {
    /** The args the AGENT sees, with the win32 ComSpec wrap taken off. */
    function agentArgsOf(launch: RuntimeLaunchSpec): string[] {
      return launch.args[0] === '/d' ? launch.args.slice(4) : launch.args
    }

    async function created(context: Harness, agentId: 'claude' | 'codex'): Promise<string> {
      const answer = await context.lifecycle.create({
        kind: 'agent',
        directory: { mode: 'adHoc', path: context.workDirectory },
        agent: { agentId, mode: 'new' },
      })
      return successOf(answer).sessionId
    }

    function lastLaunchArgs(context: Harness): string[] {
      const call = [...callsNamed(context.host, 'runtime.create'),
        ...callsNamed(context.host, 'runtime.replace')].at(-1)!
      return agentArgsOf(launchOf(call))
    }

    it('names the model on a create, with the flag each agent uses', async () => {
      const context = await harness()
      context.models.set('claude', 'claude-fable-5')
      context.models.set('codex', 'gpt-5.6-sol')

      await created(context, 'claude')
      await created(context, 'codex')

      const [claude, codex] = callsNamed(context.host, 'runtime.create').map(launchOf)
      expect(agentArgsOf(claude).slice(0, 2)).toEqual(['--model', 'claude-fable-5'])
      expect(agentArgsOf(codex).slice(0, 2)).toEqual(['-m', 'gpt-5.6-sol'])
    })

    it('leaves a launch exactly as it is while no model is stored', async () => {
      const without = await harness()
      await created(without, 'claude')
      const withModel = await harness()
      withModel.models.set('claude', 'opus')
      await created(withModel, 'claude')

      const before = agentArgsOf(launchOf(callsNamed(without.host, 'runtime.create')[0]))
      const after = agentArgsOf(launchOf(callsNamed(withModel.host, 'runtime.create')[0]))
      expect(after).toEqual(['--model', 'opus', ...before])
    })

    // The decision this whole parameter exists for: a reopen must not drag a conversation the user
    // remodelled from inside, with /model, back to the stored default on every client restart.
    it('never names a model on a reopen, however the setting stands', async () => {
      const context = await harness()
      const sessionId = await created(context, 'claude')
      context.models.set('claude', 'opus')

      await context.lifecycle.stop(sessionId)
      expect(await context.lifecycle.reopen(sessionId)).toEqual({ ok: true, value: undefined })

      expect(lastLaunchArgs(context)).not.toContain('--model')
      expect(lastLaunchArgs(context)).not.toContain('opus')
    })

    // Live like yolo: the tab reaches the next founding launch with no notification of its own.
    it('reads the setting again on every create rather than capturing it once', async () => {
      const context = await harness()
      await created(context, 'claude')
      expect(agentArgsOf(launchOf(callsNamed(context.host, 'runtime.create')[0])))
        .not.toContain('--model')

      context.models.set('claude', 'sonnet')
      await created(context, 'claude')

      expect(agentArgsOf(launchOf(callsNamed(context.host, 'runtime.create')[1])).slice(0, 2))
        .toEqual(['--model', 'sonnet'])
    })

    /*
     * The whole reason the setting is resolved into the record at create: the reader that draws the
     * context window has the record and no way to reach a setting, and a Claude transcript states
     * `claude-opus-5` for a session running on the million-token tier the launch asked for.
     */
    it('stores the model this machine is set to on the record it founds', async () => {
      const context = await harness()
      context.models.set('claude', 'claude-opus-5[1m]')

      const sessionId = await created(context, 'claude')

      expect(context.store.get(sessionId)?.agent?.model).toBe('claude-opus-5[1m]')
    })

    // The record is what a replay repeats, and a create resolved the setting into it: a record that
    // names no model was founded without one, so its replay names none either.
    it('replays a create with the model the record was founded on, not the setting', async () => {
      const context = await harness()
      context.models.set('claude', 'opus')
      await context.store.put(record('s1', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
        life: 'starting',
        binding: null,
        pendingOperationId: 'op-7',
        pendingOperationKind: 'create',
      }))

      await context.lifecycle.reconcile(context.host.listing())

      expect(agentArgsOf(launchOf(callsNamed(context.host, 'runtime.create')[0])))
        .not.toContain('--model')
    })

    // The replay is whatever the interrupted operation was, so a pending reopen stays a reopen.
    it('replays a reopen that never answered without naming a model', async () => {
      const context = await harness()
      context.models.set('claude', 'opus')
      await context.store.put(record('s1', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
        life: 'starting',
        binding: null,
        pendingOperationId: 'op-8',
        pendingOperationKind: 'reopen',
      }))

      await context.lifecycle.reconcile(context.host.listing())

      const calls = [...callsNamed(context.host, 'runtime.create'),
        ...callsNamed(context.host, 'runtime.replace')]
      for (const call of calls) expect(agentArgsOf(launchOf(call))).not.toContain('--model')
    })

    /*
     * The remote half of the model feature: a create that NAMES a model is asking for that one, and
     * the machine that runs it has its own setting which is not the answer to that question.
     */
    it('lets a model named on the spec beat the setting of the machine that runs it', async () => {
      const context = await harness()
      context.models.set('claude', 'opus')

      const answer = await context.lifecycle.create({
        kind: 'agent',
        directory: { mode: 'adHoc', path: context.workDirectory },
        agent: { agentId: 'claude', mode: 'new', model: 'claude-fable-5' },
      })

      expect(agentArgsOf(launchOf(callsNamed(context.host, 'runtime.create')[0])).slice(0, 2))
        .toEqual(['--model', 'claude-fable-5'])
      // Kept on the record for the same reason `initialPrompt` is: a replay has to repeat it.
      expect(context.store.get(successOf(answer).sessionId)?.agent?.model).toBe('claude-fable-5')
    })

    it('replays a create that named a model with that model, not the setting', async () => {
      const context = await harness()
      context.models.set('claude', 'opus')
      await context.store.put(record('s1', {
        kind: 'agent',
        agent: {
          agentId: 'claude',
          launchMode: 'new',
          nativeSessionId: 'native-1',
          model: 'claude-fable-5',
        },
        life: 'starting',
        binding: null,
        pendingOperationId: 'op-9',
        pendingOperationKind: 'create',
      }))

      await context.lifecycle.reconcile(context.host.listing())

      expect(agentArgsOf(launchOf(callsNamed(context.host, 'runtime.create')[0])).slice(0, 2))
        .toEqual(['--model', 'claude-fable-5'])
    })

    // The rule the whole parameter exists for holds over the record too: a resumed conversation
    // carries on with whatever it is running on, whoever named the model that founded it.
    it('never names the record’s model on a reopen either', async () => {
      const context = await harness()
      const answer = await context.lifecycle.create({
        kind: 'agent',
        directory: { mode: 'adHoc', path: context.workDirectory },
        agent: { agentId: 'claude', mode: 'new', model: 'claude-fable-5' },
      })
      const sessionId = successOf(answer).sessionId

      await context.lifecycle.stop(sessionId)
      expect(await context.lifecycle.reopen(sessionId)).toEqual({ ok: true, value: undefined })

      expect(lastLaunchArgs(context)).not.toContain('--model')
      expect(lastLaunchArgs(context)).not.toContain('claude-fable-5')
    })

    it('names the effort on a create, the way each agent takes one', async () => {
      const context = await harness()
      context.efforts.set('claude', 'high')
      context.efforts.set('codex', 'xhigh')

      await created(context, 'claude')
      await created(context, 'codex')

      const [claude, codex] = callsNamed(context.host, 'runtime.create').map(launchOf)
      expect(agentArgsOf(claude).slice(0, 2)).toEqual(['--effort', 'high'])
      expect(agentArgsOf(codex).slice(0, 2))
        .toEqual(['-c', 'model_reasoning_effort="xhigh"'])
    })

    // Two independent settings: an effort with no model applies to the agent's own default.
    it('carries either setting without the other, and both together in order', async () => {
      const alone = await harness()
      alone.efforts.set('claude', 'max')
      await created(alone, 'claude')
      expect(agentArgsOf(launchOf(callsNamed(alone.host, 'runtime.create')[0])).slice(0, 2))
        .toEqual(['--effort', 'max'])

      const both = await harness()
      both.models.set('claude', 'opus')
      both.efforts.set('claude', 'max')
      await created(both, 'claude')
      expect(agentArgsOf(launchOf(callsNamed(both.host, 'runtime.create')[0])).slice(0, 4))
        .toEqual(['--model', 'opus', '--effort', 'max'])
    })

    // The same decision the model rides on: an effort switched inside a session with /effort
    // must survive a client restart rather than being pulled back to the stored default.
    it('never names an effort on a reopen, however the setting stands', async () => {
      const context = await harness()
      const sessionId = await created(context, 'claude')
      context.efforts.set('claude', 'high')

      await context.lifecycle.stop(sessionId)
      expect(await context.lifecycle.reopen(sessionId)).toEqual({ ok: true, value: undefined })

      expect(lastLaunchArgs(context)).not.toContain('--effort')
      expect(lastLaunchArgs(context)).not.toContain('high')
    })

    it('reads the effort again on every create rather than capturing it once', async () => {
      const context = await harness()
      await created(context, 'claude')
      expect(agentArgsOf(launchOf(callsNamed(context.host, 'runtime.create')[0])))
        .not.toContain('--effort')

      context.efforts.set('claude', 'low')
      await created(context, 'claude')

      expect(agentArgsOf(launchOf(callsNamed(context.host, 'runtime.create')[1])).slice(0, 2))
        .toEqual(['--effort', 'low'])
    })

    // The merge resolver is a founding launch like any other; being unattended exempts nothing.
    it('applies to the one-shot session the merge resolver runs, prompt still last', async () => {
      const context = await harness()
      context.models.set('claude', 'opus')

      context.efforts.set('claude', 'high')
      await context.lifecycle.createInternal(
        {
          kind: 'agent',
          directory: { mode: 'adHoc', path: context.workDirectory },
          agent: { agentId: 'claude', mode: 'new', initialPrompt: 'resolve it' },
        },
        { sessionId: 'resolve-1', oneShot: true, resolveFor: 's1' },
      )

      const args = agentArgsOf(launchOf(callsNamed(context.host, 'runtime.create')[0]))
      expect(args.slice(0, 4)).toEqual(['--model', 'opus', '--effort', 'high'])
      expect(args).toContain('-p')
      expect(args.at(-1)).toBe('resolve it')
    })
  })
})
