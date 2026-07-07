import { contextBridge, ipcRenderer } from 'electron'
import type { TurnInfo } from '../../../core/types'
import type { SessionInfo, SessionMessage, SessionSearchMatch, UsageCache, SessionModelInfo } from '../../../core/types/session'
import type { DiffBaseline, DiffMode, DiffOptions } from '../../../core/types/file-diff'
import type { AppConfig, ConfigPatch } from '../../../core/types/config'
import type { AgentMeta, AppPathsInfo, CommitResult, CommitVcsRequest, CommitOptions, DirEntry, IpcEventMap, SessionRenameResult } from '../../../core/types/ipc-contracts'
import type { AgentId } from '../../../core/types/contracts'
import type { Idea } from '../../../core/types/ideas'
import type { AbilitiesResult, AbilitiesManageRequest, AbilitiesManageResult } from '../../../core/types/abilities'
import type { StatsDataResult } from '../../../core/types/stats'
import type {
  RemoteControlData, RemotePeer, RemoteWindowInfo, RemoteTabInfo, PeerProbeResult,
  OpenTabReq, ControlOpenTabPayload, WsServerMsg,
} from '../../../core/types/remote-control'
import { invokeChannel, onChannel, sendChannel } from '../shared/typed-ipc'

type OpenTabMeta = Parameters<IpcEventMap['screen:open-tab']>[1]

/**
 * The renderer bridge. P1: every invoke/send routes through the op layer via the typed helpers
 * (invokeChannel→`op`, sendChannel→`opSend`); every signature is byte-identical to V1, so the
 * renderer is untouched. Event listeners (`onX`) stay raw IPC in P1 (events still flow via
 * webContents.send; P3 moved them to the stream façade). The 17 `menu:*` channels are now
 * IpcEventMap streams too (P5) + the menu:list/menu:invoke ops; `onMenuAction` subscribes raw like onX.
 */
const api = {
  // Host platform — the renderer can't read `process` (sandboxed), so it reads this to branch
  // OS-specific UI (e.g. which shell tabs the picker offers). `typeof api` carries the type.
  platform: process.platform,

  saveLayout: (windowId: string, json: string): Promise<void> => invokeChannel('layout:save', windowId, json),
  loadLayout: (windowId: string): Promise<string | null> => invokeChannel('layout:load', windowId),

  newWindow: (filePath?: string): Promise<void> => invokeChannel('window:new', filePath),
  detachTab: (data: { title: string; params: Record<string, unknown> }): void => sendChannel('window:detach-tab', data),
  focusWindow: (): void => sendChannel('window:focus'),
  getConfig: (): Promise<AppConfig | null> => invokeChannel('config:get'),
  updateConfig: (patch: ConfigPatch): Promise<{ ok: boolean; error?: string }> => invokeChannel('config:update', patch),
  getRawConfig: (): Promise<Record<string, unknown> | null> => invokeChannel('config:get-raw'),
  onConfigChanged: (callback: (config: AppConfig) => void): (() => void) => onChannel('config:changed', callback),
  pickDirectory: (opts?: { title?: string; defaultPath?: string }): Promise<string | null> => invokeChannel('dialog:pick-directory', opts),
  getOnboardingState: (): Promise<{ firstRun: boolean }> => invokeChannel('onboarding:get-state'),
  completeOnboarding: (): Promise<{ ok: boolean }> => invokeChannel('onboarding:complete'),

  createScreenTerminal: (id: string, config: { cols: number; rows: number }): void => sendChannel('screen:create', id, config),
  createTerminal: (id: string, config: { cols: number; rows: number; cwd?: string; command?: string; args?: string[] }): void => sendChannel('pty:create', id, config),
  writeTerminal: (id: string, data: string): void => sendChannel('pty:write', id, data),
  resizeTerminal: (id: string, cols: number, rows: number): void => sendChannel('pty:resize', id, cols, rows),
  destroyTerminal: (id: string): void => sendChannel('pty:destroy', id),

  onTerminalData: (callback: (id: string, data: string) => void): (() => void) => onChannel('pty:output', callback),
  onTerminalExit: (callback: (id: string, code: number) => void): (() => void) => onChannel('pty:exit', callback),
  onTerminalCrash: (callback: (id: string, code: number, canResume: boolean, crashCount: number) => void): (() => void) => onChannel('pty:crash', callback),
  resumeCrashedSession: (terminalId: string): Promise<{ ok: boolean; error?: string }> => invokeChannel('pty:resume', terminalId),

  onScreenTitle: (callback: (id: string, title: string) => void): (() => void) => onChannel('screen:title', callback),
  onScreenPhase: (callback: (id: string, phase: 'menu' | 'running') => void): (() => void) => onChannel('screen:phase', callback),
  onScreenRefit: (callback: (id: string) => void): (() => void) => onChannel('screen:refit', callback),
  onScreenUpdateParams: (callback: (id: string, params: Record<string, unknown>) => void): (() => void) => onChannel('screen:update-params', callback),
  restoreTerminal: (id: string, meta: OpenTabMeta, immediate?: boolean): void => sendChannel('screen:restore', id, meta, immediate),

  // Raw subscription (like the onX stream listeners): the 17 menu:* channels are now IpcEventMap
  // streams (P5) — the main-side sends go through the publish façade + the menu:list/menu:invoke ops.
  onMenuAction: (callback: (action: string, ...args: unknown[]) => void): (() => void) => {
    const actions = ['menu:new-tab', 'menu:new-tab-picker', 'menu:close-tab', 'menu:toggle-sidebar', 'menu:toggle-notes', 'menu:toggle-maximize', 'menu:set-theme', 'menu:help', 'menu:move-tab', 'menu:reset-layout', 'menu:settings', 'menu:new-tab-type', 'menu:open-session-history', 'menu:open-file-changes', 'menu:open-sessions-search', 'menu:open-ideas']
    const handlers = actions.map((ch) => {
      const handler = (_: unknown, ...a: unknown[]) => callback(ch, ...a)
      ipcRenderer.on(ch, handler)
      return () => ipcRenderer.removeListener(ch, handler)
    })
    return () => handlers.forEach((h) => h())
  },

  createGroup: (name: string): Promise<{ id: string; name: string } | null> => invokeChannel('group:create', name),
  renameGroup: (id: string, newName: string): Promise<void> => invokeChannel('group:rename', id, newName),

  fileExists: (filePath: string): Promise<boolean> => invokeChannel('file:exists', filePath),
  fileType: (filePath: string): Promise<'file' | 'dir' | null> => invokeChannel('file:type', filePath),
  readFile: (filePath: string): Promise<string | null> => invokeChannel('file:read', filePath),
  readFileBinary: (filePath: string): Promise<string | null> => invokeChannel('file:read-binary', filePath),
  writeFile: (filePath: string, content: string): Promise<{ ok: boolean; error?: string }> => invokeChannel('file:write', filePath, content),
  openInVSCode: (filePath: string): Promise<{ ok: boolean; error?: string }> => invokeChannel('file:open-in-vscode', filePath),
  listRecentFiles: (dirPath: string, limit?: number): Promise<{ path: string; name: string; mtime: number; relative: string }[]> => invokeChannel('file:list-recent', dirPath, limit),
  listDir: (dirPath: string, limit?: number): Promise<DirEntry[]> => invokeChannel('file:list-dir', dirPath, limit),
  findFileBySuffix: (baseDir: string, partial: string, limit?: number): Promise<string[]> => invokeChannel('file:find-by-suffix', baseDir, partial, limit),
  listAbilities: (): Promise<AbilitiesResult> => invokeChannel('abilities:list'),
  manageAbility: (req: AbilitiesManageRequest): Promise<AbilitiesManageResult> => invokeChannel('abilities:manage', req),
  watchFile: (filePath: string): void => sendChannel('file:watch', filePath),
  unwatchFile: (filePath: string): void => sendChannel('file:unwatch', filePath),
  onFileChanged: (callback: (filePath: string) => void): (() => void) => onChannel('file:changed', callback),

  runAction: (action: 'open-url' | 'open-vscode' | 'dev-tools', ...args: string[]): void => sendChannel('action:run', action, ...args),

  // Clipboard via the main-process Electron module — works in the packaged file:// build where
  // navigator.clipboard is gated. See core/types/ipc-contracts.ts.
  writeClipboard: (text: string): Promise<void> => invokeChannel('clipboard:write-text', text),
  readClipboard: (): Promise<string> => invokeChannel('clipboard:read-text'),
  debugReadClipboard: (): Promise<string> => invokeChannel('clipboard:debug-read'),

  loadNotes: (panelId: string): Promise<string[]> => invokeChannel('notes:load', panelId),
  saveNotes: (panelId: string, entries: string[]): Promise<void> => invokeChannel('notes:save', panelId, entries),

  loadIdeas: (windowId: string): Promise<Idea[]> => invokeChannel('ideas:load', windowId),
  saveIdeas: (windowId: string, ideas: Idea[]): Promise<{ ok: boolean; error?: string }> => invokeChannel('ideas:save', windowId, ideas),

  onGroupColorChanged: (callback: (color: string) => void): (() => void) => onChannel('group:color-changed', callback),
  onGroupNameChanged: (callback: (name: string) => void): (() => void) => onChannel('group:name-changed', callback),
  onError: (callback: (source: string, message: string) => void): (() => void) => onChannel('error:log', callback),
  onOpenTab: (callback: (id: string, meta: OpenTabMeta) => void): (() => void) => onChannel('screen:open-tab', callback),

  listAgents: (): Promise<AgentMeta[]> => invokeChannel('agents:list'),
  resolveAgentForSession: (sessionId: string): Promise<AgentId | null> => invokeChannel('agents:resolve-for-session', sessionId),

  searchSessions: (projectDir: string, query: string): Promise<SessionSearchMatch[]> => invokeChannel('sessions:search', projectDir, query),
  searchSessionsAll: (query: string): Promise<SessionSearchMatch[]> => invokeChannel('sessions:search-all', query) as Promise<SessionSearchMatch[]>,
  searchAllSessions: (query: string): Promise<(SessionSearchMatch & { projectDir: string })[]> => invokeChannel('sessions:search-all', query),
  listSessions: (projectDir: string): Promise<SessionInfo[]> => invokeChannel('sessions:list', projectDir),
  getSessionEditFlags: (projectDir: string): Promise<Record<string, boolean>> => invokeChannel('sessions:edit-flags', projectDir),
  loadSession: (projectDir: string, sessionId: string): Promise<SessionMessage[]> => invokeChannel('sessions:load', projectDir, sessionId),
  openSessionInTab: (projectDir: string, sessionId: string, fork?: boolean): Promise<boolean> => invokeChannel('sessions:open-in-tab', projectDir, sessionId, fork),
  renameSession: (projectDir: string, sessionId: string, name: string): Promise<SessionRenameResult> => invokeChannel('sessions:rename', projectDir, sessionId, name),
  openCommitDialog: (vcs: CommitVcsRequest, projectDir: string, opts?: CommitOptions): Promise<CommitResult> => invokeChannel('commit:open-dialog', vcs, projectDir, opts),
  detectCommitVcs: (projectDir: string): Promise<{ git: boolean; svn: boolean; hg: boolean }> => invokeChannel('commit:detect-vcs', projectDir),
  openCommitLog: (vcs: 'git' | 'svn' | 'hg', projectDir: string): Promise<{ ok: boolean; error?: string }> => invokeChannel('commit:open-log', vcs, projectDir),

  getSessionModel: (projectDir: string, sessionId?: string): Promise<SessionModelInfo | null> => invokeChannel('session-model:get', projectDir, sessionId),
  getSessionChanges: (projectDir: string, sessionId?: string): Promise<TurnInfo[]> => invokeChannel('session-changes:get', projectDir, sessionId),
  locateRegion: (filePath: string, afterText: string): Promise<number | null> => invokeChannel('session-changes:locate-region', filePath, afterText),
  getFileDiffOptions: (filePath: string, projectDir?: string | null, sessionId?: string | null): Promise<DiffOptions> => invokeChannel('file-diff:list-options', filePath, projectDir ?? null, sessionId ?? null),
  getFileDiffBaseline: (filePath: string, mode: DiffMode, projectDir?: string | null, sessionId?: string | null): Promise<DiffBaseline> => invokeChannel('file-diff:get-baseline', filePath, mode, projectDir ?? null, sessionId ?? null),
  getAppVersion: (): Promise<string> => invokeChannel('app:version'),
  getAppPaths: (): Promise<AppPathsInfo> => invokeChannel('app:paths'),
  getUsage: (): Promise<UsageCache | null> => invokeChannel('usage:get'),
  getUsageCredentials: (): Promise<{ orgId: string; hasSessionKey: boolean }> => invokeChannel('usage:get-credentials'),
  setUsageCredentials: (orgId: string, sessionKey: string): Promise<{ ok: boolean; error?: string }> => invokeChannel('usage:set-credentials', orgId, sessionKey),
  generateStats: (force?: boolean): Promise<{ ok: boolean; htmlPath?: string; error?: string }> => invokeChannel('stats:generate', force),
  getStatsData: (force?: boolean): Promise<StatsDataResult> => invokeChannel('stats:data', force),
  onUsageUpdate: (callback: (cache: UsageCache) => void): (() => void) => onChannel('usage:update', callback),

  // ── Remote App Control ──
  getRemoteConfig: (): Promise<RemoteControlData> => invokeChannel('remote:get-config'),
  getRemoteBindState: (): Promise<{ enabled: boolean; bound: boolean; port: number }> => invokeChannel('remote:get-bind-state'),
  getSelfName: (): Promise<string> => invokeChannel('remote:self-name'),
  saveRemoteConfig: (data: RemoteControlData): Promise<{ ok: boolean; error?: string }> => invokeChannel('remote:save-config', data),
  getLocalIps: (): Promise<{ hostname: string; ips: string[] }> => invokeChannel('remote:local-ips'),
  remoteProbe: (peer: RemotePeer): Promise<PeerProbeResult> => invokeChannel('remote:probe', peer),
  remoteWindows: (peer: RemotePeer): Promise<{ ok: boolean; windows?: RemoteWindowInfo[]; error?: string }> => invokeChannel('remote:windows', peer),
  remoteOpenTab: (peer: RemotePeer, req: OpenTabReq): Promise<{ ok: boolean; error?: string }> => invokeChannel('remote:open-tab', peer, req),
  remoteCloseTab: (peer: RemotePeer, terminalId: string): Promise<{ ok: boolean; error?: string }> => invokeChannel('remote:close-tab', peer, terminalId),
  remoteLaunchApp: (peer: RemotePeer): Promise<{ ok: boolean; error?: string }> => invokeChannel('remote:launch-app', peer),
  remoteOp: (peer: RemotePeer, name: string, args?: unknown[]): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> => invokeChannel('remote:op', peer, name, args),
  remoteStreamOpen: (peer: RemotePeer, terminalId: string, streamId: string): Promise<{ ok: boolean; error?: string }> => invokeChannel('remote:stream-open', peer, terminalId, streamId),
  remoteStreamSendKeys: (streamId: string, data: string): void => sendChannel('remote:stream-send-keys', streamId, data),
  remoteStreamClose: (streamId: string): void => sendChannel('remote:stream-close', streamId),
  onRemoteStreamFrame: (callback: (streamId: string, msg: WsServerMsg) => void): (() => void) => onChannel('remote:stream-frame', callback),
  onControlOpenTab: (callback: (payload: ControlOpenTabPayload) => void): (() => void) => onChannel('control:open-tab', callback),
  onControlCloseTab: (callback: (payload: { terminalId: string }) => void): (() => void) => onChannel('control:close-tab', callback),
  onRemoteSessionActive: (callback: (info: { active: boolean; peerLabel: string; lastActionTs: number }) => void): (() => void) => onChannel('remote:session-active', callback),
  onRemoteActivity: (callback: (entry: { ts: number; side: 'controller' | 'controlled'; via: 'human' | 'ai'; machine: string; action?: string; phase?: string; target?: string; payload?: string; corrId?: string; scenario?: string; message: string }) => void): (() => void) => onChannel('remote:activity', callback),
  pushTabs: (tabs: RemoteTabInfo[]): void => sendChannel('tabs:push', tabs),
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type ElectronAPI = typeof api
