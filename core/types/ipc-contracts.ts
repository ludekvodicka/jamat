/**
 * Single source of truth for every IPC channel in the Electron app.
 *
 * Each entry maps a channel name to a function signature. The main-side
 * handler signature, the preload bridge wrapper, and the renderer call
 * site all derive their types from this file via the helpers in
 * `app-electron/src/shared/typed-ipc.ts`. Changing a signature here
 * breaks every drift point at compile time.
 *
 * Three flavors:
 * - `IpcInvokeMap` — request/response (`ipcMain.handle` / `ipcRenderer.invoke`)
 * - `IpcSendMap`   — renderer→main fire-and-forget (`ipcRenderer.send`)
 * - `IpcEventMap`  — main→renderer push (`webContents.send` / `ipcRenderer.on`)
 *
 * Pure types — no electron import, no runtime registry. Lives in `core/`
 * because the contract is shared across renderer + main, and `core/`
 * is the zero-dep boundary.
 */

import type { TurnInfo, SessionInfo, SessionMessage, SessionSearchMatch, UsageCache, SessionModelInfo } from './session.js'
import type { DiffBaseline, DiffMode, DiffOptions } from './file-diff.js'
import type { AppConfig, ConfigPatch } from './config.js'
import type { JamatPaths } from '../jamat-paths.js'
import type { Idea } from './ideas.js'
import type { AbilitiesResult, AbilitiesManageRequest, AbilitiesManageResult } from './abilities.js'
import type { StatsDataResult } from './stats.js'
import type { AgentId } from './contracts.js'
import type { UpdateStatus } from '../update/update-status.types.js'
import type {
  RemoteControlData,
  RemotePeer,
  RemoteWindowInfo,
  RemoteTabInfo,
  PeerProbeResult,
  OpenTabReq,
  ControlOpenTabPayload,
  WsServerMsg,
} from './remote-control.js'

// ────────────────────────────────────────────────────────────────────────────
// Shared shapes that the bridge currently re-types inline
// ────────────────────────────────────────────────────────────────────────────

export type AiModel = 'haiku' | 'sonnet' | 'opus' | 'off'
export type CommitVcs = 'git' | 'svn' | 'hg'
export type CommitVcsRequest = CommitVcs | 'all'

export interface CommitOptions {
  model?: AiModel
}

/** Resolved on-disk locations + provenance, shown read-only in Settings → Info. Extends the
 *  cross-process JamatPaths map with whether the config-dir came from --config-dir / JAMAT_CONFIG_DIR
 *  (vs the default ~/.jamat) and the running build's version. */
export interface AppPathsInfo extends JamatPaths {
  explicit: boolean
  appVersion: string
}

/** One opened Tortoise dialog within a commit request. */
export interface CommitResultDialog {
  /** Absolute working-copy root the dialog targets. */
  repoRoot: string
  /** Number of changed paths (`status` lines) the dialog will show. */
  statusLines: number
  /** Temp file holding the pre-filled commit message. */
  msgFile: string
  /** True when the message was AI-generated (vs. the basic file-list). */
  usedAi: boolean
  /** AI generation wall-time in ms; present only when `usedAi`. */
  aiMs?: number
}

/**
 * `vcs` echoes the request — `'all'` is preserved so the renderer knows the
 * call dispatched to every detected VCS rather than a single one.
 */
export interface CommitResult {
  ok: boolean
  vcs: CommitVcsRequest
  /** One entry per dialog actually opened. */
  dialogs: CommitResultDialog[]
  /** Human-readable reasons repos were skipped, e.g. `"git <root> (clean)"`. */
  skipped: string[]
  error?: string
}

export interface VcsDetectResult {
  git: boolean
  svn: boolean
  hg: boolean
}

export interface SessionRenameResult {
  ok: boolean
  error?: string
  /**
   * The session that was renamed. Differs from the caller's input when the
   * caller passed an empty/unknown id and the backend resolved the
   * project's active session instead.
   */
  sessionId?: string
}

export interface RecentFile {
  /** Absolute path on disk. */
  path: string
  /** Basename for display. */
  name: string
  /** Last-modified epoch ms (sort key). */
  mtime: number
  /** Path relative to the project dir, for compact display. */
  relative: string
}

/** One immediate child of a directory — for the directory viewer panel + the folder right-click menu. */
export interface DirEntry {
  /** Absolute path on disk. */
  path: string
  /** Basename for display. */
  name: string
  /** Whether the entry is a regular file or a subdirectory. */
  type: 'file' | 'dir'
  /** Last-modified epoch ms. */
  mtime: number
  /** Byte size (0 for directories). */
  size: number
}

/**
 * Per-agent availability + display metadata. The renderer needs this for
 * the TabTypePicker (to grey out backends without their binary on PATH)
 * but can't call the registry directly — `existsSync(PATH)` is a main-
 * process concern under sandbox+contextIsolation.
 */
export interface AgentMeta {
  id: AgentId
  displayName: string
  binary: string
  /** True when `binary` is found on PATH (main-process check). */
  available: boolean
}

export interface GroupInfo {
  id: string
  name: string
}

// AppConfig is canonical in `core/types/config.ts` — re-exported here for
// convenience so consumers of the IPC map import everything from one place.
export type { AppConfig }

// ────────────────────────────────────────────────────────────────────────────
// Invoke map — request/response over ipcMain.handle / ipcRenderer.invoke
// ────────────────────────────────────────────────────────────────────────────

export interface IpcInvokeMap {
  // app + window
  'app:version': () => Promise<string>
  // Resolved config-dir / app-state / cache paths + provenance, for the read-only Settings → Info tab.
  'app:paths': () => Promise<AppPathsInfo>
  'window:new': (filePath?: string) => Promise<void>
  'config:get': () => Promise<AppConfig | null>
  // Persist a partial config edit (the UI-editable on-disk keys: name, categories, defaultAgent,
  // dockerIsolation, customMenus, selfUpdate, sessionDonePrompts) back into the committed
  // `config-<user>.json`. Each present key is validated with the same rules as load; a categories
  // patch is brick-guarded (≥1 existing dir). On success the in-memory config is reloaded and a
  // `config:changed` event is broadcast so every window refreshes. Secrets (claudeUsage) do NOT go
  // here — they route through `usage:set-credentials` (the `.local.json` overlay). Backs all the
  // Settings config tabs (Projects, General, Updates, Project menus, Quick prompts).
  'config:update': (patch: ConfigPatch) => Promise<{ ok: boolean; error?: string }>
  // The RAW on-disk config object (parsed `config-<user>.json`), so the Settings editors seed from
  // the TRUE persisted values — not the runtime AppConfig, which filters inaccessible categories
  // (skippedCategories) and normalizes/sanitizes customMenus + selfUpdate. The base file holds NO
  // secrets (claudeUsage lives in the `.local.json` overlay), so this is safe to surface. null if
  // unloaded/unreadable.
  'config:get-raw': () => Promise<Record<string, unknown> | null>
  // The update module's live status — resolved channel + WHY (installed→GitHub, source checkout→disk
  // compare, unsigned mac→none), running version, last check + outcome, a pending version, deprecated
  // config keys. Read by Settings → Updates; the same record is in `debug:info.update`.
  'update:status': () => Promise<UpdateStatus>
  // Manual check ("Check now" / the menu item). Always ends in a dialog from the main process (the
  // renderer only needs to know the call went through), and bypasses the idle gate on purpose.
  'update:check': () => Promise<{ ok: boolean }>
  // Native folder picker (showOpenDialog, openDirectory) for the Projects/categories editor.
  // Returns the chosen absolute path, or null if the user cancelled.
  'dialog:pick-directory': (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  // First-run onboarding signal + completion. `get-state.firstRun` drives the renderer's auto-open
  // of Settings in guided mode; `complete` marks it done (persisted in app-state.json).
  'onboarding:get-state': () => Promise<{ firstRun: boolean }>
  'onboarding:complete': () => Promise<{ ok: boolean }>
  'stats:generate': (force?: boolean) => Promise<{ ok: boolean; htmlPath?: string; error?: string }>
  // Native Usage Stats tab: runs the existing generate-stats.ts and returns the parsed stats.json
  // DATA (not an HTML path). Serves a fresh (<5 min) cached stats.json unless `force` bypasses it.
  'stats:data': (force?: boolean) => Promise<StatsDataResult>

  // clipboard — the renderer runs sandboxed under contextIsolation and, in the PACKAGED build, is
  // loaded from a file:// URL where the async navigator.clipboard API is gated by Electron's
  // permission/secure-origin handling and silently rejects (it works in dev only because dev serves
  // the renderer over http://localhost). So clipboard goes through the main-process Electron
  // `clipboard` module, which is a native API independent of web security / focus / permissions.
  'clipboard:write-text': (text: string) => Promise<void>
  'clipboard:read-text': () => Promise<string>
  // Silent read for the status-bar clipboard-debug widget's poller — same value as read-text. Kept
  // separate so the (optional, off-by-default) debug widget can poll without any side effects.
  'clipboard:debug-read': () => Promise<string>

  // layout
  'layout:save': (windowId: string, json: string) => Promise<void>
  'layout:load': (windowId: string) => Promise<string | null>

  // groups
  'group:create': (name: string) => Promise<GroupInfo | null>
  'group:rename': (id: string, newName: string) => Promise<void>

  // notes
  'notes:load': (panelId: string) => Promise<string[]>
  'notes:save': (panelId: string, entries: string[]) => Promise<void>

  // ideas (per-window global list)
  'ideas:load': (windowId: string) => Promise<Idea[]>
  'ideas:save': (windowId: string, ideas: Idea[]) => Promise<{ ok: boolean; error?: string }>

  // files
  'file:exists': (filePath: string) => Promise<boolean>
  'file:type': (filePath: string) => Promise<'file' | 'dir' | null>
  'file:read': (filePath: string) => Promise<string | null>
  'file:read-binary': (filePath: string) => Promise<string | null>
  'file:write': (filePath: string, content: string) => Promise<{ ok: boolean; error?: string }>
  'file:list-recent': (dirPath: string, limit?: number) => Promise<RecentFile[]>
  // List the immediate (one-level) children of a directory — backs the directory viewer panel
  // and the folder right-click menu. Subdirs first, then files; each group name-sorted (numeric).
  'file:list-dir': (dirPath: string, limit?: number) => Promise<DirEntry[]>
  // Resolve a TRUNCATED path (e.g. a sub-agent reported `…\012-foo\bar.md`) to real files
  // by searching `baseDir` for any whose path ends with the longest matching suffix of segments.
  'file:find-by-suffix': (baseDir: string, partial: string, limit?: number) => Promise<string[]>
  // Claude Abilities tab: scan ~/.claude (skills/commands/plugins/agents/MCP) on this machine.
  'abilities:list': () => Promise<AbilitiesResult>
  // Claude Abilities tab: enable/disable/remove a plugin or user skill (FIRST write into ~/.claude).
  'abilities:manage': (req: AbilitiesManageRequest) => Promise<AbilitiesManageResult>
  'file:open-in-vscode': (filePath: string) => Promise<{ ok: boolean; error?: string }>

  // sessions
  'sessions:list': (projectDir: string) => Promise<SessionInfo[]>
  'sessions:edit-flags': (projectDir: string) => Promise<Record<string, boolean>>
  'sessions:load': (projectDir: string, sessionId: string) => Promise<SessionMessage[]>
  'sessions:rename': (projectDir: string, sessionId: string | null | undefined, name: string) => Promise<SessionRenameResult>
  'sessions:search': (projectDir: string, query: string) => Promise<SessionSearchMatch[]>
  'sessions:search-all': (query: string) => Promise<(SessionSearchMatch & { projectDir: string })[]>
  // `fork: true` opens the session as a `--fork-session` branch (new session id, history kept,
  // parent untouched) instead of a plain resume. Used by the tab "Fork session" context-menu action.
  'sessions:open-in-tab': (projectDir: string, sessionId: string, fork?: boolean) => Promise<boolean>

  // session changes / model
  'session-changes:get': (projectDir: string, sessionId?: string) => Promise<TurnInfo[]>
  'session-changes:locate-region': (filePath: string, afterText: string) => Promise<number | null>
  'session-model:get': (projectDir: string, sessionId?: string) => Promise<SessionModelInfo | null>

  // file-diff
  'file-diff:list-options': (filePath: string, projectDir?: string | null, sessionId?: string | null) => Promise<DiffOptions>
  'file-diff:get-baseline': (filePath: string, mode: DiffMode, projectDir?: string | null, sessionId?: string | null) => Promise<DiffBaseline>

  // commit
  'commit:detect-vcs': (projectDir: string) => Promise<VcsDetectResult>
  'commit:open-dialog': (vcs: CommitVcsRequest, projectDir: string, opts?: CommitOptions) => Promise<CommitResult>
  'commit:open-log': (vcs: CommitVcs, projectDir: string) => Promise<{ ok: boolean; error?: string }>

  // pty lifecycle (resume crashed Claude)
  'pty:resume': (terminalId: string) => Promise<{ ok: boolean; error?: string }>

  // usage
  'usage:get': () => Promise<UsageCache | null>
  // Status-detection credentials (Claude.ai usage). GET never returns the session key —
  // only orgId + a boolean — so the secret never crosses back to the renderer. SET writes
  // them into the gitignored `config-<user>.local.json` overlay (blank sessionKey = keep existing).
  'usage:get-credentials': () => Promise<{ orgId: string; hasSessionKey: boolean }>
  'usage:set-credentials': (orgId: string, sessionKey: string) => Promise<{ ok: boolean; error?: string }>

  // agents
  'agents:list': () => Promise<AgentMeta[]>
  'agents:resolve-for-session': (sessionId: string) => Promise<AgentId | null>

  // remote app control — local config (this machine's server token + peers)
  'remote:get-config': () => Promise<RemoteControlData>
  // runtime bind state of the LAN listener (vs the persisted config) — lets the panel show
  // "failed to bind" instead of lying "listening" when enabled but the port is in use.
  'remote:get-bind-state': () => Promise<{ enabled: boolean; bound: boolean; port: number }>
  'remote:self-name': () => Promise<string>
  'remote:save-config': (data: RemoteControlData) => Promise<{ ok: boolean; error?: string }>
  // this machine's hostname + non-internal IPv4 addresses (to hand to a peer)
  'remote:local-ips': () => Promise<{ hostname: string; ips: string[] }>
  // remote app control — client calls to a peer (all go through main; the
  // bearer token is attached server-side, so there is no browser CORS surface)
  'remote:probe': (peer: RemotePeer) => Promise<PeerProbeResult>
  'remote:windows': (peer: RemotePeer) => Promise<{ ok: boolean; windows?: RemoteWindowInfo[]; error?: string }>
  'remote:open-tab': (peer: RemotePeer, req: OpenTabReq) => Promise<{ ok: boolean; error?: string }>
  'remote:close-tab': (peer: RemotePeer, terminalId: string) => Promise<{ ok: boolean; error?: string }>
  'remote:launch-app': (peer: RemotePeer) => Promise<{ ok: boolean; error?: string }>
  // generic op passthrough to a peer's reach-gated /op endpoint — used by the Remote
  // panel's debug/control buttons (logs/terminals/restart/fullrestart). A peer only
  // honours ops whose reach includes 'remote' (control + debug ops), so this can't
  // reach anything a peer wouldn't already expose.
  'remote:op': (peer: RemotePeer, name: string, args?: unknown[]) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>
  // opens a WS stream to a peer's tab; the caller supplies streamId (so it can
  // attach its `remote:stream-frame` listener before the snapshot arrives)
  'remote:stream-open': (peer: RemotePeer, terminalId: string, streamId: string) => Promise<{ ok: boolean; error?: string }>
}

// ────────────────────────────────────────────────────────────────────────────
// Send map — renderer→main fire-and-forget
// ────────────────────────────────────────────────────────────────────────────

export interface TerminalConfig {
  cols: number
  rows: number
  cwd?: string
  command?: string
  args?: string[]
}

export interface ScreenTerminalConfig {
  cols: number
  rows: number
}

/**
 * Single shape for both `screen:open-tab` (main→renderer push at session
 * resume / cross-window open) and `screen:restore` (renderer→main on
 * panel remount). Keeping these unified prevents the `agent` field —
 * added during the agent-adapter refactor — from silently dropping at
 * one boundary while the other still carries it.
 *
 * `cmd` is the literal MenuSelection command union; the IPC contract
 * narrows it so consumers don't need a runtime guard.
 */
export interface ScreenOpenTabMeta {
  projectDir: string
  cmd: 'cc' | 'ccc' | 'resume' | 'resume-fork'
  folderName: string
  sessionId?: string
  /** Forked session's parent id — see MenuSelection.forkParentId. Carried across restart so a
   *  fork that hasn't written a transcript yet re-forks its parent instead of failing. */
  forkParentId?: string
  antiFlicker?: boolean
  agent?: AgentId
}

/** @deprecated alias — kept for the `screen:restore` IpcSend channel. */
export type ScreenRestoreMeta = ScreenOpenTabMeta

export interface DetachTabPayload {
  title: string
  params: Record<string, unknown>
}

export interface IpcSendMap {
  // window
  'window:detach-tab': (data: DetachTabPayload) => void
  // Bring the sender's window to the foreground — used by a notification click so the user lands
  // back on the app; the renderer then activates the tab the notification came from.
  'window:focus': () => void

  // pty
  'pty:create': (id: string, config: TerminalConfig) => void
  'pty:write': (id: string, data: string) => void
  'pty:resize': (id: string, cols: number, rows: number) => void
  'pty:destroy': (id: string) => void

  // screen
  'screen:create': (id: string, config: ScreenTerminalConfig) => void
  'screen:restore': (id: string, meta: ScreenRestoreMeta, immediate?: boolean) => void

  // file watcher
  'file:watch': (filePath: string) => void
  'file:unwatch': (filePath: string) => void

  // action — `action` is one of the known verbs; trailing args are the
  // verb's operands (open-url → url; open-vscode → dir; dev-tools → none).
  // Kept as `...string[]` (not correlated per-verb) to match the handler's
  // `...args: string[]` reality without the overload/Parameters footgun.
  'action:run': (action: 'open-url' | 'open-vscode' | 'dev-tools', ...args: string[]) => void

  // remote app control — renderer→main, sandbox-safe (the only allowed direction
  // under sandbox+contextIsolation; the dynamic ipcMain.once reply pattern used
  // by the legacy dialogs does NOT work for the app windows)
  // tab-tree push: each renderer pushes its current dockview tabs on change;
  // main caches per webContents.id for the control-server to read synchronously.
  'tabs:push': (tabs: RemoteTabInfo[]) => void
  // client → main → peer WS: forward keystrokes / close the stream
  'remote:stream-send-keys': (streamId: string, data: string) => void
  'remote:stream-close': (streamId: string) => void
}

// ────────────────────────────────────────────────────────────────────────────
// Event map — main→renderer push (handlers ignore the IpcRendererEvent arg)
// ────────────────────────────────────────────────────────────────────────────

export interface IpcEventMap {
  // pty stream
  'pty:output': (id: string, data: string) => void
  'pty:exit': (id: string, code: number) => void
  'pty:crash': (id: string, code: number, canResume: boolean, crashCount: number) => void

  // screen
  'screen:title': (id: string, title: string) => void
  // Terminal lifecycle phase. 'menu' = the CLI menu TUI owns the PTY (it uses F1..F8 for its own
  // actions — Search/Manage/…); 'running' = an agent session (Claude) is live. The renderer gates
  // its F1/F2 app-shortcut steal on this so the menu keeps its function keys.
  'screen:phase': (id: string, phase: 'menu' | 'running') => void
  'screen:refit': (id: string) => void
  'screen:update-params': (id: string, params: Record<string, unknown>) => void
  'screen:open-tab': (terminalId: string, meta: ScreenOpenTabMeta) => void

  // file watcher
  'file:changed': (filePath: string) => void

  // group ui
  'group:color-changed': (color: string) => void
  // Window's group name changed live (named on the fly, or renamed) — the status bar + document
  // title read the name from the URL hash once, so they need a push to update without a restart.
  'group:name-changed': (name: string) => void

  // error / log surface
  'error:log': (source: string, message: string) => void

  // usage
  'usage:update': (data: UsageCache) => void

  // config — broadcast to every window after a successful `config:update` so each renderer's
  // store refreshes (categories/agent/menus/prompts apply live, no restart).
  'config:changed': (config: AppConfig) => void

  // remote app control — controlled side: a peer asked to open a tab here
  // (payload is server-resolved + path-validated, not the raw network request)
  'control:open-tab': (payload: ControlOpenTabPayload) => void
  // remote app control — controlled side: a peer asked to close one of its tabs
  'control:close-tab': (payload: { terminalId: string }) => void
  // remote app control — client side: a frame arrived on a peer WS stream
  'remote:stream-frame': (streamId: string, msg: WsServerMsg) => void
  // remote app control — controlled side: a remote session is active (drives
  // the passive status-bar indicator + kill switch)
  'remote:session-active': (info: { active: boolean; peerLabel: string; lastActionTs: number }) => void
  // Remote Activity Log — one live line for the Remote Activity Log tab. Every
  // discrete remote-control action (human via UI or AI via the bridge, either
  // side). Auto-opens the tab inactive (silent, no focus steal) on first activity.
  'remote:activity': (entry: {
    ts: number; side: 'controller' | 'controlled'; via: 'human' | 'ai'; machine: string
    action?: string; phase?: string; target?: string; payload?: string
    corrId?: string; scenario?: string; message: string
  }) => void

  // menu (P5: menu-as-ops) — the native menu click handlers AND the menu:invoke op publish
  // these; the renderer's onMenuAction subscribes (raw, like onX). Most carry no payload.
  'menu:new-tab': () => void
  'menu:new-tab-picker': () => void
  'menu:close-tab': () => void
  'menu:toggle-sidebar': () => void
  'menu:toggle-notes': () => void
  'menu:toggle-maximize': () => void
  'menu:set-theme': (theme: string) => void
  'menu:help': () => void
  'menu:move-tab': (direction: string) => void
  'menu:reset-layout': () => void
  'menu:settings': () => void
  'menu:new-tab-type': (tabType: string) => void
  'menu:open-session-history': () => void
  'menu:open-file-changes': () => void
  'menu:open-sessions-search': () => void
  'menu:open-ideas': () => void
}

// ────────────────────────────────────────────────────────────────────────────
// Utility types — derive args/return tuples for the typed helpers
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// (The localhost /debug/ipc REST allowlist + IpcWriteChannel/AllowlistLevel were removed with the
//  generic /debug/ipc route in P2 — the renderer reaches every op only via the typed `'op'` adapter.)
// ────────────────────────────────────────────────────────────────────────────


/**
 * Tuple of parameters for an Invoke channel.
 *
 * WARNING: only valid for a *single* concrete `K`. With a union key
 * (`K = keyof IpcInvokeMap`) `Parameters<...>` is a homomorphic mapping
 * that collapses to an intersection-of-tuples (usually `never`). A
 * generic-key consumer needs a distributed conditional instead:
 * `K extends any ? Parameters<IpcInvokeMap[K]> : never`.
 */
export type IpcInvokeArgs<K extends keyof IpcInvokeMap> = Parameters<IpcInvokeMap[K]>

/** Awaited return value of an Invoke channel. */
export type IpcInvokeResult<K extends keyof IpcInvokeMap> = Awaited<ReturnType<IpcInvokeMap[K]>>

/** Tuple of parameters for a Send channel. */
export type IpcSendArgs<K extends keyof IpcSendMap> = Parameters<IpcSendMap[K]>

/** Tuple of parameters for an Event channel (received in the renderer). */
export type IpcEventArgs<K extends keyof IpcEventMap> = Parameters<IpcEventMap[K]>
