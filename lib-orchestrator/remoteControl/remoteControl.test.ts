import { describe, expect, it } from 'vitest'

import type { ProjectListResult } from '../projectManager/projectManagerApi.types'
import type {
  SessionInfo,
  SessionsSnapshot,
} from '../sessionManager/sessionManagerApi.types'
import {
  RemoteControl,
  type RemoteControlCallContext,
  type RemoteControlDeps,
} from './remoteControl'
import type {
  RemoteControlAgentsDto,
  RemoteControlOperation,
  RemoteControlRequest,
  RemoteControlRequestUnion,
  RemoteControlStepResult,
  RemoteControlTabCommandDto,
  RemoteControlTabOpenFileDto,
} from './remoteControlApi.types'
import { RemoteControlConst } from './remoteControlProtocol'
import { RemoteControlPeerConst } from './remoteControlPeerProtocol'

interface World {
  control: RemoteControl
  sessions: SessionInfo[]
  creates: () => number
  reopened: string[]
  finalized: string[]
  discarded: string[]
  tabCalls: { method: string; args: unknown[] }[]
  terminalCalls: { method: string; args: unknown[] }[]
  transcriptReads: string[]
  errors: string[]
}

function session(
  sessionId: string,
  number: string | null,
  projectPath = 'Q:\\Apps\\One',
): SessionInfo {
  const title = number === null ? sessionId : `${number} - ${sessionId}`
  return {
    sessionId,
    kind: 'shell',
    title,
    titleParts: { number, name: sessionId },
    tabTitle: `One - ${title}`,
    directory: { mode: 'project', categoryId: 'code', projectPath },
    project: { kind: 'project', categoryId: 'code', projectName: 'One', projectPath },
    life: 'live',
    activity: null,
    admits: [],
  }
}

function snapshot(sessions: SessionInfo[]): SessionsSnapshot {
  return {
    revision: 4,
    reconciled: true,
    host: {
      presence: 'running',
      hostVersion: '1.0.0',
      hostInstanceId: 'host-1',
      liveCount: sessions.length,
      lastStartError: null,
    },
    categories: [{ id: 'code', label: 'Code', path: 'Q:\\Apps' }],
    sessions,
    orphans: [],
  }
}

function successTab(kind: RemoteControlTabCommandDto['kind']):
RemoteControlStepResult<RemoteControlTabCommandDto> {
  return { ok: true, value: { kind, panelId: 'terminal:{}', windowId: 'main' } }
}

function successFile(path: string): RemoteControlStepResult<RemoteControlTabOpenFileDto> {
  return {
    ok: true,
    value: { kind: 'file-opened', panelId: 'terminal:{}', windowId: 'main', path },
  }
}

function world(options?: {
  sessions?: SessionInfo[]
  tabOpen?: RemoteControlStepResult<RemoteControlTabCommandDto>
}): World {
  const sessions = options?.sessions ?? [session('session-1', '001')]
  let creates = 0
  const reopened: string[] = []
  const finalized: string[] = []
  const discarded: string[] = []
  const tabCalls: { method: string; args: unknown[] }[] = []
  const terminalCalls: { method: string; args: unknown[] }[] = []
  const transcriptReads: string[] = []
  const errors: string[] = []
  const listing: ProjectListResult = {
    entries: [],
    projects: [{ name: 'One', path: 'Q:\\Apps\\One', lastActivity: null }],
    virtualFolders: [],
    truncated: false,
    available: true,
  }
  const deps: RemoteControlDeps = {
    system: {
      identity: () => ({
        configIdentity: 'config-1',
        runtimeChannel: 'development',
        instanceId: 'client-1',
        startedAt: 1_000,
        applicationVersion: '1.0.0',
      }),
    },
    projects: {
      listCategories: async () => [
        { id: 'code', label: 'Code', path: 'Q:\\Apps', available: true },
        { id: 'other', label: 'Other', path: 'Q:\\Other', available: false },
      ],
      listProjects: async (categoryId) => categoryId === 'code'
        ? { ok: true, value: listing }
        : { ok: false, code: 'category-unavailable', detail: 'offline' },
    },
    sessions: {
      snapshot: () => snapshot(sessions),
      createSession: async (spec) => {
        creates += 1
        const created = session(`created-${creates}`, '002')
        if (spec.presentation === 'tab') created.presentation = 'tab'
        sessions.push(created)
        return { ok: true, value: { sessionId: created.sessionId, tabTitle: created.tabTitle } }
      },
      reopenSession: async (sessionId) => {
        reopened.push(sessionId)
        return { ok: true, value: undefined }
      },
      finalizeSession: async (sessionId) => {
        finalized.push(sessionId)
        return { ok: true, value: undefined }
      },
      discardPlainSession: async (sessionId) => {
        discarded.push(sessionId)
        return { ok: true, value: undefined }
      },
    },
    tabs: {
      list: async () => [{
        panelId: 'terminal:{}',
        windowId: 'main',
        key: 'terminal',
        title: 'One - 001',
        params: { sessionId: 'session-1' },
        sessionId: 'session-1',
        presentation: 'session',
        active: true,
      }],
      open: async (...args) => {
        tabCalls.push({ method: 'open', args })
        return options?.tabOpen ?? successTab('opened')
      },
      openCommit: async (...args) => { tabCalls.push({ method: 'openCommit', args }); return { ok: true, value: { kind: 'commit-opened', panelId: 'commit-panel', windowId: 'main', scopeRoot: 'Q:/app', messageApplied: true } } },
      openFile: async (...args) => {
        tabCalls.push({ method: 'openFile', args })
        return successFile(args[2])
      },
      focus: async (...args) => {
        tabCalls.push({ method: 'focus', args })
        return successTab('focused-existing')
      },
      close: async (...args) => {
        tabCalls.push({ method: 'close', args })
        return successTab('closed')
      },
    },
    terminal: {
      peek: async (...args) => {
        terminalCalls.push({ method: 'peek', args })
        return {
          ok: true,
          value: {
            sessionId: args[0],
            snapshot: {
              type: 'terminal.snapshot',
              projection: {
                runtimeSessionId: args[0],
                generation: 1,
                outputEpoch: 1,
                outputSeq: 2,
                screen: 'hello',
                screenTruncated: false,
                cols: 80,
                rows: 24,
                alive: true,
                lastOutputAt: 2_000,
              },
            },
            terminalOutputUntrusted: true,
          },
        }
      },
      send: async (...args) => {
        terminalCalls.push({ method: 'send', args })
        return {
          ok: true,
          value: {
            sessionId: args[0],
            accepted: true,
            characterCount: args[1].length,
            enter: args[2].enter,
          },
        }
      },
    },
    transcript: {
      read: async (sessionId) => {
        transcriptReads.push(sessionId)
        return {
          kind: 'messages',
          messages: [{
            role: 'assistant',
            text: 'untrusted transcript text',
            at: 2_000,
            textTruncated: false,
          }],
          bounds: { maxMessages: 10, maxCharactersPerMessage: 2_000, scannedBytes: 128 },
          earlierContentOmitted: false,
        }
      },
    },
    agents: {
      describe: () => ({
        agents: [
          {
            agentId: 'claude',
            configuredModel: 'opus',
            models: [{
              id: 'opus',
              label: 'Opus (newest)',
              kind: 'alias',
              context: 200_000,
              efforts: ['low', 'high'],
              note: 'always the newest Opus',
            }],
          },
          {
            agentId: 'codex',
            // Configured to something this computer's own catalog no longer lists, which is the
            // case the asking side has to draw as a bare id rather than hide.
            configuredModel: 'gpt-5.4-retired',
            models: [{
              id: 'gpt-5.6-sol',
              label: 'GPT-5.6-Sol',
              kind: 'version',
              context: 272_000,
              efforts: ['low', 'high'],
            }],
          },
        ],
      }),
    },
    onError: (message) => errors.push(message),
  }
  return {
    control: new RemoteControl(deps),
    sessions,
    creates: () => creates,
    reopened,
    finalized,
    discarded,
    tabCalls,
    terminalCalls,
    transcriptReads,
    errors,
  }
}

function context(
  allowedOperations: readonly RemoteControlOperation[] = [
    ...RemoteControlConst.operations,
    ...RemoteControlConst.optionalOperations,
  ],
): RemoteControlCallContext {
  return { callerId: 'test-caller', callerKind: 'local-cli', allowedOperations }
}

function request<K extends RemoteControlOperation>(
  operation: K,
  body: RemoteControlRequest<K>['body'],
  operationId?: string,
  requestId = `request-${operation}`,
): RemoteControlRequest<K> {
  return {
    protocol: RemoteControlConst.protocol,
    requestId,
    operation,
    ...(operationId === undefined ? {} : { operationId }),
    body,
  } as RemoteControlRequest<K>
}

describe('lib-orchestrator/remoteControl/remoteControl', () => {
  it('dispatches every declared operation and exposes only the caller capabilities', async () => {
    const found = world()
    const requests: RemoteControlRequestUnion[] = [
      request('system.hello', {}),
      request('system.status', {}),
      request('projects.list', {}),
      request('sessions.list', {}),
      request('sessions.create', { spec: { kind: 'shell', directory: { mode: 'default' } } }, 'op-1'),
      request('sessions.reopen', { session: { kind: 'sessionId', sessionId: 'session-1' } }, 'op-2'),
      request('sessions.finalize', { session: { kind: 'sessionId', sessionId: 'session-1' } }, 'op-3'),
      request('sessions.transcript', {
        session: { kind: 'sessionId', sessionId: 'session-1' },
      }),
      request('agents.describe', {}),
      request('tabs.list', {}),
      request('tabs.open', { session: { kind: 'sessionId', sessionId: 'session-1' } }, 'op-4'),
      request('tabs.openFile', {
        session: { kind: 'sessionId', sessionId: 'session-1' },
        path: 'reports/report.md',
      }, 'op-5'),
      request('tabs.openCommit', { session: { kind: 'sessionId', sessionId: 'session-1' }, vcs: 'svn', message: 'Proposed' }, 'op-commit'),
      request('tabs.focus', { panelId: 'terminal:{}' }, 'op-6'),
      request('tabs.close', { panelId: 'terminal:{}' }, 'op-7'),
      request('terminal.peek', { session: { kind: 'sessionId', sessionId: 'session-1' } }),
      request('terminal.send', {
        session: { kind: 'sessionId', sessionId: 'session-1' },
        text: 'hello',
        enter: true,
      }, 'op-8'),
    ]
    expect(requests.map((item) => item.operation).sort()).toEqual([
      ...RemoteControlConst.operations,
      ...RemoteControlConst.optionalOperations,
    ].sort())
    for (const item of requests)
      expect(await found.control.execute(item, context())).toMatchObject({
        ok: true,
        operation: item.operation,
      })

    const hello = await found.control.execute(
      request('system.hello', {}),
      context(['system.hello', 'sessions.list']),
    )
    expect(hello).toMatchObject({
      ok: true,
      value: { operations: ['system.hello', 'sessions.list'] },
    })
    expect(found.reopened).toEqual(['session-1'])
    expect(found.finalized).toEqual(['session-1'])
    expect(found.transcriptReads).toEqual(['session-1'])
    expect(found.tabCalls.map((call) => call.method)).toEqual([
      'open',
      'openFile',
      'openCommit',
      'focus',
      'close',
    ])
    expect(found.tabCalls[0]?.args).toEqual([
      'session-1',
      'One - 001 - session-1',
      { plain: false },
    ])
    expect(found.tabCalls[1]?.args).toEqual([
      'session-1',
      'One - 001 - session-1',
      'reports/report.md',
      { plain: false },
    ])
    expect(found.terminalCalls.map((call) => call.method)).toEqual(['peek', 'send'])
  })

  it('opens a file through the matching plain session presentation', async () => {
    const plain = session('session-1', '001')
    plain.presentation = 'tab'
    const found = world({ sessions: [plain] })

    await expect(found.control.execute(request('tabs.openFile', {
      session: { kind: 'sessionId', sessionId: 'session-1' },
      path: 'reports/report.md',
    }, 'plain-file'), context())).resolves.toMatchObject({
      ok: true,
      value: { kind: 'file-opened', path: 'reports/report.md' },
    })
    expect(found.tabCalls).toEqual([{
      method: 'openFile',
      args: [
        'session-1',
        'One - 001 - session-1',
        'reports/report.md',
        { plain: true },
      ],
    }])
  })

  it('rejects malformed envelopes, unknown fields, bad selectors and missing operation ids', async () => {
    const found = world()
    const invalid = [
      null,
      {},
      { protocol: 'old', requestId: 'r1', operation: 'sessions.list', body: {} },
      { protocol: RemoteControlConst.protocol, requestId: 'r2', operation: 'unknown', body: {} },
      { protocol: RemoteControlConst.protocol, requestId: 'r3', operation: 'sessions.list', body: {}, extra: 1 },
      request('sessions.reopen', { session: { kind: 'sessionId', sessionId: 'session-1' } }),
      {
        ...request('sessions.list', {}),
        body: { extra: true },
      },
      {
        ...request('terminal.peek', { session: { kind: 'number', number: '001' } }),
        body: { session: { kind: 'number', number: '1' } },
      },
    ]
    const responses = await Promise.all(invalid.map((item) => found.control.execute(item, context())))
    expect(responses.map((response) => response.ok)).toEqual(invalid.map(() => false))
    expect(responses[2]).toMatchObject({ ok: false, error: { code: 'protocol-mismatch' } })
    expect(responses.filter((response) => !response.ok).map((response) => response.error.code))
      .toContain('invalid-request')
  })

  it('resolves exact ids, ordinary and fork numbers, and reports every ambiguous candidate', async () => {
    const found = world({ sessions: [
      session('one', '004', 'Q:\\Apps\\One'),
      session('two', '004', 'Q:\\Apps\\Two'),
      session('three', '005', 'Q:\\Apps\\Three'),
      session('fork', '014-015', 'Q:\\Apps\\One'),
    ] })
    const exact = await found.control.execute(request(
      'sessions.reopen',
      { session: { kind: 'sessionId', sessionId: 'two' } },
      'exact',
    ), context())
    const unique = await found.control.execute(request(
      'sessions.reopen',
      { session: { kind: 'number', number: '005' } },
      'unique',
    ), context())
    const uniqueFork = await found.control.execute(request(
      'sessions.reopen',
      { session: { kind: 'number', number: '014-015' } },
      'unique-fork',
    ), context())
    const ambiguous = await found.control.execute(request(
      'sessions.reopen',
      { session: { kind: 'number', number: '004' } },
      'ambiguous',
    ), context())
    const missing = await found.control.execute(request(
      'sessions.reopen',
      { session: { kind: 'number', number: '006' } },
      'missing',
    ), context())

    expect(exact).toMatchObject({ ok: true, value: { sessionId: 'two' } })
    expect(unique).toMatchObject({ ok: true, value: { sessionId: 'three' } })
    expect(uniqueFork).toMatchObject({ ok: true, value: { sessionId: 'fork' } })
    expect(ambiguous).toMatchObject({
      ok: false,
      error: {
        code: 'conflict',
        data: { candidates: [{ sessionId: 'one' }, { sessionId: 'two' }] },
      },
    })
    expect(missing).toMatchObject({ ok: false, error: { code: 'not-found' } })
    expect(found.reopened).toEqual(['two', 'three', 'fork'])
  })

  it('refuses tabs.openFile for an unknown session before calling the tabs port', async () => {
    const found = world()

    expect(await found.control.execute(request('tabs.openFile', {
      session: { kind: 'sessionId', sessionId: 'missing-session' },
      path: 'reports/report.md',
    }, 'missing-file-open'), context())).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    })
    expect(found.tabCalls.filter((call) => call.method === 'openFile')).toHaveLength(0)
  })

  it('replays a mutation once and conflicts when the same operation id names another body', async () => {
    const found = world()
    const first = request(
      'sessions.create',
      { spec: { kind: 'shell', directory: { mode: 'default' }, title: 'One' } },
      'same-operation',
      'first-request',
    )
    const replay = { ...first, requestId: 'second-request' }
    const conflict = request(
      'sessions.create',
      { spec: { kind: 'shell', directory: { mode: 'default' }, title: 'Two' } },
      'same-operation',
      'third-request',
    )

    const firstResponse = await found.control.execute(first, context())
    const replayResponse = await found.control.execute(replay, context())
    const conflictResponse = await found.control.execute(conflict, context())

    expect(firstResponse).toMatchObject({ ok: true, value: { session: { sessionId: 'created-1' } } })
    expect(replayResponse).toMatchObject({
      ok: true,
      requestId: 'second-request',
      value: { session: { sessionId: 'created-1' } },
    })
    expect(conflictResponse).toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect(found.creates()).toBe(1)
  })

  it('replays tabs.openFile without opening the file twice', async () => {
    const found = world()
    const first = request('tabs.openFile', {
      session: { kind: 'sessionId', sessionId: 'session-1' },
      path: 'reports/report.md',
    }, 'same-file-open', 'first-file-request')
    const replay = { ...first, requestId: 'second-file-request' }
    const conflict = request('tabs.openFile', {
      session: { kind: 'sessionId', sessionId: 'session-1' },
      path: 'reports/other.md',
    }, 'same-file-open', 'third-file-request')

    expect(await found.control.execute(first, context())).toMatchObject({
      ok: true,
      value: { kind: 'file-opened', path: 'reports/report.md' },
    })
    expect(await found.control.execute(replay, context())).toMatchObject({
      ok: true,
      requestId: 'second-file-request',
      value: { kind: 'file-opened', path: 'reports/report.md' },
    })
    expect(await found.control.execute(conflict, context())).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    })
    expect(found.tabCalls.filter((call) => call.method === 'openFile')).toHaveLength(1)
  })

  it('keeps a tree session after a tab refusal and discards a failed plain session', async () => {
    const tabOpen: RemoteControlStepResult<RemoteControlTabCommandDto> = {
      ok: false,
      error: { code: 'unavailable', detail: 'renderer unavailable' },
    }
    const found = world({ tabOpen })
    const tree = await found.control.execute(request('sessions.create', {
      spec: { kind: 'shell', directory: { mode: 'default' } },
      openTab: true,
    }, 'tree'), context())
    const plain = await found.control.execute(request('sessions.create', {
      spec: { kind: 'shell', directory: { mode: 'default' }, presentation: 'tab' },
      openTab: true,
    }, 'plain'), context())

    expect(tree).toMatchObject({
      ok: true,
      value: { tabOpen: { ok: false }, plainCleanup: null },
    })
    expect(plain).toMatchObject({
      ok: true,
      value: { tabOpen: { ok: false }, plainCleanup: { ok: true } },
    })
    expect(found.tabCalls.map((call) => call.args[2])).toEqual([
      { plain: false },
      { plain: true },
    ])
    expect(found.discarded).toEqual(['created-2'])
  })

  it('applies category filters, canonical terminal options and capability refusals', async () => {
    const found = world()
    const projects = await found.control.execute(
      request('projects.list', { categoryId: 'code', sort: 'recent' }),
      context(),
    )
    const peek = await found.control.execute(request('terminal.peek', {
      session: { kind: 'number', number: '001' },
      cols: 100,
      rows: 30,
      timeoutMs: 500,
    }), context())
    const forbidden = await found.control.execute(
      request('sessions.list', {}),
      context(['system.hello']),
    )

    expect(projects).toMatchObject({
      ok: true,
      value: { categories: [{ category: { id: 'code' }, listing: { ok: true } }] },
    })
    expect(peek).toMatchObject({ ok: true, value: { terminalOutputUntrusted: true } })
    expect(found.terminalCalls[0]).toEqual({
      method: 'peek',
      args: ['session-1', { cols: 100, rows: 30, timeoutMs: 500 }],
    })
    expect(forbidden).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('reads a transcript only after canonical selection and never exposes it to a peer', async () => {
    const found = world({ sessions: [
      session('one', '004', 'Q:\\Apps\\One'),
      session('two', '004', 'Q:\\Apps\\Two'),
      session('unique', '005', 'Q:\\Apps\\Three'),
    ] })
    const allowed = context([...RemoteControlConst.operations, ...RemoteControlConst.optionalOperations])

    const exact = await found.control.execute(request(
      'sessions.transcript',
      { session: { kind: 'sessionId', sessionId: 'unique' } },
    ), allowed)
    const number = await found.control.execute(request(
      'sessions.transcript',
      { session: { kind: 'number', number: '005' } },
    ), allowed)
    const ambiguous = await found.control.execute(request(
      'sessions.transcript',
      { session: { kind: 'number', number: '004' } },
    ), allowed)
    const peer = context(RemoteControlPeerConst.controlOperations)
    peer.callerKind = 'remote-peer'
    const forbidden = await found.control.execute(request(
      'sessions.transcript',
      { session: { kind: 'sessionId', sessionId: 'unique' } },
    ), peer)
    const peerHello = await found.control.execute(request('system.hello', {}), peer)

    expect(exact).toMatchObject({
      ok: true,
      value: {
        sessionId: 'unique',
        transcriptContentUntrusted: true,
        reading: { kind: 'messages', messages: [{ text: 'untrusted transcript text' }] },
      },
    })
    expect(number).toMatchObject({ ok: true, value: { sessionId: 'unique' } })
    expect(ambiguous).toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect(forbidden).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    /*
     * A peer is offered `agents.describe` and nothing else optional: it may ask what that computer
     * can start an agent on, and may still not read a transcript or open a file in a tab.
     */
    expect(peerHello).toMatchObject({
      ok: true,
      value: {
        operations: RemoteControlPeerConst.controlOperations
          .filter((operation) => operation !== 'agents.describe'),
        optionalOperations: ['agents.describe'],
      },
    })
    expect(found.transcriptReads).toEqual(['unique', 'unique'])
  })

  /*
   * The offer a remote create is composed from, and the reason it comes from HERE: the catalog and
   * the configured value describe THIS computer's CLIs, and the asking side's own list would name
   * versions that machine never had.
   */
  it('describes this computer’s own agents and carries nothing but the offer', async () => {
    const found = world()

    const described = await found.control.execute(request('agents.describe', {}), context())

    expect(described).toMatchObject({
      ok: true,
      value: {
        agents: [
          { agentId: 'claude', configuredModel: 'opus', models: [{ id: 'opus', kind: 'alias' }] },
          { agentId: 'codex', configuredModel: 'gpt-5.4-retired' },
        ],
      },
    })
    // The whole answer, key by key: a describe that ever grew a field carrying a token, a path or
    // an identity would be a secret leaving this computer to whoever paired with it.
    const value = (described as { value: RemoteControlAgentsDto }).value
    expect(Object.keys(value)).toEqual(['agents'])
    for (const agent of value.agents) {
      expect(Object.keys(agent).sort()).toEqual(['agentId', 'configuredModel', 'models'])
      for (const model of agent.models)
        expect(Object.keys(model).every((key) =>
          ['id', 'label', 'kind', 'context', 'efforts', 'note'].includes(key))).toBe(true)
    }
  })

  /* It reads and it is answered without an operation id: nothing about it is a mutation. */
  it('takes no operation id for agents.describe and refuses a body', async () => {
    const found = world()

    const described = await found.control.execute(request('agents.describe', {}), context())
    const withBody = await found.control.execute(
      { ...request('agents.describe', {}), body: { agentId: 'claude' } },
      context(),
    )

    expect(described).toMatchObject({ ok: true, operationId: null })
    expect(withBody).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  it('redacts unexpected failures from the response and reports them internally', async () => {
    const found = world()
    const broken = new RemoteControl({
      system: { identity: () => { throw new Error('secret failure detail') } },
      projects: {
        listCategories: async () => [],
        listProjects: async () => ({
          ok: false,
          code: 'category-not-found',
          detail: 'unused',
        }),
      },
      sessions: {
        snapshot: () => snapshot(found.sessions),
        createSession: async () => ({ ok: false, code: 'invalid-spec', detail: 'unused' }),
        reopenSession: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        finalizeSession: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        discardPlainSession: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
      },
      tabs: {
        list: async () => [],
        open: async () => successTab('opened'),
        openCommit: async () => ({ ok: true, value: { kind: 'commit-opened', panelId: 'commit-panel', windowId: 'main', scopeRoot: 'Q:/app', messageApplied: true } }),
      openFile: async (_sessionId, _tabTitle, path, _options) => successFile(path),
        focus: async () => successTab('focused-existing'),
        close: async () => successTab('closed'),
      },
      terminal: {
        peek: async () => ({ ok: false, error: { code: 'timeout', detail: 'unused' } }),
        send: async () => ({ ok: false, error: { code: 'timeout', detail: 'unused' } }),
      },
      transcript: {
        read: async () => ({ kind: 'none', code: 'not-agent', reason: 'unused' }),
      },
      agents: { describe: () => ({ agents: [] }) },
      onError: (message) => found.errors.push(message),
    })
    const response = await broken.execute(request('system.hello', {}), context())
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'operation-failed', detail: 'The operation failed unexpectedly' },
    })
    expect(JSON.stringify(response)).not.toContain('secret failure detail')
    expect(found.errors[0]).toContain('secret failure detail')
  })

  /*
   * Opening a tab is `tabs.open` whoever asks. A peer paired with `control:sessions.create` and
   * nothing else asked for `openTab: true` and got the tab anyway, because the only place that
   * pairing of flags was ever checked was the CLI's own argument parser - and a peer does not go
   * through one. The refusal has to land BEFORE the session exists, or the caller is punished with
   * a session it did not want and cannot see.
   */
  it('refuses openTab from a caller without tabs.open and creates no session', async () => {
    const found = world()
    const response = await found.control.execute(
      request(
        'sessions.create',
        { spec: { kind: 'shell', directory: { mode: 'default' } }, openTab: true },
        'op-no-tab',
      ),
      context(['sessions.create']),
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(found.creates()).toBe(0)
    expect(found.tabCalls).toEqual([])

    // The same request goes through once that caller may open tabs.
    const allowed = await found.control.execute(
      request(
        'sessions.create',
        { spec: { kind: 'shell', directory: { mode: 'default' } }, openTab: true },
        'op-with-tab',
      ),
      context(['sessions.create', 'tabs.open']),
    )
    expect(allowed.ok).toBe(true)
    expect(found.creates()).toBe(1)
    expect(found.tabCalls.map((call) => call.method)).toEqual(['open'])
  })
})
