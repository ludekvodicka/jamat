/**
 * Screen Executor — manages the menu→claude→menu lifecycle per terminal panel.
 *
 * State machine per terminal:
 *   MENU (runs menu.ts) → user selects → RUNNING (runs claude)
 *   RUNNING (claude)    → claude exits  → MENU (respawn menu)
 *   MENU                → user quits    → CLOSED (no selection file)
 */
import { readFileSync, unlinkSync, existsSync, statSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { exec } from 'child_process'
import { app } from 'electron'
import { getWebContents } from './electron-utils'
import { createPty, destroyPty, getPtyPid } from './pty-manager'
import { getMonorepoRoot } from './app-root'
import { getJamatPaths } from './jamat-paths'
import { logInfo } from './logger'
import { publish, publishTo } from './streams'
import { shellWrapArgv } from '../../../core/platform-shell.js'
import { buildDockerRunArgs, syncDockerCredentials } from '../../../core/executor/docker-utils.js'
import { buildLaunchCommand } from '../../../core/executor/agent-launcher.js'
import { resolveAgentPreLaunch } from '../../../core/executor/pre-launch.js'
import { getAppConfig } from './ipc-windows'
import { getAgent } from '../../../core/agents/index.js'
import type { AgentAdapter } from '../../../core/agents/types.js'
import { DEFAULT_AGENT_ID } from '../../../core/types/contracts.js'
import type { AgentId, MenuSelection } from '../../../core/types.js'
import type { ScreenOpenTabMeta } from '../../../core/types/ipc-contracts.js'

interface TerminalState {
  phase: 'menu' | 'running' | 'closed'
  webContentsId: number
  selectionFile: string
  menuDir: string
  menuConfig: string
  cols: number
  rows: number
  meta?: MenuSelection
  /**
   * Last tab title we pushed for this terminal. Lets the title poller send
   * `screen:title` only on an actual change (and never downgrade a custom
   * title back to the `folderName - Agent` default once it's been set).
   */
  lastTitle?: string
  /**
   * The sessionId discovered via process ancestry for a terminal launched
   * without one (`--continue`/`ccc`). Cached so the pid lookup runs only until
   * it succeeds. Cleared whenever the terminal (re)starts an agent.
   */
  resolvedSessionId?: string
  /**
   * Epoch ms when the agent PTY was spawned. Used by the no-pid session resolver
   * (Codex) to find the rollout this launch created (mtime ≥ launchedAtMs), so a
   * new session / fork resolves to its OWN id. Set at spawn; cleared on (re)start.
   */
  launchedAtMs?: number
  /** fs.watch on the session's PROJECT DIR — fires applyTitle the instant the
   *  session's `<id>.jsonl` is created or appended (so the FIRST `/rename`,
   *  which creates the transcript, is caught too — not just later appends). */
  titleWatcher?: FSWatcher
  /** Directory the titleWatcher is watching (re-arm only when it changes). */
  watchedTitleDir?: string
  /** The session's transcript filename — watch events for other files are ignored. */
  watchedTitleBase?: string
  /** Debounce timer coalescing the burst of watch events per JSONL write. */
  titleWatchTimer?: ReturnType<typeof setTimeout>
}

const terminals = new Map<string, TerminalState>()

// Per-terminal crash retry counter. Cap: 3 crashes in a 5-minute window.
// On the 4th crash the banner replaces "Resume" with a permanent
// "too many crashes" state until the user closes the tab or the
// window elapses.
interface CrashCounter {
  count: number
  firstAttempt: number
}
const CRASH_WINDOW_MS = 5 * 60 * 1000
const CRASH_CAP = 3
const crashCounters = new Map<string, CrashCounter>()

function bumpCrashCounter(terminalId: string): { count: number; canResume: boolean } {
  const now = Date.now()
  const entry = crashCounters.get(terminalId)
  if (!entry || now - entry.firstAttempt > CRASH_WINDOW_MS) {
    crashCounters.set(terminalId, { count: 1, firstAttempt: now })
    return { count: 1, canResume: true }
  }
  entry.count += 1
  return { count: entry.count, canResume: entry.count <= CRASH_CAP }
}

function resetCrashCounter(terminalId: string): void {
  crashCounters.delete(terminalId)
}

function getDockerContextDir(): string {
  return join(getMonorepoRoot(), 'dockerized-claude')
}

function tryGetAgent(id: AgentId | undefined): AgentAdapter | null {
  try { return getAgent(id ?? DEFAULT_AGENT_ID) } catch { return null }
}

/**
 * STRICT resolve of a sessionId to its transcript file — exactly that session's
 * `<id>.jsonl` or null. Crucially NOT `resolveActiveSessionFile`, whose
 * "newest active session" fallback returns a DIFFERENT session's file when the
 * target has no transcript yet (a brand-new session before its first write) —
 * which leaked a stranger's custom title (e.g. showing "test2" on a fresh tab).
 */
function sessionFileFor(adapter: AgentAdapter | null, dir: string, sessionId: string | undefined): string | null {
  if (!adapter || !sessionId) return null
  try {
    const projDir = adapter.findProjectDir(dir, homedir())
    if (!projDir) return null
    return adapter.resolveSessionFile(projDir, sessionId, homedir())
  } catch {
    return null
  }
}

/** The custom (renamed) title for a KNOWN sessionId, or null when never renamed
 *  / no transcript yet. Routed through the adapter (Codex returns null). */
function customTitleForSessionId(adapter: AgentAdapter | null, dir: string, sessionId: string | undefined): string | null {
  const file = sessionFileFor(adapter, dir, sessionId)
  if (!file || !adapter) return null
  try {
    const title = adapter.getSessionTitle(file)
    return title && title.trim() ? title.trim() : null
  } catch {
    return null
  }
}

/** The sessionId a terminal is actually running — explicit pick, else the one
 *  discovered by process ancestry (see kickSessionIdResolution).
 *
 *  `resume-fork` is special: it launches `claude -r <parent> --fork-session`, where
 *  `meta.sessionId` is the PARENT (needed only to build that command). Claude generates a
 *  BRAND-NEW id for the fork, which we don't know up front — so for an as-yet-unresolved fork
 *  we report NO id (so the pid resolver runs and discovers it, exactly like `--continue`).
 *  Once resolved we rewrite meta to `cmd:'resume' + <newId>`, after which this returns it
 *  via meta the normal way. Net effect: a fork tracks its OWN session — rename, title, and
 *  restore all target the fork, not the parent. */
function effectiveSessionId(state: TerminalState): string | undefined {
  // resume-fork (sessionId is the PARENT) OR a resume carrying a forkParentId (its launcher
  // RE-FORKS the parent when the saved fork id is gone → actual running id unknown up front)
  // must both be resolved by pid, not trusted from meta.
  if (state.meta?.cmd === 'resume-fork' || state.meta?.forkParentId) return state.resolvedSessionId
  return state.meta?.sessionId || state.resolvedSessionId
}

/**
 * The Claude session id a RUNNING terminal is on — for Remote App Control's
 * `forkOf` resolution (server resolves a peer's terminalId → its session id, the
 * same caller-passes-an-id-not-a-value discipline as `getTerminalCwd`). Undefined
 * for a non-running phase or a terminal whose session id isn't known yet — a
 * `--continue` OR a `resume-fork` tab before pid resolution lands (a fork tracks its
 * OWN new id once discovered, never the parent; see effectiveSessionId).
 */
export function getTerminalSessionId(terminalId: string): string | undefined {
  const state = terminals.get(terminalId)
  if (!state || state.phase !== 'running') return undefined
  return effectiveSessionId(state)
}

function closeTitleWatch(state: TerminalState): void {
  if (state.titleWatchTimer) { clearTimeout(state.titleWatchTimer); state.titleWatchTimer = undefined }
  try { state.titleWatcher?.close() } catch { /* already closed */ }
  state.titleWatcher = undefined
  state.watchedTitleDir = undefined
  state.watchedTitleBase = undefined
}

/**
 * Watch the session's PROJECT DIR (which exists even before the session's own
 * transcript does) and react only to `<id>.jsonl` events. This catches the
 * FIRST `/rename` — which CREATES the transcript — instantly, not just later
 * appends to an existing file; that was the source of the poll-length delay on
 * a fresh session. Debounced because each write fires several fs events;
 * re-arms only when dir/base change.
 */
function ensureTitleWatch(terminalId: string, state: TerminalState, dir: string, base: string): void {
  if (state.watchedTitleDir === dir && state.watchedTitleBase === base && state.titleWatcher) return
  closeTitleWatch(state)
  state.watchedTitleDir = dir
  state.watchedTitleBase = base
  try {
    const w = watch(dir, { persistent: false }, (_event, filename) => {
      // `filename` is reliably provided on Windows; ignore other sessions'
      // transcripts. When absent (rare), fall through and re-check.
      if (filename && filename !== base) return
      if (state.titleWatchTimer) clearTimeout(state.titleWatchTimer)
      state.titleWatchTimer = setTimeout(() => applyTitle(terminalId, state), 100)
    })
    w.on('error', () => { /* dir vanished / fs hiccup — poller remains the backstop */ })
    state.titleWatcher = w
  } catch { /* watch unsupported for this path — poller remains the backstop */ }
}

/**
 * Compose + push the tab title for one terminal when its session has a custom
 * name ("folderName - <name>"). Never downgrades to the default: custom-title
 * records are append-only, so a once-seen name never legitimately disappears.
 */
function applyTitle(terminalId: string, state: TerminalState): void {
  if (!state.meta) return
  const id = effectiveSessionId(state)
  if (!id) return
  const adapter = tryGetAgent(state.meta.agent)
  if (!adapter) return
  let projDir: string | null = null
  try { projDir = adapter.findProjectDir(state.meta.dir, homedir()) } catch { /* unresolved */ }
  if (!projDir) return
  // Arm the watcher as soon as the sessionId is known — before the transcript
  // exists — so the rename that creates it is caught without a poll wait.
  ensureTitleWatch(terminalId, state, projDir, `${id}.jsonl`)
  let file: string | null = null
  try { file = adapter.resolveSessionFile(projDir, id, homedir()) } catch { /* none */ }
  if (!file) return
  const t = adapter.getSessionTitle(file)
  const custom = t && t.trim() ? t.trim() : null
  if (!custom) return
  const title = `${state.meta.folderName} - ${custom}`
  if (title === state.lastTitle) return
  state.lastTitle = title
  logInfo('title-resolve', `term=${terminalId} title -> ${JSON.stringify(title)}`)
  const wc = getWebContents(state.webContentsId)
  if (wc && !wc.isDestroyed()) publishTo(wc, 'screen:title', terminalId, title)
}

// ── Map a `--continue`/`ccc` terminal to its real session by pid ─────────────
// Such a terminal has no sessionId up front; the only reliable link is process
// ancestry — the agent's pid (recorded in listActivePids) is a descendant of
// the terminal's pty pid. We snapshot the process table ONCE (async, off the UI
// thread) per resolution pass, match, cache the result, and tell the renderer
// the real sessionId so per-session actions (Rename, etc.) target the right
// transcript.
let resolveInFlight = false

function withProcessParentMap(cb: (map: Map<number, number> | null) => void): void {
  // Win: CIM (not the removed `wmic`) — one CSV row per process "<pid>,<ppid>". POSIX: `ps` — one
  // whitespace-separated row per process. The unified parser handles both (split on space OR comma).
  const cmd = process.platform === 'win32'
    ? 'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | ForEach-Object { \\"$($_.ProcessId),$($_.ParentProcessId)\\" }"'
    : 'ps -eo pid=,ppid='
  exec(cmd, { timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
    if (err || !stdout) { logInfo('title-resolve', `process snapshot failed: ${err?.message ?? 'no stdout'}`); cb(null); return }
    const map = new Map<number, number>()
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/[\s,]+/)
      if (parts.length < 2) continue
      const pid = parseInt(parts[0], 10)
      const ppid = parseInt(parts[1], 10)
      if (!Number.isNaN(pid) && !Number.isNaN(ppid)) map.set(pid, ppid)
    }
    cb(map)
  })
}

function isDescendant(pid: number, ancestor: number, parent: Map<number, number>): boolean {
  let cur = pid
  for (let hops = 0; hops < 30; hops++) {
    const par = parent.get(cur)
    if (par === undefined || par === 0 || par === cur) return false
    if (par === ancestor) return true
    cur = par
  }
  return false
}

/**
 * Commit a resolved sessionId onto a terminal: track/retire the fork parent, rewrite meta to a
 * plain resume of the discovered id, and push the full param set to the renderer so Rename targets
 * this session and a restart reopens it (not whatever is newest). Shared by both resolution paths
 * — pid ancestry (Claude) and the launched-session lookup (Codex).
 */
function applyResolvedSession(terminalId: string, state: TerminalState, newSessionId: string): void {
  if (!state.meta) return
  // Track the fork PARENT so a fork that hasn't written a transcript can re-fork on restart.
  // Initial fork (`resume-fork`): the parent is the launch sessionId. Re-forked tab (a
  // `resume` whose saved fork id was gone → newId ≠ saved): keep the parent. Settled tab (saved
  // fork id actually resumed → newId === saved → it has a real transcript now): drop the parent.
  const prevMeta = state.meta
  const wasInitialFork = prevMeta.cmd === 'resume-fork'
  const resumedSaved = !wasInitialFork && newSessionId === prevMeta.sessionId
  const forkParentId = resumedSaved ? undefined : (wasInitialFork ? prevMeta.sessionId : prevMeta.forkParentId)
  state.resolvedSessionId = newSessionId
  // Rewrite meta to a plain resume of the discovered id. For `--continue`/`cc` this just fills in
  // the id; for a fork it retires the parent+fork launch so a respawn resumes `<newId>` instead of
  // forking AGAIN, while `forkParentId` keeps the re-fork safety net until the fork is settled.
  state.meta = { ...prevMeta, cmd: 'resume', sessionId: newSessionId, forkParentId }
  const sel = state.meta
  const wc = getWebContents(state.webContentsId)
  if (wc && !wc.isDestroyed()) {
    // `updateParameters` REPLACES the param object, so resend the full launch set with the
    // resolved sessionId + fork parent now filled in.
    publishTo(wc, 'screen:update-params', terminalId, {
      projectDir: sel.dir,
      cmd: 'resume',
      folderName: sel.folderName,
      antiFlicker: sel.antiFlicker,
      sessionId: newSessionId,
      forkParentId,
      agent: sel.agent,
    })
  }
  applyTitle(terminalId, state)
}

function kickSessionIdResolution(): void {
  const pending = [...terminals.entries()].filter(
    ([, s]) => s.phase === 'running' && s.meta && !effectiveSessionId(s),
  )
  if (pending.length === 0) return

  // No-pid agents (Codex): a just-launched tab (new session or fork) resolves its id via the
  // newest rollout for its cwd since launch — synchronous fs, no process snapshot. Split these
  // out so the async pid path below runs only for agents that actually track live pids.
  const pidPending: Array<[string, TerminalState]> = []
  for (const [terminalId, state] of pending) {
    if (!state.meta) continue
    const adapter = tryGetAgent(state.meta.agent)
    if (!adapter) continue
    if (adapter.capabilities.activePids) { pidPending.push([terminalId, state]); continue }
    let hit: { sessionId: string } | null = null
    try { hit = adapter.resolveLaunchedSession(state.meta.dir, homedir(), state.launchedAtMs ?? 0) } catch { hit = null }
    if (hit) applyResolvedSession(terminalId, state, hit.sessionId)
  }

  // Pid path (Claude): one process snapshot, matched by ancestry. Guarded so snapshots don't overlap.
  if (pidPending.length === 0 || resolveInFlight) return
  resolveInFlight = true
  withProcessParentMap((map) => {
    resolveInFlight = false
    if (!map) return
    for (const [terminalId, state] of pidPending) {
      // Re-check: the terminal may have exited or been resolved while the snapshot was running.
      if (state.phase !== 'running' || !state.meta || effectiveSessionId(state)) continue
      const ptyPid = getPtyPid(terminalId)
      if (!ptyPid) continue
      const adapter = tryGetAgent(state.meta.agent)
      if (!adapter) continue
      const active = adapter.listActivePids(homedir())
      const hit = active.find((a) => a.pid === ptyPid || isDescendant(a.pid, ptyPid, map))
      logInfo('title-resolve', `term=${terminalId} ptyPid=${ptyPid} activePids=${active.length} -> ${hit ? hit.sessionId : 'none'}`)
      if (!hit) continue
      applyResolvedSession(terminalId, state, hit.sessionId)
    }
  })
}

// ── Live tab-title sync ─────────────────────────────────────────────────────
// A `/rename` typed directly into the running TUI (or our rename modal, which
// writes the same record) only appends a `custom-title` line to the session
// JSONL — nothing else tells the tab. Poll running terminals and push
// `screen:title` on change. Lazy: starts with the first terminal, stops once
// none remain.
const TITLE_POLL_MS = 2500
let titlePoller: ReturnType<typeof setInterval> | null = null

function pollTitlesOnce(): void {
  for (const [terminalId, state] of terminals) {
    if (state.phase !== 'running' || !state.meta) continue
    applyTitle(terminalId, state)
  }
  // Discover the sessionId for `--continue` terminals that don't have one yet.
  kickSessionIdResolution()
}

function ensureTitlePoller(): void {
  if (titlePoller) return
  titlePoller = setInterval(pollTitlesOnce, TITLE_POLL_MS)
}

function maybeStopTitlePoller(): void {
  if (titlePoller && terminals.size === 0) {
    clearInterval(titlePoller)
    titlePoller = null
  }
}

/** Diagnostic snapshot of every tracked terminal — surfaced via
 *  GET /debug/screen-state so the tab-title pipeline can be inspected live. */
export function getScreenState(): Array<{
  terminalId: string
  phase: string
  metaSessionId: string | null
  forkParentId: string | null
  resolvedSessionId: string | null
  effectiveSessionId: string | null
  lastTitle: string | null
  folderName: string | null
  agent: string | null
  cmd: string | null
  ptyPid: number | null
}> {
  return [...terminals.entries()].map(([terminalId, s]) => ({
    terminalId,
    phase: s.phase,
    metaSessionId: s.meta?.sessionId ?? null,
    forkParentId: s.meta?.forkParentId ?? null,
    resolvedSessionId: s.resolvedSessionId ?? null,
    effectiveSessionId: effectiveSessionId(s) ?? null,
    lastTitle: s.lastTitle ?? null,
    folderName: s.meta?.folderName ?? null,
    agent: s.meta?.agent ?? null,
    cmd: s.meta?.cmd ?? null,
    ptyPid: getPtyPid(terminalId) ?? null,
  }))
}

function readSelection(filePath: string): MenuSelection | null {
  if (!existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, 'utf-8')
    unlinkSync(filePath)
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function spawnMenu(terminalId: string, state: TerminalState): void {
  // The menu TUI owns the PTY now — tell the renderer so it stops stealing F1/F2 (the menu binds
  // them to Search/Manage). Single choke point for EVERY menu entry: initial launch, Codex fallback,
  // and post-session return. The matching 'running' is published when an agent launches.
  const menuWc = getWebContents(state.webContentsId)
  if (menuWc && !menuWc.isDestroyed()) publishTo(menuWc, 'screen:phase', terminalId, 'menu')

  const configDir = getJamatPaths().configDir
  const menuArgs = ['--config', state.menuConfig, '--config-dir', configDir]
  // The menu TUI is hosted by system `node` in BOTH builds. Electron-as-Node can't host an
  // interactive TTY inside a Windows ConPTY — the GUI-subsystem Jamat.exe gets no console stdio
  // there, so the TUI renders nothing and exits immediately. Installed builds run the esbuild
  // .cjs bundle (no tsx / source tree needed); dev runs the TS source via tsx. node is a
  // documented prerequisite (README) and every Claude Code user already has it.
  // out/menu is asarUnpack'd (an external `node` can't read inside app.asar), so it lives in
  // app.asar.unpacked beside the archive. The replace is a no-op if asar is off (path stays app/).
  const menuRoot = app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
  const nodeArgs = app.isPackaged
    ? [join(menuRoot, 'out', 'menu', 'menu-tui.cjs'), ...menuArgs]
    : ['--import', 'tsx', 'menu-tui.ts', ...menuArgs]
  const wrapped = shellWrapArgv('node', nodeArgs)
  createPty(terminalId, state.webContentsId, {
    cols: state.cols,
    rows: state.rows,
    cwd: app.isPackaged ? homedir() : state.menuDir,
    command: wrapped.file,
    args: wrapped.args,
    env: {
      JAMAT: '1',
      JAMAT_MENU_SELECTION_FILE: state.selectionFile,
    },
    trusted: true,
    onExit: (info) => handleTerminalExit(terminalId, info)
  })
}

export function restoreClaudeInTerminal(
  terminalId: string,
  webContentsId: number,
  config: { cols: number; rows: number; menuDir: string; menuConfig: string },
  meta: ScreenOpenTabMeta,
  /** True when the user just activated this lazy tab — spawn immediately, bypassing the
   *  restore-stampede gate (a lone click never stampedes ~/.claude.json). */
  immediate = false
): void {
  const selectionFile = join(tmpdir(), `jamat-selection-${terminalId}.json`)

  const sel: MenuSelection = {
    dir: meta.projectDir,
    cmd: meta.cmd,
    folderName: meta.folderName,
    isolated: false,
    antiFlicker: meta.antiFlicker ?? false,
    sessionId: meta.sessionId,
    forkParentId: meta.forkParentId,
    agent: meta.agent ?? DEFAULT_AGENT_ID,
  }

  const state: TerminalState = {
    phase: 'menu',
    webContentsId,
    selectionFile,
    menuDir: config.menuDir,
    menuConfig: config.menuConfig,
    cols: config.cols,
    rows: config.rows
  }

  terminals.set(terminalId, state)
  ensureTitlePoller()
  startClaudeInTerminal(terminalId, state, sel, immediate)
}

export function startMenuInTerminal(
  terminalId: string,
  webContentsId: number,
  config: { cols: number; rows: number; menuDir: string; menuConfig: string }
): void {
  const selectionFile = join(tmpdir(), `jamat-selection-${terminalId}.json`)

  const state: TerminalState = {
    phase: 'menu',
    webContentsId,
    selectionFile,
    menuDir: config.menuDir,
    menuConfig: config.menuConfig,
    cols: config.cols,
    rows: config.rows
  }

  terminals.set(terminalId, state)
  ensureTitlePoller()
  spawnMenu(terminalId, state)
}

// ── Serialized agent launch (anti-stampede) ─────────────────────────────────
// A burst of restores — several windows, each reopening its tabs at once — would
// spawn many `claude` processes within the same instant. Each does a
// read-modify-write of ~/.claude.json on startup, and concurrent writers corrupt
// it (observed: a complete JSON document followed by another writer's leftover
// trailing bytes → "non-whitespace character after JSON"). Funnel every agent spawn
// through a queue so they start strictly one at a time.
//
// A fixed gap is NOT enough: `claude`'s config write happens at a variable delay after
// spawn (cmd.exe → node → CLI), and under restore-time load that delay easily exceeds any
// fixed gap, so two startups still overlap on the write. Instead, after spawning a claude we
// hold the next one until THIS one's ~/.claude.json write has actually landed (its mtime
// advances) — serializing on the real contended resource, not on a guessed duration. Bounded
// by a timeout so a launch that never writes (failed start / non-claude agent) can't wedge
// the queue. Non-claude launches just take a small floor gap.
const AGENT_LAUNCH_FLOOR_MS = 250
const CLAUDE_JSON_PATH = join(homedir(), '.claude.json')
const CONFIG_WRITE_TIMEOUT_MS = 7000
const CONFIG_SETTLE_MS = 300
let agentLaunchTail: Promise<void> = Promise.resolve()

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function claudeJsonMtimeMs(): number {
  try { return statSync(CLAUDE_JSON_PATH).mtimeMs } catch { return 0 }
}

/** Resolve once ~/.claude.json's mtime advances past `baseline` (the spawned claude finished
 *  its startup read-modify-write) or the timeout elapses — whichever comes first. */
async function waitForConfigWrite(baseline: number): Promise<void> {
  const deadline = Date.now() + CONFIG_WRITE_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(120)
    if (claudeJsonMtimeMs() > baseline) { await sleep(CONFIG_SETTLE_MS); return }
  }
}

function gateAgentLaunch(run: () => void, writesClaudeJson: boolean, immediate = false): void {
  // A user-initiated launch (clicking a not-yet-launched tab) spawns RIGHT NOW — it bypasses the
  // queue+hold entirely. The gate exists to throttle the restore STAMPEDE (many tabs reopening in
  // the same instant); a single human click is never a stampede, and shouldn't wait behind the
  // startup launches still draining their up-to-7s config-write holds. (graceful-exit + the startup
  // ~/.claude.json repair cover the rare overlap with an in-flight restore launch.)
  if (immediate) { run(); return }
  agentLaunchTail = agentLaunchTail
    .then(async () => {
      const baseline = writesClaudeJson ? claudeJsonMtimeMs() : 0
      run()
      // Hold the NEXT spawn until this one's config write lands (claude) / a floor gap (other).
      if (writesClaudeJson) await waitForConfigWrite(baseline)
      else await sleep(AGENT_LAUNCH_FLOOR_MS)
    })
    .catch((e) => { logInfo('title-resolve', `gated launch failed: ${String(e)}`) })
}

function startClaudeInTerminal(
  terminalId: string,
  state: TerminalState,
  sel: MenuSelection,
  immediate = false
): void {
  // New agent run in a (possibly reused) terminal: tear down the previous
  // session's title watcher so it doesn't fire for the wrong session.
  closeTitleWatch(state)
  const newState: TerminalState = {
    ...state,
    phase: 'running',
    cols: state.cols,
    rows: state.rows,
    meta: sel,
    // Drop anything tied to a previous run so title/rename don't leak across
    // sessions in a reused terminal.
    resolvedSessionId: undefined,
    titleWatcher: undefined,
    watchedTitleDir: undefined,
    watchedTitleBase: undefined,
    titleWatchTimer: undefined,
  }
  terminals.set(terminalId, newState)

  // A stub adapter (Codex) throws here. Recover by dropping back to the
  // menu so the user can pick a different agent / project, rather than
  // leaving the terminal stuck in 'running' with no PTY (the throw would
  // otherwise escape into node-pty's onExit callback as an
  // uncaughtException).
  let claude
  try {
    claude = buildLaunchCommand({
      selection: sel,
      mode: 'pty',
      dockerContextDir: getDockerContextDir(),
      preLaunch: resolveAgentPreLaunch(getAppConfig()?.agents, sel.agent),
    })
  } catch (err) {
    const wc = getWebContents(state.webContentsId)
    if (wc && !wc.isDestroyed()) {
      publishTo(wc, 'error:log', 'screen-executor', `Cannot launch ${sel.agent}: ${err instanceof Error ? err.message : String(err)}`)
      publishTo(wc, 'screen:title', terminalId, 'Menu')
    }
    const menuState: TerminalState = { ...state, phase: 'menu' }
    terminals.set(terminalId, menuState)
    spawnMenu(terminalId, menuState)
    return
  }

  let cwd = claude.cwd
  try {
    if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
      const msg = `Invalid cwd "${claude.cwd}" for ${sel.folderName}, falling back`
      console.error('[screen-executor]', msg)
      publish('error:log', 'screen-executor', msg)
      cwd = homedir()
    }
  } catch {
    console.error('[screen-executor] Error checking cwd:', claude.cwd)
    publish('error:log', 'screen-executor', `Error checking cwd: ${claude.cwd}`)
    cwd = process.env['USERPROFILE'] ?? 'C:\\'
  }

  // Serialize the actual spawn through the launch gate: a restore stampede (several
  // windows × their tabs reopening at once) would otherwise start many `claude`
  // processes simultaneously, and their concurrent read-modify-writes of ~/.claude.json
  // corrupt it. State is already set above so the tab shows as running; the PTY attaches
  // when this terminal's turn in the queue comes up. A lone launch after idle is immediate;
  // each claude waits for the previous one's config write to land before it starts.
  const writesClaudeJson = (sel.agent ?? DEFAULT_AGENT_ID) === 'claude'
  gateAgentLaunch(() => {
    // Bail if the terminal was closed or re-launched while queued behind earlier spawns.
    if (terminals.get(terminalId) !== newState) return
    // Stamp the real spawn time so the no-pid resolver (Codex) can find the rollout THIS launch
    // creates (mtime ≥ launchedAtMs) rather than an older session for the same cwd.
    newState.launchedAtMs = Date.now()
    createPty(terminalId, state.webContentsId, {
      cols: state.cols,
      rows: state.rows,
      cwd,
      command: claude.command,
      args: claude.args,
      env: {
        JAMAT: '1',
        ...claude.env
      },
      trusted: true,
      onExit: (info) => handleTerminalExit(terminalId, info)
    })

    const wc = getWebContents(state.webContentsId)
    if (wc && !wc.isDestroyed()) {
      const adapter = (() => { try { return getAgent(sel.agent) } catch { return null } })()
      const titleSuffix = adapter?.displayName ?? 'Agent'
      // Tab title is always "folderName - <name>" so it stays readable. <name> is
      // the session's custom (renamed) title when we already know the sessionId
      // (resume) — so a reopened named session shows e.g. "myproject - test"
      // — otherwise the agent name ("myproject - Claude"). A `--continue`
      // launch has no sessionId yet; the title poller upgrades it once the pid
      // resolver discovers the real session (see kickSessionIdResolution).
      const name = customTitleForSessionId(adapter, sel.dir, sel.sessionId) ?? titleSuffix
      const title = `${sel.folderName} - ${name}`
      newState.lastTitle = title
      publishTo(wc, 'screen:title', terminalId, title)
      // An agent session now owns the PTY → F1/F2 revert to app shortcuts (Help / rename session).
      publishTo(wc, 'screen:phase', terminalId, 'running')
      publishTo(wc, 'screen:refit', terminalId)
      // Arm the title watcher right away rather than waiting for the first poll
      // tick: immediately when the sessionId is known (resume), or as soon as the
      // pid resolver discovers it (--continue/cc) — so a quick `/rename` reflects
      // without the poll delay.
      applyTitle(terminalId, newState)
      kickSessionIdResolution()
      publishTo(wc, 'screen:update-params', terminalId, {
        projectDir: sel.dir,
        // Persist a cmd that reopens THIS exact session on restart. When the
        // sessionId is known (a resume), 'resume' → `claude -r <id>`; otherwise
        // 'ccc' (--continue) until the pid resolver discovers the id and rewrites
        // these params with 'resume' (see kickSessionIdResolution). Without this,
        // every restored tab did --continue and resumed the *latest* session —
        // so two tabs both reopened the newer one.
        //
        // A `resume-fork` keeps 'resume-fork' here (NOT 'resume') even though its
        // sel.sessionId (the parent) is set: until the pid resolver learns the fork's
        // own new id, a restart in that window must RE-FORK the parent — persisting
        // 'resume' would silently reopen the parent and lose the fork. The resolver
        // then rewrites these to 'resume' + the fork's real id.
        cmd: sel.cmd === 'resume-fork' ? 'resume-fork' : (sel.sessionId ? 'resume' : 'ccc'),
        folderName: sel.folderName,
        antiFlicker: sel.antiFlicker,
        // Carry through any known sessionId (resumed sessions have it set; a
        // brand-new session has it undefined until the agent writes its
        // JSONL). The renderer-side tab uses this to enable per-session
        // actions like "Rename session…" in the context menu.
        sessionId: sel.sessionId,
        // Preserve the fork parent on a restored fork tab until pid resolution updates it, so a
        // restart in this window re-forks the parent instead of failing on a transcript-less id.
        forkParentId: sel.forkParentId,
        agent: sel.agent,
      })
    }
  }, writesClaudeJson, immediate)
}

function handleAction(terminalId: string, state: TerminalState, sel: MenuSelection): void {
  const wc = getWebContents(state.webContentsId)
  const dockerCtx = getDockerContextDir()
  const actionDir = sel.dir || homedir()

  switch (sel.action) {
    case 'docker-shell': {
      const vols = buildDockerRunArgs(actionDir, dockerCtx)
      const wrapped = shellWrapArgv('docker', ['run', '-it', '--rm', ...vols, 'jamat-isolated', 'bash'])
      createPty(`action-${Date.now()}`, state.webContentsId, {
        cols: state.cols, rows: state.rows, cwd: actionDir,
        command: wrapped.file, args: wrapped.args,
        trusted: true,
      })
      spawnMenu(terminalId, state)
      break
    }
    case 'docker-rebuild': {
      const wrapped = shellWrapArgv('docker', ['build', '-t', 'jamat-isolated', dockerCtx])
      createPty(`action-${Date.now()}`, state.webContentsId, {
        cols: state.cols, rows: state.rows, cwd: actionDir,
        command: wrapped.file, args: wrapped.args,
        trusted: true,
      })
      spawnMenu(terminalId, state)
      break
    }
    case 'docker-auth': {
      const result = syncDockerCredentials(actionDir)
      if (wc && !wc.isDestroyed()) {
        publishTo(wc, 'error:log', 'screen-executor', result.message)
      }
      spawnMenu(terminalId, state)
      break
    }
    case 'custom-run': {
      const run = sel.run
      if (!run) { spawnMenu(terminalId, state); break }
      const wrapped = shellWrapArgv(run.command, run.args ?? [])
      createPty(`action-${Date.now()}`, state.webContentsId, {
        cols: state.cols, rows: state.rows, cwd: run.cwd || actionDir,
        command: wrapped.file, args: wrapped.args,
        trusted: true,
      })
      spawnMenu(terminalId, state)
      break
    }
    case 'launch-window': {
      // wt.exe (Windows Terminal) is Windows-only — gate it there and degrade gracefully elsewhere.
      if (process.platform !== 'win32') {
        if (wc && !wc.isDestroyed()) {
          publishTo(wc, 'error:log', 'screen-executor', 'Launch in a new Windows Terminal is only available on Windows.')
        }
        spawnMenu(terminalId, state)
        break
      }
      const { spawn } = require('child_process') as typeof import('child_process')
      const cmd = buildLaunchCommand({
        selection: sel, mode: 'pty', dockerContextDir: dockerCtx,
        preLaunch: resolveAgentPreLaunch(getAppConfig()?.agents, sel.agent),
      })
      const title = `${sel.folderName} - Claude`
      const child = spawn('wt.exe', [
        'new-tab', '--title', title, '-d', sel.dir,
        cmd.command, ...cmd.args,
      ], { detached: true, stdio: 'ignore', env: { ...process.env, ...cmd.env } })
      child.on('error', () => {})
      child.unref()
      spawnMenu(terminalId, state)
      break
    }
    case 'open-in-screen': {
      spawnMenu(terminalId, state)
      break
    }
    default: {
      spawnMenu(terminalId, state)
      break
    }
  }
}

function handleTerminalExit(terminalId: string, info: { exitCode: number; signal?: number }): void {
  const { exitCode, signal } = info
  const state = terminals.get(terminalId)
  if (!state || state.phase === 'closed') return

  const wc = getWebContents(state.webContentsId)

  if (state.phase === 'menu') {
    const sel = readSelection(state.selectionFile)
    if (sel && sel.action) {
      handleAction(terminalId, state, sel)
    } else if (sel && !sel.action) {
      startClaudeInTerminal(terminalId, state, sel)
    } else {
      closeTitleWatch(state)
      terminals.delete(terminalId)
      maybeStopTitlePoller()
      if (wc && !wc.isDestroyed()) {
        publishTo(wc, 'pty:exit', terminalId, exitCode)
      }
    }
  } else if (state.phase === 'running') {
    // Crash classification: code 0 = clean (/quit, /exit), SIGINT
    // (signal 2) = user-Ctrl+C — neither is a crash. node-pty may
    // also expose `signal` as undefined on Windows; in that case
    // anything non-zero counts as a crash.
    const isIntentionalExit = exitCode === 0 || signal === 2
    if (!isIntentionalExit && wc && !wc.isDestroyed()) {
      const ctr = bumpCrashCounter(terminalId)
      publishTo(wc, 'pty:crash', terminalId, exitCode, ctr.canResume, ctr.count)
    } else if (isIntentionalExit) {
      // Clean exit resets the counter so a later unrelated crash
      // doesn't inherit the prior tally.
      resetCrashCounter(terminalId)
    }

    // Session ended → stop watching its transcript for title changes.
    closeTitleWatch(state)
    const newState: TerminalState = {
      ...state, phase: 'menu',
      titleWatcher: undefined, watchedTitleDir: undefined, watchedTitleBase: undefined, titleWatchTimer: undefined,
    }
    terminals.set(terminalId, newState)

    if (wc && !wc.isDestroyed()) {
      publishTo(wc, 'screen:title', terminalId, 'Menu')
      publishTo(wc, 'screen:refit', terminalId)
    }

    spawnMenu(terminalId, newState)
  }
}

/**
 * Resume a crashed Claude session. Reuses the `meta` (MenuSelection)
 * captured at the original `restoreClaudeInTerminal` call so the user
 * gets back the same project / sessionId. Returns ok=false when the
 * terminal is unknown or has no stored meta (e.g. user-spawned Claude
 * from the menu phase that never went through `restoreClaudeInTerminal`).
 */
export function resumeClaudeInTerminal(terminalId: string): { ok: boolean; error?: string } {
  const state = terminals.get(terminalId)
  if (!state) return { ok: false, error: 'terminal not found' }
  if (!state.meta) return { ok: false, error: 'no stored selection to resume' }
  // Kill any in-flight menu pty so we don't fight with it.
  destroyPty(terminalId)
  startClaudeInTerminal(terminalId, { ...state, phase: 'menu' }, state.meta)
  return { ok: true }
}

export function updateTerminalSize(terminalId: string, cols: number, rows: number): void {
  const state = terminals.get(terminalId)
  if (state) {
    state.cols = cols
    state.rows = rows
  }
}

export function cleanupTerminal(terminalId: string): void {
  const state = terminals.get(terminalId)
  if (state) closeTitleWatch(state)
  if (state?.selectionFile && existsSync(state.selectionFile)) {
    try { unlinkSync(state.selectionFile) } catch {}
  }
  terminals.delete(terminalId)
  maybeStopTitlePoller()
  destroyPty(terminalId)
}
