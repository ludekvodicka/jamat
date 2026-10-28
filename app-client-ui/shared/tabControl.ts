import type { SessionOpen } from './sessionViewItems'
import type { FileViewerDocumentSource } from '../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { FileChangesVcsId } from '../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { VersioningCommitPath } from './versioningCommit'
import type { TerminalTarget } from './terminalTarget'

export type TabControlCommand = { sharedOpen?: SessionOpen } & (
  | { kind: 'open-snapin'; requestId: string; panelId: string; snapinKind: string; title: string }
  | { kind: 'open-commit'; target?: TerminalTarget; reviewId?: string; openId?: string; itemKey?: string; requestId: string; panelId: string; vcs: FileChangesVcsId; scopeRoot: string; paths?: readonly VersioningCommitPath[]; title: string; messageApplied: boolean; activate?: boolean; existingOnly?: true }
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

export class TabControlTask {
  static keyOf(sessionId: string, task: TabControlTaskRef): string {
    return `task:${sessionId}:${task.kind}:${TabControlTask.idOf(task)}`
  }

  static idOf(task: TabControlTaskRef): string {
    switch (task.kind) {
      case 'subagent': return task.subagentId
      case 'shell': return task.shellId
      case 'script': return task.runId
      default: throw new Error(`Unknown session task: ${JSON.stringify(task satisfies never)}`)
    }
  }
}
