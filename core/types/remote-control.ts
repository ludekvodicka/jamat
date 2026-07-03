/**
 * Remote App Control — wire protocol + persisted config.
 *
 * Pure types + a few const tables (the closed-by-default `CONTROL_OPS` allowlist).
 * Shared across the Electron main process (op-server + client), the renderer (Remote
 * connections panel), and the standalone agent (launch endpoint). No electron / fs
 * imports — `core/` is the zero-dep boundary.
 *
 * Threat model lives in `docs/architecture/remote-app-control.md`. In short:
 * this is token-gated remote command injection over the LAN, opt-in and
 * closed-by-default.
 */

/**
 * The op-server's LAN listen ports — distinct from its always-on localhost listener
 * (`47100`/`47101`, which serves /debug + /jamat + /op). The LAN listener carries the
 * remote-control surface (the 7 control ops + WS + debug ops), gated by the one machine key.
 */
export const CONTROL_PORT_PACKAGED = 47200
export const CONTROL_PORT_DEV = 47201

/** Editable range for a custom control listen port (change it to run a second instance on the
 *  same machine). Floor at 1024 to stay out of the privileged range that needs elevation to bind. */
export const CONTROL_PORT_MIN = 1024
export const CONTROL_PORT_MAX = 65535
export function isValidControlPort(p: unknown): p is number {
  return Number.isInteger(p) && (p as number) >= CONTROL_PORT_MIN && (p as number) <= CONTROL_PORT_MAX
}

/** Default agent port (the always-on `app-agent`). */
export const DEFAULT_AGENT_PORT = 3501

/** Minimum acceptable token length (hex chars). A weaker token is regenerated. */
export const MIN_TOKEN_LEN = 32

/**
 * Wire-compatibility version of the remote-control surface. The op-server advertises it in
 * `/control/health`; a controller compares the peer's value against its own and refuses to
 * drive a peer whose protocol differs — or is ABSENT, as in a legacy v1
 * build, which predates this field. Bump on any breaking change to the control wire protocol.
 */
export const REMOTE_PROTOCOL = 2

/** Stable app identity advertised in `/control/health` — a human label for the peer's build family. */
export const APP_ID = 'jamat'

/** A configured remote peer — another machine running the control-server. */
export interface RemotePeer {
  /** Stable local id (list key); generated, not the peer's identity. */
  id: string
  /** Display name. */
  name: string
  /** Hostname or IP (prefer hostname — DHCP drift). */
  host: string
  /** The peer's Electron control-server port. */
  controlPort: number
  /** The peer's agent port (launch-when-closed). */
  agentPort: number
  /** The peer's machine token (the peer generated it; you paste it here). The AI
   * bridge reaches the peer with THIS token (proxied by the controller's local
   * gateway) — there is no separate per-peer AI key. */
  token: string
  /** Peer's MAC for Wake-on-LAN (optional; enables waking it when `offline`). */
  mac?: string
  /**
   * Reachable `app-wol` proxy base URL used to wake this peer, e.g.
   * `http://<host>:9009`. The proxy must live on an always-on device on the
   * peer's LAN (the peer itself is asleep). Optional — wake is best-effort.
   */
  wolProxyUrl?: string
}

/**
 * Persisted per-machine config: `<userData>/remote-control.json`.
 *
 * `listenPort` is THIS machine's control-server port; a peer's port lives on
 * `RemotePeer.controlPort` — two distinct concepts, deliberately named apart.
 */
export interface RemoteControlData {
  /** Master opt-in. False → control-server never binds AND the agent refuses launch. */
  enabled: boolean
  /**
   * This machine's single key (>= MIN_TOKEN_LEN hex, auto-generated). It gates the WHOLE
   * op-server surface: the LAN control listener (peers present it for remote control) AND
   * the localhost gateway (the jamat CLI presents it to `127.0.0.1/jamat` + `/op`).
   * V2 unified the old `token` + `aiToken` into this one key — there is no separate AI key.
   */
  token: string
  /** This machine's control-server listen port. */
  listenPort: number
  /**
   * This machine's own short name (e.g. `pc1`), used as the `<machine>` prefix of a tab's
   * instance id (`<machine>:<folder>-<rand>`). It must match the name OTHER machines gave this
   * one in their `peers` list, so an instance id copied here resolves there. Auto-seeded from the
   * short lowercase hostname on first load; overridable.
   */
  selfName?: string
  /** Peers this machine can connect TO. */
  peers: RemotePeer[]
  /**
   * Default working directory for an Jamat `--scratch` Claude session and the
   * `.jamat-tasks/` file-drop dir. Unset → falls back to this machine's home dir.
   * Lets a remote AI spin up a Claude session here without the caller knowing this
   * machine's project layout.
   */
  bridgeScratchDir?: string
}

/** Claude turn-indicator state mirrored from the renderer. `waiting` = turn paused on a
 *  question menu (AskUserQuestion / plan approval) and needs the user to choose. */
export type TabStatus = 'idle' | 'running' | 'tool-use' | 'blocked' | 'waiting' | 'done'

/**
 * A tab as seen by a remote viewer. `terminalId` === the dockview panel id;
 * for terminal tabs it also keys the PTY/ring buffer. Non-terminal panels
 * appear in the tree with `streamable: false` (no content/control).
 */
export interface RemoteTabInfo {
  terminalId: string
  title: string
  /** 'terminal' for PTY-backed tabs, else the panel component type. */
  type: string
  status?: TabStatus
  /** True when a live/buffered PTY stream is available for this tab. */
  streamable: boolean
  /** The terminal's resolved spawn (launch) cwd, for terminal tabs. Absent for
   *  non-terminal panels / when unknown. Lets a caller open a new session in the
   *  same dir (`open --same-as <terminalId>`). Launch dir, not live `cd`-tracked. */
  cwd?: string
  /** The Claude session id this terminal is running (explicit or pid-resolved), when known.
   *  A UI HINT only — present iff this is a forkable Claude session, so a controller shows the
   *  "fork" affordance on Claude tabs but not shell tabs. The fork itself is re-resolved
   *  server-side from the terminalId (`OpenTabReq.forkOf`); the wire value is never trusted. */
  sessionId?: string
  /** The tab's stable, copyable instance id (`<machine>:<folder>-<rand>`), minted lazily when the
   *  human picks "Copy instance id". Carried from the renderer's tab params; lets a second LLM
   *  address this exact tab across restart/close via `control:resolve-instance`. Absent until copied. */
  instanceId?: string
}

export interface RemoteWindowInfo {
  /** Electron webContents id (stable per window for the session). */
  windowId: number
  title: string
  tabs: RemoteTabInfo[]
}

/**
 * Reachability classification for a peer. `unauthorized` = the control server IS up and answered,
 * but rejected our credentials (a 401/403 — almost always a wrong `token`; edge case: the peer's
 * host-allowlist). Distinct from `agent-only` ("app closed") so a bad token doesn't masquerade as a
 * closed app.
 */
export type PeerReachability = 'offline' | 'agent-only' | 'app-up' | 'unauthorized'

export interface PeerProbeResult {
  reachability: PeerReachability
  /** Present when app-up (from the control-server health response). */
  hostname?: string
  /** The peer's app version (`YYYY.MM.DD.HH.mm`), from the health response when app-up.
   *  Lets the UI show which build a peer runs (and confirm a new version is deployed). */
  version?: string
  /** App identity from the health response (`APP_ID`). Absent → a legacy/foreign build. */
  app?: string
  /** The peer's remote-control wire protocol (`REMOTE_PROTOCOL`). Absent → legacy build
   *  (e.g. a legacy v1 build, which predates this field). */
  protocol?: number
  /** True iff the peer is app-up AND its `protocol` matches ours — i.e. we can actually drive it.
   *  False for a reachable-but-incompatible peer (the UI shows "non-compatible version"). */
  compatible?: boolean
  error?: string
}

/** open-tab request from a remote peer (over the wire). */
export interface OpenTabReq {
  tabType: 'claude' | 'cmd' | 'powershell'
  /** Category label, resolved against the controlled machine's config. */
  category?: string
  /** Project folder name within the category. */
  project?: string
  /** Initial command typed into the new tab once it's promptable. */
  command?: string
  /**
   * Caller-chosen dockview panel id for the new tab. The controlled side uses it
   * as the new tab's id, so the caller can open a viewer for it immediately
   * (no round-trip to learn the id). Validated server-side (charset + length).
   */
  terminalId?: string
  /** Which controlled window to open the tab in (webContents.id). Default: focused/first. */
  windowId?: number
  /** Open in this machine's configured bridge scratch dir (or home) instead of a
   *  category/project — for "any Claude instance will do" delegations. Overrides
   *  category/project when set. */
  scratch?: boolean
  /** Open in the SAME dir as an EXISTING terminal on this machine: the server
   *  resolves the cwd from that terminal's stored launch cwd (the caller passes a
   *  terminalId it can already address, NEVER a raw path — preserving the
   *  no-attacker-supplied-path rule). Overrides category/project/scratch when set;
   *  errors if that terminal is unknown / has no cwd. */
  sameAs?: string
  /** FORK an EXISTING Claude terminal on this machine: the server resolves BOTH the
   *  session id AND the cwd from that terminal server-side (same caller-passes-a-terminalId,
   *  never-a-raw-id/path discipline as `sameAs`), then opens a `--fork-session` branch — a new
   *  session id loading the parent's history, parent untouched. Forces `tabType:'claude'`;
   *  overrides category/project/scratch/sameAs. Errors if the terminal is unknown / not a
   *  running Claude session. */
  forkOf?: string
  /** Human-readable purpose for an AI-opened tab (e.g. a short task summary). Becomes the
   *  tab's display name on the controlled machine so a human can see WHAT the AI is doing
   *  there — instead of the generic "scratch". Display-only; server-sanitized + truncated. */
  label?: string
  /** Whether to ACTIVATE (focus) the new tab on the controlled machine. `false` → open it
   *  silently, leaving whatever tab was active there still active (no focus steal). Absent /
   *  `true` → activate it (legacy behavior). The UI lets the human choose; the AI always
   *  sends `false` so a delegated/bridge open never yanks focus from the person at the peer. */
  activate?: boolean
}

/**
 * What the control-server hands the renderer after resolving + validating an
 * `OpenTabReq` server-side. `cwd` is an absolute, validated path (resolved from
 * category+project against the controlled machine's config) — the renderer
 * never resolves an attacker-supplied path itself.
 */
export interface ControlOpenTabPayload {
  tabType: 'claude' | 'cmd' | 'powershell'
  /** Resolved, validated working directory. Absent → default cwd. */
  cwd?: string
  /** Project folder name, for the tab title. */
  folderName?: string
  /** Initial command typed in once the tab is promptable. */
  command?: string
  /** Caller-chosen dockview panel id to use for the new tab (validated server-side). */
  terminalId?: string
  /** When `'resume-fork'` (a `forkOf` request), the controlled renderer launches a
   *  `--fork-session` branch of `sessionId` in `cwd` instead of a fresh Claude tab. */
  cmd?: 'resume-fork'
  /** The parent session id to fork — server-resolved from the `forkOf` terminal. Only set
   *  alongside `cmd:'resume-fork'`. */
  sessionId?: string
  /** Activate (focus) the new tab on the controlled machine. `false` → open silently, keeping
   *  the currently-active tab active (the renderer adds the panel `inactive`). Absent/`true` →
   *  activate (legacy). Mirrors `OpenTabReq.activate`. */
  activate?: boolean
}

// ── WebSocket message protocol (control-server ⇄ client) ──

/** Frames the server pushes to a subscribed client. */
export type WsServerMsg =
  | { type: 'snapshot'; data: string; cols: number; rows: number; alive: boolean; seq: number }
  | { type: 'data'; delta: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'exit' }
  | { type: 'error'; message: string }

/** Frames a client sends to the server. */
export type WsClientMsg =
  | { type: 'subscribe'; terminalId: string }
  | { type: 'keys'; data: string }

/**
 * Closed-by-default operation allowlist for the LAN control surface (the discipline that killed the
 * generic `/debug/ipc-call` RCE — never a generic dispatcher). The op-server's `/control/*` routes
 * expose ONLY these named ops; in V2 they are also registry ops with reach `'remote'`. `ro` = read,
 * `rw` = mutates / injects into a PTY. `rw` IS exposed in packaged builds (write access is the whole
 * point) — but only under the machine key + Host/Origin gate.
 */
export const CONTROL_OPS = {
  windows: 'ro',
  scrollback: 'ro',
  // Resolve a copyable tab instance id (`<machine>:<folder>-<rand>`) to the tab's CURRENT live
  // terminalId (+ sessionId/cwd/status) so a second LLM can address a specific tab that survived a
  // close/restart. Read-only: it only reveals the handle; injection still goes through write-keys.
  'resolve-instance': 'ro',
  'write-keys': 'rw',
  'open-tab': 'rw',
  'close-tab': 'rw',
  // Drops a task FILE on this machine (scoped to <scratch>/.jamat-tasks/) so the
  // Jamat can delegate a large task by reference instead of injecting >4 KB of
  // keystrokes. Server owns the path; the caller only supplies corrId + text.
  'put-task': 'rw',
  // Reads a remote answer FILE (<scratch>/.jamat-tasks/<corrId>.answer.md) if the
  // delegated remote chose to answer via file instead of the terminal markers — a
  // robust answer channel alongside scrollback-marker scanning + issue comments.
  'get-answer': 'ro',
} as const
export type ControlOp = keyof typeof CONTROL_OPS

/**
 * The ops the Jamat may drive through the local gateway — the SAME set a
 * human can perform via the UI: read (`windows`/`scrollback`), inject
 * (`write-keys`), and tab lifecycle (`open-tab`/`close-tab`). Op-scoping is
 * **structural**, not a runtime filter: the gateway exposes only named routes
 * (no generic dispatcher) and every AI-driven peer call carries the `X-Jamat`
 * marker so the controlled side logs/audits it. Surfaced in `GET /jamat/help`.
 */
export const AI_KEY_OPS: readonly ControlOp[] = ['windows', 'scrollback', 'resolve-instance', 'write-keys', 'open-tab', 'close-tab', 'put-task', 'get-answer']

/**
 * One entry in the **unified Remote Activity Log** — every *discrete*
 * remote-control action, whether driven by a human (via the UI) or the AI (via
 * the bridge), on either side. Replaces the old split between `RemoteAuditEntry`
 * (controlled-side, human-or-AI, never surfaced) and the AI-only bridge-log
 * record. High-frequency machinery (health/windows polling, per-frame WS stream,
 * per-keystroke live typing) is deliberately NOT logged — see the controller /
 * controlled emit sites for the exact action allowlist.
 */
export interface RemoteActivityEntry {
  ts: number
  /** `controller` = THIS machine initiated the action; `controlled` = a remote
   *  party (human or AI) acted on us. */
  side: 'controller' | 'controlled'
  /** Who drove it. */
  via: 'human' | 'ai'
  /** The OTHER machine: the peer we acted on (controller side) / the calling
   *  party (controlled side). Human-readable label, falls back to IP. */
  machine: string
  /** The control action when this records a discrete op (`write-keys`,
   *  `open-tab`, `close-tab`, `scrollback`, `view-start`, `view-stop`). Absent
   *  for Jamat progress phases. Presence of `action` = this entry is
   *  persisted to the durable JSONL audit. */
  action?: string
  /** Jamat progress phase (`info`/`preflight`/`await`/…), when applicable. */
  phase?: string
  /** Terminal/tab the action targets, when applicable. */
  target?: string
  /**
   * Actual bytes for `rw` ops — kept LOCAL for forensics, never echoed back
   * over the network. Truncated to a sane length.
   */
  payload?: string
  /** Jamat correlation id — joins a controller trigger to the controlled record. */
  corrId?: string
  /** Jamat scenario id, when applicable. */
  scenario?: string
  /** Human-readable line for the live log (always present). */
  message: string
}
