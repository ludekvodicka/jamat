import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  RuntimeInspectResult,
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
import { OrchestratorPaths } from '../shared/orchestratorPaths'
import type { SessionRecord, SessionRecordsDocument } from './records/sessionRecord.types'
import type { SessionInfo, SessionsOpResult } from './sessionManagerApi.types'
import { SessionManager, type SessionManagerDeps } from './sessionManager'
import { WorkFixtures } from './workState/fixtures/workFixtures'

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
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
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

  async function world(): Promise<World> {
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
    const host = await FakeHost.start({ hostInstanceId: 'fake-host-1' })
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
      autoStartHost?: boolean
      spawnPublishes?: boolean
      vcsStatusView?: SessionManagerDeps['vcsStatusView']
      codexHome?: string
      exitClock?: SessionManagerDeps['exitClock']
      transcripts?: SessionManagerDeps['transcripts']
      versioningModeOf?: SessionManagerDeps['versioningModeOf']
    },
  ): Client {
    const errors: string[] = []
    const counters = { emits: 0, spawns: 0 }
    const manager = new SessionManager({
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
      vcsStatusView: options?.vcsStatusView,
      codexHome: options?.codexHome,
      transcripts: options?.transcripts,
      versioningModeOf: options?.versioningModeOf,
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
        },
      })}\n`,
      'utf8',
    )
  }

  it('finishes the first reconcile before naming an old Codex conversation on startup', async () => {
    const context = await world()
    const codexHome = join(context.root, 'codex-home')
    const conversationId = '019f4bf7-b5d8-74b0-9175-a5a5938a4082'
    const createdAt = Date.now() - 3_600_000
    writeCodexRollout(context, codexHome, conversationId, createdAt + 1_000)
    seedRecords(context, [recordOf(context, 'codex-old', {
      kind: 'agent',
      agent: { agentId: 'codex', launchMode: 'new' },
      life: 'lost',
      createdAt,
    })])
    const client = clientOf(context, { codexHome })

    await client.manager.start()

    expect(client.manager.debugStatus().reconcile.lastReason).toBe('poll')
    expect(storedRecord(context, 'codex-old')?.agent?.nativeSessionId).toBe(conversationId)
    expect(client.errors).toEqual([])
  }, 20_000)

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
        nativeSessionId: 'native-2',
        launchModel: null,
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

    const numbered = valueOf(await client.manager.createSession({
      kind: 'shell',
      directory: { mode: 'project', categoryId: 'code', projectPath: join(context.categoryRoot, 'Alpha') },
      title: '001',
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
        launchMode: 'resume',
        nativeSessionId: 'native-1',
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

  /** A promotion is where the number arrives, so the tab it re-opens under is a new name. */
  it('answers a promoted tab with the name it now takes', async () => {
    const context = await world()
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    const plain = valueOf(await client.manager.createSession({
      kind: 'shell',
      directory: { mode: 'project', categoryId: 'code', projectPath: join(context.categoryRoot, 'Alpha') },
      title: 'a look around',
      presentation: 'tab',
    }))
    expect(plain.tabTitle).toBe('Alpha - a look around')

    expect(valueOf(await client.manager.promotePlainSession(plain.sessionId)).tabTitle)
      .toBe('Alpha - 001 - a look around')
    expect(client.errors).toEqual([])
  }, 20_000)

  // A plain tab is a session like any other on the wire; only where it is drawn differs, and the
  // renderer cannot leave it out of the tree without being told which one it is.
  it('carries the plain tab mark into the snapshot', async () => {
    const context = await world()
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    const plain = valueOf(await client.manager.createSession({
      kind: 'shell',
      directory: { mode: 'adHoc', path: join(context.root, 'elsewhere') },
      presentation: 'tab',
    }))
    const inTree = valueOf(await client.manager.createSession({
      kind: 'shell',
      directory: { mode: 'adHoc', path: join(context.root, 'elsewhere') },
    }))

    // Nobody has looked yet is a different answer from nothing is running, and one surface acts on
    // the difference: before the first answered listing this is false.
    expect(client.manager.snapshot().reconciled).toBe(true)
    expect(sessionOf(client, plain.sessionId)?.presentation).toBe('tab')
    expect(sessionOf(client, inTree.sessionId)?.presentation).toBeUndefined()
    // Nothing is finished the moment it is created, and a session that is still running has no
    // ending to read either.
    expect(sessionOf(client, plain.sessionId)?.completed).toBeUndefined()
    expect(sessionOf(client, plain.sessionId)?.outcome).toBeUndefined()
    expect(client.errors).toEqual([])
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
        resolveFor: 'claude-live',
      }),
      recordOf(context, 'shell-lost', { life: 'lost' }),
      recordOf(context, 'shell-installing', {
        life: 'live',
        setupFor: 'claude-waiting',
        binding: { hostInstanceId: 'fake-host-1', generation: 1 },
      }),
      recordOf(context, 'claude-waiting', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-2' },
        life: 'ended',
        pendingSetup: { setupSessionId: 'shell-installing' },
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
        resolveFor: 'merging',
        life: 'live',
        binding: { hostInstanceId: 'fake-host-1', generation: 1 },
      }),
      recordOf(context, 'settled', {
        kind: 'agent',
        agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-2' },
        life: 'ended',
        worktree,
      }),
    ])
    // The resolver needs a RUNTIME, or the reconciler relabels it and the guard has nothing
    // live to refuse for.
    context.runtimes.set('resolver', runtime('resolver'))
    context.publishDescriptor()
    const client = clientOf(context)
    await client.manager.start()
    await writable(client)

    expect(sessionOf(client, 'merging')?.admits).not.toContain('discardWorktree')
    // And the same record with nobody resolving it does admit one, so this is the resolver's doing
    // rather than the worktree's.
    expect(sessionOf(client, 'settled')?.admits).toContain('discardWorktree')
    expect(client.errors).toEqual([])
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
    expect(status.clientProtocol).toEqual({ major: 1, minor: 0 })
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
        setupFor: 'waiting-1',
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
        setupFor: 'waiting-2',
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

  /**
   * The fact is keyed by the DIRECTORY, not by the session, which is the whole reason it is cheap:
   * every session of one project stands in the same place, so ten of them cost one child process.
   */
  it('wears the working-copy fact of the directory it stands in, measured once for all of them', async () => {
    const context = await world()
    context.publishDescriptor()
    const probed: string[] = []
    const view = {
      async detect(cwd: string) {
        return {
          id: 'git' as const,
          root: cwd,
          cwd,
          scopeRelativePath: '.',
          scopeUrl: null,
          repositoryPathPrefix: null,
        }
      },
      async dirty(detection: { cwd: string }) {
        probed.push(detection.cwd)
        return { ok: true as const, value: true }
      },
    }
    const client = clientOf(context, {
      vcsStatusView: view as unknown as NonNullable<SessionManagerDeps['vcsStatusView']>,
    })
    await client.manager.start()
    await writable(client)

    const projectPath = join(context.categoryRoot, 'Alpha')
    const first = valueOf(await client.manager.createSession({
      kind: 'shell',
      directory: { mode: 'project', categoryId: 'code', projectPath },
    }))
    const second = valueOf(await client.manager.createSession({
      kind: 'shell',
      directory: { mode: 'project', categoryId: 'code', projectPath },
    }))

    await vi.waitFor(
      () => expect(sessionOf(client, first.sessionId)?.vcs).toEqual({ vcsId: 'git', dirty: true }),
      { timeout: 10_000 },
    )
    expect(sessionOf(client, second.sessionId)?.vcs).toEqual({ vcsId: 'git', dirty: true })
    expect(new Set(probed).size).toBe(1)
    expect(client.errors).toEqual([])
  }, 20_000)

  /**
   * The strictest half of the speed budget: with nothing on screen there is nobody to draw a mark
   * for, so no working copy is measured at all. The worktree pass beside it is not this strict; this
   * one is, because a probe is a child process per directory.
   */
  it('measures no working copy while no window is visible', async () => {
    const context = await world()
    context.publishDescriptor()
    const probed: string[] = []
    const view = {
      async detect(cwd: string) {
        return {
          id: 'git' as const,
          root: cwd,
          cwd,
          scopeRelativePath: '.',
          scopeUrl: null,
          repositoryPathPrefix: null,
        }
      },
      async dirty(detection: { cwd: string }) {
        probed.push(detection.cwd)
        return { ok: true as const, value: true }
      },
    }
    const client = clientOf(context, {
      vcsStatusView: view as unknown as NonNullable<SessionManagerDeps['vcsStatusView']>,
    })
    await client.manager.start()
    client.manager.setWindowVisible(false)
    await writable(client)
    const session = valueOf(await client.manager.createSession({
      kind: 'shell',
      directory: {
        mode: 'project',
        categoryId: 'code',
        projectPath: join(context.categoryRoot, 'Alpha'),
      },
    }))

    // Two hidden ticks would have been long past a visible one; nothing was asked.
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    expect(probed).toEqual([])
    expect(sessionOf(client, session.sessionId)?.vcs).toBeUndefined()

    // And back on screen it catches up on the next tick rather than on the next window.
    client.manager.setWindowVisible(true)
    await vi.waitFor(
      () => expect(sessionOf(client, session.sessionId)?.vcs).toEqual({ vcsId: 'git', dirty: true }),
      { timeout: 10_000 },
    )
    expect(client.errors).toEqual([])
  }, 30_000)

  describe('which repository worktrees are cut from', () => {
    /**
     * The wiring is asserted on DISK rather than by reading a private field, because the disk is the
     * only place where a context that was built but never handed down looks different from one that
     * reached the worktree manager.
     */
    async function worktreeProject(context: World): Promise<string> {
      const project = join(context.categoryRoot, 'Wiring')
      mkdirSync(project, { recursive: true })
      writeFileSync(join(project, 'a.txt'), 'v1\n', 'utf8')
      return project
    }

    async function skipWithoutGit(runner: { skip: () => void }): Promise<void> {
      const version = await new GitInvoker().run(tmpdir(), ['--version'])
      if (version.failure !== null || version.code !== 0)
        runner.skip()
    }

    /** No `versioningModeOf` passed: the default is checkpoints, and a project with no git works. */
    it('defaults to a checkpoint store, so a project with no git is isolatable', {
      timeout: 120_000,
    }, async (runner) => {
      await skipWithoutGit(runner)
      const context = await world()
      context.publishDescriptor()
      const client = clientOf(context)
      await client.manager.start()
      await writable(client)
      const project = await worktreeProject(context)

      const created = valueOf(await client.manager.createSession({
        kind: 'shell',
        directory: { mode: 'project', categoryId: 'code', projectPath: project },
        worktree: { slug: 'wiring' },
      }))

      expect(existsSync(join(project, CheckpointLayout.storeRelativeConst, 'HEAD'))).toBe(true)
      // The project never gains a git of its own, which is the whole point of the mode.
      expect(existsSync(join(project, '.git'))).toBe(false)
      // A worktree's .git is a FILE holding a pointer, and this one points into the store.
      const pointer = join(project, '.worktrees', 'wiring', '.git')
      expect(statSync(pointer).isFile()).toBe(true)
      expect(readFileSync(pointer, 'utf8')).toContain(CheckpointLayout.storeNameConst)
      const worktree = sessionOf(client, created.sessionId)?.worktree
      expect(worktree?.branch).toBe('jamat/wiring')
      expect(await client.manager.workingContext(created.sessionId)).toEqual({
        ok: true,
        value: {
          sessionId: created.sessionId,
          cwd: join(project, '.worktrees', 'wiring'),
          agent: null,
          worktree: {
            worktreePath: join(project, '.worktrees', 'wiring'),
            repositoryRoot: project,
            baseCommit: worktree?.baseCommit,
          },
        },
      })
    })

    it('keeps the original transcript cwd after merge removes the worktree', {
      timeout: 120_000,
    }, async (runner) => {
      await skipWithoutGit(runner)
      const context = await world()
      handleStop(context, { exits: true })
      context.publishDescriptor()
      const client = clientOf(context)
      await client.manager.start()
      await writable(client)
      const project = await worktreeProject(context)
      const transcriptCwd = join(project, '.worktrees', 'transcript-provenance')

      const created = valueOf(await client.manager.createSession({
        kind: 'agent',
        directory: { mode: 'project', categoryId: 'code', projectPath: project },
        agent: { agentId: 'claude', mode: 'new', nativeSessionId: 'native-provenance' },
        worktree: { slug: 'transcript-provenance' },
      }))
      valueOf(await client.manager.finalizeSession(created.sessionId))
      valueOf(await client.manager.mergeSession(created.sessionId))

      expect(existsSync(transcriptCwd)).toBe(false)
      expect(await client.manager.workingContext(created.sessionId)).toMatchObject({
        ok: true,
        value: { cwd: project, worktree: null },
      })
      expect(await client.manager.transcriptContext(created.sessionId)).toEqual({
        ok: true,
        value: {
          agentId: 'claude',
          cwd: transcriptCwd,
          nativeSessionId: 'native-provenance',
          launchModel: null,
        },
      })
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
