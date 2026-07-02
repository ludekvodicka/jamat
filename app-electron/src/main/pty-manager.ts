import * as pty from 'node-pty'
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { getWebContents, isAllowedShell } from './electron-utils'
import { publishTo } from './streams'
import { computeRingDelta } from '../../../core/ring-delta'
import { defaultShell } from '../../../core/platform-shell.js'

interface PtyEntry {
  process: pty.IPty
  webContentsId: number
  /** Resolved spawn (launch) cwd — surfaced to Remote App Control so a caller can
   *  see where a session runs and open a new one in the same dir (`open --same-as`). */
  cwd: string
}

const ptys = new Map<string, PtyEntry>()

// ── Remote App Control: per-terminal scrollback ring + live fan-out ──
// The main process already sees every PTY's output here (in `proc.onData`), so
// the control-server taps a bounded ring buffer (snapshot-on-subscribe) plus a
// live event stream — no renderer round-trip, faithful raw ANSI. The buffer
// deliberately SURVIVES PTY exit (marked `alive:false`) so a crashed/finished
// Claude tab is still viewable remotely; it is cleared only on `destroyPty`
// (panel close). Bounded so many terminals can't grow memory without limit.

/** One streamed event for a subscribed remote viewer. */
export type PtyStreamEvent =
  | { type: 'data'; delta: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'exit' }

interface TerminalBuffer {
  ring: string
  cols: number
  rows: number
  alive: boolean
  /**
   * Total chars ever appended (monotonic; NOT reset by the ring trim). Lets a
   * caller capture a cursor before injecting a prompt and later fetch exactly the
   * output produced since — the foundation of the Jamat's answer-delta.
   */
  seq: number
}

const MAX_RING = 256 * 1024
const buffers = new Map<string, TerminalBuffer>()
const streamEmitter = new EventEmitter()
streamEmitter.setMaxListeners(0) // any number of remote viewers may subscribe

function resetBuffer(id: string, cols: number, rows: number): void {
  buffers.set(id, { ring: '', cols, rows, alive: true, seq: 0 })
}

function appendBuffer(id: string, data: string): void {
  const b = buffers.get(id)
  if (!b) return
  b.ring += data
  b.seq += data.length
  if (b.ring.length > MAX_RING) {
    // Trim to the ring cap, but advance the cut to the next newline so a snapshot
    // can't start mid-ANSI-escape (cosmetic garble of the first screenful). Bounded
    // search so a single very long line doesn't drop most of the buffer.
    let cut = b.ring.length - MAX_RING
    const nl = b.ring.indexOf('\n', cut)
    if (nl !== -1 && nl - cut < 4096) cut = nl + 1
    b.ring = b.ring.slice(cut)
  }
  streamEmitter.emit(`data:${id}`, data)
}

/** Recent scrollback + geometry + the monotonic `seq` cursor. Null if no buffer. */
export function getTerminalSnapshot(id: string): { data: string; cols: number; rows: number; alive: boolean; seq: number } | null {
  const b = buffers.get(id)
  if (!b) return null
  return { data: b.ring, cols: b.cols, rows: b.rows, alive: b.alive, seq: b.seq }
}

/**
 * Output appended since `sinceSeq` (exclusive). `truncated` is true when the
 * requested start fell off the 256 KB ring (the answer overflowed it) — the
 * caller then gets the whole retained ring, not a clean delta.
 */
export function getTerminalDeltaSince(
  id: string,
  sinceSeq: number,
): { data: string; cols: number; rows: number; alive: boolean; seq: number; truncated: boolean } | null {
  const b = buffers.get(id)
  if (!b) return null
  const { data, truncated } = computeRingDelta(b.ring, b.seq, sinceSeq)
  return { data, cols: b.cols, rows: b.rows, alive: b.alive, seq: b.seq, truncated }
}

/** Subscribe to live events for one terminal. Returns an unsubscribe fn. */
export function subscribeTerminal(id: string, cb: (ev: PtyStreamEvent) => void): () => void {
  const onData = (delta: string) => cb({ type: 'data', delta })
  const onResize = (cols: number, rows: number) => cb({ type: 'resize', cols, rows })
  const onExit = () => cb({ type: 'exit' })
  streamEmitter.on(`data:${id}`, onData)
  streamEmitter.on(`resize:${id}`, onResize)
  streamEmitter.on(`exit:${id}`, onExit)
  return () => {
    streamEmitter.off(`data:${id}`, onData)
    streamEmitter.off(`resize:${id}`, onResize)
    streamEmitter.off(`exit:${id}`, onExit)
  }
}

/** True when a (live or exited-but-retained) buffer exists for this terminal. */
export function hasBufferedTerminal(id: string): boolean {
  return buffers.has(id)
}

/**
 * Exit reasons surfaced by `createPty`'s `onExit` callback. `signal` is
 * present when the OS terminated the process via a signal (SIGINT from
 * Ctrl+C, SIGSEGV from crash, etc.); on Windows it's the platform's
 * signal mapping which node-pty exposes opaquely. Consumers classify
 * "clean exit (code 0 or SIGINT)" vs "crash" themselves.
 */
export interface PtyExitInfo {
  exitCode: number
  signal: number | undefined
}

export function createPty(
  terminalId: string,
  webContentsId: number,
  config: {
    cols: number
    rows: number
    cwd?: string
    command?: string
    args?: string[]
    env?: Record<string, string>
    onExit?: (info: PtyExitInfo) => void
    trusted?: boolean
  }
): void {
  if (ptys.has(terminalId)) {
    try { ptys.get(terminalId)!.process.kill() } catch {}
    ptys.delete(terminalId)
  }

  const env = { ...process.env, ...(config.env ?? {}) } as Record<string, string>
  const shell = config.command ?? defaultShell()
  const args = config.args ?? []

  if (!config.trusted && !isAllowedShell(shell)) {
    console.error(`[pty-manager] Blocked disallowed shell: ${shell}`)
    return
  }

  const cols = Math.max(1, Math.min(config.cols, 500))
  const rows = Math.max(1, Math.min(config.rows, 200))

  const cwd = config.cwd ?? homedir()
  const proc = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env
  })

  ptys.set(terminalId, { process: proc, webContentsId, cwd })
  resetBuffer(terminalId, cols, rows) // fresh scrollback per spawn (menu→claude reuses id)

  proc.onData((data: string) => {
    appendBuffer(terminalId, data)
    const wc = getWebContents(webContentsId)
    if (wc && !wc.isDestroyed()) {
      publishTo(wc, 'pty:output', terminalId, data)
    }
  })

  proc.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
    const current = ptys.get(terminalId)
    if (current?.process !== proc) return
    ptys.delete(terminalId)
    // Keep the ring buffer (mark not-alive) so a crashed/finished tab stays
    // viewable remotely; notify any subscribed viewers the stream ended.
    const buf = buffers.get(terminalId)
    if (buf) buf.alive = false
    streamEmitter.emit(`exit:${terminalId}`)
    if (config.onExit) {
      config.onExit({ exitCode, signal })
    } else {
      const wc = getWebContents(webContentsId)
      if (wc && !wc.isDestroyed()) {
        publishTo(wc, 'pty:exit', terminalId, exitCode)
      }
    }
  })
}

export function writeToPty(terminalId: string, data: string): void {
  ptys.get(terminalId)?.process.write(data)
}

export function resizePty(terminalId: string, cols: number, rows: number): void {
  try {
    const c = Math.max(1, Math.min(cols, 500))
    const r = Math.max(1, Math.min(rows, 200))
    ptys.get(terminalId)?.process.resize(c, r)
    const b = buffers.get(terminalId)
    if (b) { b.cols = c; b.rows = r; streamEmitter.emit(`resize:${terminalId}`, c, r) }
  } catch {}
}

export function destroyPty(terminalId: string): void {
  const entry = ptys.get(terminalId)
  if (entry) {
    entry.process.kill()
    ptys.delete(terminalId)
  }
  // Panel closed → drop the retained buffer and end any remote stream.
  if (buffers.delete(terminalId)) streamEmitter.emit(`exit:${terminalId}`)
}

export function destroyAll(): void {
  for (const [id, entry] of ptys) {
    entry.process.kill()
    ptys.delete(id)
  }
  for (const id of buffers.keys()) streamEmitter.emit(`exit:${id}`)
  buffers.clear()
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Per-PTY budget for a graceful exit: time for the agent to flush + quit before we hard-kill it.
 *  Experimentally short (100ms) — if it proves too tight (corrupt config) the startup
 *  claude-json-repair still heals it; bump this back up if corruption persists. */
const GRACEFUL_EXIT_PER_PTY_MS = 100

/**
 * Gracefully shut every PTY down ONE AT A TIME (the exit-side twin of the startup spawn-gate).
 *
 * A hard `destroyAll()` TerminateProcess's every `claude` mid-write, leaving `~/.claude.json`
 * with a stale trailing tail (interrupted in-place write) → "additional text after JSON" corruption;
 * killing them all at once makes several corrupt it together. Instead we walk the PTYs serially:
 * send a double Ctrl-C (Claude Code flushes `~/.claude.json` and quits on it; a shell just cancels
 * its line — harmless), wait briefly for the flush + exit, THEN hard-kill whatever remains. Serial
 * so two agents never flush the shared file concurrently. Always resolves (best-effort).
 */
export async function gracefulDestroyAll(): Promise<void> {
  for (const [id, entry] of [...ptys]) {
    try { entry.process.write('\x03') } catch { /* already gone */ }
    await sleep(40)
    try { entry.process.write('\x03') } catch { /* already gone */ }
    await sleep(GRACEFUL_EXIT_PER_PTY_MS)
    try { entry.process.kill() } catch { /* already exited on its own */ }
    ptys.delete(id)
  }
  for (const id of buffers.keys()) streamEmitter.emit(`exit:${id}`)
  buffers.clear()
}

export function listPtys(): { id: string; pid: number }[] {
  return Array.from(ptys.entries()).map(([id, entry]) => ({
    id,
    pid: entry.process.pid
  }))
}

/** OS pid of the pty's spawned process (the shell). Undefined when unknown. */
export function getPtyPid(terminalId: string): number | undefined {
  return ptys.get(terminalId)?.process.pid
}

/** The resolved spawn (launch) cwd of a terminal. Undefined when no such pty.
 *  Note: the launch dir, NOT a live `cd`-tracked cwd. */
export function getTerminalCwd(terminalId: string): string | undefined {
  return ptys.get(terminalId)?.cwd
}
