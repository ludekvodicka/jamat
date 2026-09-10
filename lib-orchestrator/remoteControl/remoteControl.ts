import { RemoteControlEnvelope } from './remoteControlEnvelope'
import type {
  CategoryInfo,
  ProjectListResult,
  ProjectsOpResult,
} from '../projectManager/projectManagerApi.types'
import type {
  SessionCreateSpec,
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
  RemoteControlTerminalPeekDto,
  RemoteControlTerminalSendDto,
  RemoteControlSessionTranscriptDto,
} from './remoteControlApi.types'
import { RemoteControlConst } from './remoteControlProtocol'

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
  discardPlainSession(sessionId: string): Promise<SessionsOpResult>
}

export interface RemoteControlTabsPort {
  openCommit(sessionId: string, tabTitle: string, vcs: 'svn' | 'git', scope: string | null,
    proposal: string | null, options: { plain: boolean }): Promise<RemoteControlStepResult<RemoteControlTabOpenCommitDto>>
  list(): Promise<readonly RemoteControlTabDto[]>
  open(
    sessionId: string,
    tabTitle: string,
    options: { plain: boolean },
  ): Promise<RemoteControlStepResult<RemoteControlTabCommandDto>>
  openFile(
    sessionId: string,
    tabTitle: string,
    path: string,
    options: { plain: boolean },
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
    else if (request.operation === 'sessions.list')
      return RemoteControl.success(this.deps.sessions.snapshot())
    else if (request.operation === 'sessions.create') {
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
      return this.sessionCreate(request.body.spec, openTab)
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
    } else if (request.operation === 'sessions.transcript') {
      const session = this.session(request.body.session)
      if (!session.ok) return session
      return RemoteControl.success({
        sessionId: session.value.sessionId,
        transcriptContentUntrusted: true,
        reading: await this.deps.transcript.read(session.value.sessionId),
      })
    } else if (request.operation === 'agents.describe')
      return RemoteControl.success(this.deps.agents.describe())
    else if (request.operation === 'tabs.list')
      return RemoteControl.success({ tabs: await this.deps.tabs.list() })
    else if (request.operation === 'tabs.open') {
      const session = this.session(request.body.session)
      if (!session.ok) return session
      return this.deps.tabs.open(
        session.value.sessionId,
        session.value.tabTitle,
        { plain: session.value.presentation === 'tab' },
      )
    } else if (request.operation === 'tabs.openFile') {
      const session = this.session(request.body.session)
      if (!session.ok) return session
      return this.deps.tabs.openFile(
        session.value.sessionId,
        session.value.tabTitle,
        request.body.path,
        { plain: session.value.presentation === 'tab' },
      )
    } else if (request.operation === 'tabs.openCommit') {
      const session = this.session(request.body.session)
      if (!session.ok) return session
      if (session.value.life !== 'live') return { ok: false, error: { code: 'not-found', detail: 'The session is not live' } }
      return this.deps.tabs.openCommit(session.value.sessionId, session.value.tabTitle, request.body.vcs,
        request.body.scope ?? null, request.body.message ?? null, { plain: session.value.presentation === 'tab' })
    } else if (request.operation === 'tabs.focus')
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
  ): Promise<RemoteControlDispatchResult> {
    const created = await this.deps.sessions.createSession(spec)
    if (!created.ok) return RemoteControl.sessionError(created)
    const value: RemoteControlSessionCreateDto = {
      session: created.value,
      tabOpen: null,
      plainCleanup: null,
    }
    if (!openTab) return RemoteControl.success(value)
    value.tabOpen = await this.deps.tabs.open(
      created.value.sessionId,
      created.value.tabTitle,
      { plain: spec.presentation === 'tab' },
    )
    if (!value.tabOpen.ok && spec.presentation === 'tab')
      value.plainCleanup = await this.deps.sessions.discardPlainSession(created.value.sessionId)
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
