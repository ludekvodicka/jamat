import { SessionTitle } from '../sessionManager/records/sessionTitle'
import { SessionColors } from '../sessionManager/sessionColors'
import { SessionGroups } from '../sessionManager/sessionGroups'
import { SessionLimits } from '../sessionManager/sessionLimits'
import type {
  SessionColorName,
  SessionCreateSpec,
  SessionGroup,
} from '../sessionManager/sessionManagerApi.types'
import type {
  RemoteControlError,
  RemoteControlMutatingOperation,
  RemoteControlOperation,
  RemoteControlRequestUnion,
  RemoteControlSessionSelector,
  RemoteControlTerminalDeliverInput,
} from './remoteControlApi.types'
import {
  RemoteControlEnvelopeValidation,
  RemoteControlValidationError,
} from './remoteControlEnvelopeValidation'
import { RemoteControlConst, RemoteControlDeliverConst } from './remoteControlProtocol'

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
    else if (operation === 'sessions.finalize' || operation === 'sessions.remove')
      return {
        ...base,
        operation,
        operationId: RemoteControlEnvelopeValidation.requiredOperationId(operationId),
        body: RemoteControlRequestValidation.sessionBody(body, operation),
      }
    else if (operation === 'sessions.transcript')
      return { ...base, operation, body: RemoteControlRequestValidation.sessionBody(body, operation) }
    else if (operation === 'sessions.color')
      return {
        ...base,
        operation,
        operationId: RemoteControlEnvelopeValidation.requiredOperationId(operationId),
        body: RemoteControlRequestValidation.sessionColorBody(body),
      }
    else if (operation === 'sessions.group')
      return {
        ...base,
        operation,
        operationId: RemoteControlEnvelopeValidation.requiredOperationId(operationId),
        body: RemoteControlRequestValidation.sessionGroupBody(body),
      }
    else if (operation === 'sessions.note')
      return { ...base, operation, body: RemoteControlRequestValidation.sessionBody(body, operation) }
    else if (operation === 'sessions.setNote')
      return {
        ...base,
        operation,
        operationId: RemoteControlEnvelopeValidation.requiredOperationId(operationId),
        body: RemoteControlRequestValidation.sessionNoteBody(body),
      }
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
    else if (operation === 'tabs.commitStatus' || operation === 'tabs.cancelCommit') {
      const value = RemoteControlEnvelopeValidation.object(body, `${operation} body`)
      RemoteControlEnvelopeValidation.keys(value, ['commitSessionId'], `${operation} body`)
      if (typeof value.commitSessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.commitSessionId))
        throw new RemoteControlValidationError('commitSessionId must be a UUID')
      return { ...base, operation,
        ...(operation === 'tabs.cancelCommit' ? { operationId: RemoteControlEnvelopeValidation.requiredOperationId(operationId) } : {}),
        body: { commitSessionId: value.commitSessionId } }
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
    else if (operation === 'terminal.deliver')
      return {
        ...base,
        operation,
        operationId: RemoteControlEnvelopeValidation.requiredOperationId(operationId),
        body: RemoteControlRequestValidation.terminalDeliver(body),
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
  ): { spec: SessionCreateSpec; openTab?: boolean; group?: SessionGroup } {
    const value = RemoteControlEnvelopeValidation.object(input, 'sessions.create body')
    RemoteControlEnvelopeValidation.keys(value, ['spec', 'openTab', 'group'], 'sessions.create body')
    const spec = RemoteControlRequestValidation.sessionSpec(value.spec)
    const openTab = value.openTab === undefined
      ? undefined
      : RemoteControlRequestValidation.boolean(value.openTab, 'openTab')
    const group = RemoteControlRequestValidation.group(value.group)
    return {
      spec,
      ...(openTab === undefined ? {} : { openTab }),
      ...(group === undefined ? {} : { group }),
    }
  }

  /**
   * Required here and optional on a create, which is the difference between painting a session at
   * birth and repainting one: a create that names no colour leaves it unpainted, and a repaint that
   * names none is a request that says nothing. A missing key therefore fails the same sentence an
   * unknown name does, because both are the caller not naming one of the twelve.
   */
  private static sessionColorBody(
    input: unknown,
  ): { session: RemoteControlSessionSelector; color: SessionColorName } {
    const value = RemoteControlEnvelopeValidation.object(input, 'sessions.color body')
    RemoteControlEnvelopeValidation.keys(value, ['session', 'color'], 'sessions.color body')
    return {
      session: RemoteControlRequestValidation.sessionSelector(value.session),
      color: RemoteControlRequestValidation.colorNamed(value.color),
    }
  }

  private static sessionGroupBody(
    input: unknown,
  ): { session: RemoteControlSessionSelector; group: SessionGroup } {
    const value = RemoteControlEnvelopeValidation.object(input, 'sessions.group body')
    RemoteControlEnvelopeValidation.keys(value, ['session', 'group'], 'sessions.group body')
    return {
      session: RemoteControlRequestValidation.sessionSelector(value.session),
      group: RemoteControlRequestValidation.groupNamed(value.group),
    }
  }

  /**
   * `null` is the caller clearing the note and is not the same as an absent key, which is a caller
   * who forgot to say what to write: exact keys refuse that one. Empty text clears it too, because
   * the record holds a note trimmed and a note of nothing is no note - the library's own rule, not
   * a second one written here.
   */
  private static sessionNoteBody(
    input: unknown,
  ): { session: RemoteControlSessionSelector; note: string | null } {
    const value = RemoteControlEnvelopeValidation.object(input, 'sessions.setNote body')
    RemoteControlEnvelopeValidation.keys(value, ['session', 'note'], 'sessions.setNote body')
    if (value.note !== null && typeof value.note !== 'string')
      throw new RemoteControlValidationError('note must be a string or null')
    if (typeof value.note === 'string' && value.note.length > SessionLimits.noteCharacters)
      throw new RemoteControlValidationError(
        `note must be at most ${SessionLimits.noteCharacters} characters`,
      )
    return {
      session: RemoteControlRequestValidation.sessionSelector(value.session),
      note: value.note,
    }
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
    session: RemoteControlSessionSelector; vcs: 'svn' | 'git'; scope?: string; paths?: readonly string[]; message?: string
  } {
    const value = RemoteControlEnvelopeValidation.object(input, 'tabs.openCommit body')
    RemoteControlEnvelopeValidation.keys(value, ['session', 'vcs', 'scope', 'paths', 'message'], 'tabs.openCommit body')
    if (value.vcs !== 'svn' && value.vcs !== 'git') throw new RemoteControlValidationError('vcs must be svn or git')
    if (value.message !== undefined && (typeof value.message !== 'string' || value.message.length > RemoteControlRequestValidation.messageLengthConst))
      throw new RemoteControlValidationError('message must be text of at most 65536 characters')
    let paths: string[] | undefined
    if (value.paths !== undefined) {
      if (!Array.isArray(value.paths) || value.paths.length === 0 || value.paths.length > 2_000)
        throw new RemoteControlValidationError('paths must contain between 1 and 2000 literal paths')
      paths = value.paths.map((path) => RemoteControlEnvelopeValidation.text(path, 'commit path', RemoteControlRequestValidation.pathLengthConst))
    }
    return {
      session: RemoteControlRequestValidation.sessionSelector(value.session), vcs: value.vcs,
      ...(value.scope === undefined ? {} : { scope: RemoteControlEnvelopeValidation.text(value.scope, 'scope', RemoteControlRequestValidation.pathLengthConst) }),
      ...(paths === undefined ? {} : { paths }),
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
      const number = RemoteControlEnvelopeValidation.text(
        value.number,
        'number',
        SessionTitle.numberCharactersConst,
      )
      if (!SessionTitle.isSelectorNumber(number))
        throw new RemoteControlValidationError(
          'number must be a session number, a custom number such as "i34", or two such parts '
          + 'separated by a hyphen',
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
        'number',
        'color',
        'flowId',
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
    const number = RemoteControlRequestValidation.optionalText(
      value.number,
      'number',
      SessionTitle.numberCharactersConst,
    )
    // The shape alone, here and in the library both: this one is a wire contract and the library's
    // is the write, and neither may be the only place a malformed number is stopped.
    if (number !== undefined && !SessionTitle.isCustomNumber(number))
      throw new RemoteControlValidationError(
        'number must be one to three letters then up to six digits, such as "i34"',
      )
    const color = RemoteControlRequestValidation.color(value.color)
    const flowId = RemoteControlRequestValidation.optionalText(
      value.flowId,
      'flowId',
      RemoteControlRequestValidation.idLengthConst,
    )
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
      ...(number === undefined ? {} : { number }),
      ...(color === undefined ? {} : { color }),
      ...(flowId === undefined ? {} : { flowId }),
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

  /**
   * `typed` stays one line: a raw `\r` or `\n` would submit the text early. A paste carries its line
   * breaks inside the bracketed-paste markers, so line breaks and tabs are the only control
   * characters it may carry.
   */
  private static terminalDeliver(input: unknown): {
    session: RemoteControlSessionSelector
    text: string
    input?: RemoteControlTerminalDeliverInput
    readyTimeoutMs?: number
    submitTimeoutMs?: number
    queue?: boolean
  } {
    const value = RemoteControlEnvelopeValidation.object(input, 'terminal.deliver body')
    RemoteControlEnvelopeValidation.keys(
      value,
      ['session', 'text', 'input', 'readyTimeoutMs', 'submitTimeoutMs', 'queue'],
      'terminal.deliver body',
    )
    const session = RemoteControlRequestValidation.sessionSelector(value.session)
    let mode: RemoteControlTerminalDeliverInput | undefined
    if (value.input === undefined) mode = undefined
    else if (value.input === 'paste' || value.input === 'typed') mode = value.input
    else throw new RemoteControlValidationError('input must be paste or typed')
    const typed = mode === 'typed'
    const text = RemoteControlRequestValidation.string(
      value.text,
      'text',
      typed ? RemoteControlDeliverConst.textLengthConst : RemoteControlRequestValidation.terminalTextLengthConst,
    )
    if (text.length === 0)
      throw new RemoteControlValidationError('text must not be empty')
    if (typed && /[\r\n]/.test(text))
      throw new RemoteControlValidationError('typed text must be one line: deliver it as a paste instead')
    if (typed && /[\x00-\x1f\x7f]/.test(text))
      throw new RemoteControlValidationError('typed text must not contain control characters')
    // An ESC would let the text close the bracketed paste itself (`\x1b[201~\r`) and submit early.
    if (!typed && /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
      throw new RemoteControlValidationError('pasted text must not contain control characters other than line breaks and tabs')
    const readyTimeoutMs = RemoteControlRequestValidation.optionalInteger(
      value.readyTimeoutMs,
      'readyTimeoutMs',
      RemoteControlDeliverConst.readyTimeoutMinimumMillisecondsConst,
      RemoteControlDeliverConst.readyTimeoutMaximumMillisecondsConst,
    )
    const submitTimeoutMs = RemoteControlRequestValidation.optionalInteger(
      value.submitTimeoutMs,
      'submitTimeoutMs',
      RemoteControlDeliverConst.submitTimeoutMinimumMillisecondsConst,
      RemoteControlDeliverConst.submitTimeoutMaximumMillisecondsConst,
    )
    return {
      session,
      text,
      ...(mode === undefined ? {} : { input: mode }),
      ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs }),
      ...(submitTimeoutMs === undefined ? {} : { submitTimeoutMs }),
      ...(value.queue === undefined
        ? {}
        : { queue: RemoteControlRequestValidation.boolean(value.queue, 'queue') }),
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

  /**
   * Proved against the library's own list rather than against twelve strings written out here, which
   * is the whole reason `SessionColors` sits at its subsystem's root: the validator, the CLI parser
   * and the lifecycle each refuse the same set, and a colour added to the union is added once.
   */
  private static color(input: unknown): SessionColorName | undefined {
    if (input === undefined) return undefined
    return RemoteControlRequestValidation.colorNamed(input)
  }

  /** The same list where a colour is the point of the request rather than a decoration on it. */
  private static colorNamed(input: unknown): SessionColorName {
    if (!SessionColors.isName(input))
      throw new RemoteControlValidationError(
        `color must be one of ${SessionColors.namesConst.join(', ')}`,
      )
    return input
  }

  /**
   * The group a create may file its session under, and here the asymmetry with `color` beside it
   * begins *(2026-09-22)*. A colour is drawn from a fixed palette and this validator can refuse an
   * unknown one outright. A group is a section a person made, so what is provable HERE is only that
   * the id could be a group at all; whether this computer has one is the client's answer, and it
   * comes back naming the groups it does have.
   */
  private static group(input: unknown): SessionGroup | undefined {
    if (input === undefined) return undefined
    return RemoteControlRequestValidation.groupNamed(input)
  }

  private static groupNamed(input: unknown): SessionGroup {
    if (!SessionGroups.isId(input))
      throw new RemoteControlValidationError(`group is invalid: ${SessionGroups.idRuleConst}`)
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
