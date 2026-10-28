import type { RemoteSidebarRequest } from '../../lib-orchestrator/remoteControl/remoteSidebarApi.types'
import type { RemoteSessionCommand } from './remoteSessionCommand'
import type { RemoteTaskRequest } from '../../lib-orchestrator/remoteControl/remoteTaskApi.types'
import type { SessionViewOpenRequest } from '../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import type { SessionOpen } from './sessionViewItems'
import type { SessionOpenCursor, SessionOpenPage } from './sessionViewItems'
import type { RemoteChangesRequest, RemoteFileRequest, RemoteContentCursor, RemoteContentPage } from '../../lib-orchestrator/remoteControl/remoteContentApi.types'
import type { TerminalTarget } from './terminalTarget'
import type { RemoteSessionView, RemoteSessionDetail, SessionViewOperationMap } from '../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import type {
  SessionGroup,
  SessionGroupAssignment,
} from './sessionsGroupsState'
import type {
  HostPingResult,
  SessionAgentId,
  SessionCreateSpec,
  SessionsOpResult,
  TerminalAttachResult,
  TerminalAttachSpec,
  TerminalFrame,
} from '../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type {
  FileChangesHistoryResult,
  FileChangesSnapshotResult,
  FileChangesWorkingTreeSnapshotResult,
  FileChangesWorkingTreeSource,
  FileChangesVcsId,
  FileDiffRequest,
  FileDiffResult,
} from '../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type {
  FileViewerChunkResult,
  FileViewerDirectoryResult,
  FileViewerDocument,
  FileViewerDocumentSource,
  FileViewerOpenResult,
  FileViewerResourceResult,
  FileViewerTextResult,
  FileViewerVersionResult,
} from '../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type {
  RemoteControlResponse,
  RemoteControlStepResult,
} from '../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteConnectionsSnapshot } from '../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { RemoteControlPeerEndpoint } from '../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import type { RemoteControlAnswer } from '../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type {
  TerminalDetectResult,
  TerminalDirectoryOpenResult,
  TerminalExternalOpenResult,
  TerminalMenuCapture,
} from '../../lib-orchestrator/terminalDetector/terminalDetectorApi.types'
import type { BareCommandId } from './commands'
import type { AutolauncherResult, AutolauncherSnapshot } from './autolauncher'
import type { ContextCompactionCooldown } from './contextCompactionCooldown'
import type { ContextCompactionDelivery } from './contextCompactionDelivery'
import type { DebugSectionId } from './debugSections.types'
import type { RemoteConnectionsHoldReason } from './remoteConnectionsHold'
import type { RemoteControlListenerSettings } from './remoteControlSettings'
import type {
  RemoteSettingsSaveResult,
  RemoteSettingsSnapshotDto,
} from './remoteSettingsSnapshot'
import type { VersioningCommitDraftDto, VersioningCommitOpenResult, VersioningCommitOpenSessions, VersioningCommitRunRequest, VersioningCommitRunResult } from './versioningCommit'
import type {
  RemarkableDependencyStatus,
  RemarkableOpenDocumentPages,
  RemarkableOpenedOperation,
  RemarkablePagePreview,
  RemarkableRenderedPage,
  RemarkableRenderTarget,
  RemarkableResult,
  RemarkableSettingsSnapshot,
} from './remarkableApi.types'
import type { RemarkableImportSettingsValue } from './remarkableImportSettings'
import type { RemarkableSettingsValue } from './remarkableSettings'
import type { RemarkableStorageSettingsValue } from './remarkableStorageSettings'
import type { SessionsTabsView } from './sessionsViewState'
import type { SplitPinRecord } from './splitPinsState'
import type { SavedSessionsFilter } from './sessionsFilterState'
import type { SidebarsStateValue } from './sidebarsState'
import type { TabControlAck, TabControlCommand } from './tabControl'
import type { TerminalClipboardPaste } from './terminalClipboardPaste'
import type {
  ClaimPanelResult,
  ReconcilePanelsResult,
  TabMoveTarget,
  TabTransferLease,
  TabTransferPayload,
  WorkspacePanelPresence,
} from './tabTransfer'
import type { WindowAppearance, WindowInfo } from './windowInfo'

export interface AppInfo {
  appVersion: string
  platform: NodeJS.Platform
  configDir: string
  configIdentity: string
  runtimeChannel: 'production' | 'development'
}

export type FileChangesOpenFileResult =
  | { ok: true; value: FileViewerDocument }
  | {
    ok: false
    code:
      | 'snapshot-expired'
      | 'unknown-file'
      | 'invalid-source'
      | 'outside-root'
      | 'not-file'
      | 'not-found'
      | 'access-denied'
      | 'proof-expired'
    detail: string
  }

export interface LoadLayoutResult {
  layout: string | null
  /** true = the file existed but could not be read. The renderer latches as it does after fromJSON throws. */
  failed: boolean
}

export interface LoadSidebarsResult {
  /** null = nothing stored yet; the renderer starts from the default rather than from a guess. */
  sidebars: SidebarsStateValue | null
  /** Same meaning as on the layout: the file existed and could not be read, so nobody writes. */
  failed: boolean
}

/**
 * No `failed` beside it, unlike the two above: this is how the panel looks rather than what it
 * holds, so a read nobody could answer costs one press of a button and the panel starts from the
 * default. The store's own latch is what protects the file after a read that failed.
 */
export interface LoadSessionsViewResult {
  /** null = nothing stored yet; the panel starts from the default rather than from a guess. */
  sessionsView: SessionsTabsView | null
}

export interface AppClientUiIpcInvokeMap {
  'agentCliUpdates:get': () => import('../../lib-orchestrator/agentCliUpdates/agentCliUpdatesApi.types').AgentCliUpdatesSnapshot
  'agentCliUpdates:check': () => void
  'agentCliUpdates:install': (id: string) => void
  /**
   * Every operation of the control API, by name: the window calls the same registry, schemas and
   * call log a script reaches over HTTP. The answer is the protocol envelope; `renderer/ipc/appControl`
   * reads it.
   */
  'control:call': (operation: string, body: unknown) => RemoteControlAnswer
  'autolauncher:get': () => AutolauncherSnapshot
  'autolauncher:enable': (invitation: string | null) => AutolauncherResult
  'autolauncher:disable': () => AutolauncherResult
  'app:info': () => AppInfo
  /**
   * Sent once the renderer has mounted AND the bridge answered, so it proves what
   * `did-finish-load` cannot: the preload ran and React is on screen. The smoke run waits for it.
   */
  'app:renderer-ready': () => void
  'shell:window-info': () => WindowInfo
  'window:save-appearance': (appearance: WindowAppearance) => WindowInfo
  'state:load-layout': () => LoadLayoutResult
  'state:save-layout': (layout: string) => boolean
  'state:clear-layout': () => boolean
  'state:load-sidebars': () => LoadSidebarsResult
  'state:save-sidebars': (sidebars: SidebarsStateValue) => boolean
  /**
   * A pair of its own rather than a field of the sidebars, because the two are written at different
   * cadences: a sidebar width lands on every drag of the splitter and this lands when somebody
   * presses the button, and two states written that differently have to be able to fail apart.
   */
  'state:load-sessions-view': () => LoadSessionsViewResult
  'state:save-sessions-view': (view: SessionsTabsView) => boolean
  'state:load-session-filters': () => readonly SavedSessionsFilter[]
  'state:save-session-filters': (filters: readonly SavedSessionsFilter[]) => boolean
  /** @deprecated Use session groups. Retained for renderers using the pin-only IPC contract. */
  'state:load-session-pins': () => readonly string[]
  /** @deprecated Use session groups. A legacy write preserves assignments to other groups. */
  'state:save-session-pins': (pins: readonly string[]) => boolean
  'state:load-session-groups': () => readonly SessionGroupAssignment[]
  /**
   * ONE assignment, never the whole map: the tree is not the only writer any more. A fork inherits
   * what its parent was put in by hand, written in the main process while the window that asked for
   * it may have no tree at all, and a renderer handing back a map it read before that write would
   * drop the fork's own row.
   */
  'state:assign-session-group': (key: string, group: SessionGroup) => boolean
  /**
   * The pinned inner split items of ONE session, outside the layout so that they survive a closed
   * tab, Reset Layout and a restart. Any workspace window may write: a session's panel lives in at
   * most one window, and that window is the one that pins.
   */
  'state:load-split-pins': (sessionId: string) => readonly SplitPinRecord[]
  'state:save-split-pins': (sessionId: string, items: readonly SplitPinRecord[]) => boolean
  'state:load-new-session-agent': () => SessionAgentId
  'state:save-new-session-agent': (agentId: SessionAgentId) => boolean
  /**
   * The one native dialog of this shell, and the only channel that opens one. A directory belongs to
   * the OS: typing a path into a text field is how a settings editor collects roots that do not
   * exist. `null` is a cancelled dialog, which is an answer rather than a failure.
   */
  'dialog:pick-directory': (title: string) => { path: string } | null
  /**
   * A native yes/no over the window that asked. The renderer has no modal of its own, and a question
   * that stops somebody throwing away a running answer is worth one channel rather than a widget.
   */
  'dialog:confirm': (message: string, detail: string) => boolean
  /**
   * Write only. Reading the clipboard stays tied to an attach, for the reason `terminal:clipboard-paste`
   * gives; putting text INTO the clipboard gives a page nothing it did not already hand over.
   */
  'clipboard:write-text': (text: string) => void
  'remote:start-image-drag': (endpointId: string, viewId: string, documentId: string) => boolean
  'remote:export-file': (endpointId: string, viewId: string, documentId: string, name: string) => boolean
  'remote:media-resource': (endpointId: string, viewId: string, documentId: string, reference: string | null) => FileViewerResourceResult
  'remote:changes-request': (endpointId: string, viewId: string, body: RemoteChangesRequest) => RemoteControlStepResult<RemoteContentPage>
  'remote:changes-page': (endpointId: string, viewId: string, body: RemoteContentCursor) => RemoteControlStepResult<RemoteContentPage>
  'remote:reviews-request': (endpointId: string, viewId: string, body: import('../../lib-orchestrator/remoteControl/remoteReviewApi.types').RemoteReviewRequest) => RemoteControlStepResult<RemoteContentPage>
  'remote:reviews-page': (endpointId: string, viewId: string, body: RemoteContentCursor) => RemoteControlStepResult<RemoteContentPage>
  'remote:sidebar-request': (endpointId: string, viewId: string, body: RemoteSidebarRequest) => RemoteControlStepResult<RemoteContentPage>
  'remote:sidebar-page': (endpointId: string, viewId: string, body: RemoteContentCursor) => RemoteControlStepResult<RemoteContentPage>
  'remote:tasks-request': (endpointId: string, viewId: string, body: RemoteTaskRequest) => RemoteControlStepResult<RemoteContentPage>
  'remote:tasks-page': (endpointId: string, viewId: string, body: { task: RemoteTaskRequest; cursor: RemoteContentCursor }) => RemoteControlStepResult<RemoteContentPage>
  'remote:items-open': (endpointId: string, viewId: string, body: SessionViewOpenRequest) => RemoteControlStepResult<RemoteContentPage>
  'tabs:open-shared-item': (sessionId: string, body: SessionViewOpenRequest) => SessionOpen
  'remote:items-request': (endpointId: string, viewId: string, body: SessionOpenCursor) => RemoteControlStepResult<RemoteContentPage>
  'remote:items-page': (endpointId: string, viewId: string, body: RemoteContentCursor) => RemoteControlStepResult<RemoteContentPage>
  'tabs:session-items': (sessionId: string, cursor: SessionOpenCursor) => SessionOpenPage
  'remote:files-request': (endpointId: string, viewId: string, body: RemoteFileRequest) => RemoteControlStepResult<RemoteContentPage>
  'remote:files-page': (endpointId: string, viewId: string, body: RemoteContentCursor) => RemoteControlStepResult<RemoteContentPage>
  'remote:view-detail': (endpointId: string, viewId: string) => RemoteControlStepResult<RemoteSessionDetail>
  'remote:view-open': (endpointId: string, sessionId: string) => RemoteControlStepResult<RemoteSessionView>
  'remote:view-close': (endpointId: string, viewId: string) => RemoteControlStepResult<null>
  'remote:view-press': (endpointId: string, viewId: string, body: SessionViewOperationMap['actions.press']['request'], operationId: string) => RemoteControlStepResult<null>
  'remote:snapshot': () => RemoteConnectionsSnapshot
  /**
   * Connect one explicitly chosen computer while the dialog is open.
   * Released by the window that took it, and by its death: see `ServiceRemoteControlIpc`.
   */
  'remote:connect': (reason: RemoteConnectionsHoldReason, remoteEndpointId: string) => RemoteControlStepResult<undefined>
  'remote:select-session': (remoteEndpointId: string, sessionId: string) => RemoteControlStepResult<undefined>
  'remote:disconnect': (remoteEndpointId: string, sessionIds?: readonly string[]) => void
  'remote:release': (reason: RemoteConnectionsHoldReason) => void
  /**
   * What that computer can start an agent on: its own catalog and its own configured value. The
   * offer is composed from the answer rather than from this computer's list, which would describe
   * the wrong machine's CLI versions.
   *
   * A target that predates the operation answers `forbidden` without a round trip - the capability
   * was never negotiated - and that refusal is the version marker of the whole model feature: no
   * offer is drawn and `SessionCreateSpec.agent.model` never travels, because that target's create
   * validator reads exact keys and would refuse the entire request over it.
   */
  'remote:agents-describe': (remoteEndpointId: string) => RemoteControlResponse
  'remote:accounts-list': (remoteEndpointId: string) => RemoteControlResponse
  /** That computer's own catalog, as its projects screen would draw it: categories and listings. */
  'remote:projects-list': (
    remoteEndpointId: string,
    request: { categoryId?: string; sort?: 'alpha' | 'recent' },
  ) => RemoteControlResponse
  /**
   * `operationId` is the CALLER's, and the one channel where it is: the far side's replay store keys
   * the stored result by it, so a Retry after an answer that never arrived has to send the same id
   * or it creates a second session. Every other remote channel keeps the per-call id the service
   * mints, because nothing there is worth replaying.
   */
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
  /**
   * `acknowledgeSetup` answers a `setup-not-acknowledged` refusal from that computer, and only that:
   * a target that never asked may predate the key and refuse the whole request over it.
   */
  'remote:sessions-finalize': (
    remoteEndpointId: string,
    sessionId: string,
    acknowledgeSetup?: string,
  ) => RemoteControlResponse
  /**
   * The reference block for a session of a PAIRED computer, and the one remote channel that asks
   * that computer nothing: its sessions already arrive whole on `remote:snapshot`, so the block is
   * composed here from what is already held. The transcript line is absent by nature - that file
   * sits on the other machine's disk.
   */
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
  /**
   * The clipboard of THIS computer, pasted into a terminal on the other one. An agent reads the
   * clipboard of the machine it runs on, so an image is sent there, saved, and its path pasted.
   */
  'remote:terminal-clipboard-paste': (
    remoteEndpointId: string,
    attachId: string,
  ) => RemoteControlStepResult<TerminalClipboardPaste>
  /**
   * The Remote Control settings surface, and the reason it is its own set of channels rather than
   * more of `remote:*`: everything above drives ANOTHER computer, and everything here changes what
   * this one is willing to do. Its snapshot is credential-free by contract - no private key, no
   * bearer, no Host token - and the change event is the `remote:changed` below, reused because it
   * is parameter-less and the value rides on the get.
   */
  'remoteSettings:get': () => RemoteSettingsSnapshotDto
  'remoteSettings:listener-save': (
    listener: RemoteControlListenerSettings,
  ) => RemoteSettingsSaveResult
  /**
   * The one thing that was typed into the connect field: a pasted bundle, or a bare `host:port`.
   * Which of the two it is, and which trust statement that makes, is the main process's decision.
   */
  'remoteSettings:pairing-connect': (text: string) => RemoteSettingsSaveResult
  'remoteSettings:profile-endpoint': (
    profileId: string,
    endpoint: RemoteControlPeerEndpoint,
  ) => RemoteSettingsSaveResult
  /** Dial that computer now rather than when the backoff says; `not-found` if it is gone. */
  'remoteSettings:profile-retry': (profileId: string) => RemoteSettingsSaveResult
  'remoteSettings:profile-forget': (profileId: string) => RemoteSettingsSaveResult
  /**
   * Taking back what a person granted at the Allow dialog. It hangs up before it writes: trust is
   * read when a peer connects and never again.
   */
  'remoteSettings:inbound-revoke': (
    remoteComputerId: string,
    remoteEndpointId: string,
  ) => RemoteSettingsSaveResult
  'tabs:claim-panel': (panel: WorkspacePanelPresence, activate?: boolean) => ClaimPanelResult
  'tabs:reconcile-panels': (
    panels: readonly WorkspacePanelPresence[],
  ) => ReconcilePanelsResult
  'tabs:release-panel': (panelId: string) => void
  'tabs:set-active-panel': (panelId: string | null) => void
  'tabs:open-session-ids': () => readonly string[]
  'tabs:close-terminal-panel': (targetKey: string) => void
  'tabs:publish-terminal-restarted': (targetKey: string) => void
  'tabs:drag-started': (token: string, panel: TabTransferPayload) => void
  'tabs:transfer-prepare': (token: string) => TabTransferLease | null
  'tabs:transfer-commit': (token: string) => void
  'tabs:transfer-abort': (token: string) => void
  'tabs:move-panel': (panel: TabTransferPayload, target: TabMoveTarget) => void
  'tabs:control-ack': (ack: TabControlAck) => void
  'tabs:open-session-task': (target: TerminalTarget, task: import('./tabControl').TabControlTaskRef, title: string) => void
  'tabs:project-review': (target: TerminalTarget, draft: VersioningCommitDraftDto, itemKey: string, openId: string) => void
  'tabs:projected-review-changed': (target: TerminalTarget, draft: VersioningCommitDraftDto, closed: boolean) => void
  'tabs:open-session-actions': (target: TerminalTarget) => void
  /**
   * The terminal surface, and the reason it is channels rather than a socket in the renderer:
   * a browser WebSocket cannot set the `Authorization` header the Host reads, so an attach opened
   * there would mean either changing the Host's auth or handing the renderer the token. The token is
   * main-only by decision - `debug:host-status` composes the descriptor field by field to keep it
   * that way - so the attach stays here and the bytes cross as `terminal:frame`.
   *
   * The id is the surface's own, minted per attempt. It is what makes a React double mount harmless
   * and what lets two panels watch one session.
   */
  'terminal:attach': (attachId: string, spec: TerminalAttachSpec) => TerminalAttachResult
  'terminal:input': (attachId: string, data: string) => void
  'terminal:resize': (attachId: string, cols: number, rows: number) => void
  /**
   * Whether this attach is the one being LOOKED at, which is what decides who owns the PTY's
   * geometry while a session is open in two windows. Without it a local attach was created
   * active and stayed active for its whole life, so a hidden tab kept holding the size of a
   * terminal somebody else was reading.
   */
  'terminal:active': (attachId: string, active: boolean) => void
  /** Never kills anything: a closed tab is not a decision about a PTY. */
  'terminal:detach': (attachId: string) => void
  /**
   * The clipboard, and it carries an attach id for the same reason the bytes do: a general
   * `clipboard:read-text` would hand every part of the renderer the user's clipboard, while these
   * two answer only a renderer that holds this terminal. They exist at all because
   * `navigator.clipboard` is gated on a secure origin and on focus, so the packaged `file://`
   * renderer gets a silent rejection - the copy works all through development and no-ops in the
   * release.
   */
  'terminal:clipboard-paste': (attachId: string) => TerminalClipboardPaste
  /** false = another process held the clipboard throughout; the caller knows the copy is not there. */
  'terminal:clipboard-write': (attachId: string, text: string) => boolean
  /**
   * The terminal menu, and the reason none of these carries a path: the renderer hands over the text
   * it scanned off the screen, main resolves what that text names, and every action afterwards names
   * an opaque `(requestId, detectionId)` pair. No `open(path)` is added to this bridge, which is the
   * one V1 lost, where a generic dispatcher took whatever the page passed it.
   *
   * What that does NOT buy is a bound on which paths exist to be asked for: the token is renderer
   * data and main keeps no copy of the buffer to check it against, so a page holding this channel
   * can name any existing path. It is not an escalation - the same attach carries `terminal:input`,
   * so that page can already make the agent read a file out loud - and `docs/architecture/file-viewer.md`
   * carries the argument and the trigger for tightening it.
   *
   * `menu-detect` takes an attach id rather than a session id for a different reason: which session a
   * terminal is showing is main's own knowledge, read off the attach it already owns.
   */
  'terminal:menu-detect': (attachId: string, capture: TerminalMenuCapture) => TerminalDetectResult
  'terminal:menu-open-file': (requestId: string, detectionId: string) => FileViewerOpenResult
  'terminal:menu-open-directory': (
    requestId: string,
    detectionId: string,
  ) => TerminalDirectoryOpenResult
  /**
   * The desktop's own reader, for a detection whose type the built-in viewer cannot show. It carries
   * no path either, and the detector answers the same `opensExternally` here as it did for the row,
   * so this channel opens only what the menu actually offered it for.
   */
  'terminal:menu-open-external': (
    requestId: string,
    detectionId: string,
  ) => TerminalExternalOpenResult
  'terminal:menu-open-vscode': (requestId: string, detectionId: string) => boolean
  /** The project of a session, whose path comes from its working context and never from the caller. */
  'terminal:menu-open-project-vscode': (sessionId: string) => boolean
  /**
   * A conflicted path of a session's SVN action, worktree-relative as its conflict entry names it:
   * main resolves it inside the session's worktree and refuses a path that leaves it, then grants it
   * to the viewer as a workspace file of that session.
   */
  'terminal:menu-open-conflict-file': (sessionId: string, path: string) => FileViewerOpenResult
  /** The same path, in TortoiseSVN's conflict editor; a refusal names the tool it expected. */
  'terminal:menu-open-conflict-editor': (sessionId: string, path: string) => { ok: true } | { ok: false; detail: string }
  /**
   * The merger's brief of a session's SVN action, read off the session by main and granted to the
   * viewer; the renderer names only the session.
   */
  'terminal:menu-open-merge-brief': (sessionId: string) => FileViewerOpenResult
  /**
   * The Debug window's surface: three named read-only channels and nothing that passes anything
   * through. V1 shipped a generic debug dispatcher and it reached `file:write` from the renderer, so
   * a section that wants data gets a channel of its own with a name and a type.
   *
   * `host-status` is composed in the main process out of state that is already there, and asks the
   * Host for nothing. `host-ping` is the one call that touches the network, and it lives here rather
   * than in the renderer because `GET /hello` needs the descriptor's token.
   */
  /** Which section is on screen, so the main process can stop pinging for one that is not. */
  'debug:section-active': (section: DebugSectionId | null) => void
  'versioning:commit-open-draft': (sessionId: string, vcs: FileChangesVcsId, scope: string | null, paths?: readonly import('./versioningCommit').VersioningCommitPath[], reviewId?: string, reviewOnly?: true) => VersioningCommitOpenResult
  'versioning:commit-read': (draftId: string) => VersioningCommitDraftDto | null
  'versioning:commit-files': (draftId: string) => import('./versioningCommit').VersioningCommitFilesResult
  'versioning:commit-external-diff': (request: FileDiffRequest) => import('./versioningCommit').VersioningExternalDiffResult
  'versioning:commit-open-tab': (sessionId: string, vcs: FileChangesVcsId, scope?: string) => import('../../lib-orchestrator/remoteControl/remoteControlApi.types').RemoteControlStepResult<import('../../lib-orchestrator/remoteControl/remoteControlApi.types').RemoteControlTabOpenCommitDto>
  'versioning:commit-decide': (request: import('./versioningCommit').VersioningReviewDecision) => VersioningCommitRunResult
  'versioning:commit-edit': (request: import('./versioningCommit').VersioningReviewEdit) => import('./versioningCommit').VersioningReviewEditResult
  'versioning:commit-set-message': (draftId: string, message: string) => boolean
  'versioning:commit-run': (request: VersioningCommitRunRequest) => VersioningCommitRunResult
  'versioning:commit-revert': (request: import('./versioningCommit').VersioningRevertRequest) => import('./versioningCommit').VersioningRevertResult
  'versioning:commit-tortoise': (draftId: string, message: string) => import('./versioningCommit').VersioningTortoiseResult
  'versioning:commit-cancel': (draftId: string) => import('../../lib-orchestrator/remoteControl/remoteControlApi.types').RemoteControlStepResult<import('../../lib-orchestrator/remoteControl/remoteControlApi.types').RemoteControlCommitStatusDto>
  'versioning:commit-close': (draftId: string) => void
  'versioning:commit-open-sessions': () => VersioningCommitOpenSessions
  'fileChanges:list': (
    sessionId: string,
    preferredVcs: FileChangesVcsId | null,
  ) => FileChangesSnapshotResult
  'fileChanges:working-tree': (
    sessionId: string,
    source: FileChangesWorkingTreeSource | null,
  ) => FileChangesWorkingTreeSnapshotResult
  'fileChanges:scoped-working-tree': (source: FileViewerDocumentSource) => FileChangesWorkingTreeSnapshotResult
  'fileChanges:history': (snapshotId: string, cursor: string) => FileChangesHistoryResult
  'fileChanges:diff': (request: FileDiffRequest) => FileDiffResult
  'fileChanges:open-file': (snapshotId: string, fileId: string) => FileChangesOpenFileResult
  'fileViewer:open-workspace': (
    sessionId: string,
    path: string,
    supportsDiff: boolean,
  ) => FileViewerOpenResult
  'fileViewer:restore': (
    source: FileViewerDocumentSource,
    supportsDiff: boolean,
  ) => FileViewerOpenResult
  'fileViewer:text': (documentId: string) => FileViewerTextResult
  /** One `stat` over a document already granted: whether the file behind it is still that file. */
  'fileViewer:version': (documentId: string) => FileViewerVersionResult
  'fileViewer:chunk': (documentId: string, offset: number) => FileViewerChunkResult
  'fileViewer:root-directory': (sessionId: string) => FileViewerDirectoryResult
  'fileViewer:project-directory': (sessionId: string) => FileViewerDirectoryResult
  /**
   * The one directory channel that takes a path from the renderer, which is why it is the one that
   * checks two proofs: the target sits inside the session's own filesystem root, or a detection
   * opened it earlier in this process. Anything else answers `proof-expired`.
   */
  'fileViewer:directory-at': (sessionId: string, path: string) => FileViewerDirectoryResult
  'fileViewer:document-directory': (documentId: string) => FileViewerDirectoryResult
  'fileViewer:directory-entry': (
    directoryId: string,
    entryId: string,
  ) => FileViewerDirectoryResult
  'fileViewer:parent-directory': (directoryId: string) => FileViewerDirectoryResult
  'fileViewer:open-entry': (directoryId: string, entryId: string) => FileViewerOpenResult
  'fileViewer:media-resource': (documentId: string) => FileViewerResourceResult
  'fileViewer:relative-resource': (
    documentId: string,
    reference: string,
  ) => FileViewerResourceResult
  'fileViewer:copy-path': (documentId: string) => boolean
  'fileViewer:start-image-drag': (documentId: string) => boolean
  'fileViewer:open-external': (url: string) => boolean
  'fileViewer:release': (documentId: string) => void
  'remarkable:settings-get': () => RemarkableSettingsSnapshot
  'remarkable:settings-save': (value: RemarkableSettingsValue) => RemarkableResult
  /** Its own section of config.json, so saving one reMarkable card never writes back the other’s value. */
  'remarkable:storage-get': () => RemarkableStorageSettingsValue
  'remarkable:storage-save': (value: RemarkableStorageSettingsValue) => RemarkableResult
  /** How the card behaves, not where its page lands: one boolean, saved the moment it is ticked. */
  'remarkable:import-save': (value: RemarkableImportSettingsValue) => RemarkableResult
  'remarkable:password-set': (expectedHost: string, password: string) => RemarkableResult
  'remarkable:password-clear': (expectedHost: string) => RemarkableResult
  'remarkable:fingerprint-detect': () => RemarkableResult<{ host: string; fingerprint: string }>
  'remarkable:connection-test': () => RemarkableResult
  'remarkable:dependencies-status': () => RemarkableDependencyStatus
  'remarkable:dependencies-install': () => RemarkableResult<RemarkableDependencyStatus>
  /**
   * The session is what the window may name; where that session runs is the main process’s to
   * answer. A renderer therefore chooses a project by choosing a terminal, never by naming a path.
   */
  'remarkable:operation-start': (sessionId: string) => RemarkableResult<RemarkableOpenedOperation>
  'remarkable:operation-pages': (operationId: string) => RemarkableResult<RemarkableOpenDocumentPages>
  'remarkable:operation-render': (
    operationId: string,
    target: RemarkableRenderTarget,
  ) => RemarkableResult<RemarkableRenderedPage>
  'remarkable:operation-preview': (
    operationId: string,
    target: RemarkableRenderTarget,
  ) => RemarkableResult<RemarkablePagePreview>
  'remarkable:operation-release': (operationId: string) => void
  'contextCompaction:claim-auto': (sessionId: string) => boolean
  'contextCompaction:note-manual': (sessionId: string) => void
  'contextCompaction:cooldown': (sessionId: string) => ContextCompactionCooldown | null
  /**
   * Types `/compact` into the session through the verified `terminal.deliver` loop in the main
   * process: wait for an empty composer, type, see it, press Enter, prove the submit.
   */
  'contextCompaction:deliver': (sessionId: string) => ContextCompactionDelivery
}

export interface AppClientUiIpcEventMap {
  'agentCliUpdates:changed': () => void
  'autolauncher:changed': (snapshot: AutolauncherSnapshot) => void
  'versioning:commit-changed': () => void
  'menu:command': (commandId: BareCommandId) => void
  'app:error': (message: string) => void
  'window:changed': () => void
  /** Parameter-less on purpose: the answer is the snapshot, and it is read through its own channel. */
  'sessions:changed': () => void
  /**
   * Parameter-less like the pair above it, and sent only when something OTHER than the tree wrote:
   * today that is a fork taking the group its parent was put in by hand. The main window reads the
   * assignments back through `state:load-session-groups`, so a window whose own write caused this
   * would only find what it already holds.
   */
  'state:session-groups-changed': () => void
  'remote:changed': () => void
  'tabs:activate-panel': (
    panelId: string,
    params?: Record<string, unknown>,
    title?: string,
  ) => void
  'tabs:close-panel': (panelId: string) => void
  /** A script run's tab given to the session the run was for, in its place and with its preview state. */
  'tabs:hand-off-panel': (panelId: string, params: Record<string, unknown>, title: string) => void
  'tabs:terminal-restarted': (targetKey: string) => void
  'tabs:visible-terminal-targets': (targetKeys: readonly string[]) => void
  /** Every session a workspace window has a tab open for, whether or not that tab is in front. */
  'tabs:open-terminal-targets': (targetKeys: readonly string[]) => void
  'tabs:transfer-in': (token: string) => void
  'tabs:transfer-out': (panelId: string) => void
  'tabs:control-command': (command: TabControlCommand) => void
  /**
   * Parameter-less for the same reason, and to every workspace plus Debug: the value rides on
   * `ui:settings-get`, so a window that missed one event and reads once still ends up holding what
   * is on disk.
   */
  'ui:settings-changed': () => void
  'agents:settings-changed': () => void
  /**
   * Parameter-less as well, to every workspace plus Debug, and only when the content actually moved:
   * the monitor holds a revision so a poll that changed nothing wakes nobody. The value rides on
   * `rate:get`, and the Debug window reads its own unreduced view off the same signal.
   */
  'rate:changed': () => void
  'usage:changed': () => void
  'snapins:changed': (change: { kind: string }) => void
  /** Published to the Debug window alone: the answer to a ping the main process asked on its own. */
  'debug:host-ping-result': (result: HostPingResult) => void
  /**
   * To the workspace window alone, and the only channel on which bytes flow rather than answers. It
   * carries the attach id because one window holds several terminals and each frame belongs to
   * exactly one of them.
   */
  'terminal:frame': (attachId: string, frame: TerminalFrame) => void
  'remote:terminal-frame': (
    remoteEndpointId: string,
    attachId: string,
    frame: TerminalFrame,
  ) => void
  /**
   * One directory's stored notes moved, after every save including an import's. To every workspace
   * plus Debug; a panel of that directory holding no unsaved edit reads them again.
   */
  'directoryNotes:changed': (directory: string) => void
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string }

export type AppClientUiInvokeArgs<K extends keyof AppClientUiIpcInvokeMap> =
  Parameters<AppClientUiIpcInvokeMap[K]>

export type AppClientUiInvokeResult<K extends keyof AppClientUiIpcInvokeMap> =
  Awaited<ReturnType<AppClientUiIpcInvokeMap[K]>>

export type AppClientUiEventArgs<K extends keyof AppClientUiIpcEventMap> =
  Parameters<AppClientUiIpcEventMap[K]>

/**
 * Which channel each member of `window.appClient` reaches, and the ONE place that pairing is
 * written. The bridge type below is derived from this table and `preload/index.ts` builds itself
 * from it, so a member cannot name a channel that does not exist, cannot be bound to a channel of
 * the same signature by mistake, and cannot lose an argument on the way: no member has any code of
 * its own left to get wrong.
 *
 * It replaced 263 lines that restated `AppClientUiIpcInvokeMap` by hand in a second shape. That
 * second shape carried no completeness proof, so a channel added to the map and forgotten here
 * compiled and was unreachable from every renderer; `AppClientUiChannelsOffTheBridge` below is that
 * proof, and `preload/index.test.ts` is the same claim measured at runtime.
 */
export const AppClientUiBridgeCallsConst = {
  control: {
    call: 'control:call',
  },
  autolauncher: {
    get: 'autolauncher:get',
    enable: 'autolauncher:enable',
    disable: 'autolauncher:disable',
  },
  appInfo: 'app:info',
  agentCliUpdates: {
    get: 'agentCliUpdates:get',
    check: 'agentCliUpdates:check',
    install: 'agentCliUpdates:install',
  },
  rendererReady: 'app:renderer-ready',
  windows: {
    info: 'shell:window-info',
    saveAppearance: 'window:save-appearance',
  },
  state: {
    loadLayout: 'state:load-layout',
    saveLayout: 'state:save-layout',
    clearLayout: 'state:clear-layout',
    loadSidebars: 'state:load-sidebars',
    saveSidebars: 'state:save-sidebars',
    loadSessionsView: 'state:load-sessions-view',
    saveSessionsView: 'state:save-sessions-view',
    loadSessionFilters: 'state:load-session-filters',
    saveSessionFilters: 'state:save-session-filters',
    loadSessionPins: 'state:load-session-pins',
    saveSessionPins: 'state:save-session-pins',
    loadSessionGroups: 'state:load-session-groups',
    assignSessionGroup: 'state:assign-session-group',
    loadSplitPins: 'state:load-split-pins',
    saveSplitPins: 'state:save-split-pins',
    loadNewSessionAgent: 'state:load-new-session-agent',
    saveNewSessionAgent: 'state:save-new-session-agent',
  },
  dialog: {
    /** null = the user cancelled. */
    pickDirectory: 'dialog:pick-directory',
    /** false = they said no, or closed it, which is the same answer. */
    confirm: 'dialog:confirm',
  },
  clipboard: {
    writeText: 'clipboard:write-text',
  },
  remote: {
    startImageDrag: 'remote:start-image-drag',
    exportFile: 'remote:export-file',
    mediaResource: 'remote:media-resource',
    requestChanges: 'remote:changes-request',
    readChangesPage: 'remote:changes-page',
    requestReviews: 'remote:reviews-request',
    readReviewPage: 'remote:reviews-page',
    sessionCommand: 'remote:session-command',
    requestSidebar: 'remote:sidebar-request',
    readSidebarPage: 'remote:sidebar-page',
    requestTasks: 'remote:tasks-request',
    readTaskPage: 'remote:tasks-page',
    openSharedItem: 'remote:items-open',
    requestItems: 'remote:items-request',
    readItemsPage: 'remote:items-page',
    requestFiles: 'remote:files-request',
    readFilePage: 'remote:files-page',
    readView: 'remote:view-detail',
    openView: 'remote:view-open',
    closeView: 'remote:view-close',
    pressAction: 'remote:view-press',
    snapshot: 'remote:snapshot',
    connect: 'remote:connect',
    selectSession: 'remote:select-session',
    disconnect: 'remote:disconnect',
    release: 'remote:release',
    describeAgents: 'remote:agents-describe',
    listAccounts: 'remote:accounts-list',
    listProjects: 'remote:projects-list',
    createSession: 'remote:sessions-create',
    reopenSession: 'remote:sessions-reopen',
    finalizeSession: 'remote:sessions-finalize',
    sessionReference: 'remote:sessions-reference',
    terminalAttach: 'remote:terminal-attach',
    terminalInput: 'remote:terminal-input',
    terminalResize: 'remote:terminal-resize',
    terminalActive: 'remote:terminal-active',
    terminalDetach: 'remote:terminal-detach',
    terminalClipboardPaste: 'remote:terminal-clipboard-paste',
  },
  remoteSettings: {
    get: 'remoteSettings:get',
    saveListener: 'remoteSettings:listener-save',
    connectPairing: 'remoteSettings:pairing-connect',
    setProfileEndpoint: 'remoteSettings:profile-endpoint',
    retryProfile: 'remoteSettings:profile-retry',
    forgetProfile: 'remoteSettings:profile-forget',
    revokeInbound: 'remoteSettings:inbound-revoke',
  },
  tabs: {
    openSharedItem: 'tabs:open-shared-item',
    sessionItems: 'tabs:session-items',
    claimPanel: 'tabs:claim-panel',
    reconcilePanels: 'tabs:reconcile-panels',
    releasePanel: 'tabs:release-panel',
    setActivePanel: 'tabs:set-active-panel',
    openSessionIds: 'tabs:open-session-ids',
    closeTerminalPanel: 'tabs:close-terminal-panel',
    publishTerminalRestarted: 'tabs:publish-terminal-restarted',
    dragStarted: 'tabs:drag-started',
    transferPrepare: 'tabs:transfer-prepare',
    transferCommit: 'tabs:transfer-commit',
    transferAbort: 'tabs:transfer-abort',
    movePanel: 'tabs:move-panel',
    controlAck: 'tabs:control-ack',
    openSessionTask: 'tabs:open-session-task',
    projectReview: 'tabs:project-review',
    projectedReviewChanged: 'tabs:projected-review-changed',
    openSessionActions: 'tabs:open-session-actions',
  },
  terminal: {
    attach: 'terminal:attach',
    input: 'terminal:input',
    resize: 'terminal:resize',
    active: 'terminal:active',
    detach: 'terminal:detach',
    clipboardPaste: 'terminal:clipboard-paste',
    clipboardWrite: 'terminal:clipboard-write',
  },
  terminalMenu: {
    detect: 'terminal:menu-detect',
    openFile: 'terminal:menu-open-file',
    openDirectory: 'terminal:menu-open-directory',
    openExternal: 'terminal:menu-open-external',
    openVsCode: 'terminal:menu-open-vscode',
    openProjectVsCode: 'terminal:menu-open-project-vscode',
    openConflictFile: 'terminal:menu-open-conflict-file',
    openConflictEditor: 'terminal:menu-open-conflict-editor',
    openMergeBrief: 'terminal:menu-open-merge-brief',
  },
  // One preload serves both document entries, so the bridge is the superset and each uses its part.
  debug: {
    sectionActive: 'debug:section-active',
  },
  versioning: {
    openDraft: 'versioning:commit-open-draft',
    readCommit: 'versioning:commit-read',
    commitFiles: 'versioning:commit-files',
    externalDiff: 'versioning:commit-external-diff',
    openCommitTab: 'versioning:commit-open-tab',
    decideCommit: 'versioning:commit-decide',
    editCommit: 'versioning:commit-edit',
    setCommitMessage: 'versioning:commit-set-message',
    runCommit: 'versioning:commit-run',
    revertCommitFile: 'versioning:commit-revert',
    openTortoise: 'versioning:commit-tortoise',
    cancelCommit: 'versioning:commit-cancel',
    closeCommit: 'versioning:commit-close',
    openCommitSessions: 'versioning:commit-open-sessions',
  },
  fileChanges: {
    list: 'fileChanges:list',
    workingTree: 'fileChanges:working-tree',
    scopedWorkingTree: 'fileChanges:scoped-working-tree',
    history: 'fileChanges:history',
    diff: 'fileChanges:diff',
    openFile: 'fileChanges:open-file',
  },
  fileViewer: {
    openWorkspace: 'fileViewer:open-workspace',
    restore: 'fileViewer:restore',
    text: 'fileViewer:text',
    version: 'fileViewer:version',
    chunk: 'fileViewer:chunk',
    rootDirectory: 'fileViewer:root-directory',
    projectDirectory: 'fileViewer:project-directory',
    directoryAt: 'fileViewer:directory-at',
    documentDirectory: 'fileViewer:document-directory',
    directoryEntry: 'fileViewer:directory-entry',
    parentDirectory: 'fileViewer:parent-directory',
    openEntry: 'fileViewer:open-entry',
    mediaResource: 'fileViewer:media-resource',
    relativeResource: 'fileViewer:relative-resource',
    copyPath: 'fileViewer:copy-path',
    startImageDrag: 'fileViewer:start-image-drag',
    openExternal: 'fileViewer:open-external',
    release: 'fileViewer:release',
  },
  remarkable: {
    getSettings: 'remarkable:settings-get',
    saveSettings: 'remarkable:settings-save',
    setPassword: 'remarkable:password-set',
    clearPassword: 'remarkable:password-clear',
    detectFingerprint: 'remarkable:fingerprint-detect',
    testConnection: 'remarkable:connection-test',
    dependenciesStatus: 'remarkable:dependencies-status',
    installDependencies: 'remarkable:dependencies-install',
    getStorage: 'remarkable:storage-get',
    saveStorage: 'remarkable:storage-save',
    saveImport: 'remarkable:import-save',
    startOperation: 'remarkable:operation-start',
    pages: 'remarkable:operation-pages',
    render: 'remarkable:operation-render',
    preview: 'remarkable:operation-preview',
    release: 'remarkable:operation-release',
  },
  contextCompaction: {
    claimAutomatic: 'contextCompaction:claim-auto',
    noteManual: 'contextCompaction:note-manual',
    cooldown: 'contextCompaction:cooldown',
    deliver: 'contextCompaction:deliver',
  },
} as const satisfies AppClientUiBridgeCallTable

/** The event half, flat because every listener the bridge offers sits at its root. */
export const AppClientUiBridgeEventsConst = {
  onAutolauncherChanged: 'autolauncher:changed',
  onMenuCommand: 'menu:command',
  onAppError: 'app:error',
  onWindowChanged: 'window:changed',
  onSessionsChanged: 'sessions:changed',
  onSessionGroupsChanged: 'state:session-groups-changed',
  onRemoteChanged: 'remote:changed',
  onTabsActivatePanel: 'tabs:activate-panel',
  onTabsClosePanel: 'tabs:close-panel',
  onTabsHandOffPanel: 'tabs:hand-off-panel',
  onTabsTerminalRestarted: 'tabs:terminal-restarted',
  onTabsVisibleTerminalTargets: 'tabs:visible-terminal-targets',
  onTabsOpenTerminalTargets: 'tabs:open-terminal-targets',
  onTabsTransferIn: 'tabs:transfer-in',
  onTabsTransferOut: 'tabs:transfer-out',
  onTabsControlCommand: 'tabs:control-command',
  onUiSettingsChanged: 'ui:settings-changed',
  onCommitChanged: 'versioning:commit-changed',
  onAgentSettingsChanged: 'agents:settings-changed',
  onRateChanged: 'rate:changed',
  onAgentCliUpdatesChanged: 'agentCliUpdates:changed',
  onUsageChanged: 'usage:changed',
  onSnapinsChanged: 'snapins:changed',
  onHostPingResult: 'debug:host-ping-result',
  onTerminalFrame: 'terminal:frame',
  onRemoteTerminalFrame: 'remote:terminal-frame',
  onDirectoryNotesChanged: 'directoryNotes:changed',
} as const satisfies Readonly<Record<string, keyof AppClientUiIpcEventMap>>

/** A group of members, or the channel one member calls. Nesting is how the bridge reads, nothing more. */
export interface AppClientUiBridgeCallTable {
  readonly [member: string]: keyof AppClientUiIpcInvokeMap | AppClientUiBridgeCallTable
}

/**
 * Written as a property rather than as a method on purpose: TypeScript checks a method's parameters
 * bivariantly even under `strictFunctionTypes`, so the hand-written interface accepted a member that
 * took LESS than its channel does and silently narrowed what the renderer was allowed to send.
 */
export type AppClientUiBridgeCall<K extends keyof AppClientUiIpcInvokeMap> =
  (...args: AppClientUiInvokeArgs<K>) => Promise<IpcResult<AppClientUiInvokeResult<K>>>

/** Subscribing returns the unsubscribe, which is the only shape a renderer effect can clean up. */
export type AppClientUiBridgeListener<K extends keyof AppClientUiIpcEventMap> =
  (callback: (...args: AppClientUiEventArgs<K>) => void) => () => void

export type AppClientUiBridgeCalls<T> = {
  readonly [K in keyof T]: T[K] extends keyof AppClientUiIpcInvokeMap
    ? AppClientUiBridgeCall<T[K]>
    : AppClientUiBridgeCalls<T[K]>
}

export type AppClientUiBridgeListeners<T> = {
  readonly [K in keyof T]: T[K] extends keyof AppClientUiIpcEventMap
    ? AppClientUiBridgeListener<T[K]>
    : never
}

/** Every channel named anywhere in the table, at any depth. */
type BridgeTableChannels<T> =
  T extends string ? T : { [K in keyof T]: BridgeTableChannels<T[K]> }[keyof T]

/**
 * The channels no member of the bridge reaches - `never` while the table is whole, and the names
 * themselves the day it is not. Read as a compile-time assertion in `preload/index.test.ts`.
 */
export type AppClientUiChannelsOffTheBridge =
  Exclude<keyof AppClientUiIpcInvokeMap, BridgeTableChannels<typeof AppClientUiBridgeCallsConst>>

/** The same for the event half. */
export type AppClientUiEventsOffTheBridge = Exclude<
  keyof AppClientUiIpcEventMap,
  typeof AppClientUiBridgeEventsConst[keyof typeof AppClientUiBridgeEventsConst]
>

/** The shape of window.appClient, derived from the table above rather than restated beside it. */
export type AppClientUiBridge =
  AppClientUiBridgeCalls<typeof AppClientUiBridgeCallsConst>
  & AppClientUiBridgeListeners<typeof AppClientUiBridgeEventsConst>
