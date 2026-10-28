import { AgentAccounts, type StoredAccount } from '../../agentAccounts/agentAccounts'
import { FinishProjection } from '../../worktrees/worktreeFinish'
import { emptyUpdateTargets, testAssembly } from '../../worktrees/worktreeTesting'
import { WorktreeLease } from '../../worktrees/worktreeLease'
import { SvnStepRunner } from '../../worktrees/svnStepRunner'
import type { SessionWorktreePort, WorktreePlaceRequest, WorktreePlacing, WorktreeProvision, WorktreeRequest } from '../../worktrees/worktreeLifecycle.types'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import type {
  RuntimeInspectResult,
  RuntimeLaunchSpec,
  RuntimeListResult,
  RuntimeRef,
  RuntimeSessionInfo,
} from '../../../app-host/app/wire/hostWire.js'
import type { CodexSessionIdentity } from '../codexSessionIdentity'
import type { HostCallFailure, HostCallResult } from '../../hostClient/hostClient.types'
import type { SetupResolution } from '../../projectSetup/projectSetup.types'
import { WorktreeConfig } from '../../projectSetup/worktreeConfig'
import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import { AgentPresets } from '../launch/agentPresets'
import type { RunToolResolution } from '../launch/runTools'
import type { SessionRecord, SessionRecordWorktree } from '../records/sessionRecord.types'
import { SessionRecordsStore } from '../records/sessionRecordsStore'
import { CommandAgreement } from '../scripts/commandAgreement'
import { CommandTrustStore } from '../scripts/commandTrustStore'
import { DeclaredScripts } from '../scripts/declaredScripts'
import { ScriptLogStore } from '../scripts/scriptLogStore'
import { WorktreeResultsStore } from '../../worktrees/worktreeResults'
import { SessionScriptDefinitions } from '../scripts/sessionScriptDefinitions'
import { type ScriptCollapsed, SessionScriptsManager } from '../scripts/sessionScriptsManager'
import type {
  SessionCommitReceipt,
  SessionCreateSpec,
  SessionHistoryOpenSpec,
  SessionsOpResult,
} from '../sessionManagerApi.types'
import {
  SessionLifecycle,
  type SessionClaudeTitlesPort,
  type SessionHostPort,
  type SessionNumbersPort,
  type SessionSetupPort,
} from './sessionLifecycle'
import type { ReconcileChange } from './reconciler'
import type { SvnActionPort } from '../../worktrees/worktreeFinish'
import { type SvnCleanupPort, SvnWorktreeFinishFlow } from '../../worktrees/worktreeFinish'
import type { SvnWorktreeRemoved } from '../../worktrees/worktreeRemoval'
import { WorktreeCleanupPacing } from '../../worktrees/worktreeRemoval'

describe('lib-orchestrator/sessionManager/lifecycle/sessionLifecycle', () => {
  const created: string[] = []
  /**
   * The project every worktree here is cut from, and where `fakeWorktrees` says it landed. The
   * worktree directory exists on disk, because a retry of its setup refuses one that is gone.
   */
  const projectParent = mkdtempSync(join(tmpdir(), 'jamat-v3-session-lifecycle-project-'))
  const projectRoot = join(projectParent, 'one')
  const worktreePath = join(projectRoot, '.worktrees', 'fix')
  mkdirSync(worktreePath, { recursive: true })

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
    rmSync(join(projectRoot, '.worktree.json'), { force: true })
  })

  afterAll(() => rmSync(projectParent, { recursive: true, force: true }))

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
    /** The rows a dead runtime still shows, per runtime; absent is a runtime that printed nothing. */
    screens: Map<string, string[]>
    /** Every `runtime.inspect`, kept apart from `calls` so the launch assertions stay about launches. */
    inspects: RuntimeRef[]
    inspect(target: RuntimeRef): Promise<HostCallResult<RuntimeInspectResult>>
  }

  type FakeRun =
    | { ok: true; session: RuntimeSessionInfo }
    | { ok: false; detail: string }

  interface FakeWorktrees {
    port: SessionWorktreePort
    places: WorktreePlaceRequest[]
    calls: WorktreeRequest[]
    purged: SessionRecordWorktree[]
    /** Null: a Git worktree of the project, or of the explicit owner, like `git` mode places one. */
    placing: WorktreePlacing | null
    outcome: WorktreeProvision
    purge: SessionsOpResult
  }

  interface FakeSetup {
    port: SessionSetupPort
    calls: { projectRoot: string; repositoryRoot: string }[]
    /** What the member answers about every project; a test that cares about one replaces it. */
    resolution: SetupResolution
  }

  interface FakeNumbers {
    /** What `allocate` hands out; null is the store saying it could not take one. */
    token: string | null
    /**
     * How far the project has already counted. High by default, so a case that says nothing about
     * numbering hands in titles the counter would have given out; a case about a typed number sets
     * it to what the project has really spent.
     */
    issued: number
    calls: { projectPath: string }[]
    port: SessionNumbersPort
  }

  interface Harness {
    lifecycle: SessionLifecycle
    store: SessionRecordsStore
    host: FakeHost
    worktrees: FakeWorktrees
    setup: FakeSetup
    /** The real gate over the real `.worktree.json` in `projectRoot`, with its own trust file. */
    agreement: CommandAgreement
    trustFile: string
    numbers: FakeNumbers
    identities: Map<string, CodexSessionIdentity>
    claudeIdentities: Map<string, { launchId: string; nativeSessionId: string; sequence: number }>
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
    /** What the relay answers, and every directory it was asked for. */
    statusLine: { file: string | null; cwds: string[]; identities: ({ sessionId: string; launchId: string } | undefined)[] }
    /** Every directory the Claude trust seed was asked to answer for. */
    seeded: string[]
    /** Every session id the reconciler asked to have its merge carried on. */
    resumed: string[]
    /** Sessions whose finish began before its record says so. */
    finishing: Set<string>
    /** The lifecycle's clock, movable so a case can wait out a replay backoff. */
    clock: { now: number }
    /** Every run the scripts manager collapsed, in order. */
    collapsed: ScriptCollapsed[]
    scripts: SessionScriptsManager
    logs: ScriptLogStore
    logsDirectory: string
    /** What a direct-process tool resolves to; a tool not named here resolves to its own name. */
    tools: Map<string, RunToolResolution>
    /** The SVN action's own svn reads and removal, which a case may replace. */
    svnAction: {
      svn: SvnActionPort
      remove: (sessionId: string) => Promise<SvnWorktreeRemoved>
      /** Every session an action removed as asked. */
      ended: string[]
      /** Every drive the action detached, so a case can wait for them. */
      detached: Promise<unknown>[]
      /** The conflicted files a resolver left markers in. */
      markers: string[]
      syncs: string[]
    }
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

  function identity(sessionId: string, nativeSessionId: string, sequence = 1): CodexSessionIdentity {
    return {schemaVersion: 1, jamatSessionId: sessionId, launchId: 'proof', nativeSessionId, sequence}
  }

  function fakeNumbers(): FakeNumbers {
    const calls: FakeNumbers['calls'] = []
    const fake: FakeNumbers = {
      token: '007',
      issued: 999,
      calls,
      port: {
        async allocate(projectPath) {
          calls.push({ projectPath })
          return fake.token
        },
        async highestIssued() {
          return fake.issued
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
      screens: new Map(),
      inspects: [],
      async inspect(target) {
        fake.inspects.push(target)
        if (fake.failure) return fake.failure
        const session = runtimes.get(target.runtimeSessionId)
        if (!session) return { ok: false, code: 'op-rejected', status: 404, detail: `Unknown runtime: ${target.runtimeSessionId}` }
        return {
          ok: true,
          value: {
            session,
            projection: {
              runtimeSessionId: session.runtimeSessionId,
              generation: session.generation,
              outputEpoch: 1,
              outputSeq: 0,
              screen: '',
              screenLines: fake.screens.get(target.runtimeSessionId) ?? [],
              cols: session.cols,
              rows: session.rows,
              alive: session.alive,
              lastOutputAt: null,
            },
          },
        }
      },
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
    const fake: FakeWorktrees = {
      places: [],
      calls: [],
      purged: [],
      placing: null,
      outcome: {
        ok: true,
        value: {
          worktree: { worktreePath, branch: 'jamat/fix', baseCommit: 'abc123', repositoryRoot: projectRoot, kind: 'git' },
          checkout: null,
        },
      },
      purge: { ok: true, value: undefined },
      port: {
        async place(request) {
          fake.places.push(request)
          const ownerDir = request.owner ?? request.projectRoot ?? request.directory
          return fake.placing ?? { ok: true, value: { kind: 'git', ownerDir, cwdSubpath: '', catalogProject: request.projectRoot } }
        },
        async create(request) {
          fake.calls.push(request)
          return fake.outcome
        },
        async purgeReserved(worktree) {
          fake.purged.push(worktree)
          return fake.purge
        },
      },
    }
    return fake
  }

  function fakeSetup(): FakeSetup {
    const calls: FakeSetup['calls'] = []
    const fake: FakeSetup = {
      calls,
      resolution: { kind: 'none', reason: 'no known project family detected' },
      port: {
        async resolve(projectRoot, repositoryRoot) {
          calls.push({ projectRoot, repositoryRoot })
          return fake.resolution
        },
      },
    }
    return fake
  }

  async function harness(
    options?: {
      accounts?: import('../sessionAccounts').SessionAccountsPort
      seed?: (cwd: string, file?: string) => { changed: boolean; problem: string | null }
      damagedRecords?: boolean
      unwritableRecords?: boolean
      /** What the trust seed answers; the default is the quiet success of an already-trusted one. */
      seedProblem?: string
      /** Records on disk before the store loads, in whatever shape an older build wrote them. */
      seedRecords?: unknown[]
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
    if (options?.seedRecords)
      writeFileSync(file, JSON.stringify({ schemaVersion: 1, savedAt: 1, records: options.seedRecords }), 'utf8')
    const snapshotsDirectory = join(root, 'session-snapshots')
    const reports: string[] = []
    const logsDirectory = join(root, 'script-logs')
    const logs = new ScriptLogStore(logsDirectory)
    const store = await SessionRecordsStore.load(file, {
      snapshotsDirectory,
      removeSessionLogs: (id, keepIds) => logs.removeParent(id, keepIds),
      report: (message) => reports.push(message),
    })
    const host = fakeHost()
    const worktrees = fakeWorktrees()
    const setup = fakeSetup()
    const trustFile = join(root, 'setup-trust.json')
    const agreement = new CommandAgreement({
      trust: CommandTrustStore.load(trustFile, (message) => reports.push(message)),
    })
    const numbers = fakeNumbers()
    const identities = new Map<string, CodexSessionIdentity>()
    /** What the Claude status line relay reported per Jamat session: its launch generation and conversation. */
    const claudeIdentities = new Map<string, { launchId: string; nativeSessionId: string; sequence: number }>()
    const claudeTitles = fakeClaudeTitles()
    let minted = 0
    // Movable, because the replay backoff is measured against it: a fixed clock makes every pass
    // land in the same instant, which is exactly the case the pacing is supposed to thin out.
    const clock = { now: 5_000 }
    const yolo = new Set<'claude' | 'codex'>()
    const models = new Map<'claude' | 'codex', string>()
    const efforts = new Map<'claude' | 'codex', string>()
    const statusLine: { file: string | null; cwds: string[]; identities: ({ sessionId: string; launchId: string } | undefined)[] } = { file: null, cwds: [], identities: [] }
    const seeded: string[] = []
    const resumed: string[] = []
    const finishing = new Set<string>()
    const tools = new Map<string, RunToolResolution>()
    const svnAction: Harness['svnAction'] = {
      svn: {
        updateTargets: emptyUpdateTargets,
        assembly: async () => ({ ok: true, value: testAssembly() }),
        present: async () => true,
        publicationRows: async () => ({ ok: true, value: { changed: [], items: [] } }),
        advancePublished: async () => ({ ok: true, value: undefined }),
        landingPaths: async () => ({ ok: true, value: [] }),
        landingProof: async () => ({ ok: true, value: { holds: true } }),
        saveLocalPaths: async () => ({ ok: true, value: 'saved' }),
        logSince: async () => ({ ok: true, value: [] }),
        headRevisionOf: async () => ({ ok: true, value: 42 }),
        revertSetup: async () => ({ ok: true, value: undefined }),
        commitHashes: async (_root, paths) => ({ ok: true, value: Object.fromEntries(paths.map((path) => [path, 'same'])) }),
        publicationHashes: async (_root, paths) => ({ ok: true, value: Object.fromEntries(paths.map((path) => [path, 'same'])) }),
        unprepareCommit: async () => ({ ok: true, value: undefined }),
        prepareCommit: async (_root, paths) => ({ ok: true, value: { targets: [...paths], added: [] } }),
        ownerCheck: async () => ({ ok: true, value: undefined }),
        scheduleMissing: async () => ({ ok: true, value: undefined }),
        revisionOf: async () => ({ ok: true, value: 41 }),
        status: async () => ({ ok: true, value: { textConflicts: [], otherConflicts: [], changed: [] } }),
        changes: async () => ({ ok: true, value: [] }),
        resolveWorking: async () => ({ ok: true, value: undefined }),
        incoming: async () => ({ ok: true, value: [] }),
        locked: async () => false,
        reviewRoots: async () => ({ ok: true, value: [] }),
        fingerprint: async () => ({ ok: true, value: 'fingerprint' }),
        lowerBounds: async (roots) => ({ ok: true, value: Object.fromEntries(roots.map((root) => [root.own, { repository: 'url', base: '/trunk', rootBase: 1, since: 1 }])) }),
        conflictSet: async () => ({ ok: true, value: { revision: 41, facts: [], rows: [] } }),
        logOf: async () => ({ ok: true, value: [] }),
        hashes: async () => ({ ok: true, value: {} }),
        baseAbove: async () => ({ ok: true, value: null }),
      },
      remove: async () => ({ state: 'removed', lines: [] }),
      ended: [],
      detached: [],
      markers: [],
      syncs: [],
    }
    const lease = new WorktreeLease('lifecycle-test', () => [])
    lease.within = async (_root, _purpose, work) => work()
    const collapsed: ScriptCollapsed[] = []
    const scripts = new SessionScriptsManager({
      records: store,
      host: {
        runtimeInspect: (target) => host.inspect(target),
        runtimeStop: (target) => host.port.runtimeStop(target),
        runtimeRemove: (target) => host.port.runtimeRemove(target),
      },
      logs,
      onCollapsed: (event) => collapsed.push(event),
      report: (message) => reports.push(message),
      now: () => clock.now,
    })
    return {
      tools,
      svnAction,
      collapsed,
      scripts,
      logs,
      logsDirectory,
      store,
      recordsFile: file,
      host,
      worktrees,
      setup,
      agreement,
      trustFile,
      numbers,
      identities,
      claudeIdentities,
      claudeTitles,
      snapshotsDirectory,
      reports,
      workDirectory: root,
      yolo,
      models,
      efforts,
      statusLine,
      seeded,
      resumed,
      finishing,
      clock,
      lifecycle: wire(new SessionLifecycle({
        accounts: options?.accounts,
        localStateDir: projectParent,
        localBefore: { accepts: () => false, run: async () => { throw new Error('local before not expected by legacy Host fixture') } },
        controller: { configIdentity: 'controller-1', channel: 'development' },
        records: store,
        host: host.port,
        worktrees: worktrees.port,
        setup: setup.port,
        agreement,
        numbers: numbers.port,
        codexSessions: {
          launch: (_record, native) => native,
          identity: record => identities.get(record.sessionId) ?? null,
        },
        claudeStatusLine: {
          settingsFileFor: (cwd, identity) => {
            statusLine.cwds.push(cwd)
            statusLine.identities.push(identity)
            return statusLine.file
          },
          identity: (sessionId, launchId) => {
            const reported = claudeIdentities.get(sessionId)
            return reported?.launchId === launchId ? { nativeSessionId: reported.nativeSessionId, sequence: reported.sequence } : null
          },
        },
        tools: { resolve: (tool) => tools.get(tool) ?? { ok: true, command: tool, prefixArgs: [], env: {} },
          node: () => ({ ok: true, command: process.execPath, prefixArgs: [], env: {} }),
          agentCli: () => ({ ok: true, command: 'node "C:/Jamat/skills/claude/appjamat-v3/scripts/jamat-v3.mjs"' }) },
        claudeTitles: claudeTitles.port,
        scripts,
        finish: { commands: { lease, accept: async () => {}, verify: async () => {}, acceptInterrupted: async () => {} },
          sync: { recover: async () => false, withControl: async (_id, work) => work(), run: async (id) => { svnAction.syncs.push(id); await store.update(id, (record) => ({ ...record, worktreeLifecycle: { ...record.worktreeLifecycle!, version: record.worktreeLifecycle!.version + 1, step: 'checking', phase: 'finishing', wait: undefined } })); return { ok: true, value: { revision: 1, conflicts: [] } } }, resolve: async () => ({ ok: false, code: 'invalid-spec', detail: 'No conflict' }) },
          handoffs: { checksFailed: async () => {}, conflicts: async () => {}, notifyCaller: async () => {} }, idle: () => true, busyReason: () => null,
          holdInput: () => () => {}, awaitExit: async () => true, liveness: async () => {} },


          activityOf: () => null,
        svnActions: {
          runner: new SvnStepRunner({ records: store, scripts, svn: { run: async (_cwd, _args, options) => { options?.onStdout?.('Updated.'); return { code: 0, stdout: 'Updated.', stderr: '', failure: null } } }, now: () => clock.now, newId: () => `local-${++minted}`, changed: () => {} }),
          logs,
          svn: {
            updateTargets: svnAction.svn.updateTargets,
            assembly: (...args) => svnAction.svn.assembly(...args),
            present: (root) => svnAction.svn.present(root),
            publicationRows: (...args) => svnAction.svn.publicationRows(...args),
            advancePublished: (...args) => svnAction.svn.advancePublished(...args),
            landingPaths: (...args) => svnAction.svn.landingPaths(...args),
            landingProof: (...args) => svnAction.svn.landingProof(...args),
            saveLocalPaths: (...args) => svnAction.svn.saveLocalPaths(...args),
            revertSetup: (...args) => svnAction.svn.revertSetup(...args),
            commitHashes: (root, paths) => svnAction.svn.commitHashes(root, paths),
            publicationHashes: (root, paths, revision) => svnAction.svn.publicationHashes(root, paths, revision),
            unprepareCommit: (root, paths) => svnAction.svn.unprepareCommit(root, paths),
            logSince: (root, revision) => svnAction.svn.logSince(root, revision),
            prepareCommit: (root, paths) => svnAction.svn.prepareCommit(root, paths),
            ownerCheck: (location) => svnAction.svn.ownerCheck(location),
            scheduleMissing: (path) => svnAction.svn.scheduleMissing(path),
            headRevisionOf: (root) => svnAction.svn.headRevisionOf(root),
            revisionOf: (path) => svnAction.svn.revisionOf(path),
            status: (path) => svnAction.svn.status(path),
            changes: (path) => svnAction.svn.changes(path),
            resolveWorking: (path, paths) => svnAction.svn.resolveWorking(path, paths),
            incoming: (path, base, changed, own) => svnAction.svn.incoming(path, base, changed, own),
            locked: (path) => svnAction.svn.locked(path),
            reviewRoots: (path) => svnAction.svn.reviewRoots(path),
            fingerprint: (path) => svnAction.svn.fingerprint(path),
            lowerBounds: (roots) => svnAction.svn.lowerBounds(roots),
            conflictSet: (path, base) => svnAction.svn.conflictSet(path, base),
            logOf: (path, from, to) => svnAction.svn.logOf(path, from, to),
            hashes: (path, paths) => svnAction.svn.hashes(path, paths),
            baseAbove: (path, revision) => svnAction.svn.baseAbove(path, revision),
          },
          labels: { ownCommits: async () => ({ ok: true, value: [] }), afterReview: async () => [], inferred: async () => [] },
          removal: { remove: (sessionId) => svnAction.remove(sessionId) },
          resolver: { unavailable: () => null, briefs: logs, withMarkers: async () => svnAction.markers, cli: () => ({ ok: true as const, command: 'node "C:/Jamat/skills/claude/appjamat-v3/scripts/jamat-v3.mjs"' }), instance: { configIdentity: 'cfg-test', channel: 'development' as const } },
          resolutions: { recoverLocked: async () => ({ ok: true, value: undefined }), apply: async () => ({ ok: true, value: undefined }) },
          results: new WorktreeResultsStore(join(root, 'worktree-results'), { now: () => clock.now, logs, report: (message) => reports.push(message) }),
          ended: (sessionId) => { svnAction.ended.push(sessionId) },
          landedDue: () => undefined,
          proposalsSpent: () => undefined,
          detach: (work) => { svnAction.detached.push(work) },
          changed: () => undefined,
          steps: { at: () => undefined, clear: () => false },
        },
        // The one channel the client has for a fact it cannot put in a result, and the store's own
        // damage report goes to the same place in production.
        report: (message) => reports.push(message),
        yoloFor: (agentId) => yolo.has(agentId),
        modelFor: (agentId) => models.get(agentId),
        effortFor: (agentId) => efforts.get(agentId),
        finishing: (sessionId) => finishing.has(sessionId),
        seedClaudeTrust: (cwd, file) => {
          if (options?.seed) return options.seed(cwd, file)
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
      // Not the bare id: `s1` is a letter then a digit, which is exactly the shape of a custom
      // session number, so a default title spelled that way would hand every fixture a number.
      title: `session ${sessionId}`,
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
      scriptOf: { sessionId: 'p1', phase: 'before', scriptId: 'setup', name: 'setup' },
      ...overrides,
    })
  }

  /** A pass minus the scripts manager's settles and collapses, for a case about something else. */
  function withoutScriptRuns(changes: readonly ReconcileChange[]): ReconcileChange[] {
    return changes.filter((change) => change.kind !== 'settle-script-run' && change.kind !== 'collapse-script-run')
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

  /** An SVN action of `root`, running unless a case gives it a reason to wait. */
  function svnActionOf(root: string, overrides?: Partial<NonNullable<SessionRecord['svnAction']>>): NonNullable<SessionRecord['svnAction']> {
    return {
      kind: 'finish', actionId: 'action-1', stage: 'reviewing', runId: 'review-run', root, checks: [], checkCursor: 0,
      roots: [{ path: root, own: '', changed: ['a.txt'] }], rootCursor: 0, rounds: { incoming: 0, outOfDate: 0, lock: 0 },
      evidence: [], requestedBy: 'window', startedAt: 5, ...overrides,
    }
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
      .toEqual({ agentId: 'claude', accountId: 'main', launchMode: 'new', nativeSessionId: 'id-1', identityLaunchId: expect.any(String) as unknown as string })
    expect(launchOf(context.host.calls[0]).args.slice(-2)).toEqual(['--session-id', 'id-1'])
    expect(launchOf(context.host.calls[0]).env).toMatchObject({
      JAMAT_V3_SESSION_ID: 'id-1', JAMAT_V3_SESSION_CONTROLLER: 'controller-1',
      JAMAT_V3_SESSION_CHANNEL: 'development',
    })
    expect(context.store.get('id-1')?.title)
      .toBe(`${basename(context.workDirectory)} (claude)`)
    expect(context.store.get('id-1')?.transcriptCwd).toBe(context.workDirectory)
  })

  it('persists a login shell command and launches it with its account environment', async () => {
    const env = { CLAUDE_CONFIG_DIR: projectRoot }
    const context = await harness({ accounts: { exists: () => true,
      defaultAccount: () => ({ accountId: 'main', noFreeAccount: false }), launchEnv: async () => env } })
    const result = await context.lifecycle.createCommandSession({ directory: { mode: 'adHoc', path: projectRoot },
      account: { agentId: 'claude', accountId: 'work' }, title: 'Login' }, 'fixture-login')
    if (!result.ok) throw new Error(result.detail)
    const created = result.value
    expect(context.store.get(created.sessionId)).toMatchObject({ kind: 'shell', account: { agentId: 'claude', accountId: 'work' },
      commands: [{ cwd: projectRoot, command: 'fixture-login' }], accountSegments: [{ accountId: 'work', from: 5_000, to: null }] })
    const launch = callsNamed(context.host, 'runtime.create')[0]!.body.launch as RuntimeLaunchSpec
    expect(launch.env.CLAUDE_CONFIG_DIR).toBe(projectRoot)
    expect(launch.args.join(' ')).toContain('fixture-login')
  })

  it('refuses creation and reopening after a relogin changes the registered identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-account-launch-'))
    created.push(root)
    const main = join(root, 'main')
    mkdirSync(main)
    let stored: readonly StoredAccount[] = []
    let identity = { key: 'org/original', label: 'original' }
    let terminalEnded = false
    let context: Harness
    const accounts = new AgentAccounts({ mainHomes: { claude: main, codex: main }, accountsRoot: join(root, 'accounts'),
      specs: [{ agentId: 'claude', mainHome: () => main, homeVariable: 'CLAUDE_CONFIG_DIR', extraEnv: () => ({}),
        shareTable: { directories: [], files: [], neverShared: [] }, loginCommand: 'fixture-login',
        probe: async home => home === main ? { kind: 'logged-out' } : { kind: 'logged-in', identity } }],
      stored: () => stored, store: value => { stored = value }, hasRunningSession: () => false, onChanged: () => {},
      login: { open: async request => successOf(await context.lifecycle.createCommandSession({
        directory: { mode: 'adHoc', path: request.home }, account: { agentId: request.agentId, accountId: request.accountId },
      }, request.command, request.prepare)), result: () => terminalEnded ? { ended: true, exitCode: 0 } : { ended: false }, stop: async () => {} },
    })
    try {
      const { accountId } = await accounts.add('claude', 'Work')
      stored = stored.map(account => ({ ...account, identity }))
      context = await harness({ accounts })
      const spec: SessionCreateSpec = { kind: 'agent', directory: { mode: 'adHoc', path: context.workDirectory },
        agent: { agentId: 'claude', mode: 'new', accountId } }
      const original = successOf(await context.lifecycle.create(spec))
      context.host.runtimes.set(original.sessionId, runtime(original.sessionId, { alive: false, exitCode: 0, exitedAt: 6_000 }))
      await context.lifecycle.reconcile(context.host.listing())
      identity = { key: 'org/rejected', label: 'rejected' }
      const login = await accounts.login(accountId)
      expect(callsNamed(context.host, 'runtime.create')).toHaveLength(2)
      context.host.runtimes.set(login.sessionId, runtime(login.sessionId, { alive: false, exitCode: 0, exitedAt: 7_000 }))
      await context.lifecycle.reconcile(context.host.listing())
      terminalEnded = true
      accounts.sessionsChanged()
      await vi.waitFor(async () => expect((await accounts.list()).find(account => account.accountId === accountId)?.profileProblem)
        .toBe('Log in again must use the same account identity'))
      expect(stored[0]!.identity).toEqual({ key: 'org/original', label: 'original' })
      for (const result of [await context.lifecycle.create(spec), await context.lifecycle.reopen(original.sessionId),
        await context.lifecycle.reopen(login.sessionId)])
        expect(result).toMatchObject({ ok: false, detail: expect.stringContaining('same account identity') })
      expect(callsNamed(context.host, 'runtime.create')).toHaveLength(2)
      expect((await accounts.list()).find(account => account.accountId === accountId)?.profileProblem)
        .toBe('Log in again must use the same account identity')
    } finally { accounts.stop() }
  })

  it('ends a failed account preflight with its reason without creating a runtime', async () => {
    const context = await harness({ accounts: { exists: () => true,
      defaultAccount: () => ({ accountId: 'main', noFreeAccount: false }),
      launchEnv: async () => { throw new Error('settings link cannot be repaired') } } })
    const result = await context.lifecycle.create({ kind: 'agent', directory: { mode: 'adHoc', path: context.workDirectory },
      agent: { agentId: 'claude', mode: 'new', accountId: 'work' } })
    expect(result).toMatchObject({ ok: false, code: 'invalid-spec', detail: expect.stringContaining('settings link cannot be repaired') })
    expect(callsNamed(context.host, 'runtime.create')).toEqual([])
    expect(context.store.get('id-1')).toMatchObject({ life: 'ended',
      endedReason: expect.stringContaining('settings link cannot be repaired'),
      accountSegments: [{ accountId: 'work', from: 5_000, to: 5_000 }] })
  })

  it('closes the selected account segment when the process ends', async () => {
    const context = await harness({ accounts: { exists: () => true,
      defaultAccount: () => ({ accountId: 'main', noFreeAccount: false }), launchEnv: async () => ({}) } })
    const created = successOf(await context.lifecycle.create({ kind: 'agent', directory: { mode: 'adHoc', path: context.workDirectory },
      agent: { agentId: 'claude', mode: 'new', accountId: 'work' } }))
    context.host.runtimes.set(created.sessionId, runtime(created.sessionId, { alive: false, exitCode: 0, exitedAt: 8_000 }))
    await context.lifecycle.reconcile(context.host.listing())
    expect(context.store.get(created.sessionId)?.accountSegments).toEqual([{ accountId: 'work', from: 5_000, to: 8_000 }])
  })

  it('passes the actual Codex trust, model and effort settings to preflight before creating a runtime', async () => {
    const launchEnv = vi.fn(async () => { throw new Error('Codex sqlite_home must use the main profile home for added accounts') })
    const context = await harness({ accounts: { exists: () => true,
      defaultAccount: () => ({ accountId: 'main', noFreeAccount: false }), launchEnv } })
    context.yolo.add('codex')
    context.models.set('codex', 'fixture-model')
    context.efforts.set('codex', 'low')
    const result = await context.lifecycle.create({ kind: 'agent', directory: { mode: 'adHoc', path: context.workDirectory },
      agent: { agentId: 'codex', mode: 'new', accountId: 'work' } })
    expect(launchEnv).toHaveBeenCalledExactlyOnceWith('codex', 'work', context.workDirectory,
      { yolo: true, model: 'fixture-model', effort: 'low' })
    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining('sqlite_home must use the main profile home') })
    expect(callsNamed(context.host, 'runtime.create')).toEqual([])
  })

  it('carries the account through launch, targeted trust and a lost Host generation', async () => {
    const files: (string | undefined)[] = []
    const context = await harness({ accounts: { exists: () => true,
      defaultAccount: () => ({ accountId: 'work', noFreeAccount: false }),
      launchEnv: async () => ({ CLAUDE_CONFIG_DIR: 'C:/disposable/profile' }) },
      seed: (_cwd, file) => { files.push(file); return { changed: true, problem: null } } })
    context.yolo.add('claude')
    const created = successOf(await context.lifecycle.create({ kind: 'agent', directory: { mode: 'adHoc', path: context.workDirectory },
      agent: { agentId: 'claude', mode: 'new' } }))
    expect(context.store.get(created.sessionId)?.accountSegments).toEqual([{ accountId: 'work', from: 5_000, to: null }])
    expect(launchOf(context.host.calls[0]).env.CLAUDE_CONFIG_DIR).toBe('C:/disposable/profile')
    expect(files).toEqual([join('C:/disposable/profile', '.claude.json')])
    context.clock.now = 6_000
    await context.lifecycle.reconcile({ ...context.host.listing(), hostInstanceId: 'host-2', sessions: [] })
    expect(context.store.get(created.sessionId)?.accountSegments).toEqual([{ accountId: 'work', from: 5_000, to: 6_000 }])
  })

  /*
   * The gate in front of a repository's own commands. `projectScanner` calls any directory a level or
   * two under a category root a project, so a clone dropped there is enough to get a `.worktree.json`
   * read - and its `setup` and `scripts` are the inputs this library executes that nobody here wrote.
   * The gate is the real `CommandAgreement` over a real file in `projectRoot`.
   */
  describe('commands the project itself declares', () => {
    function declare(config: unknown): void {
      writeFileSync(join(projectRoot, '.worktree.json'), JSON.stringify(config), 'utf8')
    }

    function agreedHash(context: Harness): string | null {
      return CommandTrustStore.load(context.trustFile, () => undefined).acknowledgedHashOf(projectRoot)
    }

    const bootstrapHash = CommandAgreement.hashOf(['./bootstrap.sh'], { before: [], after: [] })

    it('refuses the create, and leaves no worktree behind to be refused around', async () => {
      const context = await harness()
      declare({ setup: ['./bootstrap.sh'] })

      const result = await context.lifecycle.create(worktreeSpec())

      expect(result).toMatchObject({
        ok: false,
        code: 'setup-not-acknowledged',
        setup: { commands: ['./bootstrap.sh'], hash: bootstrapHash },
      })
      // The whole reason the gate sits before `provisionWorktree` rather than beside the resolution.
      expect(context.worktrees.calls).toEqual([])
      expect(context.store.list()).toEqual([])
    })

    it('asks about the declared scripts too, every command labeled by its phase', async () => {
      const context = await harness()
      declare({
        setup: ['pnpm install'],
        scripts: {
          before: [{ name: 'codegen', command: 'pnpm codegen' }],
          after: [{ name: 'tests', command: 'pnpm test', cwd: 'packages/app' }],
        },
      })

      expect(await context.lifecycle.create(worktreeSpec())).toMatchObject({
        ok: false,
        code: 'setup-not-acknowledged',
        setup: {
          commands: ['pnpm install', 'before codegen: pnpm codegen', 'after tests (in packages/app): pnpm test'],
        },
      })
      expect(context.worktrees.calls).toEqual([])
    })

    it('creates a waiting session without running commands, then starts after agreement', async () => {
      const context = await harness()
      declare({ setup: ['./bootstrap.sh'] })
      context.setup.resolution = installing([{ command: './bootstrap.sh', cwd: '' }], 'project')
      const result = await context.lifecycle.create({ ...worktreeSpec(), deferSetupAgreement: true })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.detail)
      expect(context.host.calls).toHaveLength(0)
      const waiting = context.store.get(result.value.sessionId)
      expect(waiting).toMatchObject({ life: 'ended', pendingSetup: { agreement: { hash: bootstrapHash } } })
      expect(agreedHash(context)).toBeNull()
      expect(await context.lifecycle.retrySetup(result.value.sessionId, bootstrapHash)).toMatchObject({ ok: true })
      expect(agreedHash(context)).toBe(bootstrapHash)
      expect(context.store.get(result.value.sessionId)?.pendingSetup?.agreement).toBeUndefined()
      expect(context.host.calls.length).toBeGreaterThan(0)
    })

    // A skipped check would read as a passed one, so a key the gate cannot judge is a refusal.
    it('refuses a damaged scripts key before the worktree is cut', async () => {
      const context = await harness()
      declare({ setup: ['pnpm install'], scripts: { before: 'pnpm codegen' } })

      expect(await context.lifecycle.create(worktreeSpec())).toMatchObject({
        ok: false,
        code: 'invalid-spec',
        detail: expect.stringContaining('"scripts.before" must be an array'),
      })
      expect(context.worktrees.calls).toEqual([])
      expect(context.numbers.calls).toEqual([])
      expect(context.store.list()).toEqual([])
    })

    it('goes through when the answer travels back with the spec, and remembers it', async () => {
      const context = await harness()
      declare({ setup: ['./bootstrap.sh'] })

      const result = await context.lifecycle.create({
        ...worktreeSpec(),
        acknowledgeSetup: bootstrapHash,
      })

      expect(result.ok).toBe(true)
      expect(agreedHash(context)).toBe(bootstrapHash)
      expect(context.worktrees.calls).toHaveLength(1)
    })

    // The hash is what was SHOWN. An answer to an older question is not an answer to this one.
    it('refuses an agreement that names a hash the file no longer has', async () => {
      const context = await harness()
      declare({ setup: ['./bootstrap.sh'] })

      const result = await context.lifecycle.create({
        ...worktreeSpec(),
        acknowledgeSetup: 'hash-of-what-it-said-yesterday',
      })

      expect(result).toMatchObject({ ok: false, code: 'setup-not-acknowledged' })
      expect(agreedHash(context)).toBe(null)
    })

    it('lets an already agreed setup through without asking again', async () => {
      const context = await harness()
      declare({ setup: ['./bootstrap.sh'] })
      expect(context.agreement.gate(projectRoot, await context.agreement.declared(projectRoot), bootstrapHash)).toBe(null)

      expect((await context.lifecycle.create(worktreeSpec())).ok).toBe(true)
      expect(agreedHash(context)).toBe(bootstrapHash)
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
    // Not even this machine's own install: the file is the project's word on what replaces it.
    it('installs nothing when the file cannot be read, and says why', async () => {
      const context = await harness()
      writeFileSync(join(projectRoot, '.worktree.json'), '{ "setup": [', 'utf8')
      context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])

      expect((await context.lifecycle.create(worktreeSpec())).ok).toBe(true)
      expect(context.store.get('id-1')?.setupSkipped?.reason).toContain('is not valid JSON')
      expect(context.store.get('id-1')?.pendingSetup).toBeUndefined()
      expect(JSON.stringify(context.host.calls)).not.toContain('pnpm install')
    })

    it('installs nothing when the file moves between the agreement and the resolution', async () => {
      const context = await harness()
      declare({ setup: ['./bootstrap.sh'] })
      context.setup.resolution = installing([{ command: './bootstrap.sh', cwd: '' }], 'project')
      const cut = context.worktrees.port.create
      // The gate reads it agreed; while the worktree is cut, the file starts to say something else.
      context.worktrees.port.create = async (request) => {
        declare({ setup: ['./bootstrap.sh'], scripts: { before: [{ name: 'evil', command: './evil.sh' }] } })
        return cut(request)
      }

      const result = await context.lifecycle.create({ ...worktreeSpec(), acknowledgeSetup: bootstrapHash })

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
    expect(context.worktrees.places).toEqual([{ directory: join('Q:', 'apps', 'one'), projectRoot: join('Q:', 'apps', 'one'), owner: undefined }])
    expect(context.worktrees.calls).toEqual([{
      placement: { kind: 'git', ownerDir: join('Q:', 'apps', 'one'), cwdSubpath: '', catalogProject: join('Q:', 'apps', 'one') },
      folder: '007-fix',
      baseRef: 'main',
    }])
    expect(context.store.get('id-1')?.worktree?.branch).toBe('jamat/fix')
    expect(context.store.get('id-1')?.transcriptCwd).toBe(worktreePath)
    expect(launchOf(context.host.calls[0]).cwd).toBe(worktreePath)
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

  it('refuses a worktree slug that carries no letter or digit before it takes a number', async () => {
    const context = await harness()

    const refused = await context.lifecycle.create({ ...worktreeSpec(), worktree: { slug: '!!!' } })

    expect(failureOf(refused)).toMatchObject({ code: 'invalid-spec', detail: expect.stringMatching(/letter or digit/) })
    expect(context.numbers.calls).toEqual([])
    expect(context.worktrees.calls).toEqual([])
  })

  it('hands the owner and the setup of a member checkout to the owner directory', async () => {
    const context = await harness()
    const owner = join(projectRoot, 'Member')
    context.worktrees.outcome = {
      ok: true,
      value: {
        worktree: { worktreePath: join(owner, '.worktrees', '007-fix'), branch: 'file:///repository/Member', baseCommit: 'r41', repositoryRoot: owner, kind: 'svn' },
        checkout: null,
      },
    }

    successOf(await context.lifecycle.create({ ...worktreeSpec(), worktree: { slug: 'fix', owner } }))

    expect(context.worktrees.places).toEqual([{ directory: projectRoot, projectRoot, owner }])
    expect(context.worktrees.calls).toMatchObject([{ placement: { ownerDir: owner }, folder: '007-fix' }])
    const checkedOut = join(owner, '.worktrees', '007-fix')
    expect(context.setup.calls).toEqual([{ projectRoot: checkedOut, repositoryRoot: checkedOut }])
  })

  it('refuses a spec that does not describe a session it could launch', async () => {
    const context = await harness()
    const refusals = await Promise.all([
      context.lifecycle.create({
        kind: 'shell',
        directory: { mode: 'default' },
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
    expect(stored?.lastUserInputAt).toBe(stored?.createdAt)
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
    expect(stored?.lastUserInputAt).toBeUndefined()
  })

  it('records the control operation id of a requested create, and no other door writes one', async () => {
    const context = await harness()
    await context.store.put(record('parent', {
      kind: 'agent',
      title: '014 - the wire',
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
      directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
      callerOperationId: 'op-parent',
    }))

    const requested = successOf(await context.lifecycle.create(shellSpec(context.workDirectory), { callerOperationId: 'op-create' }))
    const plain = successOf(await context.lifecycle.create(shellSpec(context.workDirectory)))
    await context.lifecycle.createInternal(
      {
        kind: 'agent',
        directory: { mode: 'adHoc', path: context.workDirectory },
        agent: { agentId: 'claude', mode: 'new', initialPrompt: 'resolve it' },
      },
      { sessionId: 'internal-1', oneShot: true, scriptOf: { sessionId: 'parent', phase: 'after', scriptId: 'merge-resolve', name: 'resolver' } },
    )
    const forked = successOf(await context.lifecycle.forkFrom('parent'))
    const resumed = successOf(await context.lifecycle.openHistory({
      directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
      agentId: 'claude',
      nativeSessionId: 'native-9',
      providerName: 'Provider task',
      providerActive: false,
    }))

    expect(context.store.get(requested.sessionId)?.callerOperationId).toBe('op-create')
    for (const sessionId of [plain.sessionId, 'internal-1', forked.sessionId, resumed.sessionId]) {
      expect(context.store.get(sessionId)).not.toBeNull()
      expect(context.store.get(sessionId)?.callerOperationId).toBeUndefined()
    }
  })

  // The id is what a caller whose create answer was lost finds the session by, so it rides through
  // every later write of the record: the replay of the pending launch, the loss and the reopen.
  it('keeps the control operation id on a create the Host never answered, through its replay and a reopen', async () => {
    const context = await harness()
    context.host.failure = { ok: false, code: 'no-lease', detail: 'no live controller lease' }
    await context.lifecycle.create(shellSpec(context.workDirectory), { callerOperationId: 'op-lost' })
    expect(context.store.get('id-1')).toEqual(expect.objectContaining({
      life: 'starting',
      pendingOperationKind: 'create',
      callerOperationId: 'op-lost',
    }))

    context.host.failure = null
    expect(await context.lifecycle.reconcile(context.host.listing()))
      .toEqual([expect.objectContaining({ kind: 'retry-launch', sessionId: 'id-1', operation: 'create' })])
    expect(context.store.get('id-1')).toEqual(expect.objectContaining({ life: 'live', callerOperationId: 'op-lost' }))

    context.host.runtimes.clear()
    context.host.hostInstanceId = 'host-2'
    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([{ kind: 'mark-lost', sessionId: 'id-1' }])
    expect(await context.lifecycle.reopen('id-1')).toEqual({ ok: true, value: undefined })
    expect(context.store.get('id-1')).toEqual(expect.objectContaining({ life: 'live', callerOperationId: 'op-lost' }))
  })

  /*
   * A colour named at create is the scheduler's mark on its own work: the wave it launches sits in
   * the tree beside sessions a person opened, and painting them afterwards would show every worker
   * uncoloured first. The refusal is the setter's own, because the two write the same field.
   */
  it('persists every accepted create colour across a store reload and refuses unknown names', async () => {
    const context = await harness()

    const colors = ['red', 'orange', 'amber', 'green', 'teal', 'cyan',
      'sky', 'blue', 'indigo', 'violet', 'magenta', 'rose'] as const
    const colored: { sessionId: string; color: SessionCreateSpec['color'] }[] = []
    for (const color of colors) {
      const created = await context.lifecycle.create({
        kind: 'agent',
        directory: { mode: 'adHoc', path: context.workDirectory },
        agent: { agentId: 'claude', mode: 'new' },
        color,
      })
      colored.push({ sessionId: successOf(created).sessionId, color })
    }
    const plain = await context.lifecycle.create({
      kind: 'shell',
      directory: { mode: 'adHoc', path: context.workDirectory },
    })
    const refused = await context.lifecycle.create({
      kind: 'shell',
      directory: { mode: 'adHoc', path: context.workDirectory },
      color: 'chartreuse' as SessionCreateSpec['color'],
    })

    const reloaded = await SessionRecordsStore.load(context.recordsFile, {
      snapshotsDirectory: context.snapshotsDirectory,
    })
    for (const { sessionId, color } of colored) {
      expect(context.store.get(sessionId)?.color).toBe(color)
      expect(reloaded.get(sessionId)?.color).toBe(color)
    }
    expect(reloaded.get(successOf(plain).sessionId)?.color).toBeUndefined()
    expect(reloaded.list()).toHaveLength(colors.length + 1)
    expect(failureOf(refused).code).toBe('invalid-spec')
    expect(failureOf(refused).detail).toContain('is not a session colour')
  })

  /*
   * The create door itself numbers, so a session is numbered by the machine that keeps the count
   * whoever asked for it. Until 2026-09-18 only the create card did, by taking a number and
   * composing the title before it submitted, and every other caller of `sessions.create` - the CLI,
   * a paired computer, the skill - got a session the tree could not order and `--number` could not
   * reach.
   */
  // The create card draws the worktree before it exists: same owner and same counter as the create, nothing taken.
  describe('the place a worktree would stand', () => {
    it('answers the owner and the counted project of a picked folder without reserving or counting', async () => {
      const context = await harness()
      const picked = join(projectRoot, 'src')
      context.worktrees.placing = { ok: true, value: { kind: 'svn', ownerDir: projectRoot, cwdSubpath: 'src', catalogProject: projectRoot, setupScope: 'project' } }

      expect(await context.lifecycle.worktreePlacementOf({ mode: 'adHoc', path: picked }))
        .toEqual({ ok: true, value: { kind: 'svn', ownerDir: projectRoot, owner: 'project', countedProject: projectRoot } })
      expect(context.worktrees.places).toEqual([{ directory: picked, projectRoot: null }])
      expect(context.worktrees.calls).toEqual([])
      expect(context.numbers.calls).toEqual([])
    })

    it('names a product group and a bare directory as what they are', async () => {
      const context = await harness()
      context.worktrees.placing = { ok: true, value: { kind: 'svn', ownerDir: projectParent, cwdSubpath: 'one', catalogProject: projectRoot, setupScope: 'members' } }
      expect(await context.lifecycle.worktreePlacementOf({ mode: 'project', categoryId: 'nodejs', projectPath: projectRoot }))
        .toEqual({ ok: true, value: { kind: 'svn', ownerDir: projectParent, owner: 'product', countedProject: projectRoot } })

      context.worktrees.placing = { ok: true, value: { kind: 'svn', ownerDir: projectParent, cwdSubpath: '', catalogProject: null, setupScope: 'project' } }
      expect(await context.lifecycle.worktreePlacementOf({ mode: 'adHoc', path: projectParent }))
        .toEqual({ ok: true, value: { kind: 'svn', ownerDir: projectParent, owner: 'directory', countedProject: null } })

      context.worktrees.placing = { ok: false, code: 'invalid-spec', detail: 'a collection of independent projects' }
      expect(await context.lifecycle.worktreePlacementOf({ mode: 'adHoc', path: projectParent }))
        .toEqual({ ok: false, code: 'invalid-spec', detail: 'a collection of independent projects' })
    })
  })

  describe('numbering a create', () => {
    it('numbers a create in a catalog project whose title carries no number', async () => {
      const context = await harness()
      context.numbers.token = '015'

      const created = successOf(await context.lifecycle.create({
        kind: 'agent',
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
        agent: { agentId: 'claude', mode: 'new' },
        title: 'app#10 Unify the two server actions',
      }))

      expect(context.store.get(created.sessionId)?.title)
        .toBe('015 - app#10 Unify the two server actions')
      expect(context.numbers.calls).toEqual([{ projectPath: projectRoot }])
    })

    // The create card takes its number first, because the worktree slug is built from the same
    // token. A second one taken here would name the session after a number the branch never got.
    it('leaves a title that already carries its number alone', async () => {
      const context = await harness()

      const created = successOf(await context.lifecycle.create({
        kind: 'shell',
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
        title: '014 - session wizard',
      }))

      expect(context.store.get(created.sessionId)?.title).toBe('014 - session wizard')
      expect(context.numbers.calls).toEqual([])
    })

    // Named after the directory, and then numbered like any other: a title nobody typed is still a
    // session of the tree, and the tree orders it by the same prefix.
    it('numbers the fallback title of a create that carried none', async () => {
      const context = await harness()
      context.numbers.token = '015'

      const created = successOf(await context.lifecycle.create({
        kind: 'shell',
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
      }))

      expect(context.store.get(created.sessionId)?.title).toBe('015 - one')
    })

    // The count is a project's. The other two bindings name a directory, and there is nothing to
    // count in - the same rule `forkConversation` already follows.
    it('does not number a session outside a catalog project', async () => {
      const context = await harness()

      const created = successOf(await context.lifecycle.create(shellSpec(context.workDirectory)))

      expect(context.store.get(created.sessionId)?.title).toBe(basename(context.workDirectory))
      expect(context.numbers.calls).toEqual([])
    })

    // The worktree folder carries the number, so the counter is asked before the cut: a refused
    // checkout costs the project one number and leaves no folder.
    it('takes the number before the cut and names the worktree folder after it', async () => {
      const context = await harness()
      context.numbers.token = '015'
      context.worktrees.outcome = {
        ok: false,
        code: 'invalid-spec',
        detail: 'SVN does not ignore .worktrees',
      }

      const refused = await context.lifecycle.create(worktreeSpec())

      expect(failureOf(refused).code).toBe('invalid-spec')
      expect(context.numbers.calls).toEqual([{ projectPath: projectRoot }])
      expect(context.worktrees.calls.map((call) => call.folder)).toEqual(['015-fix'])
      expect(context.store.list()).toEqual([])
    })

    it('uses the launcher slug as it is, and puts a custom number in front of a plain one', async () => {
      const launcher = await harness()
      successOf(await launcher.lifecycle.create({
        ...worktreeSpec(),
        title: '014 - Fix login',
        worktree: { slug: '014-fix-login' },
      }))
      const ticket = await harness()
      successOf(await ticket.lifecycle.create({ ...worktreeSpec(), number: 'i34', worktree: { slug: 'Fix Login' } }))
      const repeated = await harness()
      successOf(await repeated.lifecycle.create({ ...worktreeSpec(), worktree: { slug: '007-fix' } }))

      expect(launcher.worktrees.calls.map((call) => call.folder)).toEqual(['014-fix-login'])
      expect(launcher.numbers.calls).toEqual([])
      expect(ticket.worktrees.calls.map((call) => call.folder)).toEqual(['i34-fix-login'])
      expect(repeated.worktrees.calls.map((call) => call.folder)).toEqual(['007-fix'])
    })

    // A number that could not be taken is not a reason to refuse: a session without a number is
    // still a session.
    it('creates without a number when the counter could not answer', async () => {
      const context = await harness()
      context.numbers.token = null

      const created = successOf(await context.lifecycle.create({
        kind: 'shell',
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
        title: 'no counter today',
      }))

      expect(context.store.get(created.sessionId)?.title).toBe('no counter today')
    })

    /*
     * A title beginning with three or more digits is a session number to everything that reads a
     * record, whoever typed it. `SessionNumberStore` takes a project's count from the highest number
     * its records are titled with, so `2026 plan` used to leave a record the counter then read as
     * 2026 - the next session in that project was 2027, and a number is never counted back down.
     */
    it('refuses a title claiming a number the project never gave out', async () => {
      const context = await harness()
      context.numbers.issued = 14

      const refused = await context.lifecycle.create({
        kind: 'shell',
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
        title: '2026 plan',
      })

      expect(failureOf(refused).code).toBe('invalid-spec')
      expect(failureOf(refused).detail).toBe('A title must not begin like a session number')
      // Nothing behind it: no record for the seed to read the 2026 back out of, and no number spent.
      expect(context.store.list()).toEqual([])
      expect(context.numbers.calls).toEqual([])
      expect(callsNamed(context.host, 'runtime.create')).toEqual([])
    })

    // Two digits are not a prefix, and neither is a number with something in front of it: both read
    // back out of `partsOf` as the whole name, so neither can move the count.
    it('creates a title that only looks numeric', async () => {
      const context = await harness()
      context.numbers.issued = 14
      context.numbers.token = '015'

      const created = successOf(await context.lifecycle.create({
        kind: 'shell',
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
        title: '99 bottles',
      }))

      expect(context.store.get(created.sessionId)?.title).toBe('015 - 99 bottles')
    })

    // The create card takes its number before it submits, because the worktree slug is built from
    // the same token, so the count is already at least as high as the prefix it composed.
    it('creates a title carrying a number the counter has reached', async () => {
      const context = await harness()
      context.numbers.issued = 15

      const created = successOf(await context.lifecycle.create({
        kind: 'shell',
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
        title: '015 - session wizard',
      }))

      expect(context.store.get(created.sessionId)?.title).toBe('015 - session wizard')
      expect(context.numbers.calls).toEqual([])
    })

    /*
     * The number a caller BRINGS, which is the whole point of the letters: a skill opening a session
     * per ticket wants the ticket's number on it, and the project's count must not move because of
     * one. The counter is never even asked, so the next session in the project is still 015.
     */
    it('takes a custom number without spending one', async () => {
      const context = await harness()
      context.numbers.issued = 14
      context.numbers.token = '015'

      const created = successOf(await context.lifecycle.create({
        kind: 'shell',
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
        title: 'fix the parser',
        number: 'i34',
      }))

      expect(context.store.get(created.sessionId)?.title).toBe('i34 - fix the parser')
      expect(context.numbers.calls).toEqual([])
    })

    // Neither of the two reasons the counter's number is withheld applies to one nothing counts.
    it('takes a custom number for a titled session and for an ad-hoc directory', async () => {
      const context = await harness()

      const tab = successOf(await context.lifecycle.create({
        kind: 'shell',
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
        title: 'watch the build',
        number: 'i34',
      }))
      const adHoc = successOf(await context.lifecycle.create({
        kind: 'shell',
        directory: { mode: 'adHoc', path: projectRoot },
        title: 'look around',
        number: 'i35',
      }))

      expect(context.store.get(tab.sessionId)?.title).toBe('i34 - watch the build')
      expect(context.store.get(adHoc.sessionId)?.title).toBe('i35 - look around')
      expect(context.numbers.calls).toEqual([])
    })

    /*
     * Digits are refused by SHAPE here rather than by comparison, which is what separates this from
     * the claim above: `014` is the answering computer's to hand out, and a caller that typed it
     * into this field meant the title, so the sentence has to say which mechanism it wanted.
     */
    it('refuses a number that is not the custom shape, and one given twice', async () => {
      const context = await harness()
      context.numbers.issued = 99

      for (const spec of [
        { number: '014' },
        { number: 'hotfix' },
        { number: 'i1234567' },
        { number: 'i34', title: '014 - already numbered' },
      ])
        expect(failureOf(await context.lifecycle.create({
          kind: 'shell',
          directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
          title: 'work',
          ...spec,
        })).code).toBe('invalid-spec')
      expect(context.store.list()).toEqual([])
      expect(context.numbers.calls).toEqual([])
    })

    // A binding that names a directory has no count to move: the seed reads project records alone,
    // which is also why a fork into one keeps the number of the session it came out of.
    it('leaves a numeric title alone outside a catalog project', async () => {
      const context = await harness()
      context.numbers.issued = 14

      const created = successOf(await context.lifecycle.create({
        kind: 'shell',
        directory: { mode: 'adHoc', path: context.workDirectory },
        title: '2026 plan',
      }))

      expect(context.store.get(created.sessionId)?.title).toBe('2026 plan')
    })

    /*
     * The two paths that compose their own title have already asked the counter, and a fork's title
     * is the one this door could not rebuild: `014-015` says which session it came out of, and a
     * plain `016` taken here would throw that away.
     */
    it('asks the counter once for a fork, and keeps the pair it composed', async () => {
      const context = await harness()
      context.numbers.token = '015'
      await context.store.put(record('s1', {
        kind: 'agent',
        title: '014 - the wire',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
      }))

      const forked = successOf(await context.lifecycle.forkFrom('s1'))

      expect(context.store.get(forked.sessionId)?.title).toBe('014-015 - the wire')
      expect(context.numbers.calls).toEqual([{ projectPath: projectRoot }])
    })
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

  // A caller's notify has to reach the session the replay may still start, so only the failure that
  // keeps the record names it; the wire answer is built from the code and detail alone.
  describe('the record a failed create names', () => {
    it('names the starting record a create left when the Host decided nothing', async () => {
      const undecided: HostCallFailure[] = [
        { ok: false, code: 'host-unreachable', detail: 'no descriptor' },
        { ok: false, code: 'no-lease', detail: 'no live controller lease' },
        { ok: false, code: 'op-rejected', status: 409, detail: 'Host is stopping and rejects new mutations' },
        { ok: false, code: 'op-rejected', status: 500, detail: 'internal error' },
      ]
      for (const failure of undecided) {
        const context = await harness()
        context.host.failure = failure
        expect(await context.lifecycle.create(shellSpec(context.workDirectory))).toStrictEqual({
          ok: false, code: failure.code, detail: failure.detail, recordedSessionId: 'id-1',
        })
        expect(context.store.get('id-1')).toEqual(expect.objectContaining({
          life: 'starting', pendingOperationId: 'id-2', pendingOperationKind: 'create',
        }))
      }
    })

    it('names nothing for a create the Host refused, and ends its record', async () => {
      for (const status of [400, 404]) {
        const context = await harness()
        context.host.failure = { ok: false, code: 'op-rejected', status, detail: `refused with ${status}` }
        expect(await context.lifecycle.create(shellSpec(context.workDirectory))).toStrictEqual({
          ok: false, code: 'op-rejected', detail: `refused with ${status}`,
        })
        expect(context.store.get('id-1')).toEqual(expect.objectContaining({
          life: 'ended', endedReason: `refused with ${status}`,
        }))
      }
    })

    it('names nothing for a create refused before it wrote a record', async () => {
      const invalid = await harness()
      const refused = await invalid.lifecycle.create({
        ...shellSpec(invalid.workDirectory),
        color: 'chartreuse' as SessionCreateSpec['color'],
      })
      expect(refused).toMatchObject({ ok: false, code: 'invalid-spec' })
      expect(refused).not.toHaveProperty('recordedSessionId')
      expect(invalid.store.list()).toEqual([])

      const unacknowledged = await harness()
      writeFileSync(join(projectRoot, '.worktree.json'), JSON.stringify({ setup: ['./bootstrap.sh'] }), 'utf8')
      const asked = await unacknowledged.lifecycle.create(worktreeSpec())
      expect(asked).toMatchObject({ ok: false, code: 'setup-not-acknowledged' })
      expect(asked).not.toHaveProperty('recordedSessionId')
      expect(unacknowledged.store.list()).toEqual([])

      const latched = await harness({ damagedRecords: true })
      const unwritten = await latched.lifecycle.create(shellSpec(latched.workDirectory))
      expect(unwritten).toMatchObject({ ok: false, code: 'records-latched' })
      expect(unwritten).not.toHaveProperty('recordedSessionId')
      expect(latched.host.calls).toEqual([])
    })
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

  it('replays a direct-process run as the tool itself, with no shell in front of it', async () => {
    const context = await harness()
    context.tools.set('svn', { ok: true, command: 'C:/svn/svn.exe', prefixArgs: [], env: {} })
    await context.store.put(record('s1', {
      directory: { mode: 'adHoc', path: context.workDirectory },
      process: { tool: 'svn', args: ['update', '-q', '--', '.'] },
      life: 'starting',
      binding: null,
      pendingOperationId: 'op-7',
      pendingOperationKind: 'create',
    }))

    await context.lifecycle.reconcile(context.host.listing())
    const launch = launchOf(callsNamed(context.host, 'runtime.create')[0])
    expect(launch.command).toBe('C:/svn/svn.exe')
    expect(launch.args).toEqual(['update', '-q', '--', '.'])
    expect(launch.cwd).toBe(context.workDirectory)
  })

  // A tool missing now stays missing: replaying it would be a loop, and a shell might find another one.
  it('ends a direct-process run whose tool this machine lacks, in the words of what is missing', async () => {
    const context = await harness()
    context.tools.set('jamat-cli', { ok: false, detail: 'The packaged Jamat CLI is missing: R:/cli/jamat-v3.cjs' })
    await context.store.put(record('s1', {
      directory: { mode: 'adHoc', path: context.workDirectory },
      process: { tool: 'jamat-cli', args: ['sessions', 'worktree-review', '--self', '--wait'] },
      life: 'starting',
      binding: null,
      pendingOperationId: 'op-7',
      pendingOperationKind: 'create',
    }))

    await context.lifecycle.reconcile(context.host.listing())
    expect(callsNamed(context.host, 'runtime.create')).toEqual([])
    expect(context.store.get('s1')).toEqual(expect.objectContaining({
      life: 'ended',
      pendingOperationId: undefined,
      endedReason: 'The packaged Jamat CLI is missing: R:/cli/jamat-v3.cjs',
    }))
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
      { kind: 'mark-ended', sessionId: 's2', binding: { hostInstanceId: 'host-1', generation: 1 }, exitCode: 3, endedAt: 8_000 },
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

  it('names an SVN worktree it leaves behind as a checkout, with no branch', async () => {
    const context = await harness()
    await context.store.put(record('s1', {
      life: 'lost',
      binding: null,
      worktree: {
        worktreePath: join('Q:', 'apps', 'one', '.worktrees', '014-fix'),
        branch: 'http://svn.local/apps/one',
        baseCommit: 'r12',
        repositoryRoot: join('Q:', 'apps', 'one'),
        kind: 'svn',
      },
    }))
    expect(await context.lifecycle.remove('s1')).toEqual({ ok: true, value: undefined })
    expect(context.reports).toEqual([
      `Session s1 is gone; the SVN worktree ${join('Q:', 'apps', 'one', '.worktrees', '014-fix')}, `
        + `a checkout of http://svn.local/apps/one, is left in ${join('Q:', 'apps', 'one')} for you `
        + 'to keep or remove, because nothing here throws away work that was never committed',
    ])
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
      }, { kind: 'settle-script-run', runId: 's1' }])
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

      // Idempotent: the next pass finds a running session and starts nothing a second time. The
      // install, settled and named by nobody any more, leaves the list.
      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toEqual([{ kind: 'collapse-script-run', runId: 's1' }])
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

      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toEqual([{ kind: 'settle-script-run', runId: 's1' }])
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
      }, { kind: 'collapse-script-run', runId: 's1' }])
      expect(context.store.get('p1')?.life).toBe('live')
      expect(callsNamed(context.host, 'runtime.create')).toHaveLength(2)
    })

  it('ends the waiting session when the setup failed, and names what that leaves on disk', async () => {
    const context = await harness()
    await context.store.put(waiting())
    await context.store.put(setupRecord({ exitCode: 1 }))

    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([{
      kind: 'script-failed',
      sessionId: 'p1',
      gate: 'before',
      reason: expect.stringContaining('1'),
    }, { kind: 'settle-script-run', runId: 's1' }])
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
    expect(context.reports[0]).toContain(worktreePath)
    expect(context.reports[0]).toContain('jamat/fix')

    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
    expect(context.store.get('s1')).toMatchObject({ life: 'ended', exitCode: 1 })
    expect(context.store.get('p1')?.scriptRuns).toEqual([expect.objectContaining({
      runId: 's1', outcome: 'failed', exitCode: 1, log: { state: 'unavailable', reason: expect.stringContaining('capture') },
    })])
    expect(callsNamed(context.host, 'runtime.create')).toEqual([])
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

    expect(withoutScriptRuns(await context.lifecycle.reconcile(context.host.listing()))).toEqual([{
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
    expect(withoutScriptRuns(await context.lifecycle.reconcile(context.host.listing()))).toEqual([{
      kind: 'mark-ended',
      sessionId: 'p1',
      binding: { hostInstanceId: 'host-1', generation: 4 },
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

    expect(withoutScriptRuns(await context.lifecycle.reconcile(context.host.listing())))
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
    expect(context.setup.calls).toEqual([{ projectRoot: worktreePath, repositoryRoot: worktreePath }])
    expect(context.store.get('id-1')).toEqual(expect.objectContaining({
      life: 'starting',
      binding: null,
      pendingOperationId: 'id-2',
      pendingOperationKind: 'create',
      pendingSetup: expect.objectContaining({ setupSessionId: 'id-3', cursor: 0 }),
    }))
    expect(context.store.get('id-3')).toEqual(expect.objectContaining({
      kind: 'shell',
      life: 'live',
      scriptOf: { sessionId: 'id-1', phase: 'before', scriptId: 'setup', name: 'setup', stepKey: expect.any(String) },
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
   * The failure is staged at `AtomicJsonFile.writeAsync`, the seam the store really fails at, because
   * that is the only way to fail the SECOND of two writes made inside one call - an unwritable path
   * fails the first. Everything else is the real store: the same validation, the same commit, the
   * same `false`.
   */
  it('says where the session stands when only its install could not be written', async () => {
    const context = await harness()
    context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])
    const original = AtomicJsonFile.writeAsync
    const write = vi.spyOn(AtomicJsonFile, 'writeAsync')
    // The queue is read in call order: the waiting session's write lands, the install's does not.
    write.mockImplementationOnce(original)
    write.mockImplementationOnce(() => Promise.reject(new Error('EBUSY: the records file is locked')))

    const refused = failureOf(await context.lifecycle.create(worktreeSpec())
      .finally(() => write.mockRestore()))

    expect(refused.code).toBe('records-latched')
    expect(refused.detail).toContain('id-1')
    expect(refused.detail).toContain(worktreePath)
    expect(refused.detail).not.toMatch(/nothing (here )?changed/)
    // The session is on disk and names the worktree itself; the install is not on disk at all.
    expect(context.store.get('id-1')).toEqual(expect.objectContaining({
      life: 'starting',
      pendingSetup: expect.objectContaining({ setupSessionId: 'id-3' }),
    }))
    expect(context.store.get('id-1')?.worktree?.branch).toBe('jamat/fix')
    expect(context.store.get('id-3')).toBeNull()
    expect(context.host.calls).toEqual([])

    // What the refusal promises, carried out: the pass reads the missing install for what it is and
    // ends the session, naming the worktree a retry needs exactly where it is.
    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([{
      kind: 'script-failed',
      sessionId: 'id-1',
      gate: 'before',
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
    expect(withoutScriptRuns(await context.lifecycle.reconcile(context.host.listing()))).toEqual([{
      kind: 'script-failed',
      sessionId: 'id-1',
      gate: 'before',
      reason: 'the setup could not start: launch.cwd must be an existing directory',
    }])
    expect(context.store.get('id-1')).toEqual(expect.objectContaining({
      life: 'ended',
      pendingSetup: expect.objectContaining({ setupSessionId: 'id-3' }),
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
  it('re-resolves the install, mints it as a new run and arms the waiting session again', async () => {
    const context = await harness()
    await context.store.put(failedWaiting())
    await context.store.put(setupRecord({ exitCode: 1 }))
    context.setup.resolution = installing([
      { command: 'pnpm install --frozen-lockfile', cwd: 'packages/app' },
    ])

    expect(await context.lifecycle.retrySetup('p1')).toEqual({ ok: true, value: undefined })
    expect(context.setup.calls).toEqual([{ projectRoot, repositoryRoot: projectRoot }])
    // `id-1` is the new install, `id-2` its launch, `id-3` the launch the session waits under.
    expect(context.store.get('id-1')).toEqual(expect.objectContaining({
      life: 'live',
      commands: [{
        command: 'pnpm install --frozen-lockfile',
        cwd: join(worktreePath, 'packages', 'app'),
      }],
      directory: { mode: 'adHoc', path: join(worktreePath, 'packages', 'app') },
      scriptOf: { sessionId: 'p1', phase: 'before', scriptId: 'setup', name: 'setup', stepKey: expect.any(String) },
    }))
    expect(context.store.get('p1')).toEqual(expect.objectContaining({
      life: 'starting',
      binding: null,
      pendingOperationId: 'id-3',
      pendingOperationKind: 'create',
      pendingSetup: expect.objectContaining({ setupSessionId: 'id-1', cursor: 0 }),
      endedAt: undefined,
      endedReason: undefined,
    }))
    // The failed attempt is left as it was: its record is the evidence its history entry is made of.
    expect(context.store.get('s1')).toEqual(setupRecord({ exitCode: 1 }))

    const creates = callsNamed(context.host, 'runtime.create')
    expect(creates).toHaveLength(1)
    expect(creates[0].body.runtimeSessionId).toBe('id-1')
    expect(creates[0].body.operationId).toBe('id-2')
    expect(launchOf(creates[0]).args.join(' ')).toContain('--frozen-lockfile')

    // And it lands where the first install would have: the setup exits 0 and the session runs.
    context.host.runtimes.set('id-1', runtime('id-1', { alive: false, exitCode: 0, exitedAt: 9_000 }))
    await context.lifecycle.reconcile(context.host.listing())
    expect(context.store.get('p1')).toEqual(expect.objectContaining({
      life: 'live',
      pendingSetup: undefined,
    }))
    expect(callsNamed(context.host, 'runtime.create')[1].body.operationId).toBe('id-3')
  })

  it('refuses a retry while the install it would replace may still be running', async () => {
    const context = await harness()
    await context.store.put(failedWaiting())
    await context.store.put(setupRecord({ life: 'live', binding: { hostInstanceId: 'host-1', generation: 1 } }))
    context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])

    expect(failureOf(await context.lifecycle.retrySetup('p1')).code).toBe('live-refused')
    expect(context.store.get('p1')).toEqual(failedWaiting())
    expect(context.host.calls).toEqual([])
  })

  it('refuses a retry once the worktree is gone, naming its path, and while a cleanup holds it', async () => {
    const context = await harness()
    const gonePath = join(projectRoot, '.worktrees', 'gone')
    const absent = failedWaiting({ worktree: { ...failedWaiting().worktree!, worktreePath: gonePath } })
    await context.store.put(absent)
    await context.store.put(setupRecord({ exitCode: 1 }))
    context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])

    expect(failureOf(await context.lifecycle.retrySetup('p1')))
      .toMatchObject({ code: 'worktree-removed', detail: expect.stringContaining(gonePath) })

    const retired = failedWaiting({ retiredWorktree: { worktreePath, kind: 'svn', revisions: [], removedAt: 6_000 } })
    delete retired.worktree
    await context.store.put(retired)
    expect(failureOf(await context.lifecycle.retrySetup('p1')))
      .toMatchObject({ code: 'worktree-removed', detail: expect.stringContaining(worktreePath) })

    await context.store.put({ ...retired, pendingSetup: undefined })
    expect(failureOf(await context.lifecycle.retrySetup('p1')))
      .toMatchObject({ code: 'worktree-removed', detail: expect.stringContaining(worktreePath) })

    await context.store.put(failedWaiting())
    context.finishing.add('p1')
    expect(failureOf(await context.lifecycle.retrySetup('p1')).code).toBe('merge-pending')
    expect(context.store.get('p1')).toEqual(failedWaiting())
    expect(context.host.calls).toEqual([])
    expect(context.setup.calls).toEqual([])
  })

  /*
   * The window a retry must never leave open: the Host is briefly unreachable, so nothing can be
   * launched. The session is armed over the NEW install, which is `starting` under its own pending
   * pair, never over the old one still saying `ended` with the exit code that failed - that would
   * hand the next pass a session to condemn on the old exit code, throwing the retry away in silence.
   * The new install is replayed under its own id once the Host answers, so the retry answers as
   * accepted: the badge shows the install, and a pass will start the session after it.
   */
  it('leaves the new install to the replay when the Host cannot answer the retry', async () => {
    const context = await harness()
    await context.store.put(failedWaiting())
    await context.store.put(setupRecord({ exitCode: 1 }))
    context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])
    context.host.failure = { ok: false, code: 'host-unreachable', detail: 'no descriptor' }

    expect(await context.lifecycle.retrySetup('p1')).toEqual({ ok: true, value: undefined })
    expect(context.store.get('id-1')).toEqual(expect.objectContaining({
      life: 'starting',
      binding: null,
      pendingOperationId: 'id-2',
      pendingOperationKind: 'create',
    }))
    expect(context.store.get('p1')).toEqual(expect.objectContaining({
      life: 'starting',
      pendingSetup: expect.objectContaining({ setupSessionId: 'id-1' }),
    }))
    expect(context.store.get('s1')).toEqual(setupRecord({ exitCode: 1 }))

    context.host.failure = null
    expect(withoutScriptRuns(await context.lifecycle.reconcile(context.host.listing()))).toEqual([{
      kind: 'retry-launch',
      sessionId: 'id-1',
      operationId: 'id-2',
      operation: 'create',
    }])
    expect(context.store.get('id-1')?.life).toBe('live')
    expect(context.store.get('p1')?.life).toBe('starting')
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
      scriptOf: { sessionId: 'p1', phase: 'before', scriptId: 'setup', name: 'setup' },
    }))
    context.host.runtimes.set('s1', runtime('s1'))

    expect(await context.lifecycle.stop('s1')).toEqual({ ok: true, value: undefined })

    expect(context.store.get('s1')?.stopRequested).toBe(true)
    // The fake stops a runtime with exit 0, which is the dangerous answer; the marker outranks it.
    expect(context.host.runtimes.get('s1')?.exitCode).toBe(0)
    expect(await context.lifecycle.reconcile(context.host.listing())).toContainEqual({
      kind: 'script-failed',
      sessionId: 'p1',
      gate: 'before',
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
    writeFileSync(join(projectRoot, '.worktree.json'), JSON.stringify({ setup: ['./evil.sh'] }), 'utf8')
    const hash = CommandAgreement.hashOf(['./evil.sh'], { before: [], after: [] })

    expect(await context.lifecycle.retrySetup('p1')).toMatchObject({
      ok: false,
      code: 'setup-not-acknowledged',
      setup: { commands: ['./evil.sh'], hash },
    })
    expect(JSON.stringify(context.host.calls)).not.toContain('evil')

    expect(await context.lifecycle.retrySetup('p1', hash))
      .toEqual({ ok: true, value: undefined })
    expect(CommandTrustStore.load(context.trustFile, () => undefined).acknowledgedHashOf(projectRoot))
      .toBe(hash)
    expect(JSON.stringify(context.host.calls)).toContain('evil')
  })

  // The agreement asked and the commands that run come from one read, so no write can land between.
  it('reads .worktree.json once for a retry', async () => {
    const context = await harness()
    await context.store.put(failedWaiting())
    await context.store.put(setupRecord({ exitCode: 1 }))
    context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])
    writeFileSync(join(projectRoot, '.worktree.json'), JSON.stringify({ setup: ['pnpm install'] }), 'utf8')
    const hash = CommandAgreement.hashOf(['pnpm install'], { before: [], after: [] })
    const load = vi.spyOn(WorktreeConfig, 'load')

    expect(await context.lifecycle.retrySetup('p1', hash)).toEqual({ ok: true, value: undefined })
    expect(load).toHaveBeenCalledTimes(1)
    load.mockRestore()
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
      observedSetup = context.store.get('id-1')
      observedPrimary = context.store.get('p1')
    }

    expect(await context.lifecycle.retrySetup('p1')).toEqual({ ok: true, value: undefined })
    expect(observedSetup).toEqual(expect.objectContaining({
      life: 'starting',
      binding: null,
      pendingOperationId: 'id-2',
      pendingOperationKind: 'create',
      commands: [{ command: 'pnpm install', cwd: worktreePath }],
    }))
    expect(observedPrimary).toEqual(expect.objectContaining({
      life: 'starting',
      pendingOperationId: 'id-3',
      pendingSetup: expect.objectContaining({ setupSessionId: 'id-1' }),
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
    expect(context.store.get('id-1')).toEqual(expect.objectContaining({
      life: 'ended',
      pendingOperationId: undefined,
      endedReason: 'launch.cwd must be an existing directory',
    }))

    context.host.launchFailure = null
    expect(withoutScriptRuns(await context.lifecycle.reconcile(context.host.listing()))).toEqual([{
      kind: 'script-failed',
      sessionId: 'p1',
      gate: 'before',
      reason: 'the setup could not start: launch.cwd must be an existing directory',
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
      scriptOf: { sessionId: 'p1', phase: 'before', scriptId: 'setup', name: 'setup', stepKey: expect.any(String) },
      directory: { mode: 'adHoc', path: worktreePath },
      commands: [{ command: 'pnpm install', cwd: worktreePath }],
    }))
    expect(context.store.get('id-1')?.worktree).toBeUndefined()
    expect(context.store.get('p1')).toEqual(expect.objectContaining({
      life: 'starting',
      binding: null,
      pendingOperationId: 'id-3',
      pendingOperationKind: 'create',
      pendingSetup: expect.objectContaining({ setupSessionId: 'id-1' }),
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

    expect(withoutScriptRuns(await context.lifecycle.reconcile(context.host.listing()))).toEqual([{
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

    expect(withoutScriptRuns(await context.lifecycle.reconcile(context.host.listing()))).toEqual([{
      kind: 'retry-launch',
      sessionId: 'p1',
      operationId: 'id-1',
      operation: 'create',
    }])
    expect(context.store.get('p1')?.life).toBe('live')
  })

  /*
   * The install was only ever preparing this one session, so removing the session stops it, marked
   * as stopped. Its record goes once it has ended, without a second recovery point: the parent's
   * removal spent the one this cascade is undone by, and its logs went with its history.
   */
  it('stops a running install when its session is removed, and takes its record once it ended', async () => {
    const context = await harness()
    context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])
    await context.lifecycle.create(worktreeSpec())
    expect(await context.logs.write('id-1', 'earlier', 'an earlier attempt')).toEqual({ ok: true, bytes: 18 })
    const points = snapshotCount(context.snapshotsDirectory)

    expect(await context.lifecycle.remove('id-1')).toEqual({ ok: true, value: undefined })
    expect(context.store.get('id-1')).toBeNull()
    expect(callsNamed(context.host, 'runtime.stop')[0].body.target).toEqual({
      hostInstanceId: 'host-1',
      runtimeSessionId: 'id-3',
      generation: 1,
    })
    expect(context.store.get('id-3')?.stopRequested).toBe(true)
    expect(existsSync(join(context.logsDirectory, 'id-1'))).toBe(false)
    expect(snapshotCount(context.snapshotsDirectory)).toBe(points + 1)

    // The fake ends a stopped runtime, so one pass marks it ended and the next takes it away.
    expect(await context.lifecycle.reconcile(context.host.listing()))
      .toContainEqual(expect.objectContaining({ kind: 'mark-ended', sessionId: 'id-3' }))
    expect(await context.lifecycle.reconcile(context.host.listing()))
      .toEqual([{ kind: 'collapse-script-run', runId: 'id-3' }])
    expect(context.store.get('id-3')).toBeNull()
    expect(context.host.runtimes.has('id-3')).toBe(false)
    expect(context.collapsed).toEqual([{ runId: 'id-3', parentId: 'id-1', handoff: 'close', handoffTo: 'id-1' }])
    expect(snapshotCount(context.snapshotsDirectory)).toBe(points + 1)
  })

  /*
   * An install the Host never answered is a `starting` record with a pending pair, which is precisely
   * what a reconcile pass REPLAYS: `pnpm install` in a worktree that belongs to no session any more.
   * It holds no process, so it goes in the parent's own write, and so does an earlier attempt that
   * has ended, its dead runtime asked away first.
   */
  it('takes the runs that hold no process with their session, in one write', async () => {
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
    context.host.failure = null
    await context.store.put(setupRecord({
      sessionId: 's0',
      binding: { hostInstanceId: 'host-1', generation: 1 },
      scriptOf: { sessionId: 'id-1', phase: 'before', scriptId: 'setup', name: 'setup' },
    }))
    context.host.runtimes.set('s0', runtime('s0', { alive: false, exitCode: 1 }))
    const points = snapshotCount(context.snapshotsDirectory)

    expect(await context.lifecycle.remove('id-1')).toEqual({ ok: true, value: undefined })
    expect(context.store.list()).toEqual([])
    expect(snapshotCount(context.snapshotsDirectory)).toBe(points + 1)
    expect(callsNamed(context.host, 'runtime.stop')).toEqual([])
    expect(callsNamed(context.host, 'runtime.remove').map((call) => call.body.target))
      .toEqual([{ hostInstanceId: 'host-1', runtimeSessionId: 's0', generation: 1 }])

    expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
    expect(callsNamed(context.host, 'runtime.create')).toHaveLength(1)
  })

  /*
   * The before chain: the setup, then the project's own `scripts.before`, one run per step, before
   * the session starts. Ids are minted in pairs per run (the run, its launch); the session takes
   * `id-1` and `id-2` at create.
   */
  describe('the before chain', () => {
    function declareBefore(): void {
      writeFileSync(join(projectRoot, '.worktree.json'), JSON.stringify({
        scripts: {
          before: [
            { name: 'prepare', command: 'pnpm prepare' },
            { name: 'codegen', command: 'pnpm codegen', cwd: 'tools' },
          ],
        },
      }), 'utf8')
    }

    async function agreeToFile(context: Harness): Promise<void> {
      const declared = await context.agreement.declared(projectRoot)
      if (declared.kind !== 'read' || declared.value === null) throw new Error('the project declares nothing')
      expect(context.agreement.gate(projectRoot, declared, declared.value.hash)).toBe(null)
    }

    async function exits(context: Harness, runId: string, exitCode: number): Promise<void> {
      context.clock.now += 1_000
      context.host.runtimes.set(runId, runtime(runId, { alive: false, exitCode, exitedAt: context.clock.now }))
      await context.lifecycle.reconcile(context.host.listing())
    }

    async function settleAll(context: Harness): Promise<void> {
      for (let pass = 0; pass < 3; pass += 1) await context.lifecycle.reconcile(context.host.listing())
    }

    function createdRuntimes(context: Harness): unknown[] {
      return callsNamed(context.host, 'runtime.create').map((call) => call.body.runtimeSessionId)
    }

    /** Create with the install, then the install and `prepare` pass and `codegen` exits 2. */
    async function failedAtCodegen(context: Harness): Promise<void> {
      declareBefore()
      await agreeToFile(context)
      context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])
      successOf(await context.lifecycle.create(worktreeSpec()))
      await exits(context, 'id-3', 0)
      await exits(context, 'id-5', 0)
      await exits(context, 'id-7', 2)
      await settleAll(context)
    }

    it('runs the setup and each declared step in order, and starts the session after the last', async () => {
      const context = await harness()
      declareBefore()
      await agreeToFile(context)
      context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])

      expect(await context.lifecycle.create(worktreeSpec())).toEqual({ ok: true, value: { sessionId: 'id-1' } })
      const steps = context.store.get('id-1')?.pendingSetup?.steps ?? []
      expect(steps.map((step) => [step.scriptId, step.name])).toEqual([
        ['setup', 'setup'],
        ['declared', 'prepare'],
        ['declared', 'codegen'],
      ])
      expect(context.store.get('id-1')?.pendingSetup).toMatchObject({ setupSessionId: 'id-3', cursor: 0 })

      await exits(context, 'id-3', 0)
      expect(context.store.get('id-1')?.pendingSetup).toMatchObject({ setupSessionId: 'id-5', cursor: 1 })
      expect(context.store.get('id-5')).toEqual(expect.objectContaining({
        life: 'live',
        title: 'prepare fix',
        commands: [{ command: 'pnpm prepare', cwd: worktreePath }],
        scriptOf: { sessionId: 'id-1', phase: 'before', scriptId: 'declared', name: 'prepare', stepKey: steps[1].key },
      }))
      expect(context.scripts.infoOf(context.store.get('id-1')!).scripts?.badge)
        .toMatchObject({ state: 'running', text: 'setup: prepare', runId: 'id-5' })

      await exits(context, 'id-5', 0)
      expect(context.store.get('id-7')?.commands).toEqual([{ command: 'pnpm codegen', cwd: join(worktreePath, 'tools') }])
      expect(context.store.get('id-1')?.life).toBe('starting')
      expect(createdRuntimes(context)).toEqual(['id-3', 'id-5', 'id-7'])

      await exits(context, 'id-7', 0)
      expect(context.store.get('id-1')).toEqual(expect.objectContaining({ life: 'live', pendingSetup: undefined }))
      expect(createdRuntimes(context)).toEqual(['id-3', 'id-5', 'id-7', 'id-1'])
      expect(callsNamed(context.host, 'runtime.create')[3].body.operationId).toBe('id-2')

      await settleAll(context)
      expect(context.store.get('id-1')?.scriptRuns?.map((entry) => [entry.name, entry.outcome, entry.stepKey]))
        .toEqual(steps.map((step) => [step.name, 'succeeded', step.key]))
      expect(context.store.list().map((entry) => entry.sessionId)).toEqual(['id-1'])

      // Reopen and Restart start the session itself and nothing before it.
      context.host.runtimes.set('id-1', runtime('id-1', { alive: false, exitCode: 0, exitedAt: 20_000 }))
      await context.lifecycle.reconcile(context.host.listing())
      const before = context.host.calls.length
      successOf(await context.lifecycle.reopen('id-1'))
      expect(context.host.calls.slice(before).map((call) => call.name)).toEqual(['runtime.list', 'runtime.replace'])
      expect(callsNamed(context.host, 'runtime.replace')[0].body.target).toMatchObject({ runtimeSessionId: 'id-1' })
      expect(createdRuntimes(context)).toEqual(['id-3', 'id-5', 'id-7', 'id-1'])
    })

    it('ends the session naming the declared step that failed, and keeps the wait', async () => {
      const context = await harness()
      await failedAtCodegen(context)

      const parent = context.store.get('id-1')!
      expect(parent).toEqual(expect.objectContaining({
        life: 'ended',
        endedReason: 'setup failed: the codegen script exited with 2',
        pendingSetup: expect.objectContaining({ setupSessionId: 'id-7', cursor: 2 }),
      }))
      expect(context.scripts.infoOf(parent).scripts?.badge)
        .toMatchObject({ state: 'failed', text: 'setup failed: codegen', runId: 'id-7' })
      expect(context.reports.some((message) => message.includes('the before script codegen failed'))).toBe(true)
      expect(context.store.list().map((entry) => entry.sessionId).sort()).toEqual(['id-1', 'id-7'])
      expect(parent.scriptRuns?.map((entry) => [entry.runId, entry.outcome]))
        .toEqual([['id-3', 'succeeded'], ['id-5', 'succeeded'], ['id-7', 'failed']])
      expect(parent.scriptRuns?.find((entry) => entry.runId === 'id-7')).toMatchObject({ exitCode: 2, log: { state: 'saved' } })
      expect(existsSync(context.logs.pathOf('id-1', 'id-7'))).toBe(true)
    })

    it('retries from the failed step when nothing before it changed', async () => {
      const context = await harness()
      await failedAtCodegen(context)

      expect(await context.lifecycle.retrySetup('id-1')).toEqual({ ok: true, value: undefined })
      // `id-9` is the new codegen run, `id-10` its launch, `id-11` the launch the session waits under.
      expect(context.store.get('id-1')?.pendingSetup).toMatchObject({ setupSessionId: 'id-9', cursor: 2 })
      expect(context.store.get('id-9')?.scriptOf).toMatchObject({ scriptId: 'declared', name: 'codegen' })
      expect(createdRuntimes(context)).toEqual(['id-3', 'id-5', 'id-7', 'id-9'])

      await exits(context, 'id-9', 0)
      expect(context.store.get('id-1')?.life).toBe('live')
      expect(createdRuntimes(context)).toEqual(['id-3', 'id-5', 'id-7', 'id-9', 'id-1'])
      expect(callsNamed(context.host, 'runtime.create')[4].body.operationId).toBe('id-11')
    })

    it('retries from the failed step while the worktree keeps its setup logs', async () => {
      const context = await harness()
      await failedAtCodegen(context)
      for (let attempt = 0; attempt < 9; attempt += 1) {
        successOf(await context.lifecycle.retrySetup('id-1'))
        const runId = context.store.get('id-1')?.pendingSetup?.setupSessionId
        if (runId === undefined) throw new Error('the retry armed no run')
        await exits(context, runId, 2)
        await settleAll(context)
      }
      expect(context.store.get('id-1')?.scriptRuns).toEqual(expect.arrayContaining([expect.objectContaining({ runId: 'id-3' })]))
      const created = createdRuntimes(context).length

      successOf(await context.lifecycle.retrySetup('id-1'))
      expect(context.store.get('id-1')?.pendingSetup).toMatchObject({ cursor: 2 })
      expect(createdRuntimes(context)).toHaveLength(created + 1)
      expect(context.store.get(String(createdRuntimes(context).at(-1)))?.scriptOf).toMatchObject({ name: 'codegen' })
    })

    it('retries the whole chain once the setup it starts with changed', async () => {
      const context = await harness()
      await failedAtCodegen(context)
      context.setup.resolution = installing([{ command: 'pnpm install --force', cwd: '' }])

      expect(await context.lifecycle.retrySetup('id-1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('id-1')?.pendingSetup).toMatchObject({ setupSessionId: 'id-9', cursor: 0 })
      expect(context.store.get('id-9')?.commands).toEqual([{ command: 'pnpm install --force', cwd: worktreePath }])

      await exits(context, 'id-9', 0)
      expect(context.store.get('id-1')?.pendingSetup).toMatchObject({ cursor: 1 })
    })

    it('runs the declared steps when nothing installs the project, and keeps saying so', async () => {
      const context = await harness()
      declareBefore()
      await agreeToFile(context)

      successOf(await context.lifecycle.create(worktreeSpec()))
      expect(context.store.get('id-1')).toEqual(expect.objectContaining({
        life: 'starting',
        setupSkipped: { reason: 'no known project family detected' },
        pendingSetup: expect.objectContaining({ setupSessionId: 'id-3', cursor: 0 }),
      }))
      expect(context.store.get('id-1')?.pendingSetup?.steps?.map((step) => step.name)).toEqual(['prepare', 'codegen'])
      expect(context.reports.some((message) => message.includes('no known project family detected'))).toBe(true)

      await exits(context, 'id-3', 0)
      await exits(context, 'id-5', 0)
      expect(context.store.get('id-1')).toEqual(expect.objectContaining({
        life: 'live',
        setupSkipped: { reason: 'no known project family detected' },
      }))
    })

    // A wait an older build wrote names one setup step and no history keys, so a retry runs all of it.
    it('reads a wait written before chains existed as one setup step', async () => {
      const context = await harness()
      declareBefore()
      await agreeToFile(context)
      await context.store.put(failedWaiting())
      await context.store.put(setupRecord({ exitCode: 1 }))
      context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])

      expect(await context.lifecycle.retrySetup('p1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('p1')?.pendingSetup).toMatchObject({ setupSessionId: 'id-1', cursor: 0 })
      expect(context.store.get('p1')?.pendingSetup?.steps?.map((step) => step.name))
        .toEqual(['setup', 'prepare', 'codegen'])
    })

    /*
     * A client that died between the next step's write and the gate's advance. The orphan is never
     * launched and goes without a history entry, since nothing ran; the step before it is judged
     * succeeded once more, and one new run starts.
     */
    it('launches exactly one next step after a crash between its write and the advance', async () => {
      const context = await harness()
      declareBefore()
      await agreeToFile(context)
      context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])
      successOf(await context.lifecycle.create(worktreeSpec()))
      vi.spyOn(context.store, 'update').mockResolvedValueOnce(false)

      await exits(context, 'id-3', 0)
      expect(context.store.get('id-5')).toEqual(expect.objectContaining({ life: 'starting', binding: null }))
      expect(context.store.get('id-1')?.pendingSetup).toMatchObject({ setupSessionId: 'id-3', cursor: 0 })
      expect(createdRuntimes(context)).toEqual(['id-3'])

      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('id-5')).toBeNull()
      expect(context.store.get('id-1')?.pendingSetup).toMatchObject({ setupSessionId: 'id-7', cursor: 1 })
      expect(createdRuntimes(context)).toEqual(['id-3', 'id-7'])

      await context.lifecycle.reconcile(context.host.listing())
      expect(createdRuntimes(context)).toEqual(['id-3', 'id-7'])
      expect(context.store.get('id-1')?.scriptRuns?.map((entry) => entry.runId) ?? []).not.toContain('id-5')
    })

    /*
     * An SVN worktree of any directory: the create reserves the folder and writes the record with the
     * URL and the HEAD revision, and the checkout leads the before chain as a visible run. Here the
     * directory is `WebMirabiaAdmin/src` of the group `Mirabia`, which owns the worktree.
     */
    describe('an SVN checkout', () => {
      const groupRoot = join(projectParent, 'Mirabia')
      const reserved = join(groupRoot, '.worktrees', 'fix')
      const directory = join(groupRoot, 'WebMirabiaAdmin', 'src')
      const url = 'file:///repository/Mirabia'
      const checkoutArgs = ['--non-interactive', 'checkout', '--', `${url}@41`, '.']
      mkdirSync(reserved, { recursive: true })

      function svnWorktree(context: Harness, catalogProject: string | null = null): void {
        context.tools.set('svn', { ok: true, command: 'C:/svn/svn.exe', prefixArgs: [], env: {} })
        context.worktrees.placing = { ok: true, value: { kind: 'svn', ownerDir: groupRoot, cwdSubpath: 'WebMirabiaAdmin/src', catalogProject } }
        context.worktrees.outcome = {
          ok: true,
          value: {
            worktree: { worktreePath: reserved, branch: url, baseCommit: 'r41', repositoryRoot: groupRoot, kind: 'svn', directoryId: '1:2:3', cwdSubpath: 'WebMirabiaAdmin/src' },
            checkout: { tool: 'svn', cwd: reserved, args: checkoutArgs },
          },
        }
      }

      function adHocSpec(overrides?: Partial<SessionCreateSpec>): SessionCreateSpec {
        return { kind: 'agent', directory: { mode: 'adHoc', path: directory }, agent: { agentId: 'claude', mode: 'new' }, worktree: { slug: 'fix' }, ...overrides }
      }

      it('records the URL and r<HEAD> before the checkout, runs it as a child run and starts the session in its subpath after it', async () => {
        const context = await harness()
        svnWorktree(context)

        expect(await context.lifecycle.create(adHocSpec())).toEqual({ ok: true, value: { sessionId: 'id-1' } })
        expect(context.worktrees.places).toEqual([{ directory, projectRoot: null, owner: undefined }])
        const parent = context.store.get('id-1')!
        expect(parent.worktree).toMatchObject({ worktreePath: reserved, branch: url, baseCommit: 'r41', cwdSubpath: 'WebMirabiaAdmin/src' })
        expect(parent.worktree?.agentStartedAt).toBeUndefined()
        expect(parent.transcriptCwd).toBe(join(reserved, 'WebMirabiaAdmin', 'src'))
        expect(parent.pendingSetup?.steps?.map((step) => [step.scriptId, step.name])).toEqual([['svn', 'checkout']])
        // The owner's own `.worktree.json` is what the setup is resolved from.
        expect(context.setup.calls).toEqual([{ projectRoot: groupRoot, repositoryRoot: groupRoot }])
        expect(context.store.get('id-3')).toMatchObject({
          title: 'Checkout fix',
          process: { tool: 'svn', args: checkoutArgs },
          scriptOf: { sessionId: 'id-1', phase: 'before', scriptId: 'svn', name: 'checkout' },
        })
        expect(launchOf(callsNamed(context.host, 'runtime.create')[0])).toMatchObject({ command: 'C:/svn/svn.exe', args: checkoutArgs, cwd: reserved })
        expect(context.scripts.infoOf(parent).scripts?.badge).toMatchObject({ state: 'running', text: 'checking out', runId: 'id-3' })

        await exits(context, 'id-3', 0)
        expect(context.store.get('id-1')?.life).toBe('live')
        expect(context.store.get('id-1')?.worktree?.agentStartedAt).toBe(context.clock.now)
        expect(createdRuntimes(context)).toEqual(['id-3', 'id-1'])
        expect(launchOf(callsNamed(context.host, 'runtime.create')[1]).cwd).toBe(join(reserved, 'WebMirabiaAdmin', 'src'))
      })

      it('ends the session when the checkout fails, and Retry setup empties the folder by identity and checks out again', async () => {
        const context = await harness()
        svnWorktree(context)
        successOf(await context.lifecycle.create(adHocSpec()))

        await exits(context, 'id-3', 1)
        await settleAll(context)
        const parent = context.store.get('id-1')!
        expect(parent).toMatchObject({ life: 'ended', endedReason: 'setup failed: the checkout exited with 1' })
        expect(parent.worktree?.agentStartedAt).toBeUndefined()
        expect(context.scripts.infoOf(parent).scripts?.badge).toMatchObject({ state: 'failed', text: 'checkout failed', runId: 'id-3' })
        expect(context.reports.some((message) => message.includes('the checkout failed'))).toBe(true)

        expect(await context.lifecycle.retrySetup('id-1')).toEqual({ ok: true, value: undefined })
        expect(context.worktrees.purged.map((worktree) => [worktree.worktreePath, worktree.directoryId])).toEqual([[reserved, '1:2:3']])
        const retried = context.store.get('id-1')?.pendingSetup
        expect(retried).toMatchObject({ cursor: 0 })
        expect(context.store.get(retried?.setupSessionId ?? '')).toMatchObject({ process: { tool: 'svn', args: checkoutArgs } })
        expect(createdRuntimes(context)).toEqual(['id-3', retried?.setupSessionId])
      })

      it('refuses Retry setup when the reserved folder is another directory, and launches nothing', async () => {
        const context = await harness()
        svnWorktree(context)
        successOf(await context.lifecycle.create(adHocSpec()))
        await exits(context, 'id-3', 1)
        await settleAll(context)
        context.worktrees.purge = { ok: false, code: 'invalid-spec', detail: `${reserved} is another directory than the folder this session reserved; nothing was deleted` }

        expect(await context.lifecycle.retrySetup('id-1')).toEqual(context.worktrees.purge)
        expect(createdRuntimes(context)).toEqual(['id-3'])
        expect(context.store.get('id-1')).toMatchObject({ life: 'ended', pendingSetup: { setupSessionId: 'id-3' } })
      })

      it('resumes after a checkout that passed without emptying the folder', async () => {
        const context = await harness()
        svnWorktree(context)
        context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])
        successOf(await context.lifecycle.create(adHocSpec()))
        expect(context.store.get('id-1')?.pendingSetup?.steps?.map((step) => step.scriptId)).toEqual(['svn', 'setup'])
        await exits(context, 'id-3', 0)
        await exits(context, 'id-5', 1)
        await settleAll(context)

        expect(await context.lifecycle.retrySetup('id-1')).toEqual({ ok: true, value: undefined })
        expect(context.worktrees.purged).toEqual([])
        expect(context.store.get('id-1')?.pendingSetup).toMatchObject({ cursor: 1 })
      })

      it('numbers the session by the catalog project that holds the directory, and by nothing outside the catalog', async () => {
        const counted = await harness()
        svnWorktree(counted, join(groupRoot, 'WebMirabiaAdmin'))
        counted.numbers.token = '015'
        successOf(await counted.lifecycle.create(adHocSpec()))
        expect(counted.numbers.calls).toEqual([{ projectPath: join(groupRoot, 'WebMirabiaAdmin') }])
        expect(counted.worktrees.calls.map((call) => call.folder)).toEqual(['015-fix'])

        const outside = await harness()
        svnWorktree(outside)
        successOf(await outside.lifecycle.create(adHocSpec()))
        expect(outside.numbers.calls).toEqual([])
        expect(outside.worktrees.calls.map((call) => call.folder)).toEqual(['fix'])

        const custom = await harness()
        svnWorktree(custom)
        successOf(await custom.lifecycle.create(adHocSpec({ number: 'i7' })))
        expect(custom.worktrees.calls.map((call) => call.folder)).toEqual(['i7-fix'])
      })

      it('answers the refusal of the owner rule and leaves nothing behind', async () => {
        const context = await harness()
        context.worktrees.placing = { ok: false, code: 'invalid-spec', detail: `${directory} lies inside a worktree; cut worktrees from the main copy` }

        expect(await context.lifecycle.create(adHocSpec())).toEqual(context.worktrees.placing)
        expect(context.numbers.calls).toEqual([])
        expect(context.worktrees.calls).toEqual([])
        expect(context.store.list()).toEqual([])
      })
    })
  })

  describe('the after chain of a Finish', () => {
    /** A worktree session that ended and is ready for its Finish. */
    function ended(overrides?: Partial<SessionRecord>): SessionRecord {
      return record('p1', {
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
        life: 'ended',
        binding: null,
        exitCode: 0,
        endedAt: 4_000,
        worktree: { worktreePath, branch: 'jamat/fix', baseCommit: 'abc123', repositoryRoot: projectRoot },
        ...overrides,
      })
    }

    async function declareAfter(context: Harness): Promise<void> {
      writeFileSync(join(projectRoot, '.worktree.json'), JSON.stringify({
        scripts: { after: [{ name: 'tests', command: 'pnpm test' }] },
      }), 'utf8')
      const declared = await context.agreement.declared(projectRoot)
      if (declared.kind !== 'read' || declared.value === null) throw new Error('the project declares nothing')
      expect(context.agreement.gate(projectRoot, declared, declared.value.hash)).toBe(null)
    }

    async function checking(): Promise<Harness & { continued: string[] }> {
      const context = await harness()
      const continued: string[] = []
      context.lifecycle.setContinueFinish((sessionId) => continued.push(sessionId))
      await context.store.put(ended())
      await declareAfter(context)
      expect(await context.lifecycle.finishChecks('p1', undefined, null)).toEqual({ kind: 'started' })
      return { ...context, continued }
    }

    async function exits(context: Harness, runId: string, exitCode: number): Promise<ReconcileChange[]> {
      context.clock.now += 1_000
      context.host.runtimes.set(runId, runtime(runId, { alive: false, exitCode, exitedAt: context.clock.now }))
      return context.lifecycle.reconcile(context.host.listing())
    }

    it('starts the check run in the worktree and shows it on the parent', async () => {
      const context = await checking()

      expect(context.store.get('id-1')).toEqual(expect.objectContaining({
        life: 'live',
        title: 'tests fix',
        commands: [{ command: 'pnpm test', cwd: worktreePath }],
        scriptOf: expect.objectContaining({ sessionId: 'p1', phase: 'after', scriptId: 'declared', name: 'tests' }),
      }))
      expect(context.scripts.infoOf(context.store.get('p1')!).scripts?.badge)
        .toMatchObject({ phase: 'after', state: 'running', text: 'checks: tests', runId: 'id-1' })
      expect(await context.lifecycle.finishChecks('p1', undefined, null)).toEqual({ kind: 'running' })
      expect(callsNamed(context.host, 'runtime.create')).toHaveLength(1)
    })

    /*
     * The verdict is read off the Host's dead runtime in the pass that marks the run's own record
     * ended, and the finisher refuses a worktree a live run of the session stands in. So the pass
     * that sees the exit only ends the run, and the next one continues the Finish, once.
     */
    it('continues the Finish once, in the pass after the run record ended', async () => {
      const context = await checking()

      expect(withoutScriptRuns(await exits(context, 'id-1', 0)))
        .toEqual([{ kind: 'mark-ended', sessionId: 'id-1', binding: { hostInstanceId: 'host-1', generation: 1 }, exitCode: 0, endedAt: 6_000 }])
      expect(context.continued).toEqual([])

      expect(withoutScriptRuns(await context.lifecycle.reconcile(context.host.listing())))
        .toEqual([{ kind: 'script-succeeded', sessionId: 'p1', gate: 'finish' }])
      expect(context.continued).toEqual(['p1'])
      expect(context.store.get('p1')?.finishChecks?.result).toMatchObject({ kind: 'passed' })

      for (let pass = 0; pass < 3; pass += 1) await context.lifecycle.reconcile(context.host.listing())
      expect(context.continued).toEqual(['p1'])
      expect(context.store.get('id-1')).toBeNull()
      expect(context.scripts.infoOf(context.store.get('p1')!).scripts?.badge)
        .toMatchObject({ phase: 'after', state: 'succeeded', text: 'checks ✓ 1.0 s' })
      expect(await context.lifecycle.finishChecks('p1', undefined, null)).toEqual({ kind: 'passed' })
    })

    it('stops the Finish on a failed check, keeps its run a row, and runs the whole chain on the next press', async () => {
      const context = await checking()

      expect(withoutScriptRuns(await exits(context, 'id-1', 1))).toEqual([
        { kind: 'script-failed', sessionId: 'p1', gate: 'finish', reason: 'the tests check exited with 1' },
        { kind: 'mark-ended', sessionId: 'id-1', binding: { hostInstanceId: 'host-1', generation: 1 }, exitCode: 1, endedAt: 6_000 },
      ])
      for (let pass = 0; pass < 3; pass += 1) await context.lifecycle.reconcile(context.host.listing())
      expect(context.continued).toEqual([])
      expect(context.reports.filter((message) => message.includes('the Finish stopped'))).toHaveLength(1)
      expect(context.store.get('id-1')?.life).toBe('ended')
      expect(context.scripts.infoOf(context.store.get('p1')!).scripts?.badge)
        .toMatchObject({ phase: 'after', state: 'failed', text: 'checks failed: tests', title: 'The tests check exited with 1' })

      expect(await context.lifecycle.finishChecks('p1', undefined, null)).toEqual({ kind: 'started' })
      expect(context.store.get('p1')?.finishChecks).toMatchObject({ runId: 'id-3', cursor: 0 })
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('id-1')).toBeNull()
      expect(context.store.get('p1')?.scriptRuns?.map((entry) => [entry.runId, entry.outcome])).toEqual([['id-1', 'failed']])
    })

    it('refuses a reopen while a check runs, and a reopen after a failure clears the chain', async () => {
      const context = await checking()

      expect(await context.lifecycle.reopen('p1')).toMatchObject({ ok: false, code: 'merge-pending' })
      await exits(context, 'id-1', 1)
      expect(context.store.get('p1')?.finishChecks?.result).toMatchObject({ kind: 'failed' })

      context.host.launchFailure = { ok: false, code: 'op-rejected', status: 400, detail: 'launch refused' }
      expect(await context.lifecycle.reopen('p1')).toMatchObject({ ok: false })
      expect(context.store.get('p1')?.finishChecks?.result).toMatchObject({ kind: 'failed' })
      expect(context.store.get('p1')?.actionHistory).toBeUndefined()
      context.host.launchFailure = null

      expect(await context.lifecycle.reopen('p1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('p1')).toEqual(expect.objectContaining({ life: 'live', finishChecks: undefined }))
      await context.lifecycle.reconcile(context.host.listing())
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('p1')?.actionHistory).toBeUndefined()
      expect(context.store.get('p1')?.scriptRuns).toBeUndefined()
      expect(existsSync(context.logs.pathOf('p1', 'id-1'))).toBe(false)
    })

    // A client restart in between: the pass is written and said, and the next press finds it.
    it('does not continue a chain an earlier client process started', async () => {
      const context = await harness()
      const continued: string[] = []
      context.lifecycle.setContinueFinish((sessionId) => continued.push(sessionId))
      await declareAfter(context)
      const declared = await context.agreement.declared(projectRoot)
      if (declared.kind !== 'read' || declared.value === null) throw new Error('the project declares nothing')
      const steps = DeclaredScripts.stepsOf(declared.value.scripts.after, { projectRoot, repositoryRoot: projectRoot, worktreePath })
      if (!steps.ok) throw new Error(steps.problem)
      await context.store.put(ended({ finishChecks: { runId: 'c1', steps: steps.steps, cursor: 0, startedAt: 4_500 } }))
      await context.store.put(record('c1', {
        life: 'ended',
        binding: null,
        exitCode: 0,
        endedAt: 4_800,
        commands: steps.steps[0].commands,
        scriptOf: { sessionId: 'p1', phase: 'after', scriptId: 'declared', name: 'tests', stepKey: steps.steps[0].key },
      }))

      expect(withoutScriptRuns(await context.lifecycle.reconcile(context.host.listing())))
        .toEqual([{ kind: 'script-succeeded', sessionId: 'p1', gate: 'finish' }])
      expect(continued).toEqual([])
      expect(context.reports).toEqual(['Session p1: its Finish checks passed; press Finish to continue'])
      expect(await context.lifecycle.finishChecks('p1', undefined, null)).toEqual({ kind: 'passed' })
    })
  })

  /**
   * A script run from its end to its history: the reconciler settles it once its record says it
   * ended, and collapses it once its gate no longer holds it.
   */
  describe('script runs after they end', () => {
    it('settles a setup that exited 0 with its log, then collapses it into its parent', async () => {
      const context = await harness()
      context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])
      await context.lifecycle.create(worktreeSpec())
      context.host.runtimes.set('id-3', runtime('id-3', { alive: false, exitCode: 0, exitedAt: 9_000 }))
      context.host.screens.set('id-3', ['Packages: +12', 'Done in 2.1s'])

      expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([
        { kind: 'retry-launch', sessionId: 'id-1', operationId: 'id-2', operation: 'create' },
        { kind: 'mark-ended', sessionId: 'id-3', binding: { hostInstanceId: 'host-1', generation: 1 }, exitCode: 0, endedAt: 9_000 },
      ])
      expect(context.store.get('id-1')?.life).toBe('live')

      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toEqual([{ kind: 'settle-script-run', runId: 'id-3' }])
      expect(context.store.get('id-1')?.scriptRuns).toEqual([expect.objectContaining({
        runId: 'id-3',
        outcome: 'succeeded',
        exitCode: 0,
        startedAt: 5_000,
        endedAt: 9_000,
        commands: ['pnpm install'],
        log: { state: 'saved', bytes: expect.any(Number), truncated: false },
      })])
      expect(readFileSync(context.logs.pathOf('id-1', 'id-3'), 'utf8')).toContain('Packages: +12\nDone in 2.1s\n')

      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toEqual([{ kind: 'collapse-script-run', runId: 'id-3' }])
      expect(context.store.get('id-3')).toBeNull()
      expect(context.host.runtimes.has('id-3')).toBe(false)
      expect(context.collapsed).toEqual([{ runId: 'id-3', parentId: 'id-1', handoff: 'parent-tab', handoffTo: 'id-1' }])
      expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
    })

    it('retains a failed setup and its log while a retry starts a run with separate history', async () => {
      const context = await harness()
      context.setup.resolution = installing([{ command: 'pnpm install', cwd: '' }])
      await context.lifecycle.create(worktreeSpec())
      context.host.runtimes.set('id-3', runtime('id-3', { alive: false, exitCode: 1, exitedAt: 9_000 }))
      context.host.screens.set('id-3', ['ERR_PNPM_FETCH_404'])

      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('id-1')?.life).toBe('ended')
      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toEqual([{ kind: 'settle-script-run', runId: 'id-3' }])
      expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
      expect(context.store.get('id-3')).toMatchObject({ life: 'ended', exitCode: 1 })
      expect(context.store.get('id-1')?.scriptRuns).toEqual([expect.objectContaining({ runId: 'id-3', outcome: 'failed', exitCode: 1 })])
      expect(readFileSync(context.logs.pathOf('id-1', 'id-3'), 'utf8')).toContain('ERR_PNPM_FETCH_404')

      expect(await context.lifecycle.retrySetup('id-1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('id-1')?.pendingSetup).toMatchObject({ setupSessionId: 'id-5', cursor: 0 })
      context.host.runtimes.set('id-5', runtime('id-5', { alive: false, exitCode: 0, exitedAt: 12_000 }))

      await context.lifecycle.reconcile(context.host.listing())
      await context.lifecycle.reconcile(context.host.listing())
      await context.lifecycle.reconcile(context.host.listing())

      expect(context.store.get('id-1')?.life).toBe('live')
      expect(context.store.get('id-1')?.scriptRuns?.map((entry) => [entry.runId, entry.outcome]))
        .toEqual([['id-3', 'failed'], ['id-5', 'succeeded']])
      expect(context.store.list().map((entry) => entry.sessionId)).toEqual(['id-1'])
      expect(readFileSync(context.logs.pathOf('id-1', 'id-3'), 'utf8')).toContain('ERR_PNPM_FETCH_404')
      expect(existsSync(context.logs.pathOf('id-1', 'id-5'))).toBe(true)
      expect(context.collapsed.map((event) => event.runId)).toEqual(['id-3', 'id-5'])
    })

    it('removes expired old script rows while retaining failed setup evidence for a worktree', async () => {
      const old = (sessionId: string, parentId: string, exitCode: number): Record<string, unknown> => ({
        sessionId,
        kind: 'shell',
        title: `Setup ${sessionId}`,
        directory: { mode: 'adHoc', path: worktreePath },
        commands: [{ command: 'pnpm install', cwd: worktreePath }],
        setupFor: parentId,
        binding: { hostInstanceId: 'host-0', generation: 1 },
        life: 'ended',
        exitCode,
        createdAt: 3_000,
        endedAt: 4_000,
      })
      const context = await harness({
        seedRecords: [
          record('pa', { life: 'ended', endedAt: 4_500 }), old('sa', 'pa', 0),
          record('pb', { life: 'ended', endedAt: 4_500 }), old('sb', 'pb', 0),
          failedWaiting({ sessionId: 'pc', pendingSetup: { setupSessionId: 'sc' } }), old('sc', 'pc', 1),
          old('sd', 'gone', 0),
        ],
      })
      await context.logs.write('gone', 'sd', 'left by a parent removed elsewhere')
      utimesSync(join(context.logsDirectory, 'gone'), 1, 1)
      context.clock.now += 2 * 86_400_000
      await context.scripts.sweep()
      expect(existsSync(join(context.logsDirectory, 'gone'))).toBe(false)

      expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([
        { kind: 'collapse-script-run', runId: 'sa' },
        { kind: 'collapse-script-run', runId: 'sb' },
        { kind: 'settle-script-run', runId: 'sc' },
        { kind: 'collapse-script-run', runId: 'sd' },
      ])
      for (const parentId of ['pa', 'pb'])
        expect(context.store.get(parentId)?.scriptRuns).toBeUndefined()
      expect(context.store.get('pc')?.scriptRuns).toEqual([expect.objectContaining({
        runId: 'sc', outcome: 'failed', exitCode: 1, log: { state: 'unavailable', reason: 'ended before this build kept logs' },
      })])
      expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
      expect(context.reports).toEqual(['1 script run was settled without a saved log; each history entry says why'])
      expect(context.store.list().map((entry) => entry.sessionId).sort()).toEqual(['pa', 'pb', 'pc', 'sc'])
    })

    it.each([true, false])('dismisses a run row and retains history only for a worktree (worktree: %s)', async (withWorktree) => {
      const context = await harness()
      const parent = failedWaiting()
      if (!withWorktree) delete parent.worktree
      await context.store.put(parent)
      await context.store.put(setupRecord({ exitCode: 1 }))

      expect(await context.lifecycle.remove('s1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('s1')).toBeNull()
      if (withWorktree)
        expect(context.store.get('p1')?.scriptRuns).toEqual([expect.objectContaining({
          runId: 's1', outcome: 'failed', exitCode: 1, log: { state: 'unavailable', reason: expect.stringContaining('capture') },
        })])
      else expect(context.store.get('p1')?.scriptRuns).toBeUndefined()
      expect(snapshotCount(context.snapshotsDirectory)).toBe(0)
    })
  })

  describe('runs a live session asks for', () => {
    /** A live session the Host runs, in the harness's own directory. */
    async function asking(context: Harness): Promise<void> {
      await context.store.put(record('p1', { directory: { mode: 'adHoc', path: context.workDirectory } }))
      context.host.runtimes.set('p1', runtime('p1'))
    }

    function ends(context: Harness, runId: string, exitCode: number, rows: string[] = []): void {
      context.host.runtimes.set(runId, runtime(runId, { alive: false, exitCode, exitedAt: 9_000 }))
      context.host.screens.set(runId, rows)
    }

    it.each(['exit', 'stop', 'host-loss'] as const)('clears saved logs on %s and reopens without old action sections', async (ending) => {
      const context = await harness()
      await asking(context)
      successOf(await context.lifecycle.runScript('p1', { command: 'pnpm test' }))
      ends(context, 'id-1', 0, ['tests passed'])
      await context.lifecycle.reconcile(context.host.listing())
      await context.lifecycle.reconcile(context.host.listing())
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('p1')?.scriptRuns).toHaveLength(1)
      expect(existsSync(context.logs.pathOf('p1', 'id-1'))).toBe(true)
      switch (ending) {
        case 'exit': ends(context, 'p1', 0); break
        case 'stop': successOf(await context.lifecycle.stop('p1')); break
        case 'host-loss': context.host.runtimes.delete('p1'); break
        default: throw new Error(`Unknown ending: ${ending satisfies never}`)
      }
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('p1')?.scriptRuns).toBeUndefined()
      expect(existsSync(context.logs.pathOf('p1', 'id-1'))).toBe(false)
      successOf(await context.lifecycle.reopen('p1'))
      expect(context.store.get('p1')?.life).toBe('live')
      expect(context.store.get('p1')?.scriptRuns).toBeUndefined()
      expect(context.store.get('p1')?.actionHistory).toBeUndefined()
    })

    it('writes the run under its parent, launches it and answers its id', async () => {
      const context = await harness()
      await asking(context)

      expect(await context.lifecycle.runScript('p1', { command: 'pnpm test', title: 'tests' }))
        .toEqual({ ok: true, value: { runId: 'id-1' } })
      expect(context.store.get('id-1')).toMatchObject({
        title: 'tests',
        life: 'live',
        scriptOf: { sessionId: 'p1', phase: 'inner', scriptId: 'requested', name: 'tests' },
      })
      expect(launchOf(callsNamed(context.host, 'runtime.create')[0]).cwd).toBe(context.workDirectory)
    })

    it('ends a run the Host refused after judging it, answers the failure and never replays it', async () => {
      const context = await harness()
      await asking(context)
      context.host.launchFailure = { ok: false, code: 'op-rejected', status: 400, detail: 'launch.cwd must exist' }

      expect(await context.lifecycle.runScript('p1', { command: 'pnpm test' }))
        .toEqual({ ok: false, code: 'op-rejected', detail: 'launch.cwd must exist' })
      expect(context.store.get('id-1')).toMatchObject({ life: 'ended', endedReason: 'launch.cwd must exist' })
      expect(context.store.get('id-1')?.pendingOperationId).toBeUndefined()

      context.host.launchFailure = null
      context.clock.now += 60_000
      await context.lifecycle.reconcile(context.host.listing())
      await context.lifecycle.reconcile(context.host.listing())
      expect(callsNamed(context.host, 'runtime.create')).toHaveLength(1)
      expect(context.store.get('p1')?.scriptRuns).toEqual([expect.objectContaining({
        runId: 'id-1',
        outcome: 'failed',
        log: { state: 'unavailable', reason: 'Jamat could not capture the output of this command' },
      })])
    })

    /*
     * The answer never came, or said "not now": the Host may run it all the same. Ended here, the run
     * would be stopped with nobody, counted by no limit and let a worktree cleanup go under it.
     */
    it('keeps a run the Host did not decide pending, binds it when the Host lists it, and never replays it', async () => {
      for (const failure of [
        { ok: false, code: 'host-unreachable', detail: 'timed out' },
        { ok: false, code: 'op-rejected', status: 429, detail: 'too many live runtimes' },
      ] as const) {
        const context = await harness()
        await asking(context)
        context.host.launchFailure = failure

        expect(await context.lifecycle.runScript('p1', { command: 'pnpm test' })).toEqual({ ok: true, value: { runId: 'id-1' } })
        expect(context.store.get('id-1')).toMatchObject({ life: 'starting', pendingOperationId: 'id-2' })
        expect(context.store.get('id-1')?.endedReason).toBeUndefined()

        context.host.launchFailure = null
        context.host.runtimes.set('id-1', runtime('id-1'))
        await context.lifecycle.reconcile(context.host.listing())
        expect(context.store.get('id-1')).toMatchObject({ life: 'live' })
        expect(callsNamed(context.host, 'runtime.create')).toHaveLength(1)
      }
    })

    it('loses a pending run the Host turns out not to have, without a replay, and settles it lost', async () => {
      const context = await harness()
      await asking(context)
      context.host.launchFailure = { ok: false, code: 'host-unreachable', detail: 'timed out' }
      successOf(await context.lifecycle.runScript('p1', { command: 'pnpm test' }))
      context.host.launchFailure = null

      // An unreachable Host has said nothing about it yet.
      expect(await context.lifecycle.reconcile(null)).toEqual([])
      expect(context.store.get('id-1')?.life).toBe('starting')

      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('id-1')?.life).toBe('lost')
      await context.lifecycle.reconcile(context.host.listing())
      expect(callsNamed(context.host, 'runtime.create')).toHaveLength(1)
      expect(context.store.get('p1')?.scriptRuns).toEqual([expect.objectContaining({ runId: 'id-1', outcome: 'lost' })])
    })

    it('settles a run that exited 0 into its parent history with its log, and collapses it at once', async () => {
      const context = await harness()
      await asking(context)
      successOf(await context.lifecycle.runScript('p1', { command: 'pnpm test', title: 'tests' }))
      ends(context, 'id-1', 0, ['Tests  12 passed'])

      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toEqual([{ kind: 'mark-ended', sessionId: 'id-1', binding: { hostInstanceId: 'host-1', generation: 1 }, exitCode: 0, endedAt: 9_000 }])
      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toEqual([{ kind: 'settle-script-run', runId: 'id-1' }])
      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toEqual([{ kind: 'collapse-script-run', runId: 'id-1' }])

      expect(context.store.get('id-1')).toBeNull()
      expect(context.store.get('p1')?.scriptRuns).toEqual([expect.objectContaining({
        runId: 'id-1',
        phase: 'inner',
        scriptId: 'requested',
        name: 'tests',
        outcome: 'succeeded',
        commands: ['pnpm test'],
        log: { state: 'saved', bytes: expect.any(Number), truncated: false },
      })])
      expect(readFileSync(context.logs.pathOf('p1', 'id-1'), 'utf8')).toContain('Tests  12 passed')
      expect(context.collapsed).toEqual([{ runId: 'id-1', parentId: 'p1', handoff: 'close', handoffTo: 'p1' }])
    })

    it('keeps a run that exited 1 until its parent asks for the next one', async () => {
      const context = await harness()
      await asking(context)
      successOf(await context.lifecycle.runScript('p1', { command: 'pnpm test' }))
      ends(context, 'id-1', 1)
      await context.lifecycle.reconcile(context.host.listing())
      await context.lifecycle.reconcile(context.host.listing())
      expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
      expect(context.store.get('id-1')?.life).toBe('ended')
      expect(context.store.get('p1')?.scriptRuns?.[0]).toMatchObject({ runId: 'id-1', outcome: 'failed', exitCode: 1 })

      context.clock.now += 1_000
      expect(await context.lifecycle.runScript('p1', { command: 'pnpm test' })).toEqual({ ok: true, value: { runId: 'id-3' } })
      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toEqual([{ kind: 'collapse-script-run', runId: 'id-1' }])
      expect(context.store.get('id-1')).toBeNull()
      expect(context.store.get('id-3')?.life).toBe('live')
    })

    it('collapses a failed run once its parent is stopped', async () => {
      const context = await harness()
      await asking(context)
      successOf(await context.lifecycle.runScript('p1', { command: 'pnpm test' }))
      ends(context, 'id-1', 1)
      await context.lifecycle.reconcile(context.host.listing())
      await context.lifecycle.reconcile(context.host.listing())

      expect(await context.lifecycle.stop('p1')).toEqual({ ok: true, value: undefined })
      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toEqual([expect.objectContaining({ kind: 'mark-ended', sessionId: 'p1' })])
      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toEqual([{ kind: 'collapse-script-run', runId: 'id-1' }])
    })

    it('stops a running run once its parent ended, then removes it without saving history', async () => {
      const context = await harness()
      await asking(context)
      successOf(await context.lifecycle.runScript('p1', { command: 'pnpm dev' }))
      context.host.runtimes.set('p1', runtime('p1', { alive: false, exitCode: 0, exitedAt: 8_000 }))

      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('p1')?.life).toBe('ended')
      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toEqual([{ kind: 'stop-script-run', runId: 'id-1' }])
      expect(context.store.get('id-1')?.stopRequested).toBe(true)
      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toEqual([expect.objectContaining({ kind: 'mark-ended', sessionId: 'id-1' })])
      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toEqual([{ kind: 'collapse-script-run', runId: 'id-1' }])
      expect(context.store.get('p1')?.scriptRuns).toBeUndefined()
      expect(existsSync(context.logs.pathOf('p1', 'id-1'))).toBe(false)
    })

    it('stops a running run in the same call that stops its parent', async () => {
      const context = await harness()
      await asking(context)
      successOf(await context.lifecycle.runScript('p1', { command: 'pnpm dev' }))

      expect(await context.lifecycle.stop('p1')).toEqual({ ok: true, value: undefined })
      expect(callsNamed(context.host, 'runtime.stop').map((call) => (call.body.target as RuntimeRef).runtimeSessionId))
        .toEqual(['p1', 'id-1'])
      expect(context.store.get('id-1')?.stopRequested).toBe(true)
      expect(context.host.runtimes.get('id-1')?.alive).toBe(false)
      expect(context.reports).toEqual([])
    })

    it('says a run it could not stop and still answers the parent stopped', async () => {
      const context = await harness()
      await asking(context)
      successOf(await context.lifecycle.runScript('p1', { command: 'pnpm dev' }))
      const stop = context.host.port.runtimeStop
      let refused = 0
      context.host.port.runtimeStop = async (target) => {
        if (target.runtimeSessionId !== 'id-1') return stop(target)
        refused += 1
        return { ok: false, code: 'op-rejected', status: 500, detail: 'did not confirm its death' }
      }

      expect(await context.lifecycle.stop('p1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('p1')?.stopRequested).toBe(true)
      // Nothing waits on its verdict: marked, a killed process reporting 0 still reads as stopped.
      expect(context.store.get('id-1')?.stopRequested).toBe(true)
      expect(context.reports).toEqual([
        'The script run id-1 could not be stopped (op-rejected: did not confirm its death); it may still be running for p1',
      ])

      // The planning asks again while the Host lists it alive, and the refusal is not said twice.
      await context.lifecycle.reconcile(context.host.listing())
      await context.lifecycle.reconcile(context.host.listing())
      expect(refused).toBe(2)
      expect(context.reports).toHaveLength(1)
    })

    // A cascade stop the Host refused leaves a process with no parent; the planning stops it after.
    it('stops a run whose parent was removed after its cascade stop was refused', async () => {
      const context = await harness()
      await asking(context)
      successOf(await context.lifecycle.runScript('p1', { command: 'pnpm dev' }))
      const stop = context.host.port.runtimeStop
      context.host.port.runtimeStop = async (target) => target.runtimeSessionId === 'id-1'
        ? { ok: false, code: 'op-rejected', status: 500, detail: 'did not confirm its death' }
        : stop(target)
      expect(await context.lifecycle.stop('p1')).toEqual({ ok: true, value: undefined })
      await context.lifecycle.reconcile(context.host.listing())
      expect(await context.lifecycle.remove('p1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('p1')).toBeNull()
      expect(context.host.runtimes.get('id-1')?.alive).toBe(true)

      context.host.port.runtimeStop = stop
      context.clock.now += 60_000
      expect(await context.lifecycle.reconcile(context.host.listing())).toContainEqual({ kind: 'stop-script-run', runId: 'id-1' })
      expect(context.host.runtimes.get('id-1')?.alive).toBe(false)
      await context.lifecycle.reconcile(context.host.listing())
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('id-1')).toBeNull()
    })

    // The gated runs keep their own rules: their gate judges them, the parent's stop does not.
    it('leaves a before and an after run of the stopped parent to their gates', async () => {
      const context = await harness()
      await asking(context)
      await context.store.put(record('s1', {
        directory: { mode: 'adHoc', path: context.workDirectory },
        scriptOf: { sessionId: 'p1', phase: 'before', scriptId: 'setup', name: 'setup' },
      }))
      await context.store.put(record('c1', {
        directory: { mode: 'adHoc', path: context.workDirectory },
        scriptOf: { sessionId: 'p1', phase: 'after', scriptId: 'declared', name: 'tests' },
      }))
      context.host.runtimes.set('s1', runtime('s1'))
      context.host.runtimes.set('c1', runtime('c1'))

      expect(await context.lifecycle.stop('p1')).toEqual({ ok: true, value: undefined })
      expect(callsNamed(context.host, 'runtime.stop').map((call) => (call.body.target as RuntimeRef).runtimeSessionId))
        .toEqual(['p1'])
      expect(context.store.get('s1')?.stopRequested).toBeUndefined()
      expect(context.store.get('c1')?.stopRequested).toBeUndefined()
    })

    // A restart is a stop and a reopen in one call; no planning pass sees the parent ended between them.
    it('leaves no old run or history across a restart without an ended reconciliation', async () => {
      const context = await harness()
      await asking(context)
      successOf(await context.lifecycle.runScript('p1', { command: 'pnpm dev' }))

      expect(await context.lifecycle.stop('p1')).toEqual({ ok: true, value: undefined })
      expect(await context.lifecycle.reopen('p1')).toEqual({ ok: true, value: undefined })
      expect(context.host.runtimes.get('p1')?.alive).toBe(true)
      expect(context.host.runtimes.get('id-1')?.alive).toBe(false)

      await context.lifecycle.reconcile(context.host.listing())
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('p1')?.life).toBe('live')
      expect(context.store.get('p1')?.scriptRuns).toBeUndefined()
      expect(context.store.get('id-1')).toBeNull()
      expect(existsSync(context.logs.pathOf('p1', 'id-1'))).toBe(false)
    })

    it('refuses a Host restart while a run is live, naming it', async () => {
      const context = await harness()
      await asking(context)
      successOf(await context.lifecycle.runScript('p1', { command: 'pnpm test', title: 'tests' }))

      const refused = failureOf(await context.lifecycle.prepareHostRestart(context.host.listing()))
      expect(refused.detail).toContain('tests (id-1): the script run tests is still running; let it finish or stop it before restarting the Host')
      // Sessions that still run hold the restart back; the request itself was well formed (UA1-J13-7).
      expect(refused.code).toBe('live-refused')
    })
  })

  /**
   * Stopping a session is the one ending the person asks for, and the mark it leaves is what every
   * reading of that ending rests on.
   */
  describe('the completed mark', () => {
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
      await context.store.put(record('a1', { kind: 'agent', agent: { agentId: 'claude', launchMode: 'new' } }))

      await context.lifecycle.stop('s1')
      await context.lifecycle.stop('a1')

      expect(context.store.get('s1')?.stopRequested).toBe(true)
      expect(context.store.get('a1')?.stopRequested).toBe(true)
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
      await context.store.put(record('setup-1', { scriptOf: { sessionId: 'primary-1', phase: 'before', scriptId: 'setup', name: 'setup' } }))
      await context.store.put(record('resolve-1', { scriptOf: { sessionId: 'primary-1', phase: 'after', scriptId: 'merge-resolve', name: 'resolver' } }))
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
      await context.store.put(record('setup-1', { scriptOf: { sessionId: 'primary-1', phase: 'before', scriptId: 'setup', name: 'setup' } }))
      await context.store.put(record('resolve-1', { scriptOf: { sessionId: 'primary-1', phase: 'after', scriptId: 'merge-resolve', name: 'resolver' } }))

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

    // A restore and a worker's liveness resume continue the lifetime, and the Keep section is drawn
    // from the outcome; only a person's Reopen starts an empty history (UA1-J14-6).
    it.each([['restore', true], ['liveness', true], ['person', false]] as const)('keeps the last worktree outcome on a %s reopen: %s', async (by, keeps) => {
      const context = await harness()
      const outcome = { result: 'not-committed' as const, revisions: [], main: 'none' as const, worktree: 'kept' as const, lines: ['Worktree kept'], at: 5 }
      await context.store.put(record('s1', { life: 'ended', binding: null, worktreeOutcome: outcome }))

      expect(await context.lifecycle.reopen('s1', by)).toEqual({ ok: true, value: undefined })
      expect(context.store.get('s1')?.worktreeOutcome).toEqual(keeps ? outcome : undefined)
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

    it('recovers the confirmed identity before reopening and rotates the launch generation', async () => {
      const context = await harness()
      await context.store.put(record('s1', {
        kind: 'agent', agent: {agentId: 'codex', launchMode: 'new', identityLaunchId: 'proof'},
        life: 'lost', binding: null,
      }))
      context.identities.set('s1', identity('s1', 'conv-1'))
      expect(await context.lifecycle.reopen('s1')).toEqual({ok: true, value: undefined})
      expect(context.store.get('s1')?.agent).toMatchObject({
        nativeSessionId: 'conv-1', nativeSessionIdSource: 'codex-app-server', identityLaunchId: 'id-1',
      })
      expect(launchOf(callsNamed(context.host, 'runtime.create')[0]).args.slice(-2)).toEqual(['resume', 'conv-1'])
    })

    it('recovers a receipt after restart without any launch-time window', async () => {
      const context = await harness()
      await context.store.put(record('s1', {
        kind: 'agent', agent: {agentId: 'codex', launchMode: 'new', identityLaunchId: 'proof'},
        life: 'lost', binding: null, createdAt: -9_000_000,
      }))
      context.identities.set('s1', identity('s1', 'conv-1'))
      await context.lifecycle.nameConversationsOnStartup()
      expect(context.store.get('s1')?.agent?.nativeSessionId).toBe('conv-1')
    })

    it('keeps legacy records unnamed even when a receipt was supplied without a launch generation', async () => {
      const context = await harness()
      await context.store.put(record('s1', {
        kind: 'agent', agent: {agentId: 'codex', launchMode: 'new'}, life: 'lost', binding: null,
      }))
      context.identities.set('s1', identity('s1', 'conv-1'))
      await context.lifecycle.nameConversationsOnStartup()
      expect(context.store.get('s1')?.agent?.nativeSessionId).toBeUndefined()
      expect(failureOf(await context.lifecycle.reopen('s1')).code).toBe('invalid-spec')
      expect(callsNamed(context.host, 'runtime.create')).toEqual([])
    })

    it('persists the final identity when the terminal exits before the next live reconciliation', async () => {
      const context = await harness()
      context.host.runtimes.set('s1', {...runtime('s1'), alive: false, exitCode: 0, exitedAt: 1500})
      await context.store.put(record('s1', {
        kind: 'agent', agent: {agentId: 'codex', launchMode: 'new', identityLaunchId: 'proof'},
      }))
      context.identities.set('s1', identity('s1', 'conv-final', 2))
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('s1')).toMatchObject({life: 'ended', agent: {
        nativeSessionId: 'conv-final', nativeSessionIdSource: 'codex-app-server', identitySequence: 2,
      }})
    })

    it('updates a running conversation after clear and ignores an older receipt', async () => {
      const context = await harness()
      context.host.runtimes.set('s1', runtime('s1'))
      await context.store.put(record('s1', {
        kind: 'agent', agent: {agentId: 'codex', launchMode: 'new', identityLaunchId: 'proof'},
      }))
      context.identities.set('s1', identity('s1', 'conv-1'))
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('s1')?.agent?.nativeSessionId).toBe('conv-1')
      context.identities.set('s1', identity('s1', 'conv-2', 2))
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('s1')?.agent?.nativeSessionId).toBe('conv-2')
      context.identities.set('s1', identity('s1', 'conv-1'))
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('s1')?.agent?.nativeSessionId).toBe('conv-2')
    })
  })

  /**
   * Claude Code 2.1.304 was started with `--session-id` and wrote its conversation under another id;
   * a resume of the launched id found no conversation (UA1-J14-1). The status line relay of THAT
   * launch reports the id Claude really runs, and only that report names the conversation.
   */
  describe('the conversation a running Claude reports', () => {
    function claudeRecord(overrides?: Partial<SessionRecord>): SessionRecord {
      return record('s1', { kind: 'agent', agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 's1', identityLaunchId: 'proof' }, ...overrides })
    }

    it('binds an interactive Claude launch to a generation and hands it to the status line', async () => {
      const context = await harness()
      context.statusLine.file = join(context.workDirectory, 'settings-relay.json')
      const sessionId = successOf(await context.lifecycle.create({
        kind: 'agent', directory: { mode: 'adHoc', path: context.workDirectory }, agent: { agentId: 'claude', mode: 'new' },
      })).sessionId
      const launchId = context.store.get(sessionId)?.agent?.identityLaunchId
      expect(launchId).toEqual(expect.any(String))
      expect(context.statusLine.identities).toEqual([{ sessionId, launchId }])
    })

    it('adopts the conversation the running Claude reported for its launch and resumes that one', async () => {
      const context = await harness()
      await context.store.put(claudeRecord({ life: 'lost', binding: null }))
      context.claudeIdentities.set('s1', { launchId: 'proof', nativeSessionId: 'real-1', sequence: 5 })
      expect(await context.lifecycle.reopen('s1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('s1')?.agent).toMatchObject({
        nativeSessionId: 'real-1', nativeSessionIdSource: 'claude-statusline', identityLaunchId: 'id-1',
      })
      expect(launchOf(callsNamed(context.host, 'runtime.create')[0]).args.slice(-2)).toEqual(['--resume', 'real-1'])
    })

    it.each(['live', 'lost'] as const)('keeps confirming the original launch after a failed account switch while %s', async life => {
      const context = await harness()
      await context.store.put(claudeRecord({ life, endedReason: 'stop refused',
        agent: { agentId: 'claude', launchMode: 'new', accountId: 'b', launchAccountId: 'a',
          nativeSessionId: 'old-conversation', identityLaunchId: 'proof' } }))
      context.claudeIdentities.set('s1', { launchId: 'proof', nativeSessionId: 'latest-conversation', sequence: 5 })
      if (life === 'live') {
        context.host.runtimes.set('s1', runtime('s1'))
        await context.lifecycle.reconcile(context.host.listing())
        expect(context.store.get('s1')?.agent?.launchAccountId).toBe('a')
      }
      else if (life === 'lost') {
        expect(await context.lifecycle.reopen('s1')).toEqual({ ok: true, value: undefined })
        expect(context.store.get('s1')?.agent?.launchAccountId).toBe('b')
        expect(launchOf(callsNamed(context.host, 'runtime.create')[0]).args.slice(-2)).toEqual(['--resume', 'latest-conversation'])
      }
      else throw new Error(`Unknown session life: ${life}`)
      expect(context.store.get('s1')?.agent?.nativeSessionId).toBe('latest-conversation')
    })

    it.each(['live', 'ended', 'missing'] as const)('confirms a retained launch with matching account selection before its runtime becomes %s', async runtimeState => {
      const context = await harness()
      await context.store.put(claudeRecord({ life: 'live', endedReason: 'earlier stop refused',
        agent: { agentId: 'claude', launchMode: 'new', accountId: 'a', launchAccountId: 'a',
          nativeSessionId: 'old-conversation', identityLaunchId: 'proof' } }))
      context.claudeIdentities.set('s1', { launchId: 'proof', nativeSessionId: 'final-conversation', sequence: 5 })
      if (runtimeState === 'live') context.host.runtimes.set('s1', runtime('s1'))
      else if (runtimeState === 'ended') context.host.runtimes.set('s1', runtime('s1', { alive: false, exitedAt: 2000, exitCode: 0 }))
      else if (runtimeState === 'missing') context.host.runtimes.delete('s1')
      else throw new Error(`Unknown runtime state: ${runtimeState}`)
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('s1')?.agent?.nativeSessionId).toBe('final-conversation')
      if (runtimeState === 'ended' || runtimeState === 'missing') {
        expect(await context.lifecycle.reopen('s1')).toEqual({ ok: true, value: undefined })
        const launch = context.host.calls.find(call => call.name === 'runtime.create' || call.name === 'runtime.replace')!
        expect(launchOf(launch).args.slice(-2)).toEqual(['--resume', 'final-conversation'])
      }
      else if (runtimeState !== 'live') throw new Error(`Unknown runtime state: ${runtimeState}`)
    })

    it.each([undefined, 'a'])('rejects a late receipt on an ordinary ended record with launch account %s', async launchAccountId => {
      const context = await harness()
      await context.store.put(claudeRecord({ life: 'ended', endedReason: 'launch refused',
        agent: { agentId: 'claude', launchMode: 'new', accountId: 'a', launchAccountId,
          nativeSessionId: 'saved-conversation', identityLaunchId: 'proof' } }))
      context.claudeIdentities.set('s1', { launchId: 'proof', nativeSessionId: 'late-conversation', sequence: 5 })
      expect(await context.lifecycle.reopen('s1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('s1')?.agent?.nativeSessionId).toBe('saved-conversation')
      expect(launchOf(callsNamed(context.host, 'runtime.create')[0]).args.slice(-2)).toEqual(['--resume', 'saved-conversation'])
    })

    it('never adopts a report of another launch generation', async () => {
      const context = await harness()
      await context.store.put(claudeRecord({ life: 'lost', binding: null }))
      context.claudeIdentities.set('s1', { launchId: 'earlier', nativeSessionId: 'other', sequence: 5 })
      expect(await context.lifecycle.reopen('s1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('s1')?.agent?.nativeSessionIdSource).toBeUndefined()
      expect(launchOf(callsNamed(context.host, 'runtime.create')[0]).args.slice(-2)).toEqual(['--resume', 's1'])
    })

    it('follows a running Claude to the conversation it moved to, and ignores an older report', async () => {
      const context = await harness()
      context.host.runtimes.set('s1', runtime('s1'))
      await context.store.put(claudeRecord())
      context.claudeIdentities.set('s1', { launchId: 'proof', nativeSessionId: 's1', sequence: 1 })
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('s1')?.agent).toMatchObject({ nativeSessionId: 's1', nativeSessionIdSource: 'claude-statusline' })
      context.claudeIdentities.set('s1', { launchId: 'proof', nativeSessionId: 'real-1', sequence: 2 })
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('s1')?.agent?.nativeSessionId).toBe('real-1')
      context.claudeIdentities.set('s1', { launchId: 'proof', nativeSessionId: 's1', sequence: 1 })
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('s1')?.agent?.nativeSessionId).toBe('real-1')
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
        accountId: 'main',
        launchMode: 'fork',
        forkParentId: 'native-1',
        nativeSessionId: expect.stringMatching(/^id-\d+$/) as unknown as string,
        identityLaunchId: expect.any(String) as unknown as string,
      })
      expect(argsOf(context).slice(-2))
        .toEqual(['--session-id', child?.agent?.nativeSessionId])
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
    it('reads a Codex identity receipt before forking', async () => {
      const context = await harness()
      context.identities.set('s1', identity('s1', 'conv-1'))
      await context.store.put(record('s1', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'new', identityLaunchId: 'proof' },
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
    it('names a Codex fork from its confirmed receipt', async () => {
      const context = await harness()
      context.identities.set('f1', identity('f1', 'conv-2'))
      await context.store.put(record('f1', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'fork', forkParentId: 'conv-1', identityLaunchId: 'proof' },
        directory: { mode: 'adHoc', path: context.workDirectory },
        life: 'live',
        createdAt: 5_000,
      }))

      await context.lifecycle.nameConversationsOnStartup()

      expect(context.store.get('f1')?.agent?.nativeSessionId).toBe('conv-2')
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
      context.identities.set('f1', identity('f1', 'conv-2'))
      await context.store.put(record('f1', {
        kind: 'agent',
        agent: { agentId: 'codex', launchMode: 'fork', forkParentId: 'conv-1', identityLaunchId: 'proof' },
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
        scriptOf: { sessionId: 's1', phase: 'after', scriptId: 'merge-resolve', name: 'resolver' },
      }))

      expect(failureOf(await context.lifecycle.forkFrom('r1')).code).toBe('invalid-spec')
      expect(callsNamed(context.host, 'runtime.create')).toEqual([])
    })

    // A run works for its parent, so neither a fork nor a reopen of one is anybody's to ask for.
    it('refuses to fork or reopen any script run, and names the run as the reason', async () => {
      const context = await harness()
      await context.store.put(record('r1', {
        kind: 'agent',
        life: 'ended',
        agent: {
          agentId: 'claude', launchMode: 'fork', forkParentId: 'native-1', nativeSessionId: 'native-2',
        },
        directory: { mode: 'adHoc', path: context.workDirectory },
        scriptOf: { sessionId: 's1', phase: 'after', scriptId: 'merge-resolve', name: 'resolver' },
      }))
      await context.store.put(record('setup-1', {
        life: 'ended',
        directory: { mode: 'adHoc', path: context.workDirectory },
        commands: [{ command: 'pnpm install', cwd: context.workDirectory }],
        scriptOf: { sessionId: 's1', phase: 'before', scriptId: 'setup', name: 'setup' },
      }))

      for (const id of ['r1', 'setup-1']) {
        const forked = failureOf(await context.lifecycle.forkFrom(id))
        expect(forked.code).toBe('invalid-spec')
        expect(forked.detail).toContain('script run for s1')
        const reopened = failureOf(await context.lifecycle.reopen(id))
        expect(reopened.code).toBe('invalid-spec')
        expect(reopened.detail).toContain('a run is started by its flow')
      }
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

    it('forks an ended conversation when explicitly requested, preserving the parent', async () => {
      for (const agentId of ['claude', 'codex'] as const) {
        const context = await harness()
        await context.store.put(record('parent', {
          kind: 'agent', title: '014 - Existing task',
          directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
          agent: { agentId, launchMode: 'resume', nativeSessionId: 'native-1' },
          life: 'ended', binding: null,
        }))
        const opened = successOf(await context.lifecycle.openHistory({ ...spec(agentId, 'native-1'), action: 'fork' }))
        expect(opened.sessionId).not.toBe('parent')
        expect(context.store.get('parent')?.life).toBe('ended')
        expect(context.store.get(opened.sessionId)?.agent).toMatchObject({ agentId, launchMode: 'fork', forkParentId: 'native-1' })
      }
    })

    it('refuses explicit rerun if the provider or a newly running record owns the conversation', async () => {
      const provider = await harness()
      expect(failureOf(await provider.lifecycle.openHistory({ ...spec('claude', 'native-1', true), action: 'rerun' })).code).toBe('invalid-spec')
      expect(provider.store.list()).toHaveLength(0)
      const local = await harness()
      await local.store.put(record('running', {
        kind: 'agent', directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
        agent: { agentId: 'codex', launchMode: 'resume', nativeSessionId: 'native-1' }, life: 'live',
      }))
      expect(failureOf(await local.lifecycle.openHistory({ ...spec('codex', 'native-1'), action: 'rerun' })).code).toBe('invalid-spec')
      expect(local.store.list()).toHaveLength(1)
    })

    it('resumes an ended Claude or Codex conversation by its exact id', async () => {
      for (const agentId of ['claude', 'codex'] as const) {
        const context = await harness()
        const opened = successOf(await context.lifecycle.openHistory(spec(agentId, 'native-1')))
        expect(context.store.get(opened.sessionId)?.agent).toEqual({
          agentId,
          accountId: 'main',
          launchMode: 'resume',
          nativeSessionId: 'native-1',
          ...(agentId === 'codex' ? {nativeSessionIdSource: 'provided'} : {}),
          identityLaunchId: 'id-2',
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
        accountId: 'main',
        launchMode: 'fork',
        forkParentId: 'native-1',
        nativeSessionId: expect.stringMatching(/^id-\d+$/) as unknown as string,
        identityLaunchId: expect.any(String) as unknown as string,
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
            accountId: 'main',
            launchMode: 'fork',
            forkParentId: 'native-1',
            nativeSessionId: expect.stringMatching(/^id-\d+$/) as unknown as string,
            identityLaunchId: expect.any(String) as unknown as string,
          })
          expect(context.store.get(opened.sessionId)?.title).toBe('014-015 - Existing task')
        }
      })

    it('captures a live Codex record before deciding to fork its conversation', async () => {
      const context = await harness()
      context.identities.set('s1', identity('s1', 'conv-1'))
      await context.store.put(record('s1', {
        kind: 'agent',
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
        agent: { agentId: 'codex', launchMode: 'new', identityLaunchId: 'proof' },
        life: 'live',
        createdAt: 5_000,
      }))

      const opened = successOf(await context.lifecycle.openHistory(spec('codex', 'conv-1')))
      expect(context.store.get('s1')?.agent?.nativeSessionId).toBe('conv-1')
      expect(context.store.get(opened.sessionId)?.agent).toEqual({
        agentId: 'codex',
        accountId: 'main',
        launchMode: 'fork',
        forkParentId: 'conv-1',
        identityLaunchId: 'id-2',
      })
    })

    it('returns the exact local tree title and captures a missing Codex id first', async () => {
      const context = await harness()
      context.identities.set('s1', identity('s1', 'conv-1'))
      await context.store.put(record('s1', {
        kind: 'agent',
        title: '014 - Existing Codex task',
        directory: { mode: 'project', categoryId: 'c1', projectPath: projectRoot },
        agent: { agentId: 'codex', launchMode: 'new', identityLaunchId: 'proof' },
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
        endedAt: null,
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
    it.each(['colour', 'note', 'name'] as const)('preserves a queued SVN journal when changing the %s', async (field) => {
      const context = await harness()
      await context.store.put(record('s1', { title: '014 - old' }))
      const journal = [{ stepId: 'checkout', kind: 'checkout' as const, attempt: 1, startedAt: 10, runId: 'checkout-run' }]
      const checkout = context.store.update('s1', (current) => ({ ...current, title: '015 - current',
        worktreeLifecycle: { version: 1, actionId: null, phase: 'active', outOfDate: 0, journal,
          facts: { worker: { liveness: 'alive', resumeFailures: 0 } } } }))
      const changed = field === 'colour' ? context.lifecycle.setColor('s1', 'teal')
        : context.lifecycle.setDetails('s1', field === 'note' ? { note: 'task attempt' } : { name: 'renamed' })
      expect(await checkout).toBe(true)
      expect((await changed).ok).toBe(true)
      const saved = context.store.get('s1')!
      expect(saved.worktreeLifecycle).toMatchObject({ version: 1, journal })
      expect(saved.title).toBe(field === 'name' ? '015 - renamed' : '015 - current')
      if (field === 'colour') expect(saved.color).toBe('teal')
      else if (field === 'note') expect(saved.note).toBe('task attempt')
      else if (field !== 'name') throw new Error(`Unknown metadata: ${field}`)
      expect(JSON.parse(readFileSync(context.recordsFile, 'utf8')).records).toContainEqual(saved)
    })

    it('writes the name, the note and the colour as one record', async () => {
      const context = await harness()
      await context.store.put(record('s1', { title: '014 - staré' }))
      const updates = vi.spyOn(context.store, 'update')

      expect(successOf(await context.lifecycle.setDetails('s1', {
        name: 'nové',
        note: 'why this one exists',
        color: 'teal',
      }))).toEqual({ titleChanged: true, notifyAgent: null })
      expect(updates).toHaveBeenCalledTimes(1)
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
      expect(refused.detail)
        .toBe('A name must not begin like a session number, and "2026" reads as one')
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

      successOf(await context.lifecycle.setDetails('s1', { name: 'session s1', note: null, color: null }))
      successOf(await context.lifecycle.setDetails('s2', { name: 'session s2', note: '', color: null }))
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
      expect(context.store.get('s1')?.title).toBe('session s1')
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
      expect(context.store.get('s1')?.title).toBe('session s1')
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
        { sessionId: 'resolve-1', oneShot: true, scriptOf: { sessionId: 's1', phase: 'after', scriptId: 'merge-resolve', name: 'resolver' } },
      )

      const args = agentArgsOf(launchOf(callsNamed(context.host, 'runtime.create')[0]))
      expect(args[0]).toBe(claudeFlagConst)
      expect(args).toContain('-p')
      expect(args.at(-1)).toBe('resolve it')
      expect(context.seeded).toEqual([context.workDirectory])
    })

    // The SVN resolver edits files and runs nothing, so its own mode wins over the setting.
    it('starts the SVN resolver in accept-edits mode without YOLO, and keeps the mode for a replay', async () => {
      const context = await harness()
      context.yolo.add('claude')

      await context.lifecycle.createInternal(
        {
          kind: 'agent',
          directory: { mode: 'adHoc', path: context.workDirectory },
          agent: { agentId: 'claude', mode: 'new', initialPrompt: 'resolve it' },
        },
        { sessionId: 'resolve-3', oneShot: true, permission: 'accept-edits', scriptOf: { sessionId: 's1', phase: 'after', scriptId: 'svn-resolve', name: 'resolver' } },
      )

      const args = agentArgsOf(launchOf(callsNamed(context.host, 'runtime.create')[0]))
      expect(args).not.toContain(claudeFlagConst)
      expect(args.slice(0, 5)).toEqual(['--disallowedTools', 'Bash', '--permission-mode', 'acceptEdits', '-p'])
      expect(args.at(-1)).toBe('resolve it')
      expect(context.store.get('resolve-3')?.agent).toMatchObject({ oneShot: true, permission: 'accept-edits' })
    })

    // The merger is interactive: the status line relay like any interactive Claude, its rights, no -p, no YOLO.
    it('starts the SVN merger interactive with its rights and the settings file, never with YOLO, and replays it the same', async () => {
      const context = await harness()
      context.yolo.add('claude')
      context.statusLine.file = join(context.workDirectory, 'settings-relay.json')

      await context.lifecycle.createInternal(
        {
          kind: 'agent',
          directory: { mode: 'adHoc', path: context.workDirectory },
          agent: { agentId: 'claude', mode: 'new', initialPrompt: 'merge it' },
        },
        { sessionId: 'merge-1', permission: 'merger', scriptOf: { sessionId: 's1', phase: 'after', scriptId: 'svn-merge', name: 'merger' } },
      )

      const args = agentArgsOf(launchOf(callsNamed(context.host, 'runtime.create')[0]))
      expect(args).not.toContain(claudeFlagConst)
      expect(args).not.toContain('-p')
      expect(args).toContain('--settings')
      expect(args).toContain('--allowedTools')
      // This client's own CLI line, never the person's ~/.claude skill (UA1-J14-9).
      expect(args).toContain('Bash(node "C:/Jamat/skills/claude/appjamat-v3/scripts/jamat-v3.mjs" sessions resolve-conflict:*)')
      expect(args.slice(args.indexOf('--disallowedTools'), args.indexOf('--disallowedTools') + 5))
        .toEqual(['--disallowedTools', 'Bash(svn:*)', 'Bash(svnadmin:*)', '--permission-mode', 'acceptEdits'])
      expect(args.at(-1)).toBe('merge it')
      const stored = context.store.get('merge-1')?.agent
      expect(stored?.permission).toBe('merger')
      expect(stored?.oneShot).toBeUndefined()
      expect(AgentPresets.replayArgs(stored!, 'node "C:/Jamat/cli.mjs"')).not.toContain('-p')
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
        { sessionId: 'resolve-2', oneShot: true, scriptOf: { sessionId: 's1', phase: 'after', scriptId: 'merge-resolve', name: 'resolver' } },
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
        scriptOf: { sessionId: 'm1', phase: 'after', scriptId: 'merge-resolve', name: 'resolver' },
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

      expect(withoutScriptRuns(await context.lifecycle.reconcile(context.host.listing())))
        .toEqual([{ kind: 'script-succeeded', sessionId: 'm1', gate: 'merge' }])

      expect(context.resumed).toEqual(['m1'])
    })

    it('writes the reason on a resolver that failed, and keeps the phase', async () => {
      const context = await harness()
      await context.store.put(merging())
      await context.store.put(resolver({ exitCode: 1 }))

      expect(withoutScriptRuns(await context.lifecycle.reconcile(context.host.listing()))).toEqual([{
        kind: 'script-failed',
        sessionId: 'm1',
        gate: 'merge',
        reason: 'the resolver ended with 1',
      }])

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

    /** What `WorktreeMergeFlow.clearWorktree` writes once the branch landed: the pointer goes with the worktree. */
    async function landMerge(context: Harness): Promise<void> {
      const current = context.store.get('m1')
      if (!current) throw new Error('the merging session is gone')
      const landed: SessionRecord = { ...current, completed: true }
      delete landed.worktree
      delete landed.worktreeMerge
      await context.store.put(landed)
    }

    /** A resolver the Host ran, so its output is there to be saved when it settles. */
    async function hostedResolver(context: Harness, exitCode: number): Promise<void> {
      await context.store.put(resolver({ binding: { hostInstanceId: 'host-1', generation: 1 }, exitCode, endedAt: 9_000 }))
      context.host.runtimes.set('r1', runtime('r1', { alive: false, exitCode, exitedAt: 9_000 }))
      context.host.screens.set('r1', ['Resolved 1 conflict', 'Committed'])
    }

    it('keeps resolver output until the merge lands, then clears the ended session history', async () => {
      const context = await harness()
      await context.store.put(merging())
      await hostedResolver(context, 0)

      expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([
        { kind: 'script-succeeded', sessionId: 'm1', gate: 'merge' },
        { kind: 'settle-script-run', runId: 'r1' },
      ])
      expect(context.store.get('m1')?.scriptRuns).toEqual([expect.objectContaining({
        runId: 'r1', phase: 'after', scriptId: 'merge-resolve', name: 'resolver', outcome: 'succeeded', exitCode: 0,
        log: { state: 'saved', bytes: expect.any(Number), truncated: false },
      })])
      // Still named by a gate that judges: the merge it was resolving has not landed yet.
      expect(context.store.get('r1')).not.toBeNull()
      expect(context.collapsed).toEqual([])

      await landMerge(context)

      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toEqual([{ kind: 'collapse-script-run', runId: 'r1' }])
      expect(context.store.get('r1')).toBeNull()
      expect(context.host.runtimes.has('r1')).toBe(false)
      expect(context.store.get('m1')?.scriptRuns).toBeUndefined()
      expect(existsSync(context.logs.pathOf('m1', 'r1'))).toBe(false)
      // The resolver's tab closes rather than handing over: nothing of the parent's belongs in it.
      expect(context.collapsed).toEqual([{ runId: 'r1', parentId: 'm1', handoff: 'close', handoffTo: 'm1' }])
    })

    /*
     * The Host reports the exit before the record says so, and the merge refuses a worktree whose
     * resolver record still reads live. Resumed in that pass, the merge wrote "stop it first" as its
     * failure over a resolver that had succeeded; the smoke met exactly that.
     */
    it('resumes the merge only once the resolver record itself has ended', async () => {
      const context = await harness()
      await context.store.put(merging())
      await context.store.put(resolver({ life: 'live', binding: { hostInstanceId: 'host-1', generation: 1 }, exitCode: undefined }))
      context.host.runtimes.set('r1', runtime('r1', { alive: false, exitCode: 0, exitedAt: 9_000 }))

      const first = await context.lifecycle.reconcile(context.host.listing())
      expect(first).toContainEqual(expect.objectContaining({ kind: 'mark-ended', sessionId: 'r1', exitCode: 0 }))
      expect(first.some((change) => change.kind === 'script-succeeded')).toBe(false)
      expect(context.resumed).toEqual([])

      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toContainEqual({ kind: 'script-succeeded', sessionId: 'm1', gate: 'merge' })
      expect(context.resumed).toEqual(['m1'])
    })

    it('collapses a succeeded resolver once the resumed merge wrote a later failure', async () => {
      const context = await harness()
      await context.store.put(merging())
      await hostedResolver(context, 0)
      await context.lifecycle.reconcile(context.host.listing())

      // What the resumed merge writes when the conflict outlived the resolver; the pointer stays.
      const current = context.store.get('m1')
      if (!current?.worktreeMerge) throw new Error('the merge is gone')
      await context.store.put({
        ...current,
        worktreeMerge: { ...current.worktreeMerge, failure: 'the resolver finished and the conflict is still there' },
      })

      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toEqual([{ kind: 'collapse-script-run', runId: 'r1' }])
      expect(context.store.get('m1')?.worktreeMerge?.resolveSessionId).toBe('r1')
      expect(context.collapsed).toEqual([{ runId: 'r1', parentId: 'm1', handoff: 'close', handoffTo: 'm1' }])
    })

    it('keeps a failed resolver as a row while its merge waits, and lets it go when the merge lands', async () => {
      const context = await harness()
      await context.store.put(merging())
      await hostedResolver(context, 1)

      expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([
        { kind: 'script-failed', sessionId: 'm1', gate: 'merge', reason: 'the resolver exited with 1' },
        { kind: 'settle-script-run', runId: 'r1' },
      ])
      expect(context.store.get('m1')?.worktreeMerge?.failure).toBe('the resolver exited with 1')
      expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
      expect(context.store.get('r1')).not.toBeNull()
      expect(context.store.get('m1')?.scriptRuns?.map((entry) => [entry.runId, entry.outcome])).toEqual([['r1', 'failed']])

      // Resolved by hand and merged again: the pointer goes with the worktree, and so does the row.
      await landMerge(context)

      expect(await context.lifecycle.reconcile(context.host.listing()))
        .toEqual([{ kind: 'collapse-script-run', runId: 'r1' }])
      expect(context.collapsed).toEqual([{ runId: 'r1', parentId: 'm1', handoff: 'close', handoffTo: 'm1' }])
    })

    /*
     * Finding 024 (a), carried through the judgement: a stopped resolver is killed, and the fake Host
     * reports the 0 a POSIX platform gives a signalled process. The mark is what keeps that from
     * reading as a clean resolution and resuming the merge over a half-resolved tree.
     */
    it('judges a resolver somebody stopped as failed, whatever its exit code', async () => {
      const context = await harness()
      await context.store.put(merging())
      await context.store.put(resolver({ life: 'live', binding: { hostInstanceId: 'host-1', generation: 1 }, exitCode: undefined }))
      context.host.runtimes.set('r1', runtime('r1'))

      expect(await context.lifecycle.stop('r1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('r1')?.stopRequested).toBe(true)
      expect(context.host.runtimes.get('r1')?.exitCode).toBe(0)

      const applied = await context.lifecycle.reconcile(context.host.listing())
      await context.lifecycle.reconcile(context.host.listing())

      expect(applied).toContainEqual({ kind: 'script-failed', sessionId: 'm1', gate: 'merge', reason: 'its resolver was stopped' })
      expect(context.resumed).toEqual([])
      expect(context.store.get('m1')?.worktreeMerge?.failure).toBe('its resolver was stopped')
      expect(context.store.get('m1')?.scriptRuns?.map((entry) => [entry.runId, entry.outcome])).toEqual([['r1', 'stopped']])
      expect(context.store.get('r1')).not.toBeNull()
    })

    /*
     * Finding 024 (b), carried through the reconciler: an undecided launch leaves the resolver's
     * record pending, the flow keeps its pointer, and the replay is what follows - not a judgement
     * that the run is lost, and not an orphan rule taking it away.
     */
    it('replays a resolver whose launch the Host never decided, under the pointer the merge kept', async () => {
      const context = await harness()
      await context.store.put(merging({ worktreeMerge: { phase: 'resolving', resolveSessionId: 'resolve-9', startedAt: 1 } }))
      context.host.launchFailure = { ok: false, code: 'host-unreachable', detail: 'no descriptor' }

      const refused = await context.lifecycle.createInternal(
        {
          kind: 'agent',
          directory: { mode: 'adHoc', path: context.workDirectory },
          agent: { agentId: 'claude', mode: 'new', initialPrompt: 'resolve it' },
        },
        { sessionId: 'resolve-9', oneShot: true, scriptOf: SessionScriptDefinitions.linkOf('m1', 'after', 'merge-resolve', 'resolver') },
      )
      expect(refused.ok).toBe(false)
      expect(context.store.get('resolve-9')?.life).toBe('starting')

      context.host.launchFailure = null
      const applied = await context.lifecycle.reconcile(context.host.listing())

      expect(applied).toContainEqual(expect.objectContaining({ kind: 'retry-launch', sessionId: 'resolve-9' }))
      expect(applied.some((change) => change.kind === 'script-failed')).toBe(false)
      expect(context.store.get('resolve-9')?.life).toBe('live')
      expect(context.store.get('m1')?.worktreeMerge?.resolveSessionId).toBe('resolve-9')
    })

    it('takes an ended resolver with its parent in the one removal a landed Finish makes', async () => {
      const context = await harness()
      await context.store.put(merging())
      await hostedResolver(context, 0)
      await context.lifecycle.reconcile(context.host.listing())
      await landMerge(context)

      expect(await context.lifecycle.remove('m1')).toEqual({ ok: true, value: undefined })

      expect(context.store.list()).toEqual([])
      expect(context.host.runtimes.has('r1')).toBe(false)
      expect(existsSync(join(context.logsDirectory, 'm1'))).toBe(false)
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
        { sessionId: 'resolve-9', oneShot: true, scriptOf: { sessionId: 'm1', phase: 'after', scriptId: 'merge-resolve', name: 'resolver' } },
      )

      expect(successOf(answer).sessionId).toBe('resolve-9')
      const written = context.store.get('resolve-9')
      expect(written?.scriptOf).toEqual({ sessionId: 'm1', phase: 'after', scriptId: 'merge-resolve', name: 'resolver' })
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
      expect(written?.scriptOf).toBeUndefined()
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
        { sessionId: 'resolve-1', oneShot: true, scriptOf: { sessionId: 's1', phase: 'after', scriptId: 'merge-resolve', name: 'resolver' } },
      )

      const args = agentArgsOf(launchOf(callsNamed(context.host, 'runtime.create')[0]))
      expect(args.slice(0, 4)).toEqual(['--model', 'opus', '--effort', 'high'])
      expect(args).toContain('-p')
      expect(args.at(-1)).toBe('resolve it')
    })
  })

  /*
   * A session's conversation ran in its worktree. Once that directory is gone, the only other
   * directory a launch could use is the project's main copy, which is not where the work was.
   */
  describe('the Claude status line relay', () => {
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

    it('starts a Claude session with the settings file, asked for the session directory', async () => {
      const context = await harness()
      context.statusLine.file = join(context.workDirectory, 'settings-relay.json')
      await created(context, 'claude')
      expect(agentArgsOf(launchOf(callsNamed(context.host, 'runtime.create')[0])).slice(0, 2))
        .toEqual(['--settings', join(context.workDirectory, 'settings-relay.json')])
      expect(context.statusLine.cwds).toEqual([context.workDirectory])
    })

    // The window is read off the running process, so a resumed conversation needs it as much.
    it('starts a reopened Claude session with it too', async () => {
      const context = await harness()
      context.statusLine.file = join(context.workDirectory, 'settings-relay.json')
      const sessionId = await created(context, 'claude')
      await context.lifecycle.stop(sessionId)
      expect(await context.lifecycle.reopen(sessionId)).toEqual({ ok: true, value: undefined })
      const call = [...callsNamed(context.host, 'runtime.create'),
        ...callsNamed(context.host, 'runtime.replace')].at(-1)!
      expect(agentArgsOf(launchOf(call))).toContain('--settings')
    })

    it('leaves the launch alone when there is no relay, and never asks for Codex', async () => {
      const context = await harness()
      await created(context, 'claude')
      expect(agentArgsOf(launchOf(callsNamed(context.host, 'runtime.create')[0]))).not.toContain('--settings')
      context.statusLine.file = join(context.workDirectory, 'settings-relay.json')
      context.statusLine.cwds.length = 0
      await created(context, 'codex')
      expect(agentArgsOf(launchOf(callsNamed(context.host, 'runtime.create')[1]))).not.toContain('--settings')
      expect(context.statusLine.cwds).toEqual([])
    })
  })

  describe('a session whose worktree is gone', () => {
    const revision = 'https://svn.example.test/repos/app:r42'

    function tombstone(context: Harness): SessionRecord {
      return record('s1', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
        directory: { mode: 'project', categoryId: 'c1', projectPath: context.workDirectory },
        life: 'ended',
        binding: null,
        completed: true,
        retiredWorktree: {
          worktreePath: join(context.workDirectory, '.worktrees', '014-fix'),
          kind: 'svn',
          revisions: [revision],
          removedAt: 5,
        },
      })
    }

    function withWorktree(context: Harness, folder: string): SessionRecord {
      return record('s1', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
        directory: { mode: 'project', categoryId: 'c1', projectPath: context.workDirectory },
        life: 'ended',
        binding: null,
        worktree: {
          worktreePath: join(context.workDirectory, '.worktrees', folder),
          branch: 'https://svn.example.test/repos/app/trunk',
          baseCommit: 'r41',
          repositoryRoot: context.workDirectory,
          kind: 'svn',
        },
      })
    }

    it('refuses to reopen or fork a tombstone, naming its revisions, and asks the Host nothing', async () => {
      const context = await harness()
      await context.store.put(tombstone(context))

      for (const refused of [
        failureOf(await context.lifecycle.reopen('s1')),
        failureOf(await context.lifecycle.forkFrom('s1')),
      ]) {
        expect(refused.code).toBe('worktree-removed')
        expect(refused.detail).toContain(revision)
      }
      expect(context.host.calls).toEqual([])
      expect(context.store.get('s1')).toEqual(tombstone(context))
    })

    it('refuses to reopen a session whose worktree directory is absent', async () => {
      const context = await harness()
      await context.store.put(withWorktree(context, 'gone'))

      const refused = failureOf(await context.lifecycle.reopen('s1'))

      expect(refused.code).toBe('worktree-removed')
      expect(refused.detail).toContain(join(context.workDirectory, '.worktrees', 'gone'))
      expect(context.host.calls).toEqual([])
    })

    it('reopens a session whose worktree directory is there, in that directory', async () => {
      const context = await harness()
      mkdirSync(join(context.workDirectory, '.worktrees', 'here'), { recursive: true })
      await context.store.put(withWorktree(context, 'here'))

      expect(await context.lifecycle.reopen('s1')).toEqual({ ok: true, value: undefined })
      expect(launchOf(callsNamed(context.host, 'runtime.create')[0]).cwd)
        .toBe(join(context.workDirectory, '.worktrees', 'here'))
    })

    // A running SVN action may be about to rename the directory away; nothing else may start in it or
    // drop the record that will carry the outcome.
    it('refuses to reopen, fork or remove a session while its SVN action runs', async () => {
      const context = await harness()
      mkdirSync(join(context.workDirectory, '.worktrees', 'busy'), { recursive: true })
      const finishing: SessionRecord = {
        ...withWorktree(context, 'busy'),
        svnAction: svnActionOf(join(context.workDirectory, '.worktrees', 'busy')),
      }
      await context.store.put(finishing)

      for (const refused of [
        failureOf(await context.lifecycle.reopen('s1')),
        failureOf(await context.lifecycle.forkFrom('s1')),
        failureOf(await context.lifecycle.remove('s1')),
      ]) {
        expect(refused.code).toBe('merge-pending')
        expect(refused.detail).toContain('reviewing')
      }
      expect(context.host.calls).toEqual([])
      expect(context.store.get('s1')).toEqual(finishing)
    })

    // The verdict of a run is written in the reconcile pass; the next stage is launched off it.
    it('judges a check of an SVN action through the action gate and returns unapproved changes off the reconcile loop', async () => {
      const context = await harness()
      const worktree = join(context.workDirectory, '.worktrees', 'acting')
      mkdirSync(worktree, { recursive: true })
      const check = { key: 'k', scriptId: 'checks' as const, name: 'tests', commands: [{ command: 'pnpm test', cwd: worktree }] }
      await context.store.put({ ...withWorktree(context, 'acting'), svnAction: svnActionOf(worktree, { stage: 'checks', runId: 'check-run', checks: [check] }) })
      await context.logs.write('s1', 'check-run', 'Complete retained check output')
      await context.store.update('s1', (current) => ({ ...current, scriptRuns: [{ runId: 'check-run', title: 'tests', phase: 'after', scriptId: 'checks', name: 'tests', commands: check.commands.map((command) => command.command), startedAt: 1, endedAt: 4_000, exitCode: 0, outcome: 'succeeded', log: { state: 'saved', bytes: 30, truncated: false } }] }))
      await context.store.put(record('check-run', {
        life: 'ended', binding: null, exitCode: 0, exitReason: 'process-exit', endedAt: 4_000, commands: check.commands,
        scriptOf: { sessionId: 's1', phase: 'after', scriptId: 'checks', name: 'tests', stepKey: 'k' },
      }))
      context.tools.set('svn', { ok: true, command: 'C:/svn/svn.exe', prefixArgs: [], env: {} })

      context.svnAction.svn.reviewRoots = async () => ({ ok: true, value: [{ path: worktree, own: '', changed: [{ path: 'a.txt', kind: 'item', conflict: false }], pinned: false }] })
      context.svnAction.svn.changes = async () => ({ ok: true, value: [{ path: 'a.txt', kind: 'item', conflict: false }] })
      const applied = await context.lifecycle.reconcile(context.host.listing())
      expect(applied).toContainEqual({ kind: 'script-succeeded', sessionId: 's1', gate: 'action' })
      await Promise.all(context.svnAction.detached.splice(0))

      expect(FinishProjection.action(context.store.get('s1')!)).toMatchObject({ stage: 'changes' })
      expect(context.store.get('s1')?.worktreeLifecycle?.review?.selection).toEqual(['a.txt'])
      expect(callsNamed(context.host, 'runtime.create')).toEqual([])
    })

    it.each(['E155011', 'E160028', 'E170004', 'success', 'no-exit'])('waits for the saved commit log of a fast run before handling %s', async (result) => {
      const context = await harness()
      const worktree = join(context.workDirectory, '.worktrees', 'committing')
      mkdirSync(worktree, { recursive: true })
      const exitCode = result === 'no-exit' ? undefined : result === 'success' ? 0 : 1
      await context.store.put({ ...withWorktree(context, 'committing'), svnAction: svnActionOf(worktree, {
        stage: 'committing', runId: 'commit-run',
        roots: [{ path: worktree, own: '', changed: ['a.txt'], selection: [join(worktree, 'a.txt')], bounds: { repository: 'url', base: '/trunk', rootBase: 41, since: 41 } }],
        commit: { selection: [join(worktree, 'a.txt')], hashes: { 'a.txt': 'same' }, message: '[App] Change', preparedAdds: [] },
      }) })
      await context.store.put(record('commit-run', {
        life: 'starting', binding: null, pendingOperationId: 'commit-launch', pendingOperationKind: 'create',
        directory: { mode: 'adHoc', path: worktree }, process: { tool: 'svn', args: ['commit'] },
        scriptOf: { sessionId: 's1', phase: 'after', scriptId: 'svn', name: 'commit' },
      }))
      context.host.runtimes.set('commit-run', runtime('commit-run', { alive: false, exitCode, exitedAt: 4_000 }))
      context.host.screens.set('commit-run', [result === 'no-exit' ? 'Could not start svn: access denied'
        : result === 'success' ? 'Committed revision 51.' : `svn: ${result}: File is out of date`])
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('commit-run')).toMatchObject({ life: 'ended', exitCode,
        binding: { hostInstanceId: 'host-1', generation: 1 } })
      const inspect = vi.spyOn(context.host, 'inspect').mockResolvedValueOnce({ ok: false, code: 'host-unreachable', detail: 'try again' })

      for (let pass = 0; pass < 2; pass += 1) {
        const applied = await context.lifecycle.reconcile(context.host.listing())
        await Promise.all(context.svnAction.detached.splice(0))
        expect(applied.some((change) => change.kind === 'script-failed' || change.kind === 'script-succeeded')).toBe(false)
        expect(FinishProjection.action(context.store.get('s1')!)).toMatchObject({ stage: 'committing', rounds: { outOfDate: 0 } })
        expect(FinishProjection.action(context.store.get('s1')!)?.needs).toBeUndefined()
      }
      expect(inspect).toHaveBeenCalledTimes(2)
      expect(context.store.get('s1')?.scriptRuns?.[0].log.state).toBe('saved')

      await context.lifecycle.reconcile(context.host.listing())
      await Promise.all(context.svnAction.detached.splice(0))
      if (result === 'success')
        expect(context.store.get('s1')?.commitReceipts).toContainEqual(expect.objectContaining({ revision: 51 }))
      else if (result === 'no-exit')
        expect(FinishProjection.action(context.store.get('s1')!)?.needs?.reason).toContain('Could not start svn: access denied')
      else {
        expect(FinishProjection.action(context.store.get('s1')!)).toMatchObject({ rounds: { outOfDate: 1 } })
        while (context.svnAction.detached.length > 0) await Promise.all(context.svnAction.detached.splice(0))
        expect(context.svnAction.syncs).toEqual([])
        expect(context.store.get('s1')?.worktreeLifecycle?.wait?.kind).toBe('repository-busy')
        expect(callsNamed(context.host, 'runtime.create')).toEqual([])
      }
    })

    it.each([0, 1])('finishes judging commit exit %i when its log is permanently unavailable', async (exitCode) => {
      const context = await harness()
      const worktree = join(context.workDirectory, '.worktrees', 'committing')
      await context.store.put({ ...withWorktree(context, 'committing'), svnAction: svnActionOf(worktree, {
        stage: 'committing', runId: 'commit-run',
      }) })
      await context.store.put(record('commit-run', {
        life: 'ended', binding: null, exitCode, endedAt: 4_000,
        directory: { mode: 'adHoc', path: worktree }, process: { tool: 'svn', args: ['commit'] },
        scriptOf: { sessionId: 's1', phase: 'after', scriptId: 'svn', name: 'commit' },
      }))
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('s1')?.scriptRuns?.[0].log.state).toBe('unavailable')
      await context.lifecycle.reconcile(context.host.listing())
      await Promise.all(context.svnAction.detached.splice(0))
      expect(FinishProjection.action(context.store.get('s1')!)?.needs?.kind).toBe('svn-failed')
      expect(FinishProjection.action(context.store.get('s1')!)?.needs?.reason).toContain('full log')
      expect(context.store.get('s1')?.commitReceipts).toBeUndefined()
      expect(callsNamed(context.host, 'runtime.create')).toEqual([])
    })

    // After a restart nothing drives a client stage until the reconciler asks for it.
    it('resumes a client stage of an SVN action found on load through svn-action-due', async () => {
      const context = await harness()
      const worktree = join(context.workDirectory, '.worktrees', 'removing')
      mkdirSync(worktree, { recursive: true })
      await context.store.put({ ...withWorktree(context, 'removing'), svnAction: svnActionOf(worktree, { stage: 'removing' }) })
      context.svnAction.remove = async (sessionId) => {
        await context.store.update(sessionId, (current) => {
          const next: SessionRecord = { ...current, completed: true,
            retiredWorktree: { worktreePath: worktree, kind: 'svn', revisions: [], removedAt: context.clock.now, ownerDir: context.workDirectory } }
          delete next.worktree
          return next
        })
        return { state: 'removed', lines: [] }
      }

      const applied = await context.lifecycle.reconcile(context.host.listing())
      expect(applied).toContainEqual({ kind: 'svn-action-due', sessionId: 's1' })
      await Promise.all(context.svnAction.detached.splice(0))

      // The resumed Finish reads no change in the worktree, so its review ends without a dialog.
      expect(context.store.get('s1')?.svnAction).toBeUndefined()
      expect(context.store.get('s1')?.worktreeOutcome?.result).toBe('nothing')
      expect(context.store.get('s1')?.worktreeOutcome?.worktree).toBe('removed')
      expect(context.reports).toEqual([])
      expect(context.store.get('s1')?.worktreeLifecycle?.wait).toBeUndefined()
    })

    // A waiting action holds nothing: the person may run the session again and press Finish later.
    it('reopens a session whose SVN action waits for the person, and keeps the action', async () => {
      const context = await harness()
      mkdirSync(join(context.workDirectory, '.worktrees', 'waiting'), { recursive: true })
      const waiting = svnActionOf(join(context.workDirectory, '.worktrees', 'waiting'),
        { needs: { kind: 'review-cancelled', reason: 'the review ended without a commit', at: 6 } })
      await context.store.put({ ...withWorktree(context, 'waiting'), svnAction: waiting })

      expect(await context.lifecycle.reopen('s1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('s1')?.life).toBe('live')
      expect(context.store.get('s1')?.svnAction).toEqual(waiting)
    })

    // The first phase write of a Finish lands after an await; a reopen in between would start the
    // session in the directory the finish is about to rename away.
    it('refuses to reopen, fork or remove a session whose finish began before its record says so', async () => {
      const context = await harness()
      mkdirSync(join(context.workDirectory, '.worktrees', 'busy'), { recursive: true })
      await context.store.put(withWorktree(context, 'busy'))
      context.finishing.add('s1')

      for (const refused of [
        failureOf(await context.lifecycle.reopen('s1')),
        failureOf(await context.lifecycle.forkFrom('s1')),
        failureOf(await context.lifecycle.remove('s1')),
      ]) {
        expect(refused.code).toBe('merge-pending')
        expect(refused.detail).toContain('starting')
      }
      expect(context.host.calls).toEqual([])

      context.finishing.delete('s1')
      expect(await context.lifecycle.reopen('s1')).toEqual({ ok: true, value: undefined })
    })

    // The Host restart reopens every live session on the replacement; one that cannot be reopened
    // has to stop the restart before the old Host goes, not fail after it.
    it('cancels a Host restart over a live session whose worktree directory is absent', async () => {
      const context = await harness()
      await context.store.put({ ...withWorktree(context, 'gone'), life: 'live', binding: { hostInstanceId: 'host-1', generation: 1 } })
      context.host.runtimes.set('s1', runtime('s1'))

      const refused = failureOf(await context.lifecycle.prepareHostRestart(context.host.listing()))

      expect(refused.detail).toContain(join(context.workDirectory, '.worktrees', 'gone'))
    })
  })

  /**
   * The verdict is the reconciler's; the lifecycle writes the attempt first and hands the apply to the
   * finish flow, off this loop. The flow's own judgement is tested in `svnWorktreeFinishFlow.test.ts`.
   */
  describe('the cleanup of an SVN worktree after its end', () => {
    function cleaning(overrides?: Partial<SessionRecord>): SessionRecord {
      return record('w1', {
        life: 'ended',
        binding: null,
        exitReason: 'process-exit',
        endedAt: 1_000,
        worktree: {
          worktreePath: 'C:\\repo\\.worktrees\\014-fix',
          branch: 'https://svn.example.test/repos/app/trunk',
          baseCommit: 'r41',
          repositoryRoot: 'C:\\repo',
          kind: 'svn',
          directoryId: '1:2:3',
        },
        worktreeCleanup: { phase: 'pending', trigger: 'remove-when-ended', requestedAt: 1, attempts: 0 },
        ...overrides,
      })
    }

    async function wired(): Promise<Harness & { cleaned: string[] }> {
      const context = await harness()
      const cleaned: string[] = []
      context.lifecycle.setCleanWorktree((sessionId) => cleaned.push(sessionId))
      return { ...context, cleaned }
    }

    it('hands a pending cleanup to the flow thirty seconds after the end, with the attempt written first', async () => {
      const context = await wired()
      await context.store.put(cleaning())

      context.clock.now = 30_999
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.cleaned).toEqual([])

      context.clock.now = 31_000
      const applied = await context.lifecycle.reconcile(context.host.listing())

      expect(applied).toContainEqual({ kind: 'clean-worktree', sessionId: 'w1' })
      expect(context.cleaned).toEqual(['w1'])
      expect(context.store.get('w1')?.worktreeCleanup).toMatchObject({ phase: 'pending', attempts: 1, lastAttemptAt: 31_000 })
      // The session with a worktree is never filed as done by its ending; the removal does that.
      expect(context.store.get('w1')?.completed).toBeUndefined()
    })

    // Removed with the main-copy landing: an `unlanded` reason a 3.10 build wrote is paced like any other.
    it('judges a cleanup a 3.10 build left waiting as unlanded at once after a client start, then on the ordinary pace', async () => {
      const context = await wired()
      // The harness client started at 5_000; this attempt is older than that start.
      await context.store.put(cleaning({ worktreeCleanup: {
        phase: 'pending', trigger: 'committed', reason: 'unlanded r12: a.txt', requestedAt: 1, attempts: 3, lastAttemptAt: 4_000,
      } }))

      context.clock.now = 40_000
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.cleaned).toEqual(['w1'])

      context.clock.now = 40_000 + 2 * 60_000 - 1
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.cleaned).toEqual(['w1'])

      context.clock.now = 40_000 + 2 * 60_000
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.cleaned).toEqual(['w1', 'w1'])
    })

    it('writes no attempt while a finish or an earlier cleanup of this client holds the session', async () => {
      const context = await wired()
      await context.store.put(cleaning())
      context.finishing.add('w1')
      context.clock.now = 60_000

      await context.lifecycle.reconcile(context.host.listing())

      expect(context.cleaned).toEqual([])
      expect(context.store.get('w1')?.worktreeCleanup?.attempts).toBe(0)
    })

    it('writes nothing without a flow to hand the cleanup to', async () => {
      const context = await harness()
      await context.store.put(cleaning())
      context.clock.now = 60_000

      expect(await context.lifecycle.reconcile(context.host.listing())).toEqual([])
      expect(context.store.get('w1')?.worktreeCleanup?.attempts).toBe(0)
    })

    function svnProvision(context: Harness): void {
      context.worktrees.outcome = {
        ok: true,
        value: {
          worktree: { worktreePath: join(projectRoot, '.worktrees', '007-fix'), branch: 'file:///repository/one', baseCommit: 'r41', repositoryRoot: projectRoot, kind: 'svn' },
          checkout: null,
        },
      }
    }

    it('keeps a changed worktree after a persisted legacy Discard IN USE, a reopen and a stop', async () => {
      const context = await wired()
      const worktree = join(context.workDirectory, 'repo', '.worktrees', '014-fix')
      mkdirSync(worktree, { recursive: true })
      const base = cleaning({ exitReason: 'stopped', endedAt: 1_000 })
      if (base.worktree === undefined) throw new Error('the fixture has no worktree')
      await context.store.put({ ...base, worktree: { ...base.worktree, worktreePath: worktree, repositoryRoot: join(context.workDirectory, 'repo') } })
      const flowLog: string[] = []
      const svn: SvnCleanupPort = {
        present: async () => true,
        changes: async (path: string) => {
          flowLog.push(`changes ${path}`)
          return { ok: true as const, value: [{ kind: 'item' as const, conflict: false, path: 'after-reopen.txt' }] }
        },
      }
      let renameAnswer: 'in-use' | 'removed' = 'in-use'
      const removal = {
        remove: async (): Promise<SvnWorktreeRemoved> => {
          flowLog.push('renameAside')
          return { state: renameAnswer, lines: [] }
        },
      }
      context.svnAction.remove = removal.remove
      const ended: string[] = []
      const flow = new SvnWorktreeFinishFlow({
        records: context.store,
        svn,
        removal,
        actions: {
          start: (sessionId, press) => context.lifecycle.svnActions.start(sessionId, press),
          settled: (sessionId) => context.lifecycle.svnActions.settled(sessionId),
        },
        labels: { ownCommits: async () => ({ ok: true, value: [] }) },
        steps: { at: () => undefined, clear: () => false },
        results: new WorktreeResultsStore(join(context.workDirectory, 'cleanup-results'), {
          now: () => context.clock.now, logs: context.logs, report: () => undefined,
        }),

        changed: () => undefined,
        ended: (sessionId) => { ended.push(sessionId) },
        landedDue: () => undefined,
        report: () => undefined,
        now: () => context.clock.now,
      })
      const cleanups: Promise<void>[] = []
      context.lifecycle.setCleanWorktree((sessionId) => { cleanups.push(flow.cleanUp(sessionId)) })

      context.clock.now = 2_000
      await context.store.update('w1', (current) => ({ ...current, worktreeLifecycle: undefined,
        worktreeCleanup: { phase: 'pending', trigger: 'discard-unfinished', requestedAt: 2_000, attempts: 0 } }))
      await flow.cleanUp('w1')
      expect(context.store.get('w1')?.worktreeCleanup?.reason).toBe('in use')
      expect(context.store.get('w1')?.worktreeCleanup?.trigger).toBe('discard-unfinished')

      context.clock.now = 3_000
      expect(await context.lifecycle.reopen('w1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('w1')?.life).toBe('live')
      expect(context.store.get('w1')?.worktreeCleanup)
        .toEqual({ phase: 'pending', trigger: 'removal-unfinished', requestedAt: 3_000, attempts: 0 })

      expect(await context.lifecycle.stop('w1')).toEqual({ ok: true, value: undefined })
      const stopped = context.host.runtimes.get('w1')
      if (stopped === undefined) throw new Error('the Host holds no runtime')
      context.host.runtimes.set('w1', { ...stopped, exitReason: 'stopped', exitedAt: 4_000 })
      context.clock.now = 4_000
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.store.get('w1')?.life).toBe('ended')

      renameAnswer = 'removed'
      context.clock.now = 4_000 + 31_000
      await context.lifecycle.reconcile(context.host.listing())
      await Promise.all(cleanups)

      expect(cleanups).toHaveLength(1)
      expect(flowLog).toEqual(['renameAside', `changes ${worktree}`])
      expect(context.store.get('w1')?.worktreeCleanup).toMatchObject({ phase: 'kept', reason: '1 change' })
      expect(context.store.get('w1')?.worktree?.worktreePath).toBe(worktree)
      expect(ended).toEqual([])
    })

    it('writes a removeWhenEnded create pending from the start, and judges nothing while it runs', async () => {
      const context = await wired()
      svnProvision(context)

      const { sessionId } = successOf(await context.lifecycle.create({
        ...worktreeSpec(), worktree: { slug: 'fix', removeWhenEnded: true },
      }))

      expect(context.store.get(sessionId)?.worktreeCleanup)
        .toEqual({ phase: 'pending', trigger: 'remove-when-ended', requestedAt: context.clock.now, attempts: 0 })
      expect(context.store.get(sessionId)?.life).toBe('live')
      context.clock.now += 60 * 60_000
      await context.lifecycle.reconcile(context.host.listing())
      expect(context.cleaned).toEqual([])
    })

    it('writes no cleanup for a Git worktree or a create without the option', async () => {
      const context = await wired()
      const git = successOf(await context.lifecycle.create({ ...worktreeSpec(), worktree: { slug: 'fix', removeWhenEnded: true } }))
      svnProvision(context)
      const plain = successOf(await context.lifecycle.create(worktreeSpec()))

      expect(context.store.get(git.sessionId)?.worktree?.kind).toBe('git')
      expect(context.store.get(git.sessionId)?.worktreeCleanup).toBeUndefined()
      expect(context.store.get(plain.sessionId)?.worktreeCleanup).toBeUndefined()
    })

    it('refuses a removeWhenEnded that is not true before it takes a number', async () => {
      const context = await harness()

      const refused = await context.lifecycle.create({
        ...worktreeSpec(), worktree: { slug: 'fix', removeWhenEnded: false as unknown as true },
      })

      expect(failureOf(refused)).toMatchObject({ code: 'invalid-spec', detail: expect.stringMatching(/removeWhenEnded/) })
      expect(context.numbers.calls).toEqual([])
    })

    it('keeps the caller\'s tag and wake-up line on the worktree it creates', async () => {
      const context = await wired()
      await context.store.put(cleaning({ sessionId: 'coordinator', worktree: undefined, worktreeCleanup: undefined }))
      svnProvision(context)

      const { sessionId } = successOf(await context.lifecycle.create({
        ...worktreeSpec(), worktree: { slug: 'fix', tag: '7f3a9c2e-run:1', notify: { sessionId: 'coordinator', text: '$pp:work-tickets watch' } },
      }))

      expect(context.store.get(sessionId)?.worktree?.caller)
        .toEqual({ tag: '7f3a9c2e-run:1', notify: { sessionId: 'coordinator', text: '$pp:work-tickets watch' } })
      const plain = successOf(await context.lifecycle.create(worktreeSpec()))
      expect(context.store.get(plain.sessionId)?.worktree).not.toHaveProperty('caller')
    })

    it('refuses a bad tag or wake-up line before anything is created', async () => {
      const context = await harness()
      await context.store.put(cleaning({ sessionId: 'coordinator', worktree: undefined, worktreeCleanup: undefined }))
      const line = (text: string, sessionId = 'coordinator') => ({ notify: { sessionId, text } })

      for (const [extra, detail] of [
        [{ tag: 'x'.repeat(129) }, /tag/],
        [{ tag: 'two words' }, /tag/],
        [line('x'.repeat(801)), /exceeds 800/],
        [line('wake\rup'), /control characters/],
        [line('wake', 'nobody'), /session nobody/],
      ] as const) {
        const refused = await context.lifecycle.create({ ...worktreeSpec(), worktree: { slug: 'fix', ...extra } })
        expect(failureOf(refused)).toMatchObject({ code: 'invalid-spec', detail: expect.stringMatching(detail) })
      }
      expect(context.numbers.calls).toEqual([])
      expect(context.worktrees.calls).toEqual([])
      expect(context.store.list().map((record) => record.sessionId)).toEqual(['coordinator'])
    })

    const commit = (sessionId: string, scopeRoot: string, revision: number | null = 50, paths: string[] = []): SessionCommitReceipt =>
      ({ sessionId, scopes: [{ scopeRoot, revision }], paths })

    it('waits visibly for incomplete foreign worktree evidence and leaves a main-copy review alone', async () => {
      const context = await harness()
      await context.store.put(cleaning({ life: 'live', binding: { hostInstanceId: 'host-1', generation: 1 }, worktreeCleanup: undefined }))
      context.clock.now = 7_000

      expect(await context.lifecycle.noteCommitted(commit('main', 'C:\\repo'))).toEqual({ ok: true, value: undefined })
      expect(await context.lifecycle.noteCommitted(commit('main', 'C:\\repo\\src'))).toEqual({ ok: true, value: undefined })
      expect(context.store.get('w1')?.worktreeCleanup).toBeUndefined()

      await context.lifecycle.noteCommitted(commit('main', 'C:/repo/.worktrees/014-fix/mount'))
      expect(context.store.get('w1')?.worktreeCleanup).toBeUndefined()
      expect(context.store.get('w1')?.worktreeLifecycle?.wait?.kind).toBe('published-with-differences')
      expect(context.svnAction.ended).toEqual([])
      expect(callsNamed(context.host, 'runtime.create')).toEqual([])
    })

    it('leaves a running finish and a pending trigger alone, and judges a kept worktree again', async () => {
      const context = await harness()
      const scope = 'C:\\repo\\.worktrees\\014-fix'
      const cleanupOf = () => context.store.get('w1')?.worktreeCleanup
      const discarded = cleaning({ worktreeCleanup: { phase: 'pending', trigger: 'discard-unfinished', reason: 'in use', requestedAt: 1, attempts: 2 } })
      await context.store.put(discarded)
      await context.lifecycle.noteCommitted(commit('w1', scope))
      expect(cleanupOf()).toEqual(discarded.worktreeCleanup)

      // An SVN action reviews and removes the worktree itself; the receipt still lands on the session.
      const reviewing = cleaning({ worktreeCleanup: undefined, svnAction: svnActionOf(scope) })
      await context.store.put(reviewing)
      await context.lifecycle.noteCommitted(commit('w1', scope))
      expect(cleanupOf()).toBeUndefined()
      expect(context.store.get('w1')?.worktreeLifecycle?.wait?.kind).toBe('published-with-differences')
      expect(context.store.get('w1')?.commitReceipts?.at(-1)).toMatchObject({ scopeRoot: scope, revision: 50 })

      await context.store.put(cleaning({ worktreeCleanup: undefined }))
      context.finishing.add('w1')
      await context.lifecycle.noteCommitted(commit('w1', scope))
      expect(cleanupOf()).toBeUndefined()
      context.finishing.delete('w1')

      await context.store.put(cleaning({ worktreeCleanup: { phase: 'kept', trigger: 'committed', reason: '2 changes', requestedAt: 1, attempts: 1 } }))
      context.clock.now = 9_000
      await context.lifecycle.noteCommitted(commit('w1', scope))
      expect(cleanupOf()?.phase).toBe('kept')
      expect(context.store.get('w1')?.worktreeLifecycle?.wait?.kind).toBe('published-with-differences')
      expect(context.svnAction.ended).toEqual([])
    })

    it('keeps a receipt per scope on the split\'s session, each path relative to the deepest scope holding it', async () => {
      const context = await harness()
      const root = 'C:\\repo\\.worktrees\\014-fix'
      await context.store.put(cleaning({ worktreeCleanup: undefined }))
      context.clock.now = 7_000

      await context.lifecycle.noteCommitted({ sessionId: 'w1',
        scopes: [{ scopeRoot: `${root}\\mount`, revision: 1234 }, { scopeRoot: root, revision: 1235 }],
        paths: [`${root}\\mount\\a.txt`, `${root}\\src\\b.txt`, `${root}\\c.txt`, 'C:\\elsewhere\\d.txt'] })

      expect(context.store.get('w1')?.commitReceipts).toEqual([
        { scopeRoot: `${root}\\mount`, revision: 1234, paths: ['a.txt'], at: 7_000 },
        { scopeRoot: root, revision: 1235, paths: ['src/b.txt', 'c.txt'], at: 7_000 },
      ])
      expect(context.store.get('w1')?.worktreeCleanup).toBeUndefined()
      expect(context.store.get('w1')?.worktreeLifecycle?.step).toBe('verifying')
    })

    it('lands a main-copy commit inside another session\'s worktree on both, and a run\'s on its parent', async () => {
      const context = await harness()
      const scope = 'C:\\repo\\.worktrees\\014-fix'
      await context.store.put(cleaning({ worktreeCleanup: undefined }))
      await context.store.put(record('main', { life: 'live', binding: { hostInstanceId: 'host-1', generation: 1 } }))
      await context.store.put(record('run-1', { kind: 'shell', life: 'live', binding: { hostInstanceId: 'host-1', generation: 2 },
        scriptOf: { sessionId: 'main', phase: 'before', scriptId: 'setup', name: 'setup' } }))
      context.clock.now = 7_000

      await context.lifecycle.noteCommitted(commit('main', scope, 60, [`${scope}\\a.txt`]))
      await context.lifecycle.noteCommitted(commit('run-1', 'C:\\repo', null))

      const first = { scopeRoot: scope, revision: 60, paths: ['a.txt'], at: 7_000 }
      expect(context.store.get('main')?.commitReceipts).toEqual([first, { scopeRoot: 'C:\\repo', revision: null, paths: [], at: 7_000 }])
      expect(context.store.get('run-1')?.commitReceipts).toBeUndefined()
      expect(context.store.get('w1')?.commitReceipts).toEqual([first])
      expect(context.store.get('w1')?.worktreeCleanup).toBeUndefined()
      expect(context.store.get('w1')?.worktreeLifecycle?.step).toBe('verifying')
    })

    it('keeps the newest 50 receipts and at most 200 paths in one', async () => {
      const context = await harness()
      await context.store.put(record('main'))
      const many = Array.from({ length: 250 }, (_unused, index) => `C:\\repo\\f${index}.txt`)

      for (let revision = 1; revision <= 51; revision += 1)
        await context.lifecycle.noteCommitted(commit('main', 'C:\\repo', revision, revision === 51 ? many : []))

      const receipts = context.store.get('main')?.commitReceipts ?? []
      expect(receipts).toHaveLength(SessionLifecycle.commitReceiptsMaxConst)
      expect(receipts[0].revision).toBe(2)
      expect(receipts.at(-1)?.paths).toEqual(many.slice(0, SessionLifecycle.receiptPathsMaxConst).map((_path, index) => `f${index}.txt`))
    })

    it('takes a requested cleanup, judges a kept worktree again and makes a paced one due at once', async () => {
      const context = await harness()
      await context.store.put(cleaning({ worktreeCleanup: undefined }))
      context.clock.now = 7_000
      expect(await context.lifecycle.requestWorktreeCleanup('w1')).toEqual({ ok: true, value: undefined })
      expect(context.store.get('w1')?.worktreeCleanup)
        .toEqual({ phase: 'pending', trigger: 'requested', requestedAt: 7_000, attempts: 0 })

      await context.store.put(cleaning({ worktreeCleanup: { phase: 'kept', trigger: 'committed', reason: '2 changes', requestedAt: 1, attempts: 1, lastAttemptAt: 2 } }))
      await context.lifecycle.requestWorktreeCleanup('w1')
      expect(context.store.get('w1')?.worktreeCleanup)
        .toEqual({ phase: 'pending', trigger: 'requested', requestedAt: 7_000, attempts: 0 })

      // An unfinished Discard stays one: its trigger skips the change check the person already passed.
      await context.store.put(cleaning({ worktreeCleanup: { phase: 'pending', trigger: 'discard-unfinished', reason: 'unlanded r12: a.txt', requestedAt: 3, attempts: 4, lastAttemptAt: 6_000 } }))
      await context.lifecycle.requestWorktreeCleanup('w1')
      const paced = context.store.get('w1')?.worktreeCleanup
      expect(paced).toEqual({ phase: 'pending', trigger: 'discard-unfinished', requestedAt: 3, attempts: 0 })
      expect(paced && WorktreeCleanupPacing.due(paced, 7_000, 0)).toBe(true)
    })

    it('refuses a requested cleanup without an SVN worktree, during an SVN action and after the removal', async () => {
      const context = await harness()
      expect(failureOf(await context.lifecycle.requestWorktreeCleanup('nobody'))).toMatchObject({ code: 'not-found' })

      await context.store.put(cleaning({
        worktreeCleanup: undefined,
        worktree: { worktreePath: 'C:\\repo\\.worktrees\\014-fix', branch: 'jamat/fix', baseCommit: 'abc', repositoryRoot: 'C:\\repo', kind: 'git' },
      }))
      expect(failureOf(await context.lifecycle.requestWorktreeCleanup('w1'))).toMatchObject({ code: 'invalid-spec' })

      const reviewing = cleaning({ worktreeCleanup: undefined, svnAction: svnActionOf('C:\\repo\\.worktrees\\014-fix') })
      await context.store.put(reviewing)
      expect(failureOf(await context.lifecycle.requestWorktreeCleanup('w1'))).toMatchObject({ code: 'merge-pending' })
      expect(context.store.get('w1')).toEqual(reviewing)

      const { worktree: _worktree, ...withoutWorktree } = cleaning({ worktreeCleanup: undefined })
      await context.store.put({
        ...withoutWorktree,
        retiredWorktree: { worktreePath: 'C:/repo/.worktrees/014-fix', kind: 'svn', revisions: ['r12'], removedAt: 9 },
      })
      expect(failureOf(await context.lifecycle.requestWorktreeCleanup('w1')))
        .toMatchObject({ code: 'worktree-removed', detail: expect.stringMatching(/r12/) })
    })
  })

  // The link is display only, so a create naming a parent this computer cannot show is refused
  // rather than stored as a row nothing can nest under.
  describe('the parent link', () => {
    it('refuses an unknown parent, a script run as parent and an unknown kind before anything is created', async () => {
      const context = await harness()
      await context.store.put(record('p'))
      await context.store.put(setupRecord({ scriptOf: { sessionId: 'p', phase: 'before', scriptId: 'setup', name: 'setup' } }))

      for (const [parent, detail] of [
        [{ sessionId: 'nobody', kind: 'worktree' }, /parent names session nobody, which this computer does not have/],
        [{ sessionId: 's1', kind: 'ticket' }, /Session s1 is a script run and cannot be a parent/],
        [{ sessionId: 'p', kind: 'unit' }, /unknown parent kind "unit"/],
        [{ sessionId: ' ', kind: 'worker' }, /a parent needs the id/],
      ] as const) {
        const refused = await context.lifecycle.create({ ...shellSpec(context.workDirectory), parent } as unknown as SessionCreateSpec)
        expect(failureOf(refused)).toMatchObject({ code: 'invalid-spec', detail: expect.stringMatching(detail) })
      }
      expect(context.host.calls).toEqual([])
      expect(context.store.list().map((entry) => entry.sessionId)).toEqual(['p', 's1'])
    })

    it('stores the parent on the created record, and the record survives a reload unchanged', async () => {
      const context = await harness()
      await context.store.put(record('p'))

      const { sessionId } = successOf(await context.lifecycle.create({
        ...shellSpec(context.workDirectory), parent: { sessionId: 'p', kind: 'worker' },
      }))
      const plain = successOf(await context.lifecycle.create(shellSpec(context.workDirectory)))

      const stored = context.store.get(sessionId)
      expect(stored?.parent).toEqual({ sessionId: 'p', kind: 'worker' })
      expect(context.store.get(plain.sessionId)).not.toHaveProperty('parent')
      const reloaded = await SessionRecordsStore.load(context.recordsFile, { snapshotsDirectory: context.snapshotsDirectory })
      expect(reloaded.get(sessionId)).toEqual(stored)
    })
  })
})
