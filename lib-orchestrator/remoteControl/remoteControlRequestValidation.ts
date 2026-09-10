import type { SessionCreateSpec } from '../sessionManager/sessionManagerApi.types'
import type {
  RemoteControlError,
  RemoteControlMutatingOperation,
  RemoteControlOperation,
  RemoteControlRequestUnion,
  RemoteControlSessionSelector,
} from './remoteControlApi.types'
import {
  RemoteControlEnvelopeValidation,
  RemoteControlValidationError,
} from './remoteControlEnvelopeValidation'
import { RemoteControlConst } from './remoteControlProtocol'

export type RemoteControlRequestValidationResult =
  | { ok: true; request: RemoteControlRequestUnion }
  | {
      ok: false
      requestId: string | null
      operation: RemoteControlOperation | null
      operationId: string | null
      error: RemoteControlError
    }

export class RemoteControlRequestValidation {
  private static readonly idLengthConst = 256
  private static readonly pathLengthConst = 32_768
  private static readonly promptLengthConst = 1_000_000
  private static readonly terminalTextLengthConst = 1_000_000
  private static readonly modelLengthConst = 128
  private static readonly messageLengthConst = 65_536
  /**
   * A DELIBERATE copy of `AgentSettings.modelShapeConst`: this library may never import
   * app-client-ui, and the value reaches a command line either way. It rules out anything that
   * could be read as a flag by the CLI it is handed to or acted on by the win32 `cmd /d /q /c`
   * wrap - whether the model EXISTS is the agent's own answer and is never checked here.
   */
  private static readonly modelShapeConst = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9]+\])?$/

  private static readonly specConst = {
    operations: [...RemoteControlConst.operations, ...RemoteControlConst.optionalOperations],
    isMutating: (operation: RemoteControlOperation) =>
      RemoteControlRequestValidation.isMutating(operation),
  }

  static parse(input: unknown): RemoteControlRequestValidationResult {
    const envelope = RemoteControlEnvelopeValidation
      .parse<RemoteControlOperation>(input, RemoteControlRequestValidation.specConst)
    if (!envelope.ok) return envelope
    const { requestId, operation, operationId, body } = envelope
    try {
      return { ok: true, request: RemoteControlRequestValidation.requestOf(
        requestId,
        operation,
        operationId,
        body,
      ) }
    } catch (error) {
      if (!(error instanceof RemoteControlValidationError)) throw error
      return {
        ok: false,
        requestId,
        operation,
        operationId,
        error: { code: 'invalid-request', detail: error.message },
      }
    }
  }

  static fingerprint(request: RemoteControlRequestUnion): string {
    return JSON.stringify({ operation: request.operation, body: request.body })
  }

  static isMutating(
    operation: RemoteControlOperation,
  ): operation is RemoteControlMutatingOperation {
    return (RemoteControlConst.mutatingOperations as readonly RemoteControlOperation[])
      .includes(operation)
  }

  private static requestOf(
    requestId: string,
    operation: RemoteControlOperation,
    operationId: string | null,
    body: unknown,
  ): RemoteControlRequestUnion {
    const base = { protocol: RemoteControlConst.protocol, requestId }
    if (operation === 'system.hello')
      return { ...base, operation, body: RemoteControlEnvelopeValidation.empty(body, operation) }
    else if (operation === 'system.status')
      return { ...base, operation, body: RemoteControlEnvelopeValidation.empty(body, operation) }
    else if (operation === 'projects.list')
      return { ...base, operation, body: RemoteControlRequestValidation.projectsList(body) }
    else if (operation === 'sessions.list')
      return { ...base, operation, body: RemoteControlEnvelopeValidation.empty(body, operation) }
    else if (operation === 'sessions.create')
      return {
        ...base,
        operation,
        operationId: RemoteControlEnvelopeValidation.requiredOperationId(operationId),
        body: RemoteControlRequestValidation.sessionsCreate(body),
      }
    else if (operation === 'sessions.reopen')
      return {
        ...base,
        operation,
        operationId: RemoteControlEnvelopeValidation.requiredOperationId(operationId),
        body: RemoteControlRequestValidation.sessionBody(body, operation),
      }
    else if (operation === 'sessions.finalize')
      return {
        ...base,
        operation,
        operationId: RemoteControlEnvelopeValidation.requiredOperationId(operationId),
        body: RemoteControlRequestValidation.sessionBody(body, operation),
      }
    else if (operation === 'sessions.transcript')
      return { ...base, operation, body: RemoteControlRequestValidation.sessionBody(body, operation) }
    else if (operation === 'agents.describe')
      return { ...base, operation, body: RemoteControlEnvelopeValidation.empty(body, operation) }
    else if (operation === 'tabs.list')
      return { ...base, operation, body: RemoteControlEnvelopeValidation.empty(body, operation) }
    else if (operation === 'tabs.open')
      return {
        ...base,
        operation,
        operationId: RemoteControlEnvelopeValidation.requiredOperationId(operationId),
        body: RemoteControlRequestValidation.sessionBody(body, operation),
      }
    else if (operation === 'tabs.openFile')
      return {
        ...base,
        operation,
        operationId: RemoteControlEnvelopeValidation.requiredOperationId(operationId),
        body: RemoteControlRequestValidation.tabFileBody(body),
      }
    else if (operation === 'tabs.openCommit')
      return {
        ...base, operation,
        operationId: RemoteControlEnvelopeValidation.requiredOperationId(operationId),
        body: RemoteControlRequestValidation.tabCommitBody(body),
      }
    else if (operation === 'tabs.focus')
      return {
        ...base,
        operation,
        operationId: RemoteControlEnvelopeValidation.requiredOperationId(operationId),
        body: RemoteControlRequestValidation.panelBody(body, operation),
      }
    else if (operation === 'tabs.close')
      return {
        ...base,
        operation,
        operationId: RemoteControlEnvelopeValidation.requiredOperationId(operationId),
        body: RemoteControlRequestValidation.panelBody(body, operation),
      }
    else if (operation === 'terminal.peek')
      return { ...base, operation, body: RemoteControlRequestValidation.terminalPeek(body) }
    else if (operation === 'terminal.send')
      return {
        ...base,
        operation,
        operationId: RemoteControlEnvelopeValidation.requiredOperationId(operationId),
        body: RemoteControlRequestValidation.terminalSend(body),
      }
    else
      throw new Error(`Unknown remote control operation: ${JSON.stringify(operation)}`)
  }

  private static projectsList(
    input: unknown,
  ): { categoryId?: string; sort?: 'alpha' | 'recent' } {
    const value = RemoteControlEnvelopeValidation.object(input, 'projects.list body')
    RemoteControlEnvelopeValidation.keys(value, ['categoryId', 'sort'], 'projects.list body')
    const categoryId = value.categoryId === undefined
      ? undefined
      : RemoteControlEnvelopeValidation.text(
          value.categoryId,
          'categoryId',
          RemoteControlRequestValidation.idLengthConst,
        )
    let sort: 'alpha' | 'recent' | undefined
    if (value.sort === undefined) sort = undefined
    else if (value.sort === 'alpha' || value.sort === 'recent') sort = value.sort
    else throw new RemoteControlValidationError('sort must be alpha or recent')
    return {
      ...(categoryId === undefined ? {} : { categoryId }),
      ...(sort === undefined ? {} : { sort }),
    }
  }

  private static sessionsCreate(
    input: unknown,
  ): { spec: SessionCreateSpec; openTab?: boolean } {
    const value = RemoteControlEnvelopeValidation.object(input, 'sessions.create body')
    RemoteControlEnvelopeValidation.keys(value, ['spec', 'openTab'], 'sessions.create body')
    const spec = RemoteControlRequestValidation.sessionSpec(value.spec)
    const openTab = value.openTab === undefined
      ? undefined
      : RemoteControlRequestValidation.boolean(value.openTab, 'openTab')
    /*
     * A session of the tab is drawn by that tab and by nothing else - the tree does not carry it -
     * so asking for one without asking for the tab makes a session nobody can see and nobody will
     * clean up. The create path already knows this: when the tab fails to open it discards the
     * session it just made. Refused here rather than in the CLI parser, because a peer never goes
     * through one.
     */
    if (spec.presentation === 'tab' && openTab !== true)
      throw new RemoteControlValidationError(
        'A session with presentation tab needs openTab: nothing else draws one',
      )
    return { spec, ...(openTab === undefined ? {} : { openTab }) }
  }

  private static sessionBody(
    input: unknown,
    operation: string,
  ): { session: RemoteControlSessionSelector } {
    const value = RemoteControlEnvelopeValidation.object(input, `${operation} body`)
    RemoteControlEnvelopeValidation.keys(value, ['session'], `${operation} body`)
    return { session: RemoteControlRequestValidation.sessionSelector(value.session) }
  }

  private static panelBody(input: unknown, operation: string): { panelId: string } {
    const value = RemoteControlEnvelopeValidation.object(input, `${operation} body`)
    RemoteControlEnvelopeValidation.keys(value, ['panelId'], `${operation} body`)
    return {
      panelId: RemoteControlEnvelopeValidation.text(
        value.panelId,
        'panelId',
        RemoteControlRequestValidation.idLengthConst,
      ),
    }
  }

  private static tabFileBody(
    input: unknown,
  ): { session: RemoteControlSessionSelector; path: string } {
    const value = RemoteControlEnvelopeValidation.object(input, 'tabs.openFile body')
    RemoteControlEnvelopeValidation.keys(value, ['session', 'path'], 'tabs.openFile body')
    return {
      session: RemoteControlRequestValidation.sessionSelector(value.session),
      path: RemoteControlEnvelopeValidation.text(
        value.path,
        'path',
        RemoteControlRequestValidation.pathLengthConst,
      ),
    }
  }

  private static tabCommitBody(input: unknown): {
    session: RemoteControlSessionSelector; vcs: 'svn' | 'git'; scope?: string; message?: string
  } {
    const value = RemoteControlEnvelopeValidation.object(input, 'tabs.openCommit body')
    RemoteControlEnvelopeValidation.keys(value, ['session', 'vcs', 'scope', 'message'], 'tabs.openCommit body')
    if (value.vcs !== 'svn' && value.vcs !== 'git') throw new RemoteControlValidationError('vcs must be svn or git')
    if (value.message !== undefined && (typeof value.message !== 'string' || value.message.length > RemoteControlRequestValidation.messageLengthConst))
      throw new RemoteControlValidationError('message must be text of at most 65536 characters')
    return {
      session: RemoteControlRequestValidation.sessionSelector(value.session), vcs: value.vcs,
      ...(value.scope === undefined ? {} : { scope: RemoteControlEnvelopeValidation.text(value.scope, 'scope', RemoteControlRequestValidation.pathLengthConst) }),
      ...(value.message === undefined ? {} : { message: value.message }),
    }
  }

  private static terminalPeek(input: unknown): {
    session: RemoteControlSessionSelector
    cols?: number
    rows?: number
    timeoutMs?: number
  } {
    const value = RemoteControlEnvelopeValidation.object(input, 'terminal.peek body')
    RemoteControlEnvelopeValidation.keys(
      value,
      ['session', 'cols', 'rows', 'timeoutMs'],
      'terminal.peek body',
    )
    const session = RemoteControlRequestValidation.sessionSelector(value.session)
    const cols = RemoteControlRequestValidation.optionalInteger(value.cols, 'cols', 2, 1_000)
    const rows = RemoteControlRequestValidation.optionalInteger(value.rows, 'rows', 1, 500)
    if ((cols === undefined) !== (rows === undefined))
      throw new RemoteControlValidationError('cols and rows must be provided together')
    const timeoutMs = RemoteControlRequestValidation.optionalInteger(
      value.timeoutMs,
      'timeoutMs',
      50,
      60_000,
    )
    let size: { cols: number; rows: number } | Record<string, never>
    if (cols === undefined && rows === undefined) size = {}
    else if (cols !== undefined && rows !== undefined) size = { cols, rows }
    else throw new Error('Terminal size pairing passed validation in an invalid state')
    return { session, ...size, ...(timeoutMs === undefined ? {} : { timeoutMs }) }
  }

  private static terminalSend(input: unknown): {
    session: RemoteControlSessionSelector
    text: string
    enter?: boolean
    timeoutMs?: number
  } {
    const value = RemoteControlEnvelopeValidation.object(input, 'terminal.send body')
    RemoteControlEnvelopeValidation.keys(
      value,
      ['session', 'text', 'enter', 'timeoutMs'],
      'terminal.send body',
    )
    const session = RemoteControlRequestValidation.sessionSelector(value.session)
    const text = RemoteControlRequestValidation.string(
      value.text,
      'text',
      RemoteControlRequestValidation.terminalTextLengthConst,
    )
    const enter = value.enter === undefined
      ? undefined
      : RemoteControlRequestValidation.boolean(value.enter, 'enter')
    const timeoutMs = RemoteControlRequestValidation.optionalInteger(
      value.timeoutMs,
      'timeoutMs',
      50,
      60_000,
    )
    return {
      session,
      text,
      ...(enter === undefined ? {} : { enter }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }
  }

  private static sessionSelector(input: unknown): RemoteControlSessionSelector {
    const value = RemoteControlEnvelopeValidation.object(input, 'session selector')
    RemoteControlEnvelopeValidation.keys(value, ['kind', 'sessionId', 'number'], 'session selector')
    if (value.kind === 'sessionId')
      return {
        kind: value.kind,
        sessionId: RemoteControlEnvelopeValidation.text(
          value.sessionId,
          'sessionId',
          RemoteControlRequestValidation.idLengthConst,
        ),
      }
    else if (value.kind === 'number') {
      const number = RemoteControlEnvelopeValidation.text(value.number, 'number', 7)
      if (!/^\d{3}(?:-\d{3})?$/.test(number))
        throw new RemoteControlValidationError(
          'number must contain three digits or two three-digit parts separated by a hyphen',
        )
      return { kind: value.kind, number }
    } else
      throw new RemoteControlValidationError('session selector kind must be sessionId or number')
  }

  private static sessionSpec(input: unknown): SessionCreateSpec {
    const value = RemoteControlEnvelopeValidation.object(input, 'session spec')
    RemoteControlEnvelopeValidation.keys(
      value,
      [
        'kind',
        'directory',
        'agent',
        'worktree',
        'title',
        'flowId',
        'presentation',
        'acknowledgeSetup',
      ],
      'session spec',
    )
    if (value.kind !== 'shell' && value.kind !== 'agent')
      throw new RemoteControlValidationError('session kind must be shell or agent')
    const directory = RemoteControlRequestValidation.directory(value.directory)
    const agent = value.agent === undefined
      ? undefined
      : RemoteControlRequestValidation.agent(value.agent)
    if (value.kind === 'agent' && agent === undefined)
      throw new RemoteControlValidationError('agent is required for an agent session')
    if (value.kind === 'shell' && agent !== undefined)
      throw new RemoteControlValidationError('agent is not allowed for a shell session')
    const worktree = value.worktree === undefined
      ? undefined
      : RemoteControlRequestValidation.worktree(value.worktree)
    const title = RemoteControlRequestValidation.optionalString(value.title, 'title', 512)
    const flowId = RemoteControlRequestValidation.optionalText(
      value.flowId,
      'flowId',
      RemoteControlRequestValidation.idLengthConst,
    )
    if (value.presentation !== undefined && value.presentation !== 'tab')
      throw new RemoteControlValidationError('presentation must be tab')
    const acknowledgeSetup = RemoteControlRequestValidation.optionalText(
      value.acknowledgeSetup,
      'acknowledgeSetup',
      RemoteControlRequestValidation.idLengthConst,
    )
    return {
      kind: value.kind,
      directory,
      ...(agent === undefined ? {} : { agent }),
      ...(worktree === undefined ? {} : { worktree }),
      ...(title === undefined ? {} : { title }),
      ...(flowId === undefined ? {} : { flowId }),
      ...(value.presentation === undefined ? {} : { presentation: value.presentation }),
      ...(acknowledgeSetup === undefined ? {} : { acknowledgeSetup }),
    }
  }

  private static directory(input: unknown): SessionCreateSpec['directory'] {
    const value = RemoteControlEnvelopeValidation.object(input, 'session directory')
    RemoteControlEnvelopeValidation.keys(
      value,
      ['mode', 'categoryId', 'projectPath', 'path'],
      'session directory',
    )
    if (value.mode === 'project')
      return {
        mode: value.mode,
        categoryId: RemoteControlEnvelopeValidation.text(
          value.categoryId,
          'categoryId',
          RemoteControlRequestValidation.idLengthConst,
        ),
        projectPath: RemoteControlEnvelopeValidation.text(
          value.projectPath,
          'projectPath',
          RemoteControlRequestValidation.pathLengthConst,
        ),
      }
    else if (value.mode === 'adHoc')
      return {
        mode: value.mode,
        path: RemoteControlEnvelopeValidation.text(
          value.path,
          'path',
          RemoteControlRequestValidation.pathLengthConst,
        ),
      }
    else if (value.mode === 'default') return { mode: value.mode }
    else
      throw new RemoteControlValidationError('directory mode must be project, adHoc or default')
  }

  private static agent(input: unknown): NonNullable<SessionCreateSpec['agent']> {
    const value = RemoteControlEnvelopeValidation.object(input, 'agent')
    RemoteControlEnvelopeValidation.keys(
      value,
      ['agentId', 'mode', 'nativeSessionId', 'forkParentId', 'initialPrompt', 'model'],
      'agent',
    )
    if (value.agentId !== 'claude' && value.agentId !== 'codex')
      throw new RemoteControlValidationError('agentId must be claude or codex')
    if (value.mode !== 'new'
      && value.mode !== 'continue'
      && value.mode !== 'resume'
      && value.mode !== 'fork')
      throw new RemoteControlValidationError('agent mode is invalid')
    const nativeSessionId = RemoteControlRequestValidation.optionalText(
      value.nativeSessionId,
      'nativeSessionId',
      RemoteControlRequestValidation.idLengthConst,
    )
    const forkParentId = RemoteControlRequestValidation.optionalText(
      value.forkParentId,
      'forkParentId',
      RemoteControlRequestValidation.idLengthConst,
    )
    const initialPrompt = RemoteControlRequestValidation.optionalString(
      value.initialPrompt,
      'initialPrompt',
      RemoteControlRequestValidation.promptLengthConst,
    )
    const model = RemoteControlRequestValidation.optionalText(
      value.model,
      'model',
      RemoteControlRequestValidation.modelLengthConst,
    )
    if (model !== undefined && !RemoteControlRequestValidation.modelShapeConst.test(model))
      throw new RemoteControlValidationError('model has an invalid shape')
    return {
      agentId: value.agentId,
      mode: value.mode,
      ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
      ...(forkParentId === undefined ? {} : { forkParentId }),
      ...(initialPrompt === undefined ? {} : { initialPrompt }),
      ...(model === undefined ? {} : { model }),
    }
  }

  private static worktree(input: unknown): NonNullable<SessionCreateSpec['worktree']> {
    const value = RemoteControlEnvelopeValidation.object(input, 'worktree')
    RemoteControlEnvelopeValidation.keys(value, ['slug', 'baseRef'], 'worktree')
    const slug = RemoteControlEnvelopeValidation.text(value.slug, 'slug', 256)
    const baseRef = RemoteControlRequestValidation.optionalText(value.baseRef, 'baseRef', 1_024)
    return { slug, ...(baseRef === undefined ? {} : { baseRef }) }
  }

  private static string(input: unknown, name: string, maximumLength: number): string {
    if (typeof input !== 'string')
      throw new RemoteControlValidationError(`${name} must be a string`)
    if (input.length > maximumLength)
      throw new RemoteControlValidationError(`${name} exceeds ${maximumLength} characters`)
    return input
  }

  private static optionalText(
    input: unknown,
    name: string,
    maximumLength: number,
  ): string | undefined {
    if (input === undefined) return undefined
    return RemoteControlEnvelopeValidation.text(input, name, maximumLength)
  }

  private static optionalString(
    input: unknown,
    name: string,
    maximumLength: number,
  ): string | undefined {
    if (input === undefined) return undefined
    return RemoteControlRequestValidation.string(input, name, maximumLength)
  }

  private static boolean(input: unknown, name: string): boolean {
    if (typeof input !== 'boolean')
      throw new RemoteControlValidationError(`${name} must be a boolean`)
    return input
  }

  private static optionalInteger(
    input: unknown,
    name: string,
    minimum: number,
    maximum: number,
  ): number | undefined {
    if (input === undefined) return undefined
    if (!Number.isInteger(input) || typeof input !== 'number' || input < minimum || input > maximum)
      throw new RemoteControlValidationError(`${name} must be an integer from ${minimum} to ${maximum}`)
    return input
  }
}
