import type { FileViewerDocumentSource } from '../fileViewer/fileViewerApi.types'
import type { FileChangesVcsId } from '../fileChangesManager/fileChangesManagerApi.types'
import type { RemoteControlCommitPath, RemoteControlStepResult, RemoteControlTabCommandDto, RemoteControlTabOpenFileDto, RemoteControlTabOpenCommitDto, RemoteControlTabDto } from '../remoteControl/remoteControlApi.types'

export type TerminalTarget =
  | { kind: 'local'; sessionId: string }
  | { kind: 'remote'; remoteEndpointId: string; sessionId: string }

export type SessionViewItem =
  | { kind: 'file'; source: FileViewerDocumentSource }
  | { kind: 'review'; reviewId: string; vcs: 'svn' | 'git'; scopeRoot: string }
  | { kind: 'task'; task: TabControlTaskRef }
  | { kind: 'workflow' }

export interface SessionOpen {
  sequence: number
  openId: string
  sessionId: string
  key: string
  title: string
  item: SessionViewItem
}

export type TabControlCommand = { sharedOpen?: SessionOpen } & (
  | { kind: 'open-snapin'; requestId: string; panelId: string; snapinKind: string; title: string }
  | { kind: 'open-commit'; target?: TerminalTarget; reviewId?: string; openId?: string; itemKey?: string; requestId: string; panelId: string; vcs: FileChangesVcsId; scopeRoot: string; paths?: readonly RemoteControlCommitPath[]; title: string; messageApplied: boolean; activate?: boolean; existingOnly?: true
    /** With `activate: false`: the review becomes the split's item in front, but neither the tab nor the keyboard focus moves. */
    splitFront?: true }
  | {
      kind: 'open-session'
      requestId: string
      sessionId: string
      tabTitle: string
      activate?: boolean
    }
  | {
      kind: 'open-file'
      requestId: string
      panelId: string
      source: FileViewerDocumentSource
      documentKey: string
      title: string
    }
  | { kind: 'open-task'; requestId: string; panelId: string; item: TabControlTaskItem; target?: TerminalTarget }
  /** The session's workflow item in its own tab's split, made active. */
  | { kind: 'open-workflow'; requestId: string; panelId: string; sessionId: string; target?: TerminalTarget }
  /** The project todo list in the session's own local tab's split, made active. */
  | { kind: 'open-todos'; requestId: string; panelId: string; sessionId: string; view: 'split' | 'sidebar' }
  /** The processes list in the session's own local tab's split, made active. */
  | { kind: 'open-processes'; requestId: string; panelId: string; sessionId: string }
  | { kind: 'focus-panel'; requestId: string; panelId: string }
  | { kind: 'close-panel'; requestId: string; panelId: string }
)

export type TabControlCommandResult =
  | { kind: 'snapin-opened'; panelId: string }
  | { kind: 'opened'; panelId: string }
  | { kind: 'focused-existing'; panelId: string; windowId: string }
  | { kind: 'focused'; panelId: string }
  | { kind: 'closed'; panelId: string }
  | { kind: 'file-opened'; panelId: string }
  | { kind: 'commit-opened'; panelId: string }
  | { kind: 'task-opened'; panelId: string }
  | { kind: 'workflow-opened'; panelId: string }
  | { kind: 'todos-opened'; panelId: string }
  | { kind: 'processes-opened'; panelId: string }
  | { kind: 'failed'; detail: string }

export interface TabControlAck {
  requestId: string
  result: TabControlCommandResult
}

/** Which task of a session a split item shows. */
export type TabControlTaskRef =
  | { kind: 'subagent'; subagentId: string }
  | { kind: 'shell'; shellId: string }
  | { kind: 'script'; runId: string }

/** A task view in the parent's split. Main builds it and the window stores it, so both derive one key. */
export interface TabControlTaskItem {
  key: string
  title: string
  sessionId: string
  task: TabControlTaskRef
}

export interface TabControlTaskOpenedDto { kind: 'task-opened'; panelId: string; windowId: string }
export interface TabControlWorkflowOpenedDto { kind: 'workflow-opened'; panelId: string; windowId: string }
export interface TabControlTodosOpenedDto { kind: 'todos-opened'; panelId: string; windowId: string }
export interface TabControlProcessesOpenedDto { kind: 'processes-opened'; panelId: string; windowId: string }
export interface TabControlSnapinOpenedDto { kind: 'snapin-opened'; panelId: string; windowId: string }
export type TabControlBrokerDto = RemoteControlTabCommandDto | RemoteControlTabOpenFileDto | RemoteControlTabOpenCommitDto
  | TabControlTaskOpenedDto | TabControlWorkflowOpenedDto | TabControlTodosOpenedDto | TabControlProcessesOpenedDto | TabControlSnapinOpenedDto
export type TabControlBrokerResult = RemoteControlStepResult<TabControlBrokerDto>
export type TabPanelSnapshot = Omit<RemoteControlTabDto, 'commitReviews'>
export interface TabPanelOwner { windowId: string; panel: Omit<TabPanelSnapshot, 'windowId' | 'active'> }

export interface TabRequestPort {
  snapshot(): readonly TabPanelSnapshot[]
  ownerOf(panelId: string): string | null
  panelsOfSession(sessionId: string): readonly TabPanelOwner[]
  panelsOfTerminalTarget(targetKey: string): readonly TabPanelOwner[]
  lastFocusedWindowId(): string | null
  request(windowId: string, command: Extract<TabControlCommand, { kind: 'open-commit' }>): Promise<RemoteControlStepResult<RemoteControlTabOpenCommitDto>>
  request(windowId: string, command: Extract<TabControlCommand, { kind: 'open-file' }>): Promise<RemoteControlStepResult<RemoteControlTabOpenFileDto>>
  request(windowId: string, command: Extract<TabControlCommand, { kind: 'open-task' }>): Promise<RemoteControlStepResult<TabControlTaskOpenedDto>>
  request(windowId: string, command: Extract<TabControlCommand, { kind: 'open-workflow' }>): Promise<RemoteControlStepResult<TabControlWorkflowOpenedDto>>
  request(windowId: string, command: Extract<TabControlCommand, { kind: 'open-todos' }>): Promise<RemoteControlStepResult<TabControlTodosOpenedDto>>
  request(windowId: string, command: Extract<TabControlCommand, { kind: 'open-processes' }>): Promise<RemoteControlStepResult<TabControlProcessesOpenedDto>>
  request(windowId: string, command: Extract<TabControlCommand, { kind: 'open-snapin' }>): Promise<RemoteControlStepResult<TabControlSnapinOpenedDto>>
  request(windowId: string, command: Exclude<TabControlCommand, { kind: 'open-commit' | 'open-file' | 'open-task' | 'open-workflow' | 'open-todos' | 'open-processes' | 'open-snapin' }>): Promise<RemoteControlStepResult<RemoteControlTabCommandDto>>
}
