import { describe, expect, it } from 'vitest'

import type { ProjectListResult } from '../projectManager/projectManagerApi.types'
import type {
  SessionColorName,
  SessionDetailsSaved,
  SessionGroup,
  SessionInfo,
  SessionsOpResult,
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
import { SessionsSnapshotValidation } from '../sessionManager/sessionsSnapshotValidation'

interface World {
  control: RemoteControl
  sessions: SessionInfo[]
  creates: () => number
  colored: { sessionId: string; color: SessionColorName }[]
  noted: { sessionId: string; note: string | null }[]
  groupAssigns: { sessionId: string; group: SessionGroup }[]
  reopened: string[]
  finalized: string[]
  removed: string[]
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
  groupAssign?: RemoteControlStepResult<{ group: SessionGroup }>
  setColor?: SessionsOpResult
  setNote?: SessionsOpResult<SessionDetailsSaved>
  remove?: SessionsOpResult
}): World {
  const sessions = options?.sessions ?? [session('session-1', '001')]
  let creates = 0
  const colored: { sessionId: string; color: SessionColorName }[] = []
  const noted: { sessionId: string; note: string | null }[] = []
  const groupAssigns: { sessionId: string; group: SessionGroup }[] = []
  const reopened: string[] = []
  const finalized: string[] = []
  const removed: string[] = []
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
      createSession: async () => {
        creates += 1
        const created = session(`created-${creates}`, '002')
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
      removeSession: async (sessionId) => {
        removed.push(sessionId)
        return options?.remove ?? { ok: true, value: undefined }
      },
      setSessionColor: async (sessionId, color) => {
        colored.push({ sessionId, color })
        return options?.setColor ?? { ok: true, value: undefined }
      },
      // The record's own rule, kept here so the answer is what a real save would have stored.
      setSessionDetails: async (sessionId, update) => {
        if (update.note === undefined) throw new Error('The note is the only detail this library writes')
        const note = update.note?.trim() ?? ''
        noted.push({ sessionId, note: note === '' ? null : note })
        const found = sessions.find((candidate) => candidate.sessionId === sessionId)
        if (found !== undefined) {
          if (note === '') delete found.note
          else found.note = note
        }
        return options?.setNote ?? { ok: true, value: { titleChanged: false, notifyAgent: null } }
      },
    },
    groups: {
      read: () => new Map(groupAssigns.map(({ sessionId, group }) => [sessionId, group === 'none' ? null : group])),
      assign: (sessionId, group) => {
        groupAssigns.push({ sessionId, group })
        return options?.groupAssign ?? { ok: true, value: { group } }
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
      commitStatus: (commitSessionId) => ({ ok: true, value: { kind: 'commit-status', commitSessionId, sessionId: 'session-1', vcs: 'svn',
        scopeRoot: 'Q:/app', state: 'cancelled', closed: true, revision: null, detail: null } }),
      cancelCommit: async (commitSessionId) => {
        tabCalls.push({ method: 'cancelCommit', args: [commitSessionId] })
        return { ok: true, value: { kind: 'commit-status', commitSessionId, sessionId: 'session-1', vcs: 'svn',
          scopeRoot: 'Q:/app', state: 'cancelled', closed: true, revision: null, detail: null } }
      },
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
      deliver: async (...args) => {
        terminalCalls.push({ method: 'deliver', args: args.slice(0, 3) })
        const reading = await args[3].transcript()
        return {
          ok: true,
          value: {
            sessionId: args[0],
            accepted: true,
            characterCount: args[1].length,
            delivered: true,
            input: args[2].input,
            composeProof: 'text',
            proof: reading.kind === 'messages' ? 'transcript' : 'working',
            submitKey: 'enter',
            readyAfterMs: 1,
            submittedAfterMs: 1,
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
    colored,
    noted,
    groupAssigns,
    reopened,
    finalized,
    removed,
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
  it('replays cancellation once and refuses callers without its capability', async () => {
    const found = world()
    const cancel = request('tabs.cancelCommit', { commitSessionId: '11111111-1111-4111-8111-111111111111' }, 'cancel-review')
    expect(await found.control.execute(cancel, context(['tabs.commitStatus']))).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(found.tabCalls).toEqual([])
    expect(await found.control.execute(cancel, context())).toMatchObject({ ok: true, value: { state: 'cancelled', closed: true } })
    expect(await found.control.execute(cancel, context())).toMatchObject({ ok: true, value: { state: 'cancelled', closed: true } })
    expect(found.tabCalls).toEqual([{ method: 'cancelCommit', args: [cancel.body.commitSessionId] }])
  })
  it('dispatches every declared operation and exposes only the caller capabilities', async () => {
    const found = world({ sessions: [
      session('session-1', '001'),
      { ...session('agent-9', '009'), kind: 'agent', agent: { agentId: 'codex' } },
    ] })
    const requests: RemoteControlRequestUnion[] = [
      request('system.hello', {}),
      request('system.status', {}),
      request('projects.list', {}),
      request('sessions.list', {}),
      request('sessions.create', { spec: { kind: 'shell', directory: { mode: 'default' } } }, 'op-1'),
      request('sessions.reopen', { session: { kind: 'sessionId', sessionId: 'session-1' } }, 'op-2'),
      request('sessions.finalize', { session: { kind: 'sessionId', sessionId: 'session-1' } }, 'op-3'),
      request('sessions.remove', { session: { kind: 'sessionId', sessionId: 'session-1' } }, 'op-remove'),
      request('sessions.transcript', {
        session: { kind: 'sessionId', sessionId: 'session-1' },
      }),
      request('sessions.color', {
        session: { kind: 'sessionId', sessionId: 'session-1' },
        color: 'cyan',
      }, 'op-color'),
      request('sessions.group', {
        session: { kind: 'sessionId', sessionId: 'session-1' },
        group: 'waiting',
      }, 'op-group'),
      request('sessions.note', { session: { kind: 'sessionId', sessionId: 'session-1' } }),
      request('sessions.setNote', {
        session: { kind: 'sessionId', sessionId: 'session-1' },
        note: 'waiting for the review',
      }, 'op-note'),
      request('agents.describe', {}),
      request('tabs.list', {}),
      request('tabs.open', { session: { kind: 'sessionId', sessionId: 'session-1' } }, 'op-4'),
      request('tabs.openFile', {
        session: { kind: 'sessionId', sessionId: 'session-1' },
        path: 'reports/report.md',
      }, 'op-5'),
      request('tabs.openCommit', { session: { kind: 'sessionId', sessionId: 'session-1' }, vcs: 'svn', message: 'Proposed' }, 'op-commit'),
      request('tabs.commitStatus', { commitSessionId: '11111111-1111-4111-8111-111111111111' }),
      request('tabs.cancelCommit', { commitSessionId: '11111111-1111-4111-8111-111111111111' }, 'op-cancel-commit'),
      request('tabs.focus', { panelId: 'terminal:{}' }, 'op-6'),
      request('tabs.close', { panelId: 'terminal:{}' }, 'op-7'),
      request('terminal.peek', { session: { kind: 'sessionId', sessionId: 'session-1' } }),
      request('terminal.send', {
        session: { kind: 'sessionId', sessionId: 'session-1' },
        text: 'hello',
        enter: true,
      }, 'op-8'),
      request('terminal.deliver', {
        session: { kind: 'sessionId', sessionId: 'agent-9' },
        text: 'hello',
        input: 'typed',
      }, 'op-9'),
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
    expect(found.transcriptReads).toEqual(['session-1', 'agent-9'])
    expect(found.colored).toEqual([{ sessionId: 'session-1', color: 'cyan' }])
    expect(found.groupAssigns).toEqual([{ sessionId: 'session-1', group: 'waiting' }])
    expect(found.noted).toEqual([{ sessionId: 'session-1', note: 'waiting for the review' }])
    expect(found.tabCalls.map((call) => call.method)).toEqual([
      'open',
      'openFile',
      'openCommit',
      'cancelCommit',
      'focus',
      'close',
    ])
    expect(found.tabCalls[0]?.args).toEqual(['session-1', 'One - 001 - session-1'])
    expect(found.tabCalls[1]?.args).toEqual([
      'session-1',
      'One - 001 - session-1',
      'reports/report.md',
    ])
    expect(found.terminalCalls.map((call) => call.method)).toEqual(['peek', 'send', 'deliver'])
  })

  /**
   * The pair a scheduler repaints a running session with. Both name the value rather than toggling
   * it, so what the request says is what the session ends up carrying, and the same request sent
   * twice leaves it there.
   */
  it('repaints and refiles a session that already exists, by number as well as by id', async () => {
    const found = world()

    await expect(found.control.execute(request('sessions.color', {
      session: { kind: 'number', number: '001' },
      color: 'magenta',
    }, 'paint-1'), context())).resolves.toMatchObject({
      ok: true,
      value: { sessionId: 'session-1', color: 'magenta' },
    })
    await expect(found.control.execute(request('sessions.group', {
      session: { kind: 'sessionId', sessionId: 'session-1' },
      group: 'automation',
    }, 'file-1'), context())).resolves.toMatchObject({
      ok: true,
      value: { sessionId: 'session-1', group: 'automation' },
    })

    expect(found.colored).toEqual([{ sessionId: 'session-1', color: 'magenta' }])
    expect(found.groupAssigns).toEqual([{ sessionId: 'session-1', group: 'automation' }])
  })

  /**
   * The note is the one session field a caller writes in order to READ it back: a scheduler leaves
   * the sentence saying what the session waits for, and its next pass has to see what it left.
   * Both halves answer the stored value, which is why the write is answered out of the snapshot
   * rather than out of the request - the record trims, and keeps no note of nothing.
   */
  it('writes, reads back and clears the note of a session, by number as well as by id', async () => {
    const found = world()

    await expect(found.control.execute(request('sessions.note', {
      session: { kind: 'number', number: '001' },
    }), context())).resolves.toMatchObject({
      ok: true,
      value: { sessionId: 'session-1', note: null },
    })
    await expect(found.control.execute(request('sessions.setNote', {
      session: { kind: 'number', number: '001' },
      note: '  waiting for the SVN review  ',
    }, 'write-1'), context())).resolves.toMatchObject({
      ok: true,
      value: { sessionId: 'session-1', note: 'waiting for the SVN review' },
    })
    await expect(found.control.execute(request('sessions.note', {
      session: { kind: 'sessionId', sessionId: 'session-1' },
    }), context())).resolves.toMatchObject({
      ok: true,
      value: { sessionId: 'session-1', note: 'waiting for the SVN review' },
    })
    await expect(found.control.execute(request('sessions.setNote', {
      session: { kind: 'sessionId', sessionId: 'session-1' },
      note: null,
    }, 'clear-1'), context())).resolves.toMatchObject({
      ok: true,
      value: { sessionId: 'session-1', note: null },
    })

    expect(found.noted).toEqual([
      { sessionId: 'session-1', note: 'waiting for the SVN review' },
      { sessionId: 'session-1', note: null },
    ])
  })

  it('reports a note the records store refused, and writes nothing to the session', async () => {
    const refusing = world({
      setNote: { ok: false, code: 'records-latched', detail: 'Session records are not accepting writes' },
    })

    await expect(refusing.control.execute(request('sessions.setNote', {
      session: { kind: 'sessionId', sessionId: 'session-1' },
      note: 'blocked on the other computer',
    }, 'write-2'), context())).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation-failed' },
    })
  })

  /**
   * A move is the WHOLE request here, unlike inside a create where a refused assignment leaves a
   * session the caller still has to be told about. Nothing exists afterwards that the caller would
   * be holding without knowing, so the refusal is the answer.
   */
  it('fails the move when the client state refuses the write, and names the session it cannot find', async () => {
    const refusing = world({
      groupAssign: { ok: false, error: { code: 'unavailable', detail: 'Client state is not accepting writes' } },
    })

    await expect(refusing.control.execute(request('sessions.group', {
      session: { kind: 'sessionId', sessionId: 'session-1' },
      group: 'waiting',
    }, 'file-2'), context())).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    })

    const missing = world()
    await expect(missing.control.execute(request('sessions.color', {
      session: { kind: 'sessionId', sessionId: 'nobody' },
      color: 'teal',
    }, 'paint-2'), context())).resolves.toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    })
    expect(missing.colored).toEqual([])

    // A colour the session manager itself refuses is the library's answer, not a redacted failure.
    const refused = world({ setColor: { ok: false, code: 'not-found', detail: 'no such record' } })
    await expect(refused.control.execute(request('sessions.color', {
      session: { kind: 'sessionId', sessionId: 'session-1' },
      color: 'teal',
    }, 'paint-3'), context())).resolves.toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    })
  })

  it('removes an ended record and refuses a live one as a conflict without stopping it', async () => {
    const ended = world()
    await expect(ended.control.execute(request('sessions.remove', {
      session: { kind: 'number', number: '001' },
    }, 'remove-1'), context())).resolves.toMatchObject({
      ok: true,
      value: { sessionId: 'session-1' },
    })
    expect(ended.removed).toEqual(['session-1'])

    const live = world({ remove: {
      ok: false,
      code: 'live-refused',
      detail: 'Session session-1 is live; stop it before removing it',
    } })
    await expect(live.control.execute(request('sessions.remove', {
      session: { kind: 'sessionId', sessionId: 'session-1' },
    }, 'remove-2'), context())).resolves.toMatchObject({
      ok: false,
      error: { code: 'conflict', data: { sourceCode: 'live-refused' } },
    })
    expect(live.terminalCalls).toEqual([])

    const missing = world()
    await expect(missing.control.execute(request('sessions.remove', {
      session: { kind: 'sessionId', sessionId: 'nobody' },
    }, 'remove-3'), context())).resolves.toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    })
    expect(missing.removed).toEqual([])

    // Deleting a record is local-only: a peer is never offered it, so a peer request is refused.
    const peer = context(RemoteControlPeerConst.controlOperations)
    peer.callerKind = 'remote-peer'
    await expect(ended.control.execute(request('sessions.remove', {
      session: { kind: 'sessionId', sessionId: 'session-1' },
    }, 'remove-4'), peer)).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(RemoteControlPeerConst.controlOperations).not.toContain('sessions.remove')
    expect(ended.removed).toEqual(['session-1'])
  })

  it('opens a file on the tab of the session it names', async () => {
    const found = world({ sessions: [session('session-1', '001')] })

    await expect(found.control.execute(request('tabs.openFile', {
      session: { kind: 'sessionId', sessionId: 'session-1' },
      path: 'reports/report.md',
    }, 'plain-file'), context())).resolves.toMatchObject({
      ok: true,
      value: { kind: 'file-opened', path: 'reports/report.md' },
    })
    expect(found.tabCalls).toEqual([{
      method: 'openFile',
      args: ['session-1', 'One - 001 - session-1', 'reports/report.md'],
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

  it('lists the current group after a move and null for sessions in no group', async () => {
    const found = world({ sessions: [session('session-1', '001'), session('session-2', '002')] })
    await expect(found.control.execute(request('sessions.group', {
      session: { kind: 'sessionId', sessionId: 'session-1' }, group: 'waiting',
    }, 'move'), context())).resolves.toMatchObject({ ok: true })
    await expect(found.control.execute(request('sessions.list', {}), context())).resolves.toMatchObject({
      ok: true,
      value: { sessions: [{ sessionId: 'session-1', group: 'waiting' }, { sessionId: 'session-2', group: null }] },
    })
    await found.control.execute(request('sessions.group', {
      session: { kind: 'sessionId', sessionId: 'session-1' }, group: 'none',
    }, 'clear'), context())
    await expect(found.control.execute(request('sessions.list', {}), context())).resolves.toMatchObject({
      ok: true, value: { sessions: [{ group: null }, { group: null }] },
    })
    const listed = await found.control.execute(request('sessions.list', {}), context())
    if (!listed.ok) throw new Error(listed.error.detail)
    const legacy = SessionsSnapshotValidation.parse(listed.value)
    expect(legacy?.sessions.map(({ sessionId, title }) => ({ sessionId, title })))
      .toEqual(found.sessions.map(({ sessionId, title }) => ({ sessionId, title })))
    expect(found.sessions.every((entry) => !Object.hasOwn(entry, 'group'))).toBe(true)
  })

  it('files a created session under the group the create named, before any tab is drawn', async () => {
    const found = world()

    const created = await found.control.execute(request('sessions.create', {
      spec: { kind: 'shell', directory: { mode: 'default' } },
      openTab: true,
      group: 'automation',
    }, 'grouped'), context())

    expect(created).toMatchObject({
      ok: true,
      value: { groupAssign: { ok: true, value: { group: 'automation' } } },
    })
    expect(found.groupAssigns).toEqual([{ sessionId: 'created-1', group: 'automation' }])
    expect(found.tabCalls.filter((call) => call.method === 'open')).toHaveLength(1)
  })

  /*
   * The session is the thing that was asked for; the section it sits in is not. A store that refuses
   * the write leaves a session the caller has to be TOLD about, so the step fails inside a create
   * that succeeded rather than taking the create down with it.
   */
  it('reports a refused group assignment without failing the create', async () => {
    const found = world({
      groupAssign: { ok: false, error: { code: 'unavailable', detail: 'state is latched' } },
    })

    const created = await found.control.execute(request('sessions.create', {
      spec: { kind: 'shell', directory: { mode: 'default' } },
      group: 'blocked',
    }, 'refused-group'), context())

    expect(created).toMatchObject({
      ok: true,
      value: {
        session: { sessionId: 'created-1' },
        groupAssign: { ok: false, error: { code: 'unavailable' } },
        tabOpen: null,
      },
    })
  })

  it('assigns no group when the create names none', async () => {
    const found = world()

    const created = await found.control.execute(request('sessions.create', {
      spec: { kind: 'shell', directory: { mode: 'default' } },
    }, 'plain-create'), context())

    expect(created).toMatchObject({ ok: true, value: { groupAssign: null } })
    expect(found.groupAssigns).toEqual([])
  })

  it('keeps the session after a tab refusal, and says which step failed', async () => {
    const tabOpen: RemoteControlStepResult<RemoteControlTabCommandDto> = {
      ok: false,
      error: { code: 'unavailable', detail: 'renderer unavailable' },
    }
    const found = world({ tabOpen })
    const created = await found.control.execute(request('sessions.create', {
      spec: { kind: 'shell', directory: { mode: 'default' } },
      openTab: true,
    }, 'tree'), context())

    expect(created).toMatchObject({ ok: true, value: { tabOpen: { ok: false } } })
    expect(found.tabCalls.map((call) => call.args.length)).toEqual([2])
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
     * What a peer is offered out of the optional set: what that computer can start an agent on, the
     * two mutations that repaint a session it runs, and the note it writes and reads back. It may
     * still not read a transcript or open a file in a tab.
     */
    expect(peerHello).toMatchObject({
      ok: true,
      value: {
        operations: [
          'system.hello',
          'system.status',
          'projects.list',
          'sessions.list',
          'sessions.create',
          'sessions.reopen',
          'sessions.finalize',
          'terminal.peek',
          'terminal.send',
        ],
        optionalOperations: [
          'agents.describe',
          'sessions.color',
          'sessions.group',
          'sessions.note',
          'sessions.setNote',
        ],
      },
    })
    expect(found.transcriptReads).toEqual(['unique', 'unique'])
  })

  /*
   * The offer a remote create is composed from, and the reason it comes from HERE: the catalog and
   * the configured value describe THIS computer's CLIs, and the asking side's own list would name
   * versions that machine never had.
   */
  it('delivers only to a live agent session, with defaults, once per operation id, and never for a peer', async () => {
    const agent = (sessionId: string, number: string, life: SessionInfo['life']): SessionInfo => ({
      ...session(sessionId, number),
      kind: 'agent',
      agent: { agentId: 'claude' },
      life,
    })
    const found = world({ sessions: [
      agent('agent-1', '010', 'live'),
      agent('ended-1', '011', 'ended'),
      session('shell-1', '012'),
      agent('twin-a', '013', 'live'),
      { ...agent('twin-b', '013', 'live'), directory: { mode: 'project', categoryId: 'code', projectPath: 'Q:\\Apps\\Two' } },
    ] })
    const deliver = (selector: RemoteControlRequest<'terminal.deliver'>['body']['session'], operationId: string) =>
      request('terminal.deliver', { session: selector, text: 'Read the file.' }, operationId)

    const delivered = await found.control.execute(deliver({ kind: 'sessionId', sessionId: 'agent-1' }, 'd-1'), context())
    const replayed = await found.control.execute(deliver({ kind: 'sessionId', sessionId: 'agent-1' }, 'd-1'), context())
    const shell = await found.control.execute(deliver({ kind: 'sessionId', sessionId: 'shell-1' }, 'd-2'), context())
    const ended = await found.control.execute(deliver({ kind: 'sessionId', sessionId: 'ended-1' }, 'd-3'), context())
    const ambiguous = await found.control.execute(deliver({ kind: 'number', number: '013' }, 'd-4'), context())
    const queued = await found.control.execute(request('terminal.deliver', {
      session: { kind: 'sessionId', sessionId: 'agent-1' },
      text: 'Next task.',
      queue: true,
    }, 'd-6'), context())
    const peer = context(RemoteControlPeerConst.controlOperations)
    peer.callerKind = 'remote-peer'
    const forbidden = await found.control.execute(deliver({ kind: 'sessionId', sessionId: 'agent-1' }, 'd-5'), peer)

    expect(delivered).toMatchObject({ ok: true, value: { sessionId: 'agent-1', delivered: true, input: 'paste', proof: 'transcript' } })
    expect(replayed).toMatchObject({ ok: true, value: { sessionId: 'agent-1' } })
    expect(shell).toMatchObject({
      ok: false,
      error: { code: 'invalid-request', data: { stage: 'validate', reason: 'shell-session', typed: false, entered: 0, hint: null, composer: null } },
    })
    expect(ended).toMatchObject({ ok: false, error: { code: 'not-found', data: { stage: 'attach', reason: 'not-live' } } })
    expect(ambiguous).toMatchObject({ ok: false, error: { code: 'conflict', data: { candidates: expect.any(Array) } } })
    expect(forbidden).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(RemoteControlPeerConst.controlOperations).not.toContain('terminal.deliver')
    expect(found.terminalCalls.filter((call) => call.method === 'deliver')).toEqual([{
      method: 'deliver',
      args: ['agent-1', 'Read the file.', { input: 'paste', readyTimeoutMs: 45_000, submitTimeoutMs: 10_000, queue: false }],
    }, {
      method: 'deliver',
      args: ['agent-1', 'Next task.', { input: 'paste', readyTimeoutMs: 45_000, submitTimeoutMs: 10_000, queue: true }],
    }])
    expect(queued).toMatchObject({ ok: true })
    expect(found.transcriptReads).toEqual(['agent-1', 'agent-1'])
  })

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
        removeSession: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        setSessionColor: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        setSessionDetails: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
      },
      groups: { read: () => new Map(), assign: (_sessionId, group) => ({ ok: true, value: { group } }) },
      tabs: {
        list: async () => [],
        open: async () => successTab('opened'),
        openCommit: async () => ({ ok: true, value: { kind: 'commit-opened', panelId: 'commit-panel', windowId: 'main', scopeRoot: 'Q:/app', messageApplied: true } }),
        openFile: async (_sessionId, _tabTitle, path) => successFile(path),
        focus: async () => successTab('focused-existing'),
        close: async () => successTab('closed'),
      },
      terminal: {
        peek: async () => ({ ok: false, error: { code: 'timeout', detail: 'unused' } }),
        send: async () => ({ ok: false, error: { code: 'timeout', detail: 'unused' } }),
        deliver: async () => ({ ok: false, error: { code: 'timeout', detail: 'unused' } }),
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
