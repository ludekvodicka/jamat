// Facade: re-exports all types from focused files.
// Import from here for convenience, or from specific files for precision.

export { SESSION_ID_RE, DEFAULT_AGENT_ID, isAgentId } from './types/contracts.js'
export type { MenuSelection, LaunchMode, LaunchConfig, LaunchCommand, AgentId } from './types/contracts.js'

export type { VirtualFolderDef, CategoryJson, Category, AppConfig, ConfigPatch, SelfUpdateConfig, SessionDonePrompt, CustomMenuNode, CustomRun, ContextWarnLevel, FolderStats, StatsMap } from './types/config.js'

export type { SessionInfo, LatestSessionMeta, SessionModelInfo, UsageCache, EditStep, FileTurnEdit, TurnInfo } from './types/session.js'

export { SEARCH_ITEM, SEPARATOR_ITEM, CROSS_FOLDER_THRESHOLD } from './types/state.js'
export type { SubmenuType, MenuItem, MenuEntry, SeparatorItem, CrossFolderItem, SessionPickerItem, RenderLayout, MenuState } from './types/state.js'

export type { ProjectEntry, SortMode, DisplayEntry } from './menu-core/pure.js'

export {
  CONTROL_PORT_PACKAGED,
  CONTROL_PORT_DEV,
  DEFAULT_AGENT_PORT,
  MIN_TOKEN_LEN,
  CONTROL_OPS,
} from './types/remote-control.js'
export type {
  RemotePeer,
  RemoteControlData,
  RemoteTabInfo,
  RemoteWindowInfo,
  TabStatus,
  PeerReachability,
  PeerProbeResult,
  OpenTabReq,
  ControlOpenTabPayload,
  WsServerMsg,
  WsClientMsg,
  ControlOp,
  RemoteActivityEntry,
} from './types/remote-control.js'

export type {
  BaselineSource,
  VcsRepoInfo,
  VcsDetection,
  BaselineFetch,
  DiffMode,
  DiffGroup,
  DiffOption,
  DiffOptions,
  DiffBaseline,
  SessionPoint,
  SessionBaselineResult,
} from './types/file-diff.js'
