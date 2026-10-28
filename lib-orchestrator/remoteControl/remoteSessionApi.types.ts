import type { RemoteReviewRequest } from './remoteReviewApi.types'
import type { RemoteTaskRequest } from './remoteTaskApi.types'
import type { RemoteFileRequest, RemoteChangesRequest, RemoteContentCursor, RemoteContentPage } from './remoteContentApi.types'
import type { SessionInfo, SessionsSnapshot } from '../sessionManager/sessionManagerApi.types'
import type { RemoteControlStepResult } from './remoteControlApi.types'
import type { SvnConflictKind, SvnConflictOption } from '../svn/svn.types'
import type { RemoteSidebarRequest } from './remoteSidebarApi.types'

export interface RemoteSessionRevision {
  epoch: string
  revision: number
}

export interface RemoteSessionSummary extends SessionInfo {
  reviewPending?: boolean
  pending: boolean
  hasResult: boolean
}

export type RemoteSessionStateRequest = {
  requestId: string
  expected: RemoteSessionRevision | null
  offset: number
} & ({ kind: 'sessions' | 'categories' } | { kind: 'detail'; sessionId: string })

export type RemoteSessionStatePage = RemoteSessionRevision & {
  offset: number
  next: number | null
} & (
  | { kind: 'sessions' | 'categories'; snapshot: SessionsSnapshot }
  | { kind: 'detail'; sessionId: string; sourceRevision?: number; base64: string; totalBytes: number }
)

export interface RemoteSessionStateResponse {
  requestId: string
  result: RemoteControlStepResult<RemoteSessionStatePage>
}

export interface RemoteSessionView {
  viewId: string
  epoch: string
  sessionId: string
  viewerId: string
}

export interface SessionViewOpenRequest { openId: string; item: { kind: 'file'; documentId: string } | { kind: 'workflow' } | { kind: 'task'; task: { kind: 'subagent'; subagentId: string } | { kind: 'shell'; shellId: string } | { kind: 'script'; runId: string } } }

export interface SessionViewOperationMap {
  'sidebar.request': { request: RemoteSidebarRequest; response: RemoteContentPage }
  'sidebar.page': { request: RemoteContentCursor; response: RemoteContentPage }
  'reviews.request': { request: RemoteReviewRequest; response: RemoteContentPage }
  'reviews.page': { request: RemoteContentCursor; response: RemoteContentPage }
  'tasks.request': { request: RemoteTaskRequest; response: RemoteContentPage }
  'tasks.page': { request: { task: RemoteTaskRequest; cursor: RemoteContentCursor }; response: RemoteContentPage }
  'items.open': { request: SessionViewOpenRequest; response: RemoteContentPage }
  'items.request': { request: { after: number; epoch?: string; revision?: number }; response: RemoteContentPage }
  'items.page': { request: RemoteContentCursor; response: RemoteContentPage }
  'changes.request': { request: RemoteChangesRequest; response: RemoteContentPage }
  'changes.page': { request: RemoteContentCursor; response: RemoteContentPage }
  'files.request': { request: RemoteFileRequest; response: RemoteContentPage }
  'files.page': { request: RemoteContentCursor; response: RemoteContentPage }
  'views.open': { request: { sessionId: string; viewerId: string }; response: RemoteSessionView }
  'views.close': { request: Record<string, never>; response: null }
  'actions.press': {
    request: { revision: number; workflowId: string; actionId: string; agreement: { acknowledgeSetup?: string; confirmWorking?: true; overrideChecks?: true }; commit?: { selection: string[]; message: string } }
      | { kind: 'resolve-conflict'; revision: number; path: string; conflictKind?: SvnConflictKind; option: SvnConflictOption; confirm?: true }
      | { kind: 'clear-history'; revision: number }
    response: null
  }
}

export type RemoteSessionViewRequest = {
  [K in keyof SessionViewOperationMap]: {
    requestId: string
    operation: K
    body: SessionViewOperationMap[K]['request']
  } & (K extends 'views.open' ? { epoch: string }
    : RemoteSessionView & (K extends 'actions.press' ? { operationId: string } : object))
}[keyof SessionViewOperationMap]

export interface RemoteSessionViewResponse {
  requestId: string
  operation: keyof SessionViewOperationMap
  result: RemoteControlStepResult<SessionViewOperationMap[keyof SessionViewOperationMap]['response']>
}

export interface RemoteSessionDetail {
  revision: number
  session: SessionInfo
}

export type RemoteSessionReadRequest = Extract<RemoteSessionViewRequest, { operation: 'sidebar.request' | 'sidebar.page' | 'reviews.request' | 'reviews.page' | 'tasks.request' | 'tasks.page' | 'files.request' | 'files.page' | 'changes.request' | 'changes.page' | 'items.request' | 'items.page' | 'items.open' }>
