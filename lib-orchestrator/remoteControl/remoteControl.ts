import type {
  CatalogCategoryDto,
  CategoryInfo,
  DeletePreview,
  DeleteReport,
  DisplayEntry,
  ProjectEntry,
  ProjectListResult,
  ProjectSessionsResult,
  ProjectsOpErrorCode,
  ProjectsOpResult,
  RelocationReport,
} from '../projectManager/projectManagerApi.types'
import type {
  HostDebugStatus,
  HostPingResult,
  SessionColorName,
  SessionCreated,
  SessionCreateSpec,
  SessionDetailsSaved,
  SessionDetailsUpdate,
  SessionGroup,
  SessionHistoryOpenSpec,
  SessionHistoryReference,
  SessionInfo,
  SessionScriptRequest,
  SessionScriptsReading,
  SessionSetupAgreement,
  SessionsOpErrorCode,
  SessionFinishPress,
  SessionsOpResult,
  SessionsSnapshot,
  SessionWorktreeState,
  WorktreeResultDto,
  WorktreeResultsFilter,
} from '../sessionManager/sessionManagerApi.types'
import { RemoteControlActivityLog } from './remoteControlActivityLog'
import type { RemoteControlOperationStore } from './remoteControlOperationStore'
import { type RemoteControlCallContext, RemoteControlRegistry } from './remoteControlRegistry'
import { RemoteControlRequestValidation } from './remoteControlRequestValidation'
import { RemoteControlBodySchemas } from './remoteControlSchemas'
import type {
  RemoteControlAgentsDto,
  RemoteControlError,
  RemoteControlOperation,
  RemoteControlOperationMap,
  RemoteControlProjectCategoryDto,
  RemoteControlProjectsDto,
  RemoteControlRequestBody,
  RemoteControlResponse,
  RemoteControlResponseBody,
  RemoteControlSessionCandidate,
  RemoteControlSessionCreateDto,
  RemoteControlSessionSelector,
  RemoteControlStepResult,
  RemoteControlSystemIdentity,
  RemoteControlTabCommandDto,
  RemoteControlTabDto,
  RemoteControlTabOpenFileDto,
  RemoteControlTabOpenCommitDto,
  RemoteControlCommitPath,
  RemoteControlCommitStatusDto,
  RemoteControlTerminalPeekDto,
  RemoteControlTerminalSendDto,
  RemoteControlTerminalDeliverDto,
  RemoteControlTerminalDeliverFailureData,
  RemoteControlTerminalDeliverInput,
  RemoteControlSessionTranscriptDto,
} from './remoteControlApi.types'
import { RemoteControlConst, RemoteControlDeliverConst } from './remoteControlProtocol'

export interface RemoteControlSystemPort {
  identity(): RemoteControlSystemIdentity
}

export interface RemoteControlProjectsPort {
  listCategories(): Promise<CategoryInfo[]>
  listProjects(
    categoryId: string,
    options?: { sort?: 'alpha' | 'recent' },
  ): Promise<ProjectsOpResult<ProjectListResult>>
  getConfig(): Promise<ProjectsOpResult<CatalogCategoryDto[]>>
  saveConfig(categories: readonly CatalogCategoryDto[]): Promise<ProjectsOpResult>
  listProjectSessions(categoryId: string, projectName: string): Promise<ProjectsOpResult<ProjectSessionsResult>>
  createProject(categoryId: string, name: string, options?: { virtualFolderPrefix?: string }): Promise<ProjectsOpResult<ProjectEntry>>
  renameProject(categoryId: string, oldName: string, newName: string): Promise<ProjectsOpResult<RelocationReport>>
  moveProjectPrefix(categoryId: string, name: string, targetPrefix: string | null): Promise<ProjectsOpResult<RelocationReport>>
  archiveProject(categoryId: string, name: string): Promise<ProjectsOpResult<RelocationReport>>
  previewDelete(categoryId: string, name: string): Promise<ProjectsOpResult<DeletePreview>>
  executeDelete(token: string): Promise<ProjectsOpResult<DeleteReport>>
}

export interface RemoteControlSessionsPort {
  snapshot(): SessionsSnapshot
  notifies(filter: { sessionId?: string }): Promise<SessionsOpResult<RemoteControlResponseBody<'sessions.notifies'>>>
  createSession(spec: SessionCreateSpec): Promise<SessionsOpResult<SessionCreated>>
  reopenSession(sessionId: string): Promise<SessionsOpResult>
  finalizeSession(sessionId: string, options?: { expect?: 'stop'; acknowledgeSetup?: string }): Promise<SessionsOpResult>
  removeSession(sessionId: string): Promise<SessionsOpResult>
  discardWorktree(sessionId: string): Promise<SessionsOpResult>
  /** A press of the Finish dialog on an SVN worktree; Discard only on a Git one. */
  finishWorktreeSession(sessionId: string, press: SessionFinishPress): Promise<SessionsOpResult<{ sessionId: string; actionId: string | null }>>
  /** UPDATE of the main copy of a landed row, or of the session's own main copy. */
  updateMain(sessionId: string, confirmLive: readonly string[] | undefined, requestedBy: SessionFinishPress['requestedBy'])
    : Promise<SessionsOpResult<{ sessionId: string; actionId: string }>>
  /** The review a review run of an SVN action hosts, opened once. */
  openActionReview(runId: string): Promise<SessionsOpResult<{ commitSessionId: string; scopeRoot: string }>>
  worktreeResults(filter: WorktreeResultsFilter): Promise<SessionsOpResult<{ results: WorktreeResultDto[] }>>
  acknowledgeWorktreeResult(actionId: string): Promise<SessionsOpResult<{ actionId: string }>>
  /** A worker's commit message, kept for its review; nothing opens. */
  proposeCommit(sessionId: string, message: string): Promise<SessionsOpResult<{ scopeRoot: string }>>
  retrySetup(sessionId: string, acknowledgeSetup?: string): Promise<SessionsOpResult>
  requestWorktreeCleanup(sessionId: string): Promise<SessionsOpResult>
  forkSession(sessionId: string, options?: { name?: string }): Promise<SessionsOpResult<{ sessionId: string; tabTitle: string }>>
  restartSession(sessionId: string): Promise<SessionsOpResult>
  adoptOrphan(runtimeSessionId: string): Promise<SessionsOpResult>
  sessionReference(sessionId: string): Promise<SessionsOpResult<{ text: string }>>
  historyReferences(directory: SessionHistoryOpenSpec['directory']): Promise<SessionsOpResult<{ references: SessionHistoryReference[] }>>
  openHistorySession(spec: SessionHistoryOpenSpec): Promise<SessionsOpResult<{ sessionId: string; tabTitle: string }>>
  nextSessionNumber(projectPath: string): Promise<SessionsOpResult<{ token: string }>>
  allocateSessionNumber(projectPath: string): Promise<SessionsOpResult<{ token: string }>>
  worktreeOf(sessionId: string): Promise<SessionsOpResult<SessionWorktreeState>>
  /** A requested run: a shell command for a running session, as its child. */
  runScript(parentId: string, request: SessionScriptRequest): Promise<SessionsOpResult<{ runId: string }>>
  scriptsOf(parentId: string, runId?: string): Promise<SessionsOpResult<SessionScriptsReading>>
  /**
   * The same setter the details dialog uses. It is on the sessions port and the group beside it is
   * not, because a colour lives on the session RECORD, which this library owns, while a group lives
   * in the client's own state.
   */
  setSessionColor(sessionId: string, color: SessionColorName | null): Promise<SessionsOpResult>
  /**
   * The details dialog's Save, of which this library asks for one field: the note. The whole method
   * rather than a note-only one, because it is the production contract the client already holds and
   * a second entry point into the same record write would be a second set of rules about it.
   */
  setSessionDetails(
    sessionId: string,
    update: SessionDetailsUpdate,
  ): Promise<SessionsOpResult<SessionDetailsSaved>>
}

/**
 * Where a created session is filed in the sessions tree. A port rather than a method on the sessions
 * port beside it, because the assignment is not the session manager's: the client keeps it in its
 * own state, keyed by terminal target, and keys projects and categories the same way. The library
 * knows only that a group can be named at create and has to land somewhere.
 *
 * Synchronous for the reason `tabs.commitStatus` is: the one implementation reads and writes a file
 * the client already holds open, and a promise would only be a promise.
 */
export interface RemoteControlSessionGroupsPort {
  read(sessions: readonly SessionInfo[]): ReadonlyMap<string, SessionGroup | null>
  assign(sessionId: string, group: SessionGroup): RemoteControlStepResult<{ group: SessionGroup }>
  /** A fork keeps the section its parent was put in by hand. */
  inherit(parentSessionId: string, sessionId: string): void
}

/** The Host as the session manager reaches it: its state, a timed hello, and the explicit actions. */
export interface RemoteControlHostPort {
  debugStatus(): HostDebugStatus
  pingHost(): Promise<HostPingResult>
  startHost(): Promise<SessionsOpResult>
  restartHost(expectedHostInstanceId: string): Promise<SessionsOpResult>
  stopHost(expectedHostInstanceId: string): Promise<SessionsOpResult>
}

export interface RemoteControlTabsPort {
  commitStatus?(commitSessionId: string): RemoteControlStepResult<RemoteControlCommitStatusDto>
  cancelCommit?(commitSessionId: string): Promise<RemoteControlStepResult<RemoteControlCommitStatusDto>>
  openCommit(sessionId: string, tabTitle: string, vcs: 'svn' | 'git', scope: string | null,
    proposal: string | null, options: { paths?: readonly RemoteControlCommitPath[] }): Promise<RemoteControlStepResult<RemoteControlTabOpenCommitDto>>
  list(): Promise<readonly RemoteControlTabDto[]>
  open(sessionId: string, tabTitle: string): Promise<RemoteControlStepResult<RemoteControlTabCommandDto>>
  openFile(
    sessionId: string,
    tabTitle: string,
    path: string,
  ): Promise<RemoteControlStepResult<RemoteControlTabOpenFileDto>>
  focus(panelId: string): Promise<RemoteControlStepResult<RemoteControlTabCommandDto>>
  close(panelId: string): Promise<RemoteControlStepResult<RemoteControlTabCommandDto>>
}

export interface RemoteControlTerminalPort {
  peek(
    sessionId: string,
    options: { cols?: number; rows?: number; timeoutMs?: number },
  ): Promise<RemoteControlStepResult<RemoteControlTerminalPeekDto>>
  send(
    sessionId: string,
    text: string,
    options: { enter: boolean; timeoutMs?: number },
  ): Promise<RemoteControlStepResult<RemoteControlTerminalSendDto>>
  deliver(
    sessionId: string,
    text: string,
    options: RemoteControlTerminalDeliverOptions,
    proof: RemoteControlTerminalDeliverProofPort,
  ): Promise<RemoteControlStepResult<RemoteControlTerminalDeliverDto>>
}

export interface RemoteControlTerminalDeliverOptions {
  input: RemoteControlTerminalDeliverInput
  readyTimeoutMs: number
  submitTimeoutMs: number
  /** Absent means false: Enter, exactly as before the option existed. */
  queue?: boolean
}

/** The target session's transcript, which the submit phase reads for its strongest proof. */
export interface RemoteControlTerminalDeliverProofPort {
  transcript(): Promise<RemoteControlSessionTranscriptDto['reading']>
}

export interface RemoteControlTranscriptPort {
  read(sessionId: string): Promise<RemoteControlSessionTranscriptDto['reading']>
}

/**
 * What THIS computer can start an agent on, answered from its own settings and its own catalog. A
 * controller composes the model offer out of this rather than out of its own list, which would
 * describe the wrong machine's CLI versions. It carries no secret: what a person may choose, and
 * what this computer has chosen.
 */
export interface RemoteControlAgentsPort {
  describe(): RemoteControlAgentsDto
}

export type { RemoteControlCallContext } from './remoteControlRegistry'

export interface RemoteControlDeps {
  system: RemoteControlSystemPort
  projects: RemoteControlProjectsPort
  sessions: RemoteControlSessionsPort
  host: RemoteControlHostPort
  groups: RemoteControlSessionGroupsPort
  tabs: RemoteControlTabsPort
  terminal: RemoteControlTerminalPort
  transcript: RemoteControlTranscriptPort
  agents: RemoteControlAgentsPort
  onError: (message: string) => void
  operationStore?: RemoteControlOperationStore
}

/**
 * The protocol's operations, registered into the one registry every caller goes through. The client
 * adds its own operations to `registry` at composition; this class names none of them.
 */
export class RemoteControl {
  readonly registry: RemoteControlRegistry
  readonly activity = new RemoteControlActivityLog()

  constructor(private readonly deps: RemoteControlDeps) {
    this.registry = new RemoteControlRegistry({
      onError: deps.onError,
      ...(deps.operationStore === undefined ? {} : { operationStore: deps.operationStore }),
      onWritten: (operation, context, body) => this.activity.publish('operation.completed', {
        operation,
        callerKind: context.callerKind,
        ...RemoteControl.sessionOf(body),
      }),
    })
    this.registerProtocol()
  }

  async execute(input: unknown, context: RemoteControlCallContext): Promise<RemoteControlResponse> {
    return await this.registry.execute(input, context) as RemoteControlResponse
  }

  /** What the client registered beside the protocol, for the descriptor's `registryOperations`. */
  clientOperations(): string[] {
    const protocol: readonly string[] = [...RemoteControlConst.descriptorOperations, ...RemoteControlConst.optionalOperations]
    return this.registry.names().filter((name) => !protocol.includes(name))
  }

  private registerProtocol(): void {
    const op = this.registry.registrar<RemoteControlOperationMap>()
    const kindOf = (name: RemoteControlOperation): 'read' | 'write' =>
      RemoteControlRequestValidation.isMutating(name) ? 'write' : 'read'
    const define = <K extends RemoteControlOperation>(
      name: K,
      description: string,
      run: (body: RemoteControlRequestBody<K>, context: RemoteControlCallContext) =>
        Promise<RemoteControlStepResult<RemoteControlResponseBody<K>>>,
    ): void => op(name, { kind: kindOf(name), description, input: RemoteControlBodySchemas[name], run })
    const bySession = <K extends RemoteControlOperation>(
      name: K,
      description: string,
      run: (session: SessionInfo, body: RemoteControlRequestBody<K>, context: RemoteControlCallContext) =>
        Promise<RemoteControlStepResult<RemoteControlResponseBody<K>>>,
    ): void => define(name, description, async (body, context) => {
      const session = this.session((body as { session: RemoteControlSessionSelector }).session)
      if (!session.ok) return session
      return run(session.value, body, context)
    })

    define('system.hello', 'Who answers, the protocol, and the operations this caller may use.', async (_body, context) =>
      RemoteControl.success({
        ...this.deps.system.identity(),
        protocol: RemoteControlConst.protocol,
        operations: RemoteControlConst.operations.filter((operation) => context.allowedOperations.includes(operation)),
        optionalOperations: RemoteControlConst.optionalOperations.filter((operation) => context.allowedOperations.includes(operation)),
      }))
    define('system.status', 'Counts of sessions and tabs, the Host state and the revision of the sessions snapshot.', async () => {
      const snapshot = this.deps.sessions.snapshot()
      const tabs = await this.deps.tabs.list()
      return RemoteControl.success({
        identity: this.deps.system.identity(),
        sessions: {
          revision: snapshot.revision,
          reconciled: snapshot.reconciled,
          count: snapshot.sessions.length,
          host: snapshot.host,
        },
        tabs: { count: tabs.length },
      })
    })
    define('system.operations', 'Every operation with its kind, description and the JSON Schema of its body.', async (_body, context) =>
      RemoteControl.success({
        operations: this.registry.catalog().filter((entry) => context.allowedOperations.includes(entry.name)),
      }))
    define('system.calls', 'The latest 100 calls of every caller, the window included, oldest first.', async () =>
      RemoteControl.success({ calls: this.registry.latestCalls() }))
    define('system.events', 'The activity log after `after`, waiting at most `waitMs` (up to 30000) for a first entry.', async (body) =>
      RemoteControl.success(await this.activity.read(body.after, body.waitMs ?? 0)))
    define('projects.list', 'The catalog categories and the projects of each, or of one category.', async (body) =>
      this.projectsList(body.categoryId, body.sort))
    define('projects.config', "The catalog's roots as the settings edit them.", async () =>
      RemoteControl.projectsOutcome(await this.deps.projects.getConfig()))
    define('projects.saveConfig', "Replace the catalog's roots; every other section of the config stays.", async (body) =>
      RemoteControl.projectsOutcome(await this.deps.projects.saveConfig(body.categories), () => ({})))
    define('projects.categories', 'The categories of the catalog and whether each root is reachable.', async () =>
      RemoteControl.success(await this.deps.projects.listCategories()))
    define('projects.listing', "One category's projects with its groups, as the launcher draws them.", async (body) =>
      RemoteControl.projectsOutcome(await this.deps.projects.listProjects(body.categoryId, { sort: body.sort })))
    define('projects.sessions', 'The provider conversations of one project.', async (body) =>
      RemoteControl.projectsOutcome(await this.deps.projects.listProjectSessions(body.categoryId, body.projectName)))
    define('projects.create', 'Create a project directory in a category, optionally under a virtual folder.', async (body) =>
      RemoteControl.projectsOutcome(await this.deps.projects.createProject(
        body.categoryId,
        body.name,
        body.virtualFolderPrefix === null ? undefined : { virtualFolderPrefix: body.virtualFolderPrefix },
      )))
    define('projects.rename', 'Rename a project and carry its Claude and Codex history along.', async (body) =>
      RemoteControl.projectsOutcome(await this.deps.projects.renameProject(body.categoryId, body.oldName, body.newName)))
    define('projects.movePrefix', 'Move a project under another virtual folder, or to the root with null.', async (body) =>
      RemoteControl.projectsOutcome(await this.deps.projects.moveProjectPrefix(body.categoryId, body.name, body.targetPrefix)))
    define('projects.archive', "Move a project into its category's archive.", async (body) =>
      RemoteControl.projectsOutcome(await this.deps.projects.archiveProject(body.categoryId, body.name)))
    define('projects.deletePreview', 'What a delete would remove, and the token that alone confirms it.', async (body) =>
      RemoteControl.projectsOutcome(await this.deps.projects.previewDelete(body.categoryId, body.name)))
    define('projects.delete', "Delete a project and its histories, named by a preview's token.", async (body) =>
      RemoteControl.projectsOutcome(await this.deps.projects.executeDelete(body.token)))
    define('sessions.list', 'The sessions snapshot, each session with its group.', async () => {
      const snapshot = this.deps.sessions.snapshot()
      const groups = this.deps.groups.read(snapshot.sessions)
      return RemoteControl.success({
        ...snapshot,
        sessions: snapshot.sessions.map((session) => ({
          ...session,
          group: groups.get(session.sessionId) ?? null,
        })),
      })
    })
    define('sessions.create', 'Create a session; optionally open its tab and file it under a group.', async (body, context) => {
      if (body.spec.notify !== undefined && context.callerKind === 'remote-peer')
        return RemoteControl.error('forbidden', 'Session notify is local only')
      const openTab = body.openTab === true
      /*
       * Opening the tab IS `tabs.open`, whoever asks for it. A peer granted `control:sessions.create`
       * and nothing else got the tab for free through this flag, and the only thing that ever
       * objected was the CLI's own argument parser - which a peer never goes through. Refused before
       * the session is created, so a request that may not open a tab leaves nothing behind either.
       */
      if (openTab && !context.allowedOperations.includes('tabs.open'))
        return RemoteControl.error('forbidden', `tabs.open is not allowed for ${context.callerKind}`)
      return this.sessionCreate(body.spec, openTab, body.group)
    })
    bySession('sessions.reopen', 'Start an ended session again in its own conversation.', async (session) =>
      this.sessionMutation(session.sessionId, () => this.deps.sessions.reopenSession(session.sessionId)))
    bySession('sessions.finalize', "Do the next Finish step: stop a running session, or finish an ended session's worktree.", async (session, body) => {
      const result = await this.deps.sessions.finalizeSession(session.sessionId, {
        ...(body.expect === undefined ? {} : { expect: body.expect }),
        ...(body.acknowledgeSetup === undefined ? {} : { acknowledgeSetup: body.acknowledgeSetup }),
      })
      // The next step is not what the caller expected: its request conflicts with the session's state.
      if (!result.ok && result.code === 'live-refused')
        return RemoteControl.error('conflict', result.detail, { sourceCode: result.code })
      if (!result.ok) return RemoteControl.sessionError(result)
      return RemoteControl.success({ sessionId: session.sessionId })
    })
    bySession('sessions.worktree', "One session's worktree, its finish, its last outcome, its cleanup and its commit receipts.", async (session) => {
      const state = await this.deps.sessions.worktreeOf(session.sessionId)
      if (!state.ok) return RemoteControl.sessionError(state)
      return RemoteControl.success(state.value)
    })
    bySession('sessions.remove', 'Delete an ended session record from the list; a worktree stays on disk.', async (session) => {
      const result = await this.deps.sessions.removeSession(session.sessionId)
      /*
       * A live runtime is a conflict with the caller's request, not a failure of it: the caller
       * stops or finalizes the session first. It is never stopped here on the caller's behalf.
       */
      if (!result.ok && result.code === 'live-refused')
        return RemoteControl.error('conflict', result.detail, { sourceCode: result.code })
      if (!result.ok) return RemoteControl.sessionError(result)
      return RemoteControl.success({ sessionId: session.sessionId })
    })
    bySession('sessions.discardWorktree', 'The Finish Discard: the worktree goes with its uncommitted work, nothing is brought home.', async (session) =>
      this.worktreeMutation(session.sessionId, () => this.deps.sessions.discardWorktree(session.sessionId)))
    bySession('sessions.cleanupWorktree', 'Remove an SVN worktree once its session ended, judged at the next pass; changes keep it.', async (session) =>
      this.worktreeMutation(session.sessionId, () => this.deps.sessions.requestWorktreeCleanup(session.sessionId)))
    bySession('sessions.finishWorktree', 'A press of Finish on an SVN worktree: Commit, Keep or Discard, answered once the action is written.', async (session, body, context) => {
      const result = await this.deps.sessions.finishWorktreeSession(session.sessionId, {
        choice: body.choice,
        ...(body.acknowledgeSetup === undefined ? {} : { acknowledgeSetup: body.acknowledgeSetup }),
        ...(body.confirmWorking === undefined ? {} : { confirmWorking: body.confirmWorking }),
        requestedBy: RemoteControl.requestedByOf(context),
      })
      if (!result.ok) return RemoteControl.worktreeRefusal(result)
      return RemoteControl.success(result.value)
    })
    bySession('sessions.updateMain', 'UPDATE of the main copy a landed row was cut from, or a session works in, as visible runs of that session.', async (session, body, context) => {
      const result = await this.deps.sessions.updateMain(session.sessionId, body.confirmLive, RemoteControl.requestedByOf(context))
      if (!result.ok) return RemoteControl.worktreeRefusal(result)
      return RemoteControl.success(result.value)
    })
    bySession('sessions.worktreeReview', "Open the review of an SVN action's review run once, on the run's own tab.", async (session) => {
      const opened = await this.deps.sessions.openActionReview(session.sessionId)
      if (!opened.ok) return RemoteControl.worktreeRefusal(opened)
      return RemoteControl.success(opened.value)
    })
    define('sessions.notifies', 'Watched local sessions and their notification events.', async (body) =>
      RemoteControl.outcome(await this.deps.sessions.notifies(body)))
    define('sessions.worktreeResults', 'How SVN worktrees ended, also of removed sessions, by tag, session or not yet acknowledged.', async (body) =>
      RemoteControl.outcome(await this.deps.sessions.worktreeResults({
        ...(body.tag === undefined ? {} : { tag: body.tag }),
        ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
        ...(body.unacknowledged === undefined ? {} : { unacknowledged: body.unacknowledged }),
      })))
    define('sessions.acknowledgeWorktreeResult', 'Mark a worktree result as read: it goes a day later instead of after 30.', async (body) =>
      RemoteControl.outcome(await this.deps.sessions.acknowledgeWorktreeResult(body.actionId)))
    bySession('sessions.proposeCommit', "Store a worker's commit message for its worktree; nothing opens and nothing is committed.", async (session, body) => {
      const result = await this.deps.sessions.proposeCommit(session.sessionId, body.message)
      if (!result.ok) return RemoteControl.worktreeRefusal(result)
      return RemoteControl.success(result.value)
    })
    bySession('sessions.retrySetup', 'Run the failed dependency install of a worktree session again.', async (session, body) =>
      this.sessionMutation(session.sessionId, () =>
        this.deps.sessions.retrySetup(session.sessionId, body.acknowledgeSetup)))
    bySession('sessions.transcript', "The session's conversation as its agent's transcript holds it; untrusted text.", async (session) =>
      RemoteControl.success({
        sessionId: session.sessionId,
        transcriptContentUntrusted: true,
        reading: await this.deps.transcript.read(session.sessionId),
      }))
    bySession('sessions.scripts', "The session's script runs, and with runId that run's saved log; untrusted text.", async (session, body) => {
      const read = await this.deps.sessions.scriptsOf(session.sessionId, body.runId)
      if (!read.ok) return RemoteControl.sessionError(read)
      return RemoteControl.success({ ...read.value, logContentUntrusted: true })
    })
    bySession('sessions.runScript', 'Run a shell command for a running session as its child, judged by its exit code.', async (session, body) => {
      const started = await this.deps.sessions.runScript(session.sessionId, {
        command: body.command,
        ...(body.cwd === undefined ? {} : { cwd: body.cwd }),
        ...(body.title === undefined ? {} : { title: body.title }),
      })
      if (!started.ok) return RemoteControl.sessionError(started)
      return RemoteControl.success({ sessionId: session.sessionId, runId: started.value.runId })
    })
    bySession('sessions.color', "Paint the session's row with a colour of the palette.", async (session, body) => {
      const result = await this.deps.sessions.setSessionColor(session.sessionId, body.color)
      if (!result.ok) return RemoteControl.sessionError(result)
      return RemoteControl.success({ sessionId: session.sessionId, color: body.color })
    })
    bySession('sessions.group', 'File the session under a section of the sessions tree.', async (session, body) => {
      /*
       * The same port a create files a new session with, so a session moved after the fact lands in
       * the same place and through the same broadcast as one born there. A refused write fails the
       * whole request here, unlike inside a create: there the session exists whatever the state file
       * says, and here the move is the entire request.
       */
      const assigned = this.deps.groups.assign(session.sessionId, body.group)
      if (!assigned.ok) return assigned
      return RemoteControl.success({ sessionId: session.sessionId, group: assigned.value.group })
    })
    bySession('sessions.note', "Read the session's note.", async (session) =>
      RemoteControl.success({ sessionId: session.sessionId, note: session.note ?? null }))
    bySession('sessions.setNote', "Write the session's note; null clears it.", async (session, body) => {
      const written = await this.deps.sessions.setSessionDetails(session.sessionId, { note: body.note })
      if (!written.ok) return RemoteControl.sessionError(written)
      /*
       * Answered from the snapshot rather than from the request, so the caller is told what the
       * record HOLDS: the library trims a note and keeps no empty one, and a caller that sent
       * spaces would otherwise be told they are there.
       */
      const stored = this.session({ kind: 'sessionId', sessionId: session.sessionId })
      return RemoteControl.success({
        sessionId: session.sessionId,
        note: stored.ok ? stored.value.note ?? null : null,
      })
    })
    bySession('sessions.fork', "Fork the session's conversation into a new session; it keeps the parent's group.", async (session, body) => {
      const forked = await this.deps.sessions.forkSession(
        session.sessionId,
        body.name === undefined ? undefined : { name: body.name },
      )
      if (!forked.ok) return RemoteControl.sessionError(forked)
      this.deps.groups.inherit(session.sessionId, forked.value.sessionId)
      return RemoteControl.success(forked.value)
    })
    bySession('sessions.restart', 'Stop what runs and resume the same conversation in a fresh process.', async (session) =>
      this.sessionMutation(session.sessionId, () => this.deps.sessions.restartSession(session.sessionId)))
    bySession('sessions.setDetails', 'Save the name, the note and the colour of a session as one write.', async (session, body) =>
      RemoteControl.outcome(await this.deps.sessions.setSessionDetails(session.sessionId, body.update)))
    define('sessions.adoptOrphan', 'Take a runtime the Host runs and no record names into the list.', async (body) => {
      const adopted = await this.deps.sessions.adoptOrphan(body.runtimeSessionId)
      if (!adopted.ok) return RemoteControl.sessionError(adopted)
      return RemoteControl.success({ runtimeSessionId: body.runtimeSessionId })
    })
    bySession('sessions.reference', 'The session written down for a second agent.', async (session) =>
      RemoteControl.outcome(await this.deps.sessions.sessionReference(session.sessionId)))
    define('sessions.historyReferences', 'The sessions of this list that ran a provider conversation in one project.', async (body) =>
      RemoteControl.outcome(await this.deps.sessions.historyReferences(body.directory)))
    define('sessions.openHistory', 'Open a provider conversation from the project history as a session.', async (body) =>
      RemoteControl.outcome(await this.deps.sessions.openHistorySession(body.spec)))
    define('sessions.nextNumber', 'The number the next session of a project would take; takes nothing.', async (body) =>
      RemoteControl.outcome(await this.deps.sessions.nextSessionNumber(body.projectPath)))
    define('sessions.allocateNumber', 'Take the next number of a project.', async (body) =>
      RemoteControl.outcome(await this.deps.sessions.allocateSessionNumber(body.projectPath)))
    define('host.status', 'The Host as this client sees it, without its token.', async () =>
      RemoteControl.success(this.deps.host.debugStatus()))
    define('host.ping', 'One timed hello to the Host.', async () => RemoteControl.success(await this.deps.host.pingHost()))
    define('host.start', 'Start the Host when none runs.', async () =>
      RemoteControl.outcome(await this.deps.host.startHost(), () => ({})))
    define('host.restart', 'Restart the Host the caller saw; a different running Host is refused.', async (body) =>
      RemoteControl.outcome(await this.deps.host.restartHost(body.expectedHostInstanceId), () => ({})))
    define('host.stop', 'Stop the Host the caller saw, with every session it runs.', async (body) =>
      RemoteControl.outcome(await this.deps.host.stopHost(body.expectedHostInstanceId), () => ({})))
    define('agents.describe', 'What this computer can start an agent on: its catalog and its configured models.', async () =>
      RemoteControl.success(this.deps.agents.describe()))
    define('tabs.list', 'The open panels of every window, with the commit reviews they hold.', async () =>
      RemoteControl.success({ tabs: await this.deps.tabs.list() }))
    bySession('tabs.open', "Open or focus the session's terminal tab.", async (session) =>
      this.deps.tabs.open(session.sessionId, session.tabTitle))
    bySession('tabs.openFile', "Open a file in the session's terminal split.", async (session, body) =>
      this.deps.tabs.openFile(session.sessionId, session.tabTitle, body.path))
    bySession('tabs.openCommit', "Open a Jamat commit review for a live session; the commit stays the person's act.", async (session, body) => {
      if (session.life !== 'live') return RemoteControl.error('not-found', 'The session is not live')
      return this.deps.tabs.openCommit(session.sessionId, session.tabTitle, body.vcs,
        body.scope ?? null, body.message ?? null,
        body.paths === undefined ? {} : { paths: body.paths })
    })
    define('tabs.commitStatus', 'The state of one commit review.', async (body) =>
      this.deps.tabs.commitStatus?.(body.commitSessionId)
        ?? RemoteControl.error('unavailable', 'Commit status is unavailable'))
    define('tabs.cancelCommit', 'Close one commit review without committing.', async (body) =>
      await this.deps.tabs.cancelCommit?.(body.commitSessionId)
        ?? RemoteControl.error('unavailable', 'Commit cancellation is unavailable'))
    define('tabs.focus', 'Bring a panel to the front.', async (body) => this.deps.tabs.focus(body.panelId))
    define('tabs.close', 'Close a panel.', async (body) => this.deps.tabs.close(body.panelId))
    bySession('terminal.peek', "The session's screen as text; untrusted output.", async (session, body) =>
      this.deps.terminal.peek(session.sessionId, {
        ...(body.cols === undefined ? {} : { cols: body.cols }),
        ...(body.rows === undefined ? {} : { rows: body.rows }),
        ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
      }))
    bySession('terminal.send', 'Write raw text to the session, optionally followed by Enter.', async (session, body) =>
      this.deps.terminal.send(session.sessionId, body.text, {
        enter: body.enter === true,
        ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
      }))
    bySession('terminal.deliver', "Type a message into an agent's composer and prove it was submitted.", async (session, body) => {
      if (session.kind !== 'agent' || session.agent === undefined)
        return RemoteControl.error(
          'invalid-request',
          'terminal.deliver needs an agent session',
          RemoteControl.deliverRefusal('validate', 'shell-session'),
        )
      if (session.life !== 'live' && session.life !== 'starting')
        return RemoteControl.error('not-found', 'The session is not live', RemoteControl.deliverRefusal('attach', 'not-live'))
      const sessionId = session.sessionId
      return this.deps.terminal.deliver(sessionId, body.text, {
        input: body.input ?? 'paste',
        readyTimeoutMs: body.readyTimeoutMs ?? RemoteControlDeliverConst.readyTimeoutMillisecondsConst,
        submitTimeoutMs: body.submitTimeoutMs ?? RemoteControlDeliverConst.submitTimeoutMillisecondsConst,
        queue: body.queue === true,
      }, { transcript: () => this.deps.transcript.read(sessionId) })
    })
    const missing = [...RemoteControlConst.operations, ...RemoteControlConst.optionalOperations]
      .filter((name) => !this.registry.has(name))
    if (missing.length > 0) throw new Error(`Protocol operations without a registration: ${missing.join(', ')}`)
  }

  /** The session a write named, for the activity log; nothing when the body names none. */
  private static sessionOf(body: unknown): { session?: unknown } {
    const value = body !== null && typeof body === 'object' ? (body as { session?: unknown }).session : undefined
    return value === undefined ? {} : { session: value }
  }

  private async projectsList(
    categoryId?: string,
    sort?: 'alpha' | 'recent',
  ): Promise<RemoteControlStepResult<RemoteControlProjectsDto>> {
    const categories = await this.deps.projects.listCategories()
    const selected = categoryId === undefined
      ? categories
      : categories.filter((category) => category.id === categoryId)
    if (categoryId !== undefined && selected.length === 0)
      return RemoteControl.error('not-found', `No category ${JSON.stringify(categoryId)}`)
    const listings: RemoteControlProjectCategoryDto[] = await Promise.all(selected.map(
      async (category) => {
        const listing = await this.deps.projects.listProjects(
          category.id,
          sort === undefined ? undefined : { sort },
        )
        return {
          category,
          listing: listing.ok
            ? { ok: true, value: { ...listing.value, entries: RemoteControl.withoutGroups(listing.value.entries) } }
            : listing,
        }
      },
    ))
    return RemoteControl.success({ categories: listings })
  }

  /**
   * A container's projects, at the level the container stood on. A peer built before the `group`
   * entry existed throws on the kind it does not know, and it gets the same projects under the same
   * `container/project` names it drew for a flattened container before that entry was added.
   */
  private static withoutGroups(entries: readonly DisplayEntry[]): DisplayEntry[] {
    return entries.flatMap((entry) => {
      if (entry.kind === 'group') return RemoteControl.withoutGroups(entry.entries)
      else if (entry.kind === 'project' || entry.kind === 'virtualFolder') return [entry]
      else throw new Error(`Unknown display entry: ${JSON.stringify(entry)}`)
    })
  }

  private async sessionCreate(
    spec: SessionCreateSpec,
    openTab: boolean,
    group: SessionGroup | undefined,
  ): Promise<RemoteControlStepResult<RemoteControlSessionCreateDto>> {
    const created = await this.deps.sessions.createSession(spec)
    if (!created.ok) return RemoteControl.sessionError(created)
    const value: RemoteControlSessionCreateDto = {
      session: created.value,
      tabOpen: null,
      groupAssign: null,
    }
    /*
     * Before the tab, so the first tree the session appears in already has it in its section. The
     * other order draws it under Sessions for a tick and moves it, which is the flicker `color` at
     * create exists to avoid one field over.
     */
    if (group !== undefined) value.groupAssign = this.deps.groups.assign(created.value.sessionId, group)
    if (!openTab) return RemoteControl.success(value)
    value.tabOpen = await this.deps.tabs.open(created.value.sessionId, created.value.tabTitle)
    return RemoteControl.success(value)
  }

  private async sessionMutation(
    sessionId: string,
    mutate: () => Promise<SessionsOpResult>,
  ): Promise<RemoteControlStepResult<{ sessionId: string }>> {
    const result = await mutate()
    if (!result.ok) return RemoteControl.sessionError(result)
    return RemoteControl.success({ sessionId })
  }

  /**
   * A running session or a finish in progress stands in the way of a worktree's ending: a conflict
   * the caller waits out or resolves, as for `sessions.remove`.
   */
  private async worktreeMutation(
    sessionId: string,
    mutate: () => Promise<SessionsOpResult>,
  ): Promise<RemoteControlStepResult<{ sessionId: string }>> {
    const result = await mutate()
    if (!result.ok) return RemoteControl.worktreeRefusal(result)
    return RemoteControl.success({ sessionId })
  }

  /**
   * A running session, an action in progress, a session that still works or live sessions in a main
   * copy stand in the way of a worktree's ending or an UPDATE: a conflict the caller waits out or
   * confirms. A client with no commit dialog to review in is unavailable.
   */
  /** Only a press from a window opens the editor on the worktree; a script never gets a window it did not ask for. */
  private static requestedByOf(context: RemoteControlCallContext): SessionFinishPress['requestedBy'] {
    if (context.callerKind === 'window') return 'window'
    else if (context.callerKind === 'local-cli') return 'cli'
    else if (context.callerKind === 'remote-peer') return 'peer'
    else throw new Error(`Unknown caller kind: ${JSON.stringify(context.callerKind satisfies never)}`)
  }

  private static worktreeRefusal(result: Extract<SessionsOpResult<unknown>, { ok: false }>): RemoteControlStepResult<never> {
    if (result.code === 'live-sessions')
      return RemoteControl.error('conflict', result.detail, { sourceCode: result.code, liveSessions: result.liveSessions ?? [] })
    if (result.code === 'live-refused' || result.code === 'merge-pending' || result.code === 'session-working'
      || result.code === 'message-edited')
      return RemoteControl.error('conflict', result.detail, { sourceCode: result.code })
    if (result.code === 'review-unavailable')
      return RemoteControl.error('unavailable', result.detail, { sourceCode: result.code })
    return RemoteControl.sessionError(result)
  }

  private session(
    selector: RemoteControlSessionSelector,
  ): RemoteControlStepResult<SessionInfo> {
    const sessions = this.deps.sessions.snapshot().sessions
    if (selector.kind === 'sessionId') {
      const found = sessions.find((session) => session.sessionId === selector.sessionId)
      return found
        ? RemoteControl.success(found)
        : RemoteControl.error('not-found', `No session ${JSON.stringify(selector.sessionId)}`)
    } else if (selector.kind === 'number') {
      const found = sessions.filter((session) => session.titleParts.number === selector.number)
      if (found.length === 1) return RemoteControl.success(found[0])
      if (found.length === 0)
        return RemoteControl.error('not-found', `No session numbered ${selector.number}`)
      const candidates: RemoteControlSessionCandidate[] = found.map((session) => ({
        sessionId: session.sessionId,
        number: session.titleParts.number,
        tabTitle: session.tabTitle,
        project: session.project,
      }))
      return RemoteControl.error(
        'conflict',
        `Session number ${selector.number} is ambiguous`,
        { candidates },
      )
    } else
      throw new Error(`Unknown session selector: ${JSON.stringify(selector)}`)
  }

  private static sessionError(result: Extract<SessionsOpResult<unknown>, { ok: false }> & {
    setup?: SessionSetupAgreement
  }): RemoteControlStepResult<never> {
    return RemoteControl.error(
      RemoteControl.remoteCodeOf(result.code),
      result.detail,
      {
        sourceCode: result.code,
        ...(result.setup === undefined ? {} : { setup: result.setup }),
      },
    )
  }

  /**
   * A worktree whose state stands in the way of the request is a conflict the caller resolves: the
   * detail carries the finish's own lines, and `sourceCode` the library's code. Every other code the
   * library names is a failure of the operation.
   */
  private static remoteCodeOf(code: SessionsOpErrorCode): RemoteControlError['code'] {
    if (code === 'not-found') return 'not-found'
    if (code === 'worktree-updated' || code === 'worktree-conflict' || code === 'worktree-removed') return 'conflict'
    return 'operation-failed'
  }

  /**
   * A library result as an answer: its value, or its refusal as `sessionError` words it. `empty` gives
   * the value of a result that carries none.
   */
  private static outcome<T, V = T>(
    result: SessionsOpResult<T>,
    empty?: (value: T) => V,
  ): RemoteControlStepResult<V> {
    if (!result.ok) return RemoteControl.sessionError(result)
    return RemoteControl.success(empty === undefined ? result.value as unknown as V : empty(result.value))
  }

  /** A project manager result as an answer, its refusal under its own code in `sourceCode`. */
  private static projectsOutcome<T, V = T>(
    result: ProjectsOpResult<T>,
    empty?: (value: T) => V,
  ): RemoteControlStepResult<V> {
    if (!result.ok)
      return RemoteControl.error(RemoteControl.projectsCodeOf(result.code), result.detail, { sourceCode: result.code })
    return RemoteControl.success(empty === undefined ? result.value as unknown as V : empty(result.value))
  }

  private static projectsCodeOf(code: ProjectsOpErrorCode): RemoteControlError['code'] {
    if (code === 'category-not-found' || code === 'project-not-found') return 'not-found'
    if (code === 'target-exists' || code === 'relocation-in-progress' || code === 'locked'
      || code === 'stale-preview' || code === 'preview-expired') return 'conflict'
    return 'operation-failed'
  }

  private static deliverRefusal(
    stage: RemoteControlTerminalDeliverFailureData['stage'],
    reason: RemoteControlTerminalDeliverFailureData['reason'],
  ): Record<string, unknown> {
    const data: RemoteControlTerminalDeliverFailureData = {
      stage,
      reason,
      typed: false,
      entered: 0,
      hint: null,
      composer: null,
    }
    return { ...data }
  }

  private static success<T>(value: T): RemoteControlStepResult<T> {
    return { ok: true, value }
  }

  private static error(
    code: RemoteControlError['code'],
    detail: string,
    data?: Record<string, unknown>,
  ): RemoteControlStepResult<never> {
    return { ok: false, error: { code, detail, ...(data === undefined ? {} : { data }) } }
  }

}
