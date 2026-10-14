import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { ProjectListResult } from '../projectManager/projectManagerApi.types'
import type {
  HostDebugStatus,
  HostPingResult,
  SessionsOpErrorCode,
  SessionColorName,
  SessionDetailsSaved,
  SessionGroup,
  SessionCreated,
  SessionCreateOrigin,
  SessionInfo,
  SessionCreateSpec,
  SessionNotifyDto,
  SessionScriptRequest,
  SessionScriptsReading,
  SessionsOpResult,
  SessionsSnapshot,
  SessionWorktreeState,
  SessionConflictList,
  SessionConflictResolved,
  WorktreeResultDto,
} from '../sessionManager/sessionManagerApi.types'
import {
  RemoteControl,
  type RemoteControlCallContext,
  type RemoteControlDeps,
} from './remoteControl'
import type {
  RemoteControlAgentsDto,
  RemoteControlOperation,
  RemoteControlOperationMap,
  RemoteControlRequest,
  RemoteControlRequestUnion,
  RemoteControlStepResult,
  RemoteControlTabCommandDto,
  RemoteControlTabOpenFileDto,
} from './remoteControlApi.types'
import { RemoteControlConst, RemoteControlDeliverConst } from './remoteControlProtocol'
import { SessionLimits } from '../sessionManager/sessionLimits'
import { RemoteControlPeerConst } from './remoteControlPeerProtocol'
import { SessionsSnapshotValidation } from '../sessionManager/sessionsSnapshotValidation'

interface World {
  control: RemoteControl
  sessions: SessionInfo[]
  creates: () => number
  colored: { sessionId: string; color: SessionColorName | null }[]
  noted: { sessionId: string; note: string | null }[]
  groupAssigns: { sessionId: string; group: SessionGroup }[]
  reopened: string[]
  finalized: string[]
  finalizeOptions: ({ expect?: 'stop'; acknowledgeSetup?: string } | undefined)[]
  removed: string[]
  worktreeCalls: { method: string; sessionId: string; acknowledgeSetup?: string }[]
  sessionCalls: { method: string; args: unknown[] }[]
  groupInherits: { parentSessionId: string; sessionId: string }[]
  tabCalls: { method: string; args: unknown[] }[]
  terminalCalls: { method: string; args: unknown[] }[]
  transcriptReads: string[]
  scriptCalls: { method: string; parentId: string; runId?: string; request?: SessionScriptRequest }[]
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

/** Every project read answers empty and every write succeeds, unless a test says otherwise. */
function projectsPort(overrides: Partial<RemoteControlDeps['projects']>): RemoteControlDeps['projects'] {
  const report = { operationId: null, directoryRenamed: true, providers: { claude: 'done', codex: 'done' }, leftoverCount: 0 } as const
  return {
    listCategories: async () => [],
    listProjects: async () => ({ ok: false, code: 'category-not-found', detail: 'unused' }),
    getConfig: async () => ({ ok: true, value: [] }),
    saveConfig: async () => ({ ok: true, value: undefined }),
    listProjectSessions: async () => ({ ok: true, value: { claude: [], codex: [], merged: [] } }),
    createProject: async (_categoryId, name) => ({ ok: true, value: { name, path: `Q:/Apps/${name}`, lastActivity: null } }),
    renameProject: async () => ({ ok: true, value: report }),
    moveProjectPrefix: async () => ({ ok: true, value: report }),
    archiveProject: async () => ({ ok: true, value: report }),
    previewDelete: async (_categoryId, name) => ({
      ok: true,
      value: {
        token: 'token-1', expiresAt: 1, projectPath: `Q:/Apps/${name}`, projectFileCount: 1,
        claude: { encodedDirectory: null, transcriptFiles: [] }, codex: { rolloutFiles: [] },
      },
    }),
    executeDelete: async () => ({ ok: true, value: { deletedPaths: 1, leftoverCount: 0 } }),
    ...overrides,
  }
}

function unusedHost(): RemoteControlDeps['host'] {
  const refused = async (): Promise<SessionsOpResult> => ({ ok: false, code: 'host-unreachable', detail: 'unused' })
  return {
    debugStatus: () => { throw new Error('unused') },
    pingHost: async () => { throw new Error('unused') },
    startHost: refused,
    restartHost: refused,
    stopHost: refused,
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
  worktreeEnding?: SessionsOpResult
  /** What a press of Finish on an SVN worktree and a review run's review answer. */
  finishPress?: SessionsOpResult<{ sessionId: string; actionId: string | null }>
  updateMain?: SessionsOpResult<{ sessionId: string; actionId: string }>
  actionReview?: SessionsOpResult<{ commitSessionId: string; scopeRoot: string }>
  proposeCommit?: SessionsOpResult<{ scopeRoot: string }>
  finalize?: SessionsOpResult
  created?: Partial<SessionCreated>
  worktree?: SessionsOpResult<SessionWorktreeState>
  conflicts?: SessionsOpResult<SessionConflictList>
  resolved?: SessionsOpResult<SessionConflictResolved>
  scripts?: SessionsOpResult<SessionScriptsReading>
  runScript?: SessionsOpResult<{ runId: string }>
  results?: WorktreeResultDto[]
  notifies?: SessionNotifyDto[]
  create?: (spec: SessionCreateSpec, origin?: SessionCreateOrigin) => Promise<SessionsOpResult<SessionCreated>>
}): World {
  const sessions = options?.sessions ?? [session('session-1', '001')]
  let creates = 0
  const colored: { sessionId: string; color: SessionColorName | null }[] = []
  const noted: { sessionId: string; note: string | null }[] = []
  const groupAssigns: { sessionId: string; group: SessionGroup }[] = []
  const reopened: string[] = []
  const finalized: string[] = []
  const finalizeOptions: ({ expect?: 'stop'; acknowledgeSetup?: string } | undefined)[] = []
  const removed: string[] = []
  const worktreeCalls: { method: string; sessionId: string; acknowledgeSetup?: string }[] = []
  const sessionCalls: { method: string; args: unknown[] }[] = []
  const groupInherits: { parentSessionId: string; sessionId: string }[] = []
  const tabCalls: { method: string; args: unknown[] }[] = []
  const terminalCalls: { method: string; args: unknown[] }[] = []
  const transcriptReads: string[] = []
  const scriptCalls: World['scriptCalls'] = []
  const errors: string[] = []
  const one = { name: 'One', path: 'Q:\\Apps\\One', lastActivity: null }
  const grouped = { name: 'Bots/Two', path: 'Q:\\Apps\\Bots\\Two', lastActivity: null }
  const listing: ProjectListResult = {
    entries: [
      {
        kind: 'group',
        name: 'Bots',
        title: 'Bots',
        path: 'Q:\\Apps\\Bots',
        entries: [{ kind: 'project', project: grouped }],
      },
      { kind: 'project', project: one },
    ],
    projects: [one, grouped],
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
    projects: projectsPort({
      listCategories: async () => [
        { id: 'code', label: 'Code', path: 'Q:\\Apps', available: true },
        { id: 'other', label: 'Other', path: 'Q:\\Other', available: false },
      ],
      listProjects: async (categoryId) => categoryId === 'code'
        ? { ok: true, value: listing }
        : { ok: false, code: 'category-unavailable', detail: 'offline' },
    }),
    sessions: {
      snapshot: () => snapshot(sessions),
      createSession: async (spec, origin) => {
        creates += 1
        if (options?.create !== undefined) return options.create(spec, origin)
        const created: SessionInfo = { ...session(`created-${creates}`, '002'),
          ...spec.parent === undefined ? {} : { parent: { ...spec.parent, sameProject: true } } }
        sessions.push(created)
        return { ok: true, value: { sessionId: created.sessionId, tabTitle: created.tabTitle, ...options?.created } }
      },
      reopenSession: async (sessionId) => {
        reopened.push(sessionId)
        return { ok: true, value: undefined }
      },
      finalizeSession: async (sessionId, finalizeOption) => {
        finalized.push(sessionId)
        finalizeOptions.push(finalizeOption)
        return options?.finalize ?? { ok: true, value: undefined }
      },
      conflictsOf: async (sessionId) => options?.conflicts
        ?? { ok: true, value: { sessionId, actionId: 'a1', stage: 'updating', summary: '1 conflict needs you', entries: [], more: 1 } },
      resolveConflict: async (sessionId, request) => {
        worktreeCalls.push({ method: `resolveConflict ${request.path} ${request.option}${request.confirm ? ' confirmed' : ''} by ${request.requestedBy}`, sessionId })
        return options?.resolved ?? { ok: true, value: { sessionId, path: request.path, state: 'settled', left: 2 } }
      },
      worktreeOf: async (sessionId) => options?.worktree ?? {
        ok: true,
        value: { sessionId, worktree: null, retired: null, finish: null, action: null, outcome: null, cleanup: null, receipts: [], step: null, workflow: null },
      },
      removeSession: async (sessionId) => {
        removed.push(sessionId)
        return options?.remove ?? { ok: true, value: undefined }
      },
      discardWorktree: async (sessionId) => {
        worktreeCalls.push({ method: 'discardWorktree', sessionId })
        return options?.worktreeEnding ?? { ok: true, value: undefined }
      },
      finishWorktreeSession: async (sessionId, press) => {
        worktreeCalls.push({
          method: `finishWorktree ${press.choice}${press.confirmWorking === true ? ' confirmed' : ''}${press.requestedBy === 'cli' ? '' : ` by ${press.requestedBy}`}`,
          sessionId,
          ...press.acknowledgeSetup === undefined ? {} : { acknowledgeSetup: press.acknowledgeSetup },
        })
        return options?.finishPress ?? { ok: true, value: { sessionId, actionId: 'action-1' } }
      },
      updateMain: async (sessionId, confirmLive, requestedBy) => {
        worktreeCalls.push({ method: `updateMain ${requestedBy} [${(confirmLive ?? []).join(',')}]`, sessionId })
        return options?.updateMain ?? { ok: true, value: { sessionId, actionId: 'update-1' } }
      },
      openActionReview: async (runId) => {
        worktreeCalls.push({ method: 'openActionReview', sessionId: runId })
        return options?.actionReview ?? { ok: true, value: { commitSessionId: 'commit-1', scopeRoot: 'Q:/Apps/One/.worktrees/014-fix' } }
      },
      worktreeResults: async (filter) => {
        sessionCalls.push({ method: 'worktreeResults', args: [filter] })
        return { ok: true, value: { results: (options?.results ?? []).filter((result) => filter.tag === undefined || result.tag === filter.tag) } }
      },
      notifies: async (filter) => {
        sessionCalls.push({ method: 'notifies', args: [filter] })
        return { ok: true, value: { notifies: (options?.notifies ?? []).filter((notify) => filter.sessionId === undefined || notify.sessionId === filter.sessionId) } }
      },
      children: async (sessionId) => ({ ok: true, value: { children: sessions.flatMap((child) => child.parent?.sessionId === sessionId
        ? [{ sessionId: child.sessionId, number: child.titleParts.number, title: child.title, agentId: child.agent?.agentId ?? null,
          life: child.life, kind: child.parent.kind, sameProject: child.parent.sameProject }]
        : []) } }),
      proposeCommit: async (sessionId, message) => {
        sessionCalls.push({ method: 'proposeCommit', args: [sessionId, message] })
        return options?.proposeCommit ?? { ok: true, value: { scopeRoot: 'Q:/Apps/One/.worktrees/014-fix' } }
      },
      acknowledgeWorktreeResult: async (actionId) => {
        sessionCalls.push({ method: 'acknowledgeWorktreeResult', args: [actionId] })
        return options?.results === undefined || options.results.some((result) => result.actionId === actionId)
          ? { ok: true, value: { actionId } }
          : { ok: false, code: 'not-found', detail: `No worktree result ${actionId}` }
      },
      retrySetup: async (sessionId, acknowledgeSetup) => {
        worktreeCalls.push({
          method: 'retrySetup',
          sessionId,
          ...(acknowledgeSetup === undefined ? {} : { acknowledgeSetup }),
        })
        return options?.worktreeEnding ?? { ok: true, value: undefined }
      },
      requestWorktreeCleanup: async (sessionId) => {
        worktreeCalls.push({ method: 'requestWorktreeCleanup', sessionId })
        return options?.worktreeEnding ?? { ok: true, value: undefined }
      },
      forkSession: async (sessionId, forkOptions) => {
        sessionCalls.push({ method: 'forkSession', args: [sessionId, forkOptions] })
        return { ok: true, value: { sessionId: 'forked-1', tabTitle: 'One - 001-002' } }
      },
      restartSession: async (sessionId) => {
        sessionCalls.push({ method: 'restartSession', args: [sessionId] })
        return { ok: true, value: undefined }
      },
      adoptOrphan: async (runtimeSessionId) => {
        sessionCalls.push({ method: 'adoptOrphan', args: [runtimeSessionId] })
        return { ok: true, value: undefined }
      },
      sessionReference: async (sessionId) => ({ ok: true, value: { text: `reference of ${sessionId}` } }),
      historyReferences: async () => ({ ok: true, value: { references: [] } }),
      openHistorySession: async () => ({ ok: true, value: { sessionId: 'history-1', tabTitle: 'One - 003' } }),
      nextSessionNumber: async () => ({ ok: true, value: { token: '002' } }),
      allocateSessionNumber: async (projectPath) => {
        sessionCalls.push({ method: 'allocateSessionNumber', args: [projectPath] })
        return { ok: true, value: { token: '002' } }
      },
      runScript: async (parentId, scriptRequest) => {
        scriptCalls.push({ method: 'runScript', parentId, request: scriptRequest })
        return options?.runScript ?? { ok: true, value: { runId: 'run-1' } }
      },
      scriptsOf: async (parentId, runId) => {
        scriptCalls.push({ method: 'scriptsOf', parentId, ...(runId === undefined ? {} : { runId }) })
        return options?.scripts ?? { ok: true, value: { sessionId: parentId, runs: [], log: null } }
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
      inherit: (parentSessionId, sessionId) => { groupInherits.push({ parentSessionId, sessionId }) },
    },
    host: {
      debugStatus: () => ({ capturedAt: 1 } as HostDebugStatus),
      pingHost: async () => ({ at: 1, ok: false, detail: 'unreachable' } as unknown as HostPingResult),
      startHost: async () => ({ ok: true, value: undefined }),
      restartHost: async (expected) => expected === 'host-1'
        ? { ok: true, value: undefined }
        : { ok: false, code: 'host-mismatch' as SessionsOpErrorCode, detail: 'another Host runs' },
      stopHost: async () => ({ ok: true, value: undefined }),
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
    finalizeOptions,
    removed,
    worktreeCalls,
    sessionCalls,
    groupInherits,
    tabCalls,
    terminalCalls,
    transcriptReads,
    scriptCalls,
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
      request('system.operations', {}),
      request('system.calls', {}),
      request('system.events', { waitMs: 0 }),
      request('projects.list', {}),
      request('sessions.list', {}),
      request('sessions.create', { spec: { kind: 'shell', directory: { mode: 'default' } } }, 'op-1'),
      request('sessions.reopen', { session: { kind: 'sessionId', sessionId: 'session-1' } }, 'op-2'),
      request('sessions.finalize', { session: { kind: 'sessionId', sessionId: 'session-1' } }, 'op-3'),
      request('sessions.remove', { session: { kind: 'sessionId', sessionId: 'session-1' } }, 'op-remove'),
      request('sessions.worktree', { session: { kind: 'sessionId', sessionId: 'session-1' } }),
      request('sessions.conflicts', { session: { kind: 'sessionId', sessionId: 'session-1' } }),
      request('sessions.resolveConflict', { session: { kind: 'sessionId', sessionId: 'session-1' }, path: '.aidocs/engines', option: 'keep-both' }, 'op-resolve'),
      request('sessions.discardWorktree', { session: { kind: 'sessionId', sessionId: 'session-1' } }, 'op-discard'),
      request('sessions.fork', { session: { kind: 'sessionId', sessionId: 'session-1' }, name: 'Branch' }, 'op-fork'),
      request('sessions.restart', { session: { kind: 'sessionId', sessionId: 'session-1' } }, 'op-restart'),
      request('sessions.setDetails', { session: { kind: 'sessionId', sessionId: 'session-1' }, update: { note: 'n' } }, 'op-details'),
      request('sessions.adoptOrphan', { runtimeSessionId: 'orphan-1' }, 'op-adopt'),
      request('sessions.reference', { session: { kind: 'sessionId', sessionId: 'session-1' } }),
      request('sessions.historyReferences', { directory: { mode: 'project', categoryId: 'code', projectPath: 'Q:\Apps\One' } }),
      request('sessions.openHistory', { spec: {
        directory: { mode: 'project', categoryId: 'code', projectPath: 'Q:\Apps\One' },
        agentId: 'claude', nativeSessionId: 'native-1', providerName: 'One', providerActive: false,
      } }, 'op-history'),
      request('sessions.nextNumber', { projectPath: 'Q:\Apps\One' }),
      request('sessions.allocateNumber', { projectPath: 'Q:\Apps\One' }, 'op-number'),
      request('host.status', {}),
      request('host.ping', {}),
      request('host.start', {}, 'op-host-start'),
      request('host.restart', { expectedHostInstanceId: 'host-1' }, 'op-host-restart'),
      request('host.stop', { expectedHostInstanceId: 'host-1' }, 'op-host-stop'),
      request('projects.config', {}),
      request('projects.saveConfig', { categories: [{ id: 'code', label: 'Code', path: 'Q:/Apps' }] }, 'op-config'),
      request('projects.categories', {}),
      request('projects.listing', { categoryId: 'code', sort: 'alpha' }),
      request('projects.sessions', { categoryId: 'code', projectName: 'One' }),
      request('projects.create', { categoryId: 'code', name: 'Two', virtualFolderPrefix: null }, 'op-project-create'),
      request('projects.rename', { categoryId: 'code', oldName: 'Two', newName: 'Three' }, 'op-project-rename'),
      request('projects.movePrefix', { categoryId: 'code', name: 'Three', targetPrefix: null }, 'op-project-move'),
      request('projects.archive', { categoryId: 'code', name: 'Three' }, 'op-project-archive'),
      request('projects.deletePreview', { categoryId: 'code', name: 'Three' }, 'op-project-preview'),
      request('projects.delete', { token: 'token-1' }, 'op-project-delete'),
      request('sessions.retrySetup', { session: { kind: 'sessionId', sessionId: 'session-1' } }, 'op-retry'),
      request('sessions.cleanupWorktree', { session: { kind: 'sessionId', sessionId: 'session-1' } }, 'op-cleanup'),
      request('sessions.transcript', {
        session: { kind: 'sessionId', sessionId: 'session-1' },
      }),
      request('sessions.scripts', { session: { kind: 'sessionId', sessionId: 'session-1' } }),
      request('sessions.runScript', { session: { kind: 'sessionId', sessionId: 'session-1' }, command: 'pnpm test' }, 'op-run'),
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
      request('sessions.finishWorktree', { session: { kind: 'sessionId', sessionId: 'session-1' }, choice: 'keep' }, 'op-finish-worktree'),
      request('sessions.updateMain', { session: { kind: 'sessionId', sessionId: 'session-1' }, confirmLive: ['session-2'] }, 'op-update-main'),
      request('sessions.worktreeReview', { session: { kind: 'sessionId', sessionId: 'session-1' } }, 'op-worktree-review'),
      request('sessions.worktreeResults', { tag: 'run-7' }),
      request('sessions.notifies', {}),
      request('sessions.children', { sessionId: 'session-1' }),
      request('sessions.acknowledgeWorktreeResult', { actionId: 'action-1' }, 'op-acknowledge-result'),
      request('sessions.proposeCommit', { session: { kind: 'sessionId', sessionId: 'session-1' }, message: 'Fix login' }, 'op-propose'),
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
    expect(found.noted).toEqual([{ sessionId: 'session-1', note: 'n' }, { sessionId: 'session-1', note: 'waiting for the review' }])
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

    // An SVN worktree with changes, or one a process holds, keeps the session: the caller resolves it.
    for (const code of ['dirty', 'locked'] as const) {
      const kept = world({ remove: { ok: false, code, detail: `Session session-1 keeps its worktree (${code})` } })
      await expect(kept.control.execute(request('sessions.remove', {
        session: { kind: 'sessionId', sessionId: 'session-1' },
      }, `remove-${code}`), context())).resolves.toMatchObject({
        ok: false,
        error: { code: 'conflict', data: { sourceCode: code } },
      })
    }

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

  /**
   * A script that means to stop a running session says so, and a session that ended meanwhile is
   * then never handed to its Finish Commit by the same press.
   */
  it('refuses a finalize whose next step is no stop as a conflict, and passes the expectation on', async () => {
    const ended = world({ finalize: {
      ok: false,
      code: 'live-refused',
      detail: 'Session session-1: the next Finish step is finish-worktree, not a stop; nothing was done',
    } })
    await expect(ended.control.execute(request('sessions.finalize', {
      session: { kind: 'number', number: '001' },
      expect: 'stop',
    }, 'stop-1'), context())).resolves.toMatchObject({
      ok: false,
      error: { code: 'conflict', data: { sourceCode: 'live-refused' } },
    })
    expect(ended.finalizeOptions).toEqual([{ expect: 'stop' }])

    const plain = world()
    await expect(plain.control.execute(request('sessions.finalize', {
      session: { kind: 'sessionId', sessionId: 'session-1' },
    }, 'stop-2'), context())).resolves.toMatchObject({ ok: true, value: { sessionId: 'session-1' } })
    expect(plain.finalizeOptions).toEqual([{}])
  })

  it('passes the agreed hash on a finalize, and answers an unagreed after script with its agreement', async () => {
    const setup = { commands: ['after tests: pnpm test'], hash: 'hash-1' }
    const refused = world({ finalize: {
      ok: false,
      code: 'setup-not-acknowledged',
      detail: 'Q:/Apps/One asks to run 1 command in its worktrees, and this machine has not agreed to them',
      setup,
    } })
    await expect(refused.control.execute(request('sessions.finalize', {
      session: { kind: 'sessionId', sessionId: 'session-1' },
    }, 'finish-ask'), context())).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation-failed', data: { sourceCode: 'setup-not-acknowledged', setup } },
    })

    const agreed = world()
    await expect(agreed.control.execute(request('sessions.finalize', {
      session: { kind: 'sessionId', sessionId: 'session-1' },
      acknowledgeSetup: 'hash-1',
    }, 'finish-agreed'), context())).resolves.toMatchObject({ ok: true, value: { sessionId: 'session-1' } })
    expect(agreed.finalizeOptions).toEqual([{ acknowledgeSetup: 'hash-1' }])

    // The peer reaches the same operation, hash and all.
    const peer = context(RemoteControlPeerConst.controlOperations)
    peer.callerKind = 'remote-peer'
    await expect(agreed.control.execute(request('sessions.finalize', {
      session: { kind: 'sessionId', sessionId: 'session-1' },
      acknowledgeSetup: 'hash-2',
    }, 'finish-peer'), peer)).resolves.toMatchObject({ ok: true })
    expect(agreed.finalizeOptions).toEqual([{ acknowledgeSetup: 'hash-1' }, { acknowledgeSetup: 'hash-2' }])
  })

  it('maps a worktree state that stands in the way to a conflict, with the finish lines as the detail', async () => {
    for (const code of ['worktree-updated', 'worktree-conflict', 'worktree-removed'] as const) {
      const found = world({ finalize: { ok: false, code, detail: 'UPDATED to r12: other commits changed the project' } })
      await expect(found.control.execute(request('sessions.finalize', {
        session: { kind: 'sessionId', sessionId: 'session-1' },
      }, `finish-${code}`), context())).resolves.toMatchObject({
        ok: false,
        error: { code: 'conflict', detail: 'UPDATED to r12: other commits changed the project', data: { sourceCode: code } },
      })
    }
    for (const code of ['svn-failed', 'review-unavailable'] as const) {
      const found = world({ finalize: { ok: false, code, detail: 'svn: E170013' } })
      await expect(found.control.execute(request('sessions.finalize', {
        session: { kind: 'sessionId', sessionId: 'session-1' },
      }, `finish-${code}`), context())).resolves.toMatchObject({
        ok: false,
        error: { code: 'operation-failed', data: { sourceCode: code } },
      })
    }
  })

  it('answers a session worktree from its record, and a create with its number and worktree', async () => {
    const state: SessionWorktreeState = {
      sessionId: 'session-1',
      worktree: { kind: 'svn', worktreePath: 'Q:/Apps/One/.worktrees/014-fix', url: 'file:///repo/One', baseRevision: 12 },
      retired: null,
      finish: { phase: 'reviewing', scopeRoot: 'Q:/Apps/One/.worktrees/014-fix' },
      action: { kind: 'finish', stage: 'reviewing', needs: null, needsKind: null, review: { index: 1, count: 1, scopeRoot: 'Q:/Apps/One/.worktrees/014-fix' } },
      outcome: null,
      cleanup: { phase: 'pending', reason: 'in use' },
      receipts: [{ scopeRoot: 'Q:/Apps/One/.worktrees/014-fix', revision: 15, at: 3 }],
      step: { text: 'Reading conflicts after the update', detail: 'svn status --xml', progress: null, startedAt: 5 },
      workflow: null,
    }
    const found = world({
      worktree: { ok: true, value: state },
      created: { number: '014', worktree: state.worktree ?? undefined },
    })
    await expect(found.control.execute(request('sessions.worktree', {
      session: { kind: 'number', number: '001' },
    }), context())).resolves.toMatchObject({ ok: true, operationId: null, value: state })
    await expect(found.control.execute(request('sessions.create', {
      spec: { kind: 'shell', directory: { mode: 'default' }, worktree: { slug: 'fix', owner: 'Q:/Apps/One' } },
    }, 'create-wt'), context())).resolves.toMatchObject({
      ok: true,
      value: { session: { number: '014', worktree: { kind: 'svn', baseRevision: 12 } }, tabOpen: null, groupAssign: null },
    })

    const missing = world({ worktree: { ok: false, code: 'not-found', detail: 'No session session-1' } })
    await expect(missing.control.execute(request('sessions.worktree', {
      session: { kind: 'sessionId', sessionId: 'session-1' },
    }), context())).resolves.toMatchObject({ ok: false, error: { code: 'not-found' } })

    // A read a peer is never offered: a paired computer's build may refuse a capability it does not know.
    const peer = context(RemoteControlPeerConst.controlOperations)
    peer.callerKind = 'remote-peer'
    await expect(found.control.execute(request('sessions.worktree', {
      session: { kind: 'sessionId', sessionId: 'session-1' },
    }), peer)).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('answers the full conflict list of an action to a local caller, not-found without a set, and never to a peer', async () => {
    const entry = {
      path: '.aidocs/engines', kind: 'tree', state: 'person', by: null, saved: null,
      description: 'Your session added this folder with 2 files; r421 added it with 3 files.',
      options: [{ id: 'keep-both', label: 'Keep both', note: 'restores the files r421 added', loses: 'nothing' }],
    } as const
    const list: SessionConflictList = {
      sessionId: 'session-1', actionId: 'a1', stage: 'updating', summary: '60 conflicts need you',
      entries: Array.from({ length: 60 }, (_, index) => ({ ...entry, path: `src/f${index}.ts`, options: [...entry.options] })), more: 0,
    }
    const found = world({ conflicts: { ok: true, value: list } })
    const one = { session: { kind: 'sessionId', sessionId: 'session-1' } } as const
    expect(await found.control.execute(request('sessions.conflicts', one), context())).toMatchObject({ ok: true, operationId: null, value: list })
    const none = world({ conflicts: { ok: false, code: 'not-found', detail: 'Session session-1 has no conflicts of an SVN action' } })
    expect(await none.control.execute(request('sessions.conflicts', one), context())).toMatchObject({ ok: false, error: { code: 'not-found' } })
    expect(RemoteControlConst.optionalOperations).toContain('sessions.conflicts')
    expect(RemoteControlConst.mutatingOperations).not.toContain('sessions.conflicts')
    expect(RemoteControlPeerConst.controlOperations).not.toContain('sessions.conflicts')
    const peer = { ...context(RemoteControlPeerConst.controlOperations), callerKind: 'remote-peer' as const }
    expect(await found.control.execute(request('sessions.conflicts', one), peer)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('settles one conflicted path for a local caller, names a loss of incoming work only the person may choose, and never for a peer', async () => {
    const found = world()
    const one = { session: { kind: 'number', number: '001' } } as const
    expect(await found.control.execute(request('sessions.resolveConflict', { ...one, path: '.aidocs/engines', option: 'keep-both' }, 'resolve-1'), context()))
      .toMatchObject({ ok: true, value: { sessionId: 'session-1', path: '.aidocs/engines', state: 'settled', left: 2 } })
    const window = { ...context(), callerKind: 'window' as const }
    await found.control.execute(request('sessions.resolveConflict', { ...one, path: 'src/a.ts', option: 'keep-mine', confirm: true }, 'resolve-2'), window)
    expect(found.worktreeCalls).toEqual([
      { method: 'resolveConflict .aidocs/engines keep-both by cli', sessionId: 'session-1' },
      { method: 'resolveConflict src/a.ts keep-mine confirmed by window', sessionId: 'session-1' },
    ])
    expect(await found.control.execute(request('sessions.resolveConflict', { ...one, path: 'a', option: 'squash' as 'merged' }, 'resolve-3'), context()))
      .toMatchObject({ ok: false, error: { code: 'invalid-request' } })

    const personOnly = world({ resolved: { ok: false, code: 'person-only', detail: 'only you can choose it' } })
    expect(await personOnly.control.execute(request('sessions.resolveConflict', { ...one, path: 'a', option: 'keep-mine' }, 'resolve-4'), context()))
      .toMatchObject({ ok: false, error: { code: 'conflict', data: { sourceCode: 'person-only' } } })
    const running = world({ resolved: { ok: false, code: 'merge-pending', detail: 'fixing' } })
    expect(await running.control.execute(request('sessions.resolveConflict', { ...one, path: 'a', option: 'merged' }, 'resolve-5'), context()))
      .toMatchObject({ ok: false, error: { code: 'conflict', data: { sourceCode: 'merge-pending' } } })
    const unknown = world({ resolved: { ok: false, code: 'invalid-spec', detail: 'not a conflict' } })
    expect(await unknown.control.execute(request('sessions.resolveConflict', { ...one, path: 'a', option: 'merged' }, 'resolve-6'), context()))
      .toMatchObject({ ok: false, error: { code: 'operation-failed', data: { sourceCode: 'invalid-spec' } } })

    expect(RemoteControlConst.optionalOperations).toContain('sessions.resolveConflict')
    expect(RemoteControlConst.mutatingOperations).toContain('sessions.resolveConflict')
    expect(RemoteControlPeerConst.controlOperations).not.toContain('sessions.resolveConflict')
    const peer = { ...context(RemoteControlPeerConst.controlOperations), callerKind: 'remote-peer' as const }
    expect(await found.control.execute(request('sessions.resolveConflict', { ...one, path: 'a', option: 'merged' }, 'resolve-7'), peer))
      .toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('ends a worktree the way the Finish overlay and the row do, and only for a local caller', async () => {
    const found = world()
    const one = { session: { kind: 'number', number: '001' } } as const
    await expect(found.control.execute(request('sessions.discardWorktree', one, 'discard-1'), context()))
      .resolves.toMatchObject({ ok: true, value: { sessionId: 'session-1' } })
    await expect(found.control.execute(request('sessions.cleanupWorktree', one, 'cleanup-1'), context()))
      .resolves.toMatchObject({ ok: true, value: { sessionId: 'session-1' } })
    await expect(found.control.execute(request('sessions.retrySetup', {
      ...one,
      acknowledgeSetup: 'hash-1',
    }, 'retry-1'), context())).resolves.toMatchObject({ ok: true, value: { sessionId: 'session-1' } })
    expect(found.worktreeCalls).toEqual([
      { method: 'discardWorktree', sessionId: 'session-1' },
      { method: 'requestWorktreeCleanup', sessionId: 'session-1' },
      { method: 'retrySetup', sessionId: 'session-1', acknowledgeSetup: 'hash-1' },
    ])

    // A running session or a finish in progress is waited out, not a failure.
    for (const code of ['live-refused', 'merge-pending'] as const) {
      const busy = world({ worktreeEnding: { ok: false, code, detail: 'busy' } })
      await expect(busy.control.execute(request('sessions.discardWorktree', one, `discard-${code}`), context()))
        .resolves.toMatchObject({ ok: false, error: { code: 'conflict', data: { sourceCode: code } } })
      await expect(busy.control.execute(request('sessions.cleanupWorktree', one, `cleanup-${code}`), context()))
        .resolves.toMatchObject({ ok: false, error: { code: 'conflict', data: { sourceCode: code } } })
    }
    const gone = world({ worktreeEnding: { ok: false, code: 'worktree-removed', detail: 'removed after r12' } })
    await expect(gone.control.execute(request('sessions.cleanupWorktree', one, 'cleanup-gone'), context()))
      .resolves.toMatchObject({ ok: false, error: { code: 'conflict', data: { sourceCode: 'worktree-removed' } } })

    const peer = context(RemoteControlPeerConst.controlOperations)
    peer.callerKind = 'remote-peer'
    for (const operation of ['sessions.discardWorktree', 'sessions.retrySetup', 'sessions.cleanupWorktree'] as const) {
      expect(RemoteControlPeerConst.controlOperations).not.toContain(operation)
      await expect(found.control.execute(request(operation, one, `peer-${operation}`), peer))
        .resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    expect(found.worktreeCalls).toHaveLength(3)
  })

  it('takes a press of Finish on an SVN worktree and the review of a review run, for a local caller only', async () => {
    const found = world()
    const one = { session: { kind: 'number', number: '001' } } as const
    await expect(found.control.execute(request('sessions.finishWorktree', { ...one, choice: 'commit', acknowledgeSetup: 'hash-1' }, 'press-1'), context()))
      .resolves.toMatchObject({ ok: true, value: { sessionId: 'session-1', actionId: 'action-1' } })
    await expect(found.control.execute(request('sessions.finishWorktree', { ...one, choice: 'discard', confirmWorking: true }, 'press-2'), context()))
      .resolves.toMatchObject({ ok: true })
    await expect(found.control.execute(request('sessions.worktreeReview', one, 'review-1'), context()))
      .resolves.toMatchObject({ ok: true, value: { commitSessionId: 'commit-1', scopeRoot: 'Q:/Apps/One/.worktrees/014-fix' } })
    expect(found.worktreeCalls).toEqual([
      { method: 'finishWorktree commit', sessionId: 'session-1', acknowledgeSetup: 'hash-1' },
      { method: 'finishWorktree discard confirmed', sessionId: 'session-1' },
      { method: 'openActionReview', sessionId: 'session-1' },
    ])
    await expect(found.control.execute(request('sessions.finishWorktree', { ...one, choice: 'merge' as 'commit' }, 'press-3'), context()))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } })

    // A session that still works, a running action or a running session is a conflict the caller confirms or waits out.
    for (const code of ['session-working', 'merge-pending', 'live-refused'] as const) {
      const busy = world({ finishPress: { ok: false, code, detail: 'busy' } })
      await expect(busy.control.execute(request('sessions.finishWorktree', { ...one, choice: 'commit' }, `press-${code}`), context()))
        .resolves.toMatchObject({ ok: false, error: { code: 'conflict', data: { sourceCode: code } } })
    }
    const lost = world({ actionReview: { ok: false, code: 'review-unavailable', detail: 'lost with the client' } })
    await expect(lost.control.execute(request('sessions.worktreeReview', one, 'review-lost'), context()))
      .resolves.toMatchObject({ ok: false, error: { code: 'unavailable', data: { sourceCode: 'review-unavailable' } } })

    const peer = context(RemoteControlPeerConst.controlOperations)
    peer.callerKind = 'remote-peer'
    for (const operation of ['sessions.finishWorktree', 'sessions.worktreeReview'] as const) {
      expect(RemoteControlPeerConst.controlOperations).not.toContain(operation)
      const body = operation === 'sessions.finishWorktree' ? { ...one, choice: 'keep' } : one
      await expect(found.control.execute(request(operation, body as never, `peer-${operation}`), peer))
        .resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
  })

  // Only a press from a window opens VS Code on the worktree, so the press carries who made it.
  it('tells the sessions which caller pressed Finish or UPDATE', async () => {
    const found = world()
    const one = { session: { kind: 'number', number: '001' } } as const
    const window = { ...context(), callerKind: 'window' as const }
    await expect(found.control.execute(request('sessions.finishWorktree', { ...one, choice: 'commit' }, 'press-window'), window))
      .resolves.toMatchObject({ ok: true })
    await expect(found.control.execute(request('sessions.updateMain', one, 'update-window'), window))
      .resolves.toMatchObject({ ok: true })
    expect(found.worktreeCalls).toEqual([
      { method: 'finishWorktree commit by window', sessionId: 'session-1' },
      { method: 'updateMain window []', sessionId: 'session-1' },
    ])
  })

  it('stores the commit proposal of a worker for a local caller only, and names a message a person wrote as a conflict', async () => {
    const found = world()
    const one = { session: { kind: 'number', number: '001' } } as const
    await expect(found.control.execute(request('sessions.proposeCommit', { ...one, message: 'Fix login\n\nBody' }, 'propose-1'), context()))
      .resolves.toMatchObject({ ok: true, value: { scopeRoot: 'Q:/Apps/One/.worktrees/014-fix' } })
    expect(found.sessionCalls).toContainEqual({ method: 'proposeCommit', args: ['session-1', 'Fix login\n\nBody'] })
    await expect(found.control.execute(request('sessions.proposeCommit', one as never, 'propose-2'), context()))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } })

    const edited = world({ proposeCommit: { ok: false, code: 'message-edited', detail: 'A person already wrote it' } })
    await expect(edited.control.execute(request('sessions.proposeCommit', { ...one, message: 'x' }, 'propose-3'), context()))
      .resolves.toMatchObject({ ok: false, error: { code: 'conflict', data: { sourceCode: 'message-edited' } } })
    const none = world({ proposeCommit: { ok: false, code: 'review-unavailable', detail: 'no commit dialog' } })
    await expect(none.control.execute(request('sessions.proposeCommit', { ...one, message: 'x' }, 'propose-4'), context()))
      .resolves.toMatchObject({ ok: false, error: { code: 'unavailable', data: { sourceCode: 'review-unavailable' } } })

    const peer = context(RemoteControlPeerConst.controlOperations)
    peer.callerKind = 'remote-peer'
    expect(RemoteControlPeerConst.controlOperations).not.toContain('sessions.proposeCommit')
    await expect(found.control.execute(request('sessions.proposeCommit', { ...one, message: 'x' }, 'propose-peer'), peer))
      .resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('takes an UPDATE of a main copy and names the live sessions a confirmation has to name, for a local caller only', async () => {
    const found = world()
    const one = { session: { kind: 'number', number: '001' } } as const
    await expect(found.control.execute(request('sessions.updateMain', one, 'update-1'), context()))
      .resolves.toMatchObject({ ok: true, value: { sessionId: 'session-1', actionId: 'update-1' } })
    await expect(found.control.execute(request('sessions.updateMain', { ...one, confirmLive: ['a', 'b'] }, 'update-2'), context()))
      .resolves.toMatchObject({ ok: true })
    expect(found.worktreeCalls).toEqual([
      { method: 'updateMain cli []', sessionId: 'session-1' },
      { method: 'updateMain cli [a,b]', sessionId: 'session-1' },
    ])
    await expect(found.control.execute(request('sessions.updateMain', { ...one, confirmLive: 'a' as never }, 'update-3'), context()))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } })

    const liveSessions = [{ sessionId: 'a', title: '002 - coordinator', number: '002' }]
    const crowded = world({ updateMain: { ok: false, code: 'live-sessions', detail: '1 live session', liveSessions } })
    await expect(crowded.control.execute(request('sessions.updateMain', one, 'update-4'), context()))
      .resolves.toMatchObject({ ok: false, error: { code: 'conflict', data: { sourceCode: 'live-sessions', liveSessions } } })
    const running = world({ updateMain: { ok: false, code: 'merge-pending', detail: 'an update runs' } })
    await expect(running.control.execute(request('sessions.updateMain', one, 'update-5'), context()))
      .resolves.toMatchObject({ ok: false, error: { code: 'conflict', data: { sourceCode: 'merge-pending' } } })

    const peer = context(RemoteControlPeerConst.controlOperations)
    peer.callerKind = 'remote-peer'
    expect(RemoteControlPeerConst.controlOperations).not.toContain('sessions.updateMain')
    await expect(found.control.execute(request('sessions.updateMain', one, 'peer-update'), peer))
      .resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('answers the results of SVN worktrees and their acknowledgement, for a local caller only', async () => {
    const committed: WorktreeResultDto = {
      actionId: 'action-1', action: 'finish', result: 'committed', sessionId: 'gone-1', title: '014 - fix', tag: 'run-7',
      worktreePath: 'Q:/Apps/One/.worktrees/014-fix', mainCopy: 'Q:/Apps/One', directoryId: '1:2:3', removal: 'removed',
      revisions: [{ repository: 'https://svn.test/repos/app', revision: 51, label: 'receipt' }], lines: [], logs: [],
      notify: null, holdsLanded: null, at: 5, acknowledgedAt: null,
    }
    const found = world({ results: [committed, { ...committed, actionId: 'action-2', tag: null }] })

    await expect(found.control.execute(request('sessions.worktreeResults', { tag: 'run-7', unacknowledged: true }), context()))
      .resolves.toMatchObject({ ok: true, value: { results: [committed] } })
    await expect(found.control.execute(request('sessions.acknowledgeWorktreeResult', { actionId: 'action-1' }, 'ack-1'), context()))
      .resolves.toMatchObject({ ok: true, value: { actionId: 'action-1' } })
    await expect(found.control.execute(request('sessions.acknowledgeWorktreeResult', { actionId: 'action-9' }, 'ack-2'), context()))
      .resolves.toMatchObject({ ok: false, error: { code: 'not-found' } })
    expect(found.sessionCalls).toEqual([
      { method: 'worktreeResults', args: [{ tag: 'run-7', unacknowledged: true }] },
      { method: 'acknowledgeWorktreeResult', args: ['action-1'] },
      { method: 'acknowledgeWorktreeResult', args: ['action-9'] },
    ])
    await expect(found.control.execute(request('sessions.worktreeResults', { tag: 'two words' }), context()))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } })

    const peer = context(RemoteControlPeerConst.controlOperations)
    peer.callerKind = 'remote-peer'
    expect(RemoteControlPeerConst.controlOperations).not.toContain('sessions.worktreeResults')
    expect(RemoteControlPeerConst.controlOperations).not.toContain('sessions.acknowledgeWorktreeResult')
    await expect(found.control.execute(request('sessions.worktreeResults', {}), peer))
      .resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    await expect(found.control.execute(request('sessions.acknowledgeWorktreeResult', { actionId: 'action-1' }, 'peer-ack'), peer))
      .resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('passes a notify create once on replay and refuses it from a peer', async () => {
    const specs: SessionCreateSpec[] = []
    const found = world({ create: async (spec) => {
      specs.push(spec)
      return { ok: true, value: { sessionId: 'child', tabTitle: 'child' } }
    } })
    const spec: SessionCreateSpec = { kind: 'shell', directory: { mode: 'default' },
      notify: { sessionId: 'parent', text: 'child moved or ended', onGroups: ['waiting', 'unknown-group'] } }
    const create = request('sessions.create', { spec }, 'create-notify')
    expect(await found.control.execute(create, context())).toMatchObject({ ok: true })
    expect(await found.control.execute({ ...create, requestId: 'replay' }, context())).toMatchObject({ ok: true })
    expect(specs).toEqual([spec])
    expect(found.creates()).toBe(1)
    const peer = { ...context(RemoteControlPeerConst.controlOperations), callerKind: 'remote-peer' as const }
    expect(await found.control.execute(request('sessions.create', { spec }, 'peer-notify'), peer))
      .toMatchObject({ ok: false, error: { code: 'forbidden', detail: expect.stringContaining('local only') } })
    expect(found.creates()).toBe(1)
    expect(await found.control.execute(request('sessions.create', { spec: { kind: 'shell', directory: { mode: 'default' } } }, 'peer-plain'), peer))
      .toMatchObject({ ok: true })
  })

  it('passes the envelope operation id of a create as its origin for every caller kind, once on replay', async () => {
    const origins: (SessionCreateOrigin | undefined)[] = []
    const found = world({ create: async (_spec, origin) => {
      origins.push(origin)
      return { ok: true, value: { sessionId: `child-${origins.length}`, tabTitle: 'child' } }
    } })
    const spec: SessionCreateSpec = { kind: 'shell', directory: { mode: 'default' } }
    const peer = { ...context(RemoteControlPeerConst.controlOperations), callerKind: 'remote-peer' as const }
    const window = { ...context(), callerKind: 'window' as const }
    const create = request('sessions.create', { spec }, 'create-cli')
    expect(await found.control.execute(create, context())).toMatchObject({ ok: true, operationId: 'create-cli' })
    expect(await found.control.execute({ ...create, requestId: 'replay' }, context()))
      .toMatchObject({ ok: true, value: { session: { sessionId: 'child-1' } } })
    expect(await found.control.execute(request('sessions.create', { spec }, 'create-window'), window)).toMatchObject({ ok: true })
    expect(await found.control.execute(request('sessions.create', { spec }, 'create-peer'), peer)).toMatchObject({ ok: true })
    expect(origins).toEqual([
      { callerOperationId: 'create-cli' },
      { callerOperationId: 'create-window' },
      { callerOperationId: 'create-peer' },
    ])
    expect(found.creates()).toBe(3)
  })

  it('validates notify text, group shapes and bounds before creating anything', async () => {
    const found = world()
    const notify = { sessionId: 'parent', text: 'wake', onGroups: ['waiting'] }
    for (const invalid of [
      { ...notify, sessionId: '' }, { ...notify, text: '' },
      { ...notify, text: 'x'.repeat(SessionLimits.worktreeNotifyCharacters + 1) },
      ...['\n', '\r', '\t', '\x00', '\x1b', '\x7f', '\u2028', '\u2029'].map((control) => ({ ...notify, text: `a${control}b` })),
      { ...notify, onGroups: ['Wrong Shape'] }, { ...notify, onGroups: [''] },
      { ...notify, onGroups: Array.from({ length: 9 }, (_, i) => `group-${i}`) },
    ])
      expect(await found.control.execute(request('sessions.create', {
        spec: { kind: 'shell', directory: { mode: 'default' }, notify: invalid },
      }, 'invalid-notify'), context())).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(found.creates()).toBe(0)
    expect(await found.control.execute(request('sessions.create', {
      spec: { kind: 'shell', directory: { mode: 'default' }, notify: {
        ...notify, text: 'x'.repeat(SessionLimits.worktreeNotifyCharacters), onGroups: Array.from({ length: 8 }, (_, i) => `unknown-${i}`),
      } },
    }, 'boundary-notify'), context())).toMatchObject({ ok: true })
  })

  it('lists notify events with optional session filtering for local callers only', async () => {
    const one: SessionNotifyDto = { sessionId: 'child-1', target: 'parent', text: 'wake', onGroups: ['waiting'], events: [
      { cause: 'group:waiting', at: 10, state: 'delivered', attempts: 0, settledAt: 11 },
      { cause: 'ended', at: 20, state: 'delivered', attempts: 0, settledAt: 21 },
    ] }
    const two = { ...one, sessionId: 'child-2', events: [] }
    const found = world({ notifies: [one, two] })
    for (const [filter, expected] of [[{}, [one, two]], [{ sessionId: 'child-1' }, [one]], [{ sessionId: 'missing' }, []]] as const)
      expect(await found.control.execute(request('sessions.notifies', filter), context()))
        .toMatchObject({ ok: true, value: { notifies: expected } })
    const peer = { ...context(RemoteControlPeerConst.controlOperations), callerKind: 'remote-peer' as const }
    expect(RemoteControlPeerConst.controlOperations).not.toContain('sessions.notifies')
    expect(await found.control.execute(request('sessions.notifies', {}), peer)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('creates a local child with a parent link, lists it as a child and refuses the link from a peer', async () => {
    const found = world()
    const spec: SessionCreateSpec = { kind: 'shell', directory: { mode: 'default' }, parent: { sessionId: 'session-1', kind: 'worktree' } }
    expect(await found.control.execute(request('sessions.create', { spec }, 'create-child'), context())).toMatchObject({ ok: true })
    expect(await found.control.execute(request('sessions.children', { sessionId: 'session-1' }), context())).toMatchObject({ ok: true, value: { children: [
      { sessionId: 'created-1', number: '002', title: '002 - created-1', agentId: null, life: 'live', kind: 'worktree', sameProject: true },
    ] } })
    expect(await found.control.execute(request('sessions.list', {}), context()))
      .toMatchObject({ ok: true, value: { sessions: expect.arrayContaining([expect.objectContaining({ sessionId: 'created-1', parent: { sessionId: 'session-1', kind: 'worktree', sameProject: true } })]) } })
    const peer = { ...context(RemoteControlPeerConst.controlOperations), callerKind: 'remote-peer' as const }
    expect(await found.control.execute(request('sessions.create', { spec }, 'peer-child'), peer))
      .toMatchObject({ ok: false, error: { code: 'forbidden', detail: 'Session parent is local only' } })
    expect(found.creates()).toBe(1)
    expect(RemoteControlPeerConst.controlOperations).not.toContain('sessions.children')
    expect(await found.control.execute(request('sessions.children', { sessionId: 'session-1' }), peer)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('refuses a parent link of an unknown kind or with extra keys, and a children read without a session id', async () => {
    const found = world()
    for (const parent of [{ sessionId: 'session-1', kind: 'child' }, { sessionId: '', kind: 'worker' }, { sessionId: 'session-1' },
      { sessionId: 'session-1', kind: 'worker', sameProject: true }])
      expect(await found.control.execute(request('sessions.create', {
        spec: { kind: 'shell', directory: { mode: 'default' }, parent },
      } as never, 'invalid-parent'), context())).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(found.creates()).toBe(0)
    for (const body of [{}, { sessionId: '' }, { sessionId: 'session-1', kind: 'worker' }])
      expect(await found.control.execute(request('sessions.children', body as never), context()))
        .toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  it('takes a tag and a wake-up line on a create, which a 3.10 target refuses by name', async () => {
    const found = world()
    const spec = {
      kind: 'shell', directory: { mode: 'default' },
      worktree: { slug: 'fix', tag: '7f3a9c2e-run', notify: { sessionId: 'session-1', text: '$pp:work-tickets watch' } },
    } as const
    await expect(found.control.execute(request('sessions.create', { spec }, 'create-tagged'), context())).resolves.toMatchObject({ ok: true })
    // The line is typed by the deliver rules, so it can never be longer than one delivery.
    expect(SessionLimits.worktreeNotifyCharacters).toBe(RemoteControlDeliverConst.textLengthConst)
    for (const worktree of [{ ...spec.worktree, tag: 'x'.repeat(129) }, { ...spec.worktree, notify: { sessionId: 'session-1', text: 'x'.repeat(801) } }])
      await expect(found.control.execute(request('sessions.create', { spec: { ...spec, worktree } }, 'create-bad'), context()))
        .resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } })

    // The worktree keys Jamat 3.10.0 accepted (RemoteControlRequestValidation.worktree at git 7f1bac7): exact keys, so a tag is refused, never dropped.
    const worktree310 = z.strictObject({
      slug: z.string().min(1).max(256),
      baseRef: z.string().min(1).max(1_024).optional(),
      owner: z.string().min(1).optional(),
      removeWhenEnded: z.literal(true).optional(),
    })
    const refused = worktree310.safeParse(spec.worktree)
    expect(refused.success).toBe(false)
    expect(JSON.stringify(refused.error?.issues)).toMatch(/"tag"/)
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

  it('lists the create operation id on every session, null for a session made without one', async () => {
    const found = world({ sessions: [{ ...session('session-1', '001'), callerOperationId: 'op-1' }, session('session-2', '002')] })

    const listed = await found.control.execute(request('sessions.list', {}), context())
    if (!listed.ok) throw new Error(listed.error.detail)
    const { sessions } = listed.value as RemoteControlOperationMap['sessions.list']['response']
    expect(sessions.map(({ sessionId, callerOperationId }) => ({ sessionId, callerOperationId }))).toEqual([
      { sessionId: 'session-1', callerOperationId: 'op-1' },
      { sessionId: 'session-2', callerOperationId: null },
    ])
    expect(SessionsSnapshotValidation.parse(listed.value)).not.toBeNull()
  })

  it('lists ended sessions locally and leaves them out for a paired computer', async () => {
    const found = world({ sessions: [session('session-1', '001'), { ...session('session-2', '002'), life: 'ended' }] })
    const peer: RemoteControlCallContext = { ...context(), callerKind: 'remote-peer' }

    await expect(found.control.execute(request('sessions.list', {}), context())).resolves.toMatchObject({
      ok: true, value: { sessions: [{ sessionId: 'session-1' }, { sessionId: 'session-2' }] },
    })
    const listed = await found.control.execute(request('sessions.list', {}), peer)
    if (!listed.ok) throw new Error(listed.error.detail)
    expect((listed.value as SessionsSnapshot).sessions.map(({ sessionId }) => sessionId)).toEqual(['session-1'])
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

  // A peer built before groups existed throws on a display entry it does not know.
  it('unfolds a product group into its projects before a listing leaves this computer', async () => {
    const listed = await world().control.execute(request('projects.list', { categoryId: 'code' }), context())

    expect(listed).toMatchObject({
      ok: true,
      value: {
        categories: [{
          listing: {
            ok: true,
            value: {
              entries: [
                { kind: 'project', project: { name: 'Bots/Two' } },
                { kind: 'project', project: { name: 'One' } },
              ],
            },
          },
        }],
      },
    })
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

  it('reads script runs with an untrusted log, starts a run once per operation id, and refuses a peer both', async () => {
    const reading: SessionScriptsReading = {
      sessionId: 'session-1',
      runs: [],
      log: { runId: 'run-1', text: 'untrusted output', truncated: false },
    }
    const found = world({ scripts: { ok: true, value: reading } })
    const one = { kind: 'number', number: '001' } as const
    await expect(found.control.execute(request('sessions.scripts', { session: one, runId: 'run-1' }), context()))
      .resolves.toMatchObject({ ok: true, operationId: null, value: { ...reading, logContentUntrusted: true } })
    const run = request('sessions.runScript', {
      session: one,
      command: 'pnpm test',
      cwd: 'packages/app',
      title: 'tests',
    }, 'run-once')
    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(found.control.execute(run, context()))
        .resolves.toMatchObject({ ok: true, operationId: 'run-once', value: { sessionId: 'session-1', runId: 'run-1' } })
    expect(found.scriptCalls).toEqual([
      { method: 'scriptsOf', parentId: 'session-1', runId: 'run-1' },
      { method: 'runScript', parentId: 'session-1', request: { command: 'pnpm test', cwd: 'packages/app', title: 'tests' } },
    ])
    await expect(found.control.execute(request('sessions.runScript', { session: one, command: 'pnpm test' }), context()))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } })

    const unknown = world({ scripts: { ok: false, code: 'not-found', detail: 'Session session-1 has no script run nope' } })
    await expect(unknown.control.execute(request('sessions.scripts', { session: one, runId: 'nope' }), context()))
      .resolves.toMatchObject({ ok: false, error: { code: 'not-found', data: { sourceCode: 'not-found' } } })
    const refused = world({ runScript: { ok: false, code: 'invalid-spec', detail: 'Session session-1 is not running' } })
    await expect(refused.control.execute(request('sessions.runScript', { session: one, command: 'pnpm test' }, 'run-refused'), context()))
      .resolves.toMatchObject({ ok: false, error: { code: 'operation-failed', data: { sourceCode: 'invalid-spec' } } })

    const peer = context(RemoteControlPeerConst.controlOperations)
    peer.callerKind = 'remote-peer'
    for (const operation of ['sessions.scripts', 'sessions.runScript'] as const)
      expect(RemoteControlPeerConst.controlOperations).not.toContain(operation)
    await expect(found.control.execute(request('sessions.scripts', { session: one }), peer))
      .resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    await expect(found.control.execute(request('sessions.runScript', { session: one, command: 'pnpm test' }, 'run-peer'), peer))
      .resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(found.scriptCalls).toHaveLength(2)
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
      projects: projectsPort({}),
      sessions: {
        snapshot: () => snapshot(found.sessions),
        createSession: async () => ({ ok: false, code: 'invalid-spec', detail: 'unused' }),
        reopenSession: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        finalizeSession: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        removeSession: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        discardWorktree: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        finishWorktreeSession: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        updateMain: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        openActionReview: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        worktreeResults: async () => ({ ok: true, value: { results: [] } }),
        notifies: async () => ({ ok: true, value: { notifies: [] } }),
        children: async () => ({ ok: true, value: { children: [] } }),
        acknowledgeWorktreeResult: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        proposeCommit: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        retrySetup: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        requestWorktreeCleanup: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        forkSession: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        restartSession: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        adoptOrphan: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        sessionReference: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        historyReferences: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        openHistorySession: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        nextSessionNumber: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        allocateSessionNumber: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        worktreeOf: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        conflictsOf: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        resolveConflict: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        runScript: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        scriptsOf: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        setSessionColor: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
        setSessionDetails: async () => ({ ok: false, code: 'not-found', detail: 'unused' }),
      },
      host: unusedHost(),
      groups: { read: () => new Map(), assign: (_sessionId, group) => ({ ok: true, value: { group } }), inherit: () => undefined },
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
