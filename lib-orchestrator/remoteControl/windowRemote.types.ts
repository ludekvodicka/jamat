import type { RemoteControlResponse, RemoteControlStepResult } from './remoteControlApi.types'
import type { RemoteConnectionsSnapshot } from './remoteConnectionsApi.types'
import type { RemoteConnectionsHoldReason } from './remoteConnectionsHold'
import type { RemoteSessionCommand } from './remoteSessionCommand'
import type { RemoteSessionView, RemoteSessionDetail, SessionViewOperationMap, SessionViewOpenRequest } from './remoteSessionApi.types'
import type { RemoteChangesRequest, RemoteFileRequest, RemoteContentCursor, RemoteContentPage } from './remoteContentApi.types'
import type { RemoteSidebarRequest } from './remoteSidebarApi.types'
import type { RemoteTaskRequest } from './remoteTaskApi.types'
import type { SessionCreateSpec, SessionsOpResult, TerminalAttachSpec } from '../sessionManager/sessionManagerApi.types'
import type { TerminalClipboardPaste } from '../sessionManager/terminalClipboardPaste'

export interface WindowRemoteInvokeMap {
  'remote:changes-request': (endpointId: string, viewId: string, body: RemoteChangesRequest) => RemoteControlStepResult<RemoteContentPage>
  'remote:changes-page': (endpointId: string, viewId: string, body: RemoteContentCursor) => RemoteControlStepResult<RemoteContentPage>
  'remote:reviews-request': (endpointId: string, viewId: string, body: import('./remoteReviewApi.types').RemoteReviewRequest) => RemoteControlStepResult<RemoteContentPage>
  'remote:reviews-page': (endpointId: string, viewId: string, body: RemoteContentCursor) => RemoteControlStepResult<RemoteContentPage>
  'remote:sidebar-request': (endpointId: string, viewId: string, body: RemoteSidebarRequest) => RemoteControlStepResult<RemoteContentPage>
  'remote:sidebar-page': (endpointId: string, viewId: string, body: RemoteContentCursor) => RemoteControlStepResult<RemoteContentPage>
  'remote:tasks-request': (endpointId: string, viewId: string, body: RemoteTaskRequest) => RemoteControlStepResult<RemoteContentPage>
  'remote:tasks-page': (endpointId: string, viewId: string, body: { task: RemoteTaskRequest; cursor: RemoteContentCursor }) => RemoteControlStepResult<RemoteContentPage>
  'remote:items-open': (endpointId: string, viewId: string, body: SessionViewOpenRequest) => RemoteControlStepResult<RemoteContentPage>
  'remote:items-request': (endpointId: string, viewId: string, body: SessionViewOperationMap['items.request']['request']) => RemoteControlStepResult<RemoteContentPage>
  'remote:items-page': (endpointId: string, viewId: string, body: RemoteContentCursor) => RemoteControlStepResult<RemoteContentPage>
  'remote:files-request': (endpointId: string, viewId: string, body: RemoteFileRequest) => RemoteControlStepResult<RemoteContentPage>
  'remote:files-page': (endpointId: string, viewId: string, body: RemoteContentCursor) => RemoteControlStepResult<RemoteContentPage>
  'remote:view-detail': (endpointId: string, viewId: string) => RemoteControlStepResult<RemoteSessionDetail>
  'remote:view-open': (endpointId: string, sessionId: string) => RemoteControlStepResult<RemoteSessionView>
  'remote:view-close': (endpointId: string, viewId: string) => RemoteControlStepResult<null>
  'remote:view-press': (endpointId: string, viewId: string, body: SessionViewOperationMap['actions.press']['request'], operationId: string) => RemoteControlStepResult<null>
  'remote:snapshot': () => RemoteConnectionsSnapshot
  'remote:connect': (reason: RemoteConnectionsHoldReason, remoteEndpointId: string) => RemoteControlStepResult<undefined>
  'remote:select-session': (remoteEndpointId: string, sessionId: string) => RemoteControlStepResult<undefined>
  'remote:disconnect': (remoteEndpointId: string, sessionIds?: readonly string[]) => void
  'remote:release': (reason: RemoteConnectionsHoldReason) => void
  'remote:agents-describe': (remoteEndpointId: string) => RemoteControlResponse
  'remote:accounts-list': (remoteEndpointId: string) => RemoteControlResponse
  'remote:projects-list': (
    remoteEndpointId: string,
    request: { categoryId?: string; sort?: 'alpha' | 'recent' },
  ) => RemoteControlResponse
  'remote:session-command': (endpointId: string, command: RemoteSessionCommand) => RemoteControlResponse
  'remote:sessions-create': (
    remoteEndpointId: string,
    spec: SessionCreateSpec,
    operationId: string,
  ) => RemoteControlResponse
  'remote:sessions-reopen': (
    remoteEndpointId: string,
    sessionId: string,
  ) => RemoteControlResponse
  'remote:sessions-finalize': (
    remoteEndpointId: string,
    sessionId: string,
    acknowledgeSetup?: string,
  ) => RemoteControlResponse
  'remote:sessions-reference': (
    remoteEndpointId: string,
    sessionId: string,
  ) => SessionsOpResult<{ text: string }>
  'remote:terminal-attach': (
    remoteEndpointId: string,
    attachId: string,
    spec: TerminalAttachSpec,
  ) => RemoteControlStepResult<{ attachId: string; sessionId: string }>
  'remote:terminal-input': (
    remoteEndpointId: string,
    attachId: string,
    data: string,
  ) => RemoteControlStepResult<unknown>
  'remote:terminal-resize': (
    remoteEndpointId: string,
    attachId: string,
    cols: number,
    rows: number,
  ) => RemoteControlStepResult<unknown>
  'remote:terminal-active': (
    remoteEndpointId: string,
    attachId: string,
    active: boolean,
  ) => RemoteControlStepResult<unknown>
  'remote:terminal-detach': (
    remoteEndpointId: string,
    attachId: string,
  ) => RemoteControlStepResult<unknown>
  'remote:terminal-clipboard-paste': (
    remoteEndpointId: string,
    attachId: string,
  ) => RemoteControlStepResult<TerminalClipboardPaste>
}

export type WindowRemoteCall = { [K in keyof WindowRemoteInvokeMap]: { method: K; args: Parameters<WindowRemoteInvokeMap[K]> } }[keyof WindowRemoteInvokeMap]
