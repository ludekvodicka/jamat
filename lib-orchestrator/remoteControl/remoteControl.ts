import { RemoteControlEnvelope } from './remoteControlEnvelope'
import type {
  CategoryInfo,
  ProjectListResult,
  ProjectsOpResult,
} from '../projectManager/projectManagerApi.types'
import type {
  SessionColorName,
  SessionCreateSpec,
  SessionDetailsSaved,
  SessionDetailsUpdate,
  SessionGroup,
  SessionInfo,
  SessionSetupAgreement,
  SessionsOpResult,
  SessionsSnapshot,
} from '../sessionManager/sessionManagerApi.types'
import { ErrorText } from '../shared/errorText'
import { RemoteControlOperationStore } from './remoteControlOperationStore'
import { RemoteControlRequestValidation } from './remoteControlRequestValidation'
import type {
  RemoteControlAgentsDto,
  RemoteControlError,
  RemoteControlOperation,
  RemoteControlProjectCategoryDto,
  RemoteControlRequestUnion,
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
}

export interface RemoteControlSessionsPort {
  snapshot(): SessionsSnapshot
  createSession(
    spec: SessionCreateSpec,
  ): Promise<SessionsOpResult<{ sessionId: string; tabTitle: string }>>
  reopenSession(sessionId: string): Promise<SessionsOpResult>
  finalizeSession(sessionId: string): Promise<SessionsOpResult>
  removeSession(sessionId: string): Promise<SessionsOpResult>
  /**
   * The same setter the details dialog uses. It is on the sessions port and the group beside it is
   * not, because a colour lives on the session RECORD, which this library owns, while a group lives
   * in the client's own state.
   */
  setSessionColor(sessionId: string, color: SessionColorName): Promise<SessionsOpResult>
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
}

export interface RemoteControlTabsPort {
  commitStatus?(commitSessionId: string): RemoteControlStepResult<RemoteControlCommitStatusDto>
  cancelCommit?(commitSessionId: string): Promise<RemoteControlStepResult<RemoteControlCommitStatusDto>>
  openCommit(sessionId: string, tabTitle: string, vcs: 'svn' | 'git', scope: string | null,
    proposal: string | null, options: { paths?: readonly string[] }): Promise<RemoteControlStepResult<RemoteControlTabOpenCommitDto>>
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

export interface RemoteControlCallContext {
  callerId: string
  callerKind: 'local-cli' | 'remote-peer'
  allowedOperations: readonly RemoteControlOperation[]
}

export interface RemoteControlDeps {
  system: RemoteControlSystemPort
  projects: RemoteControlProjectsPort
  sessions: RemoteControlSessionsPort
  groups: RemoteControlSessionGroupsPort
  tabs: RemoteControlTabsPort
  terminal: RemoteControlTerminalPort
  transcript: RemoteControlTranscriptPort
  agents: RemoteControlAgentsPort
  onError: (message: string) => void
  operationStore?: RemoteControlOperationStore
}

type RemoteControlDispatchResult = RemoteControlStepResult<
  RemoteControlResponseBody<RemoteControlOperation>
>

export class RemoteControl {
  private readonly operationStore: RemoteControlOperationStore

  constructor(private readonly deps: RemoteControlDeps) {
    this.operationStore = deps.operationStore ?? new RemoteControlOperationStore()
  }

  async execute(input: unknown, context: RemoteControlCallContext): Promise<RemoteControlResponse> {
    const validated = RemoteControlRequestValidation.parse(input)
    if (!validated.ok)
      return RemoteControlEnvelope.failure(
        validated.requestId,
        validated.operation,
        validated.operationId,
        validated.error,
      )
    const request = validated.request
    if (context.callerId.length === 0)
      return RemoteControlEnvelope.failure(
        request.requestId,
        request.operation,
        request.operationId ?? null,
        { code: 'invalid-request', detail: 'callerId must not be empty' },
      )
    if (!context.allowedOperations.includes(request.operation))
      return RemoteControlEnvelope.failure(
        request.requestId,
        request.operation,
        request.operationId ?? null,
        { code: 'forbidden', detail: `${request.operation} is not allowed for ${context.callerKind}` },
      )

    try {
      let result: RemoteControlDispatchResult
      if (RemoteControlRequestValidation.isMutating(request.operation)) {
        const operationId = request.operationId
        if (operationId === undefined)
          throw new Error(`Mutation ${request.operation} passed validation without operationId`)
        const stored = await this.operationStore.runOrRefuse(
          context.callerId,
          operationId,
          RemoteControlRequestValidation.fingerprint(request),
          () => this.dispatch(request, context),
        )
        if (!stored.ok)
          return RemoteControlEnvelope.failure(
            request.requestId,
            request.operation,
            operationId,
            stored.error,
          )
        result = stored.value
      } else result = await this.dispatch(request, context)

      if (!result.ok)
        return RemoteControlEnvelope.failure(
          request.requestId,
          request.operation,
          request.operationId ?? null,
          result.error,
        )
      return RemoteControlEnvelope.success(request, result.value)
    } catch (error) {
      this.deps.onError(`Remote control ${request.operation} failed: ${ErrorText.of(error)}`)
      return RemoteControlEnvelope.failure(
        request.requestId,
        request.operation,
        request.operationId ?? null,
        { code: 'operation-failed', detail: 'The operation failed unexpectedly' },
      )
    }
  }

  private async dispatch(
    request: RemoteControlRequestUnion,
    context: RemoteControlCallContext,
  ): Promise<RemoteControlDispatchResult> {
    if (request.operation === 'system.hello')
      return RemoteControl.success({
        ...this.deps.system.identity(),
        protocol: RemoteControlConst.protocol,
        operations: RemoteControlConst.operations.filter((operation) =>
          context.allowedOperations.includes(operation)),
        optionalOperations: RemoteControlConst.optionalOperations.filter((operation) =>
          context.allowedOperations.includes(operation)),
      })
    else if (request.operation === 'system.status') {
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
    } else if (request.operation === 'projects.list')
      return this.projectsList(request.body.categoryId, request.body.sort)
    else if (request.operation === 'sessions.list') {
      const snapshot = this.deps.sessions.snapshot()
      const groups = this.deps.groups.read(snapshot.sessions)
      return RemoteControl.success({
        ...snapshot,
        sessions: snapshot.sessions.map((session) => ({
          ...session,
          group: groups.get(session.sessionId) ?? null,
        })),
      })
    } else if (request.operation === 'sessions.create') {
      const openTab = request.body.openTab === true
      /*
       * Opening the tab IS `tabs.open`, whoever asks for it. A peer granted `control:sessions.create`
       * and nothing else got the tab for free through this flag, and the only thing that ever
       * objected was the CLI's own argument parser - which a peer never goes through. Refused before
       * the session is created, so a request that may not open a tab leaves nothing behind either.
       */
      if (openTab && !context.allowedOperations.includes('tabs.open'))
        return RemoteControl.error(
          'forbidden',
          `tabs.open is not allowed for ${context.callerKind}`,
        )
      return this.sessionCreate(request.body.spec, openTab, request.body.group)
    } else if (request.operation === 'sessions.reopen') {
      const session = this.session(request.body.session)
      if (!session.ok) return session
      return this.sessionMutation(session.value.sessionId, () =>
        this.deps.sessions.reopenSession(session.value.sessionId))
    } else if (request.operation === 'sessions.finalize') {
      const session = this.session(request.body.session)
      if (!session.ok) return session
      return this.sessionMutation(session.value.sessionId, () =>
        this.deps.sessions.finalizeSession(session.value.sessionId))
    } else if (request.operation === 'sessions.remove') {
      const session = this.session(request.body.session)
      if (!session.ok) return session
      const result = await this.deps.sessions.removeSession(session.value.sessionId)
      /*
       * A live runtime is a conflict with the caller's request, not a failure of it: the caller
       * stops or finalizes the session first. It is never stopped here on the caller's behalf.
       */
      if (!result.ok && result.code === 'live-refused')
        return RemoteControl.error('conflict', result.detail, { sourceCode: result.code })
      if (!result.ok) return RemoteControl.sessionError(result)
      return RemoteControl.success({ sessionId: session.value.sessionId })
    } else if (request.operation === 'sessions.transcript') {
      const session = this.session(request.body.session)
      if (!session.ok) return session
      return RemoteControl.success({
        sessionId: session.value.sessionId,
        transcriptContentUntrusted: true,
        reading: await this.deps.transcript.read(session.value.sessionId),
      })
    } else if (request.operation === 'sessions.color') {
      const session = this.session(request.body.session)
      if (!session.ok) return session
      const color = request.body.color
      const result = await this.deps.sessions.setSessionColor(session.value.sessionId, color)
      if (!result.ok) return RemoteControl.sessionError(result)
      return RemoteControl.success({ sessionId: session.value.sessionId, color })
    } else if (request.operation === 'sessions.group') {
      const session = this.session(request.body.session)
      if (!session.ok) return session
      /*
       * The same port a create files a new session with, so a session moved after the fact lands in
       * the same place and through the same broadcast as one born there. A refused write fails the
       * whole request here, unlike inside a create: there the session exists whatever the state file
       * says, and here the move is the entire request.
       */
      const assigned = this.deps.groups.assign(session.value.sessionId, request.body.group)
      if (!assigned.ok) return assigned
      return RemoteControl.success({
        sessionId: session.value.sessionId,
        group: assigned.value.group,
      })
    } else if (request.operation === 'sessions.note') {
      const session = this.session(request.body.session)
      if (!session.ok) return session
      return RemoteControl.success({
        sessionId: session.value.sessionId,
        note: session.value.note ?? null,
      })
    } else if (request.operation === 'sessions.setNote') {
      const session = this.session(request.body.session)
      if (!session.ok) return session
      const written = await this.deps.sessions.setSessionDetails(
        session.value.sessionId,
        { note: request.body.note },
      )
      if (!written.ok) return RemoteControl.sessionError(written)
      /*
       * Answered from the snapshot rather than from the request, so the caller is told what the
       * record HOLDS: the library trims a note and keeps no empty one, and a caller that sent
       * spaces would otherwise be told they are there.
       */
      const stored = this.session({ kind: 'sessionId', sessionId: session.value.sessionId })
      return RemoteControl.success({
        sessionId: session.value.sessionId,
        note: stored.ok ? stored.value.note ?? null : null,
      })
    } else if (request.operation === 'agents.describe')
      return RemoteControl.success(this.deps.agents.describe())
    else if (request.operation === 'tabs.list')
      return RemoteControl.success({ tabs: await this.deps.tabs.list() })
    else if (request.operation === 'tabs.open') {
      const session = this.session(request.body.session)
      if (!session.ok) return session
      return this.deps.tabs.open(session.value.sessionId, session.value.tabTitle)
    } else if (request.operation === 'tabs.openFile') {
      const session = this.session(request.body.session)
      if (!session.ok) return session
      return this.deps.tabs.openFile(
        session.value.sessionId,
        session.value.tabTitle,
        request.body.path,
      )
    } else if (request.operation === 'tabs.openCommit') {
      const session = this.session(request.body.session)
      if (!session.ok) return session
      if (session.value.life !== 'live') return { ok: false, error: { code: 'not-found', detail: 'The session is not live' } }
      return this.deps.tabs.openCommit(session.value.sessionId, session.value.tabTitle, request.body.vcs,
        request.body.scope ?? null, request.body.message ?? null,
        request.body.paths === undefined ? {} : { paths: request.body.paths })
    } else if (request.operation === 'tabs.commitStatus')
      return this.deps.tabs.commitStatus?.(request.body.commitSessionId)
        ?? { ok: false, error: { code: 'unavailable', detail: 'Commit status is unavailable' } }
    else if (request.operation === 'tabs.cancelCommit')
      return this.deps.tabs.cancelCommit?.(request.body.commitSessionId)
        ?? { ok: false, error: { code: 'unavailable', detail: 'Commit cancellation is unavailable' } }
    else if (request.operation === 'tabs.focus')
      return this.deps.tabs.focus(request.body.panelId)
    else if (request.operation === 'tabs.close')
      return this.deps.tabs.close(request.body.panelId)
    else if (request.operation === 'terminal.peek') {
      const session = this.session(request.body.session)
      if (!session.ok) return session
      return this.deps.terminal.peek(session.value.sessionId, {
        ...(request.body.cols === undefined ? {} : { cols: request.body.cols }),
        ...(request.body.rows === undefined ? {} : { rows: request.body.rows }),
        ...(request.body.timeoutMs === undefined ? {} : { timeoutMs: request.body.timeoutMs }),
      })
    } else if (request.operation === 'terminal.send') {
      const session = this.session(request.body.session)
      if (!session.ok) return session
      return this.deps.terminal.send(session.value.sessionId, request.body.text, {
        enter: request.body.enter === true,
        ...(request.body.timeoutMs === undefined ? {} : { timeoutMs: request.body.timeoutMs }),
      })
    } else if (request.operation === 'terminal.deliver') {
      const session = this.session(request.body.session)
      if (!session.ok) return session
      if (session.value.kind !== 'agent' || session.value.agent === undefined)
        return RemoteControl.error(
          'invalid-request',
          'terminal.deliver needs an agent session',
          RemoteControl.deliverRefusal('validate', 'shell-session'),
        )
      if (session.value.life !== 'live' && session.value.life !== 'starting')
        return RemoteControl.error(
          'not-found',
          'The session is not live',
          RemoteControl.deliverRefusal('attach', 'not-live'),
        )
      const sessionId = session.value.sessionId
      return this.deps.terminal.deliver(sessionId, request.body.text, {
        input: request.body.input ?? 'paste',
        readyTimeoutMs: request.body.readyTimeoutMs ?? RemoteControlDeliverConst.readyTimeoutMillisecondsConst,
        submitTimeoutMs: request.body.submitTimeoutMs ?? RemoteControlDeliverConst.submitTimeoutMillisecondsConst,
        queue: request.body.queue === true,
      }, { transcript: () => this.deps.transcript.read(sessionId) })
    } else
      throw new Error(`Unknown remote control operation: ${JSON.stringify(request)}`)
  }

  private async projectsList(
    categoryId?: string,
    sort?: 'alpha' | 'recent',
  ): Promise<RemoteControlDispatchResult> {
    const categories = await this.deps.projects.listCategories()
    const selected = categoryId === undefined
      ? categories
      : categories.filter((category) => category.id === categoryId)
    if (categoryId !== undefined && selected.length === 0)
      return RemoteControl.error('not-found', `No category ${JSON.stringify(categoryId)}`)
    const listings: RemoteControlProjectCategoryDto[] = await Promise.all(selected.map(
      async (category) => ({
        category,
        listing: await this.deps.projects.listProjects(
          category.id,
          sort === undefined ? undefined : { sort },
        ),
      }),
    ))
    return RemoteControl.success({ categories: listings })
  }

  private async sessionCreate(
    spec: SessionCreateSpec,
    openTab: boolean,
    group: SessionGroup | undefined,
  ): Promise<RemoteControlDispatchResult> {
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
  ): Promise<RemoteControlDispatchResult> {
    const result = await mutate()
    if (!result.ok) return RemoteControl.sessionError(result)
    return RemoteControl.success({ sessionId })
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
  }): RemoteControlDispatchResult {
    return RemoteControl.error(
      result.code === 'not-found' ? 'not-found' : 'operation-failed',
      result.detail,
      {
        sourceCode: result.code,
        ...(result.setup === undefined ? {} : { setup: result.setup }),
      },
    )
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
