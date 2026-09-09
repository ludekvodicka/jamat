import type {
  CatalogCategoryDto,
  CategoryInfo,
  DeletePreview,
  DeleteReport,
  ProjectEntry,
  ProjectListResult,
  ProjectSessionsResult,
  ProjectsOpResult,
  RelocationReport,
} from '../../lib-orchestrator/projectManager/projectManagerApi.types'
import type {
  HostDebugStatus,
  HostPingResult,
  SessionAgentId,
  SessionColorName,
  SessionCreateSpec,
  SessionDetailsSaved,
  SessionDetailsUpdate,
  SessionHistoryOpenSpec,
  SessionHistoryReference,
  SessionsOpResult,
  SessionsSnapshot,
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
  RateMonitorDebugStatus,
  RateMonitorSnapshot,
} from '../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
import type {
  RemoteControlResponse,
  RemoteControlStepResult,
} from '../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteConnectionsSnapshot } from '../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { RemoteControlPeerEndpoint } from '../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import type { SessionModelReading } from '../../lib-orchestrator/sessionModelReader/sessionModelReaderApi.types'
import type { SessionTranscriptReading } from '../../lib-orchestrator/sessionTranscriptReader/sessionTranscriptReaderApi.types'
import type {
  TerminalDetectResult,
  TerminalDirectoryOpenResult,
  TerminalExternalOpenResult,
  TerminalMenuCapture,
} from '../../lib-orchestrator/terminalDetector/terminalDetectorApi.types'
import type {
  AgentSettingsAgentId,
  AgentSettingsSaveResult,
  AgentSettingsValue,
} from './agentSettings'
import type { BareCommandId } from './commands'
import type { ContextCompactionCooldown } from './contextCompactionCooldown'
import type { DebugSectionId } from './debugSections.types'
import type {
  FileChangesSettingsSaveResult,
  FileChangesSettingsValue,
} from './fileChangesSettings'
import type { RemoteConnectionsHoldReason } from './remoteConnectionsHold'
import type { RemoteControlListenerSettings } from './remoteControlSettings'
import type {
  RemoteSettingsSaveResult,
  RemoteSettingsSnapshotDto,
} from './remoteSettingsSnapshot'
import type {
  VersioningSettingsSaveResult,
  VersioningSettingsValue,
} from './versioningSettings'
import type {
  ProjectSetupRead,
  ProjectSetupWrite,
  WorktreeSettingsSaveResult,
  WorktreeSettingsValue,
} from './worktreeSettings'
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
import type { SavedSessionsFilter } from './sessionsFilterState'
import type { SidebarsStateValue } from './sidebarsState'
import type { TabControlAck, TabControlCommand } from './tabControl'
import type {
  ClaimPanelResult,
  ReconcilePanelsResult,
  TabMoveTarget,
  TabTransferLease,
  TabTransferPayload,
  WorkspacePanelPresence,
} from './tabTransfer'
import type { KeyboardSettingsSaveResult, KeyboardSettingsValue } from './keyboardSettings'
import type { UiSettingsSaveResult, UiSettingsValue } from './uiSettings'
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
   * Write only. Reading the clipboard stays tied to an attach, for the reason `terminal:clipboard-read`
   * gives; putting text INTO the clipboard gives a page nothing it did not already hand over.
   */
  'clipboard:write-text': (text: string) => void
  /**
   * The ProjectManager surface. The catalog pair is read and written by the settings editor
   * (`renderer/overlays/configuration/tabs/projects/`); the other nine belong to the launcher.
   *
   * The pair carries the roots alone, not the file they live in: `config.json` is a document of
   * registered sections and the catalog owns one key of it, so everything beside `categories`
   * survives a save without this contract ever naming it.
   *
   * A domain failure travels as `ProjectsOpResult`, not as a thrown handler: which project could not
   * be renamed and why is an answer, and `IpcResult` is reserved for the channel itself failing.
   */
  'projects:config-get': () => ProjectsOpResult<readonly CatalogCategoryDto[]>
  'projects:config-save': (categories: readonly CatalogCategoryDto[]) => ProjectsOpResult
  'projects:categories': () => readonly CategoryInfo[]
  'projects:list': (
    categoryId: string,
    sort: 'alpha' | 'recent',
  ) => ProjectsOpResult<ProjectListResult>
  'projects:sessions': (
    categoryId: string,
    projectName: string,
  ) => ProjectsOpResult<ProjectSessionsResult>
  'projects:create': (
    categoryId: string,
    name: string,
    virtualFolderPrefix: string | null,
  ) => ProjectsOpResult<ProjectEntry>
  'projects:rename': (
    categoryId: string,
    oldName: string,
    newName: string,
  ) => ProjectsOpResult<RelocationReport>
  'projects:move-prefix': (
    categoryId: string,
    name: string,
    targetPrefix: string | null,
  ) => ProjectsOpResult<RelocationReport>
  'projects:archive': (categoryId: string, name: string) => ProjectsOpResult<RelocationReport>
  'projects:delete-preview': (categoryId: string, name: string) => ProjectsOpResult<DeletePreview>
  /** Only ever the token a preview handed out: the confirmation cannot be skipped or guessed. */
  'projects:delete': (token: string) => ProjectsOpResult<DeleteReport>
  /**
   * The SessionManager surface. Its consumers arrived on 2026-08-10: the sessions tree and the Host
   * item read the snapshot and run the row actions, and the launcher's second screen is the one
   * caller of `create`.
   *
   * The whole snapshot travels on every read. It carries a revision, so a renderer told
   * `sessions:changed` and asking for the snapshot knows which change it is holding; diffing it into
   * a tree is the renderer's job, not this contract's.
   */
  'sessions:snapshot': () => SessionsSnapshot
  /**
   * Every create answers with the name a tab for the session takes, `AppJamatV3 - 001`: what a tab
   * is called is the library's to compose, and a surface that named it itself would be one of four
   * naming one session four ways.
   */
  'sessions:create': (
    spec: SessionCreateSpec,
  ) => SessionsOpResult<{ sessionId: string; tabTitle: string }>
  'sessions:history-references': (
    directory: SessionHistoryOpenSpec['directory'],
  ) => SessionsOpResult<{ references: SessionHistoryReference[] }>
  'sessions:open-history': (
    spec: SessionHistoryOpenSpec,
  ) => SessionsOpResult<{ sessionId: string; tabTitle: string }>
  'sessions:reopen': (sessionId: string) => SessionsOpResult
  /**
   * Being done with a session, as one action that always does the next step: the stop for a session
   * that is running, and for one with a worktree the commit and the merge that bring it home. It
   * replaced the separate stop and merge channels, which were two names for one thought.
   */
  'sessions:finalize': (sessionId: string) => SessionsOpResult
  /** Refused with `live-refused` while the session runs: removing a record is not stopping a runtime. */
  'sessions:remove': (sessionId: string) => SessionsOpResult
  /**
   * Closing a plain tab, which is the one close that ends what is behind it: the tab is the only
   * place such a session is drawn. Refused with `invalid-spec` for a session of the tree.
   */
  'sessions:close-plain': (sessionId: string) => SessionsOpResult
  /** A plain tab becomes a session of the tree, and answers with the name its tab now takes. */
  'sessions:promote-plain': (sessionId: string) => SessionsOpResult<{ tabTitle: string }>
  /**
   * The four operations derived from an existing session rather than described by the caller. The
   * renderer names the session and the agent and nothing else: what forking or restarting MEANS is
   * the library's, which is why none of these takes a `SessionCreateSpec`.
   */
  'sessions:fork': (sessionId: string) => SessionsOpResult<{ sessionId: string; tabTitle: string }>
  'sessions:new-beside': (
    sessionId: string,
    agentId: SessionAgentId,
  ) => SessionsOpResult<{ sessionId: string; tabTitle: string }>
  'sessions:restart': (sessionId: string) => SessionsOpResult
  /** `null` is None. An unknown name is refused rather than stored. */
  'sessions:set-color': (
    sessionId: string,
    color: SessionColorName | null,
  ) => SessionsOpResult
  /**
   * The details dialog's Save: name, note and colour as one mutation. What comes back says what
   * happened and what is left to do - `notifyAgent` carries the text a live Codex session still
   * has to be told, decided from the record rather than re-derived by the card.
   */
  'sessions:set-details': (
    sessionId: string,
    update: SessionDetailsUpdate,
  ) => SessionsOpResult<SessionDetailsSaved>
  'sessions:adopt-orphan': (runtimeSessionId: string) => SessionsOpResult
  /**
   * The other two endings a worktree session can have. Bringing the branch home is `finalize` now;
   * `discard-worktree` takes the worktree and the branch away and brings nothing, and `retry-setup`
   * is the one way out of an install that failed.
   */
  'sessions:discard-worktree': (sessionId: string) => SessionsOpResult
  /**
   * `acknowledgeSetup` is the hash from a `setup-not-acknowledged` refusal, answering the one
   * question this call can be refused with. Without it the retry could ask and nobody could
   * answer: the create path's blocks are in the launcher, and a failed install is on the tree.
   */
  'sessions:retry-setup': (sessionId: string, acknowledgeSetup?: string) => SessionsOpResult
  /**
   * The running count a session in this project is named after, and the reason it is two channels
   * rather than one: the first only looks, so a card that is opened and abandoned costs the project
   * nothing, and the second takes the number at submit. The token the second answers is what the
   * title and the worktree slug are built from - never the one the first showed.
   *
   * The project is its directory and not its catalog entry, because the directory is what a repeated
   * number would collide in: one `.worktrees/` folder, one branch namespace.
   */
  'sessions:next-number': (projectPath: string) => SessionsOpResult<{ token: string }>
  'sessions:allocate-number': (projectPath: string) => SessionsOpResult<{ token: string }>
  /**
   * The manual attempt at starting a Host. There is deliberately no channel to stop one: `host.stop`
   * kills every PTY, which is the opposite of what closing a client means here.
   */
  'sessions:start-host': () => SessionsOpResult
  /**
   * One session written down for a SECOND agent: the machine, the agent and its own conversation id,
   * the directory and the transcript file. Composed in the library rather than here, and asked for
   * when a person clicks rather than polled, because finding the transcript reads the disk.
   */
  'sessions:reference': (sessionId: string) => SessionsOpResult<{ text: string }>
  'remote:snapshot': () => RemoteConnectionsSnapshot
  /**
   * "Keep the paired computers reachable while this screen is open." Nothing is dialled until
   * something asks, so a screen that draws what only a live connection can answer has to ask.
   * Released by the window that took it, and by its death: see `ServiceRemoteControlIpc`.
   */
  'remote:hold': (reason: RemoteConnectionsHoldReason) => void
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
  'tabs:claim-panel': (panel: WorkspacePanelPresence) => ClaimPanelResult
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
  'terminal:clipboard-read': (attachId: string) => string
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
   * The Debug window's surface: three named read-only channels and nothing that passes anything
   * through. V1 shipped a generic debug dispatcher and it reached `file:write` from the renderer, so
   * a section that wants data gets a channel of its own with a name and a type.
   *
   * `host-status` is composed in the main process out of state that is already there, and asks the
   * Host for nothing. `host-ping` is the one call that touches the network, and it lives here rather
   * than in the renderer because `GET /hello` needs the descriptor's token.
   */
  'debug:host-status': () => HostDebugStatus
  'debug:host-ping': () => HostPingResult
  /** Which section is on screen, so the main process can stop pinging for one that is not. */
  'debug:section-active': (section: DebugSectionId | null) => void
  'versioning:settings-get': () => VersioningSettingsValue
  'versioning:settings-save': (
    value: VersioningSettingsValue,
  ) => VersioningSettingsSaveResult
  'worktrees:settings-get': () => WorktreeSettingsValue
  'worktrees:settings-save': (
    value: WorktreeSettingsValue,
  ) => WorktreeSettingsSaveResult
  /** The project's own tier, over its `.worktree.json`. The path is a project root, not a worktree. */
  'worktrees:project-setup-get': (projectPath: string) => ProjectSetupRead
  'worktrees:project-setup-save': (projectPath: string, setup: string[]) => ProjectSetupWrite
  'fileChanges:settings-get': () => FileChangesSettingsValue
  'fileChanges:settings-save': (
    value: FileChangesSettingsValue,
  ) => FileChangesSettingsSaveResult
  'fileChanges:list': (
    sessionId: string,
    preferredVcs: FileChangesVcsId | null,
  ) => FileChangesSnapshotResult
  'fileChanges:working-tree': (
    sessionId: string,
    source: FileChangesWorkingTreeSource | null,
  ) => FileChangesWorkingTreeSnapshotResult
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
  /**
   * The two font scales, the second section of `config.json` after the catalog.
   *
   * The read always answers a value: a config nobody can read means the defaults, because a window
   * has to draw text either way. Refusal belongs to the save alone, which is where there is finally
   * something that would be lost by writing over a damaged file.
   */
  'ui:settings-get': () => UiSettingsValue
  'ui:settings-save': (value: UiSettingsValue) => UiSettingsSaveResult
  /**
   * Which of the two launcher cards Ctrl+T opens. Read by the settings tab and by the one tooltip
   * that prints a key; the main process reads the same section straight from the store to build the
   * menu, so what the accelerators ARE never crosses this bridge.
   */
  'keyboard:settings-get': () => KeyboardSettingsValue
  'keyboard:settings-save': (value: KeyboardSettingsValue) => KeyboardSettingsSaveResult
  /**
   * Whether each agent runs without being asked anything. The read is only the tab's: what a launch
   * is planned from never crosses this bridge, because the main process reads the same section
   * straight from the store.
   */
  'agents:settings-get': () => AgentSettingsValue
  'agents:settings-save': (value: AgentSettingsValue) => AgentSettingsSaveResult
  'agents:auto-compact-set': (
    agentId: AgentSettingsAgentId,
    enabled: boolean,
  ) => AgentSettingsSaveResult
  /**
   * How much of each provider's rate limit is spent. The whole snapshot travels on every read and
   * carries a revision, the same shape as `sessions:snapshot`.
   */
  'rate:get': () => RateMonitorSnapshot
  /**
   * The manual read, and it answers the snapshot once the reads have settled, so a widget does not
   * have to race the event it would otherwise wait for. Asking more often than the monitor's floor
   * allows costs nothing and reads nothing: the floor lives in the library, not in the caller.
   */
  'rate:refresh': () => RateMonitorSnapshot
  /**
   * The Debug window alone: every window the API returned, both timestamps per provider and when the
   * OAuth token expires. Never a token - `RateProviderDebug` has no field one could travel in, and
   * the library composes it field by field, which is the same boundary `debug:host-status` keeps.
   */
  'rate:debug-status': () => RateMonitorDebugStatus
  /**
   * The model, the effort and how full the context is for one session, read out of the transcript
   * its agent is writing. On demand and per window rather than broadcast: which panel is in front is
   * the renderer's knowledge, and only the window looking at a terminal has anything to ask about.
   *
   * The session id is the whole request and it is taken strictly: a session nobody knows, a shell
   * session and an agent session with no native session id all answer `none` with the reason, and
   * never the newest transcript that happens to lie in the same directory.
   */
  'sessionModel:get': (sessionId: string) => SessionModelReading
  'contextCompaction:claim-auto': (sessionId: string) => boolean
  'contextCompaction:note-manual': (sessionId: string) => void
  'contextCompaction:cooldown': (sessionId: string) => ContextCompactionCooldown | null
  /**
   * The last words of a session that has ended, for the post-mortem block of a panel whose runtime
   * the Host no longer has. Taken as strictly as the model above it and answered the same way: a
   * session nobody knows, a shell and an agent with no native session id all answer `none`.
   */
  'sessionTranscript:get': (sessionId: string) => SessionTranscriptReading
}

export interface AppClientUiIpcEventMap {
  'menu:command': (commandId: BareCommandId) => void
  'app:error': (message: string) => void
  'window:changed': () => void
  /** Parameter-less on purpose: the answer is the snapshot, and it is read through its own channel. */
  'sessions:changed': () => void
  'remote:changed': () => void
  'tabs:activate-panel': (
    panelId: string,
    params?: Record<string, unknown>,
    title?: string,
  ) => void
  'tabs:close-panel': (panelId: string) => void
  'tabs:terminal-restarted': (targetKey: string) => void
  'tabs:visible-terminal-targets': (targetKeys: readonly string[]) => void
  'tabs:transfer-in': (token: string) => void
  'tabs:transfer-out': (panelId: string) => void
  'tabs:control-command': (command: TabControlCommand) => void
  /**
   * Parameter-less for the same reason, and to every workspace plus Debug: the value rides on
   * `ui:settings-get`, so a window that missed one event and reads once still ends up holding what
   * is on disk.
   */
  'ui:settings-changed': () => void
  'keyboard:settings-changed': () => void
  'agents:settings-changed': () => void
  /**
   * Parameter-less as well, to every workspace plus Debug, and only when the content actually moved:
   * the monitor holds a revision so a poll that changed nothing wakes nobody. The value rides on
   * `rate:get`, and the Debug window reads its own unreduced view off the same signal.
   */
  'rate:changed': () => void
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
  appInfo: 'app:info',
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
  projects: {
    getConfig: 'projects:config-get',
    saveConfig: 'projects:config-save',
    categories: 'projects:categories',
    list: 'projects:list',
    sessions: 'projects:sessions',
    create: 'projects:create',
    rename: 'projects:rename',
    movePrefix: 'projects:move-prefix',
    archive: 'projects:archive',
    deletePreview: 'projects:delete-preview',
    deleteProject: 'projects:delete',
  },
  sessions: {
    snapshot: 'sessions:snapshot',
    create: 'sessions:create',
    historyReferences: 'sessions:history-references',
    openHistory: 'sessions:open-history',
    reopen: 'sessions:reopen',
    finalize: 'sessions:finalize',
    remove: 'sessions:remove',
    closePlain: 'sessions:close-plain',
    promotePlain: 'sessions:promote-plain',
    fork: 'sessions:fork',
    newBeside: 'sessions:new-beside',
    restart: 'sessions:restart',
    setColor: 'sessions:set-color',
    setDetails: 'sessions:set-details',
    adoptOrphan: 'sessions:adopt-orphan',
    discardWorktree: 'sessions:discard-worktree',
    retrySetup: 'sessions:retry-setup',
    nextNumber: 'sessions:next-number',
    allocateNumber: 'sessions:allocate-number',
    startHost: 'sessions:start-host',
    reference: 'sessions:reference',
  },
  remote: {
    snapshot: 'remote:snapshot',
    hold: 'remote:hold',
    release: 'remote:release',
    describeAgents: 'remote:agents-describe',
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
  },
  terminal: {
    attach: 'terminal:attach',
    input: 'terminal:input',
    resize: 'terminal:resize',
    active: 'terminal:active',
    detach: 'terminal:detach',
    clipboardRead: 'terminal:clipboard-read',
    clipboardWrite: 'terminal:clipboard-write',
  },
  terminalMenu: {
    detect: 'terminal:menu-detect',
    openFile: 'terminal:menu-open-file',
    openDirectory: 'terminal:menu-open-directory',
    openExternal: 'terminal:menu-open-external',
    openVsCode: 'terminal:menu-open-vscode',
    openProjectVsCode: 'terminal:menu-open-project-vscode',
  },
  // One preload serves both document entries, so the bridge is the superset and each uses its part.
  debug: {
    hostStatus: 'debug:host-status',
    pingHost: 'debug:host-ping',
    sectionActive: 'debug:section-active',
  },
  versioning: {
    getSettings: 'versioning:settings-get',
    saveSettings: 'versioning:settings-save',
  },
  worktrees: {
    getSettings: 'worktrees:settings-get',
    saveSettings: 'worktrees:settings-save',
    getProjectSetup: 'worktrees:project-setup-get',
    saveProjectSetup: 'worktrees:project-setup-save',
  },
  fileChanges: {
    getSettings: 'fileChanges:settings-get',
    saveSettings: 'fileChanges:settings-save',
    list: 'fileChanges:list',
    workingTree: 'fileChanges:working-tree',
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
  ui: {
    getSettings: 'ui:settings-get',
    saveSettings: 'ui:settings-save',
  },
  keyboard: {
    getSettings: 'keyboard:settings-get',
    saveSettings: 'keyboard:settings-save',
  },
  agents: {
    getSettings: 'agents:settings-get',
    saveSettings: 'agents:settings-save',
    setAutoCompact: 'agents:auto-compact-set',
  },
  rateMonitor: {
    get: 'rate:get',
    refresh: 'rate:refresh',
    debugStatus: 'rate:debug-status',
  },
  sessionModel: {
    get: 'sessionModel:get',
  },
  contextCompaction: {
    claimAutomatic: 'contextCompaction:claim-auto',
    noteManual: 'contextCompaction:note-manual',
    cooldown: 'contextCompaction:cooldown',
  },
  sessionTranscript: {
    get: 'sessionTranscript:get',
  },
} as const satisfies AppClientUiBridgeCallTable

/** The event half, flat because every listener the bridge offers sits at its root. */
export const AppClientUiBridgeEventsConst = {
  onMenuCommand: 'menu:command',
  onAppError: 'app:error',
  onWindowChanged: 'window:changed',
  onSessionsChanged: 'sessions:changed',
  onRemoteChanged: 'remote:changed',
  onTabsActivatePanel: 'tabs:activate-panel',
  onTabsClosePanel: 'tabs:close-panel',
  onTabsTerminalRestarted: 'tabs:terminal-restarted',
  onTabsVisibleTerminalTargets: 'tabs:visible-terminal-targets',
  onTabsTransferIn: 'tabs:transfer-in',
  onTabsTransferOut: 'tabs:transfer-out',
  onTabsControlCommand: 'tabs:control-command',
  onUiSettingsChanged: 'ui:settings-changed',
  onKeyboardSettingsChanged: 'keyboard:settings-changed',
  onAgentSettingsChanged: 'agents:settings-changed',
  onRateChanged: 'rate:changed',
  onHostPingResult: 'debug:host-ping-result',
  onTerminalFrame: 'terminal:frame',
  onRemoteTerminalFrame: 'remote:terminal-frame',
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
