import type {
  RemoteControlSessionSelector,
  RemoteControlStepResult,
} from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type {
  SessionCreateSpec,
  SessionsOpResult,
  SessionsSnapshot,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { ProjectsOpResult } from '../../../lib-orchestrator/projectManager/projectManagerApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import type {
  AppControlOperation,
  AppControlRequest,
  AppControlResponse,
} from '../../shared/appOperationMap'

/** A library refusal as the client hands it on: its own code and every field beside it. */
export interface AppControlRefusal<TCode extends string = string> {
  ok: false
  code: TCode
  detail: string
  [field: string]: unknown
}

/**
 * The window's way to an operation: by name, through the one `control:call` channel, into the same
 * registry a script reaches over HTTP.
 */
export class AppControl {
  /** The answer as the control API gives it: the value, or the protocol's refusal behind `error`. */
  static async call<K extends AppControlOperation>(
    operation: K,
    body: AppControlRequest<K>,
  ): Promise<IpcResult<RemoteControlStepResult<AppControlResponse<K>>>> {
    const answer = await window.appClient.control.call(operation, body)
    if (!answer.ok) return answer
    const envelope = answer.value
    return envelope.ok
      ? { ok: true, value: { ok: true, value: envelope.value as AppControlResponse<K> } }
      : { ok: true, value: { ok: false, error: envelope.error } }
  }

  /**
   * The same answer in the shape the library gave it: a refusal carries the library's own code
   * (`sourceCode`) and the fields the operation put beside it, so a surface written against a
   * library result reads it unchanged. A refusal with no library code - a schema the window broke,
   * a forbidden operation - is a fault of this window and fails the channel instead.
   */
  static async library<K extends AppControlOperation, TCode extends string = string>(
    operation: K,
    body: AppControlRequest<K>,
  ): Promise<IpcResult<{ ok: true; value: AppControlResponse<K> } | AppControlRefusal<TCode>>> {
    const answer = await AppControl.call(operation, body)
    if (!answer.ok) return answer
    const step = answer.value
    if (step.ok) return { ok: true, value: step }
    const { sourceCode, ...fields } = step.error.data ?? {}
    if (typeof sourceCode !== 'string')
      return { ok: false, error: `${operation}: ${step.error.code}: ${step.error.detail}` }
    return { ok: true, value: { ...fields, ok: false, code: sourceCode as TCode, detail: step.error.detail } }
  }

  /** A session manager operation, answered as the `SessionsOpResult` the session manager gave. */
  static async sessions<K extends AppControlOperation>(
    operation: K,
    body: AppControlRequest<K>,
  ): Promise<IpcResult<SessionsOpResult<AppControlResponse<K>>>> {
    return await AppControl.library(operation, body) as IpcResult<SessionsOpResult<AppControlResponse<K>>>
  }

  /** The same, for a caller that only needs to know it was done. */
  static async sessionsDone<K extends AppControlOperation>(
    operation: K,
    body: AppControlRequest<K>,
  ): Promise<IpcResult<SessionsOpResult>> {
    const answer = await AppControl.sessions(operation, body)
    if (!answer.ok || !answer.value.ok) return answer as IpcResult<SessionsOpResult>
    return { ok: true, value: { ok: true, value: undefined } }
  }

  /** A create as the launcher reads it: the new session's id and the name its tab takes. */
  static async createSession(
    spec: SessionCreateSpec,
  ): Promise<IpcResult<SessionsOpResult<{ sessionId: string; tabTitle: string }>>> {
    const answer = await AppControl.sessions('sessions.create', { spec })
    if (!answer.ok || !answer.value.ok) return answer as IpcResult<SessionsOpResult<{ sessionId: string; tabTitle: string }>>
    const { sessionId, tabTitle } = answer.value.value.session
    return { ok: true, value: { ok: true, value: { sessionId, tabTitle } } }
  }

  /** The sessions snapshot as the session manager composes it; the group of each row is the tree's own. */
  static async snapshot(): Promise<IpcResult<SessionsSnapshot>> {
    const answer = await AppControl.value('sessions.list', {})
    if (!answer.ok) return answer
    // The list sends null for a session made without a create operation id; the snapshot leaves it absent.
    return { ok: true, value: { ...answer.value, sessions: answer.value.sessions.map((session) =>
      ({ ...session, callerOperationId: session.callerOperationId ?? undefined })) } }
  }

  static sessionOf(sessionId: string): RemoteControlSessionSelector {
    return { kind: 'sessionId', sessionId }
  }

  /** A project manager operation, answered as the `ProjectsOpResult` the project manager gave. */
  static async projects<K extends AppControlOperation>(
    operation: K,
    body: AppControlRequest<K>,
  ): Promise<IpcResult<ProjectsOpResult<AppControlResponse<K>>>> {
    return await AppControl.library(operation, body) as IpcResult<ProjectsOpResult<AppControlResponse<K>>>
  }

  static async projectsDone<K extends AppControlOperation>(
    operation: K,
    body: AppControlRequest<K>,
  ): Promise<IpcResult<ProjectsOpResult>> {
    const answer = await AppControl.projects(operation, body)
    if (!answer.ok || !answer.value.ok) return answer as IpcResult<ProjectsOpResult>
    return { ok: true, value: { ok: true, value: undefined } }
  }

  /** The value, or a channel failure naming the refusal: for a read whose library never refuses. */
  static async value<K extends AppControlOperation>(
    operation: K,
    body: AppControlRequest<K>,
  ): Promise<IpcResult<AppControlResponse<K>>> {
    const answer = await AppControl.call(operation, body)
    if (!answer.ok) return answer
    return answer.value.ok
      ? { ok: true, value: answer.value.value }
      : { ok: false, error: `${operation}: ${answer.value.error.code}: ${answer.value.error.detail}` }
  }
}
