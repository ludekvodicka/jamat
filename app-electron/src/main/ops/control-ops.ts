/**
 * Control ops — the LAN-reachable Remote App Control surface, as registry ops.
 *
 * These were the 7 `CONTROL_OPS` handlers inside `control-server.ts`'s request
 * handler (plan 002 P2). They now live in the op registry with
 * `reach: ['ui','ai','remote']` — the ONLY ops a remote peer (`via:'remote'`) may
 * invoke. Localhost (`via:'ai'`) and the renderer (`via:'ui'`) reach them too, so
 * the local AI/self-control and the UI drive the SAME ops (no parallel code path).
 *
 * Each handler returns `data` = the EXACT JSON body V1's control-server sent on
 * success; the op-server's `/control/*` adapter sends that verbatim and maps a
 * failure `code` to the V1 HTTP status (`bad_args`→400, `not_found`→404,
 * `too_large`→413, `no_window`→500). Transport concerns (rate-limit, session
 * indicator, `signalActivity`) stay in the op-server; per-action AUDIT
 * (`recordRemoteActivity`) stays here. `ctx.marker` = the X-Jamat corrId
 * (AI-origin flag for the log), `ctx.machine` = the controller's label.
 */

import { BrowserWindow } from 'electron'
import path from 'node:path'
import { homedir } from 'node:os'
import { existsSync, promises as fsp } from 'node:fs'
import { registerOp } from '../../../../core/op/registry.js'
import type { OpCtx, Result } from '../../../../core/op/types.js'
import { getRemoteControl, getSelfName } from '../remote-control-store'
import { getWindowsTabs, getTabStatus } from '../tab-tree-cache'
import { parseInstanceId } from '../../../../core/instance-id.js'
import {
  writeToPty, getTerminalSnapshot, getTerminalDeltaSince, hasBufferedTerminal, getTerminalCwd,
} from '../pty-manager'
import { getTerminalSessionId } from '../screen-executor'
import { getAppConfig, getAppVersion } from '../ipc-windows'
import { publish, publishTo } from '../streams'
import { recordRemoteActivity } from '../remote-activity'
import type { OpenTabReq, ControlOpenTabPayload } from '../../../../core/types/remote-control.js'

const MAX_KEYS_BYTES = 4096       // per write-keys payload cap (a keystroke burst, not a file)
const MAX_TASK_BYTES = 256 * 1024 // per put-task file cap (a delegated task, not a keystroke)
const AUDIT_PAYLOAD_CAP = 4096    // bytes of payload kept per activity entry

const REMOTE_REACH = ['ui', 'ai', 'remote'] as const

/** A controller-label fallback for the audit log (in-proc/UI callers have no machine). */
function machineOf(ctx: OpCtx): string { return ctx.machine ?? '(local)' }

// ── open-tab resolution (server-owned paths; never trust a caller path) ──────

function isValidName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0
    && !name.includes('..') && !name.includes('/') && !name.includes('\\')
    && !path.isAbsolute(name)
}

/** Clean a caller `label` into a safe display folder name (control chars stripped, capped). */
function cleanLabel(label: unknown): string | undefined {
  if (typeof label !== 'string') return undefined
  const clean = label.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
  return clean || undefined
}

/** Validate a caller-chosen dockview panel id (charset + length). */
function validTerminalId(id: unknown): string | undefined {
  return typeof id === 'string' && /^[A-Za-z0-9_:-]{1,128}$/.test(id) ? id : undefined
}

/** Resolve + validate an open-tab request server-side (never trust the path). */
function resolveOpenTab(r: OpenTabReq): ControlOpenTabPayload | null {
  if (!r || (r.tabType !== 'claude' && r.tabType !== 'cmd' && r.tabType !== 'powershell')) return null
  // FORK: resolve BOTH the parent session id and the cwd from the caller-addressed terminal
  // (never a wire-supplied id/path — same discipline as `sameAs`). Forces a Claude fork tab.
  if (r.forkOf) {
    const sessionId = getTerminalSessionId(r.forkOf)
    const dir = getTerminalCwd(r.forkOf)
    if (!sessionId || !dir || !existsSync(dir)) return null
    return {
      tabType: 'claude',
      cwd: dir,
      folderName: cleanLabel(r.label) ?? `${path.basename(dir)} (fork)`,
      terminalId: validTerminalId(r.terminalId),
      cmd: 'resume-fork',
      sessionId,
      activate: r.activate,
    }
  }
  let cwd: string | undefined
  let folderName: string | undefined
  if (r.sameAs) {
    const dir = getTerminalCwd(r.sameAs)
    if (!dir || !existsSync(dir)) return null
    cwd = dir
    folderName = path.basename(dir)
  } else if (r.scratch) {
    const dir = getRemoteControl().bridgeScratchDir || homedir()
    if (!existsSync(dir)) return null
    cwd = dir
    folderName = 'scratch'
  } else if (r.category && r.project) {
    const cfg = getAppConfig()
    const cat = cfg?.categories.find((c) => c.label === r.category)
    if (!cat) return null
    if (!isValidName(r.project)) return null
    const resolved = path.resolve(cat.path, r.project)
    if (!resolved.startsWith(path.resolve(cat.path) + path.sep)) return null
    if (!existsSync(resolved)) return null
    cwd = resolved
    folderName = r.project
  }
  const labelName = cleanLabel(r.label)
  if (labelName) folderName = labelName
  const command = typeof r.command === 'string' ? r.command.slice(0, MAX_KEYS_BYTES) : undefined
  const terminalId = validTerminalId(r.terminalId)
  return { tabType: r.tabType, cwd, folderName, command, terminalId, activate: r.activate }
}

/** The controlled window to open a tab in: the requested one (by webContents.id), else focused/first. */
function resolveTargetWindow(windowId?: number): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows()
  if (typeof windowId === 'number') {
    const w = wins.find((win) => win.webContents.id === windowId)
    if (w) return w
  }
  return BrowserWindow.getFocusedWindow() ?? wins[0] ?? null
}

// ── the 7 control ops ────────────────────────────────────────────────────────

export function registerControlOps(): void {
  // windows — poll (refreshes the tab list); `version` rides along. Not audited (noise).
  registerOp({
    name: 'control:windows',
    meta: { summary: 'List this machine\'s windows/tabs', reach: [...REMOTE_REACH], rw: 'ro', audit: 'never' },
    handler: (): Result => ({ ok: true, data: { ok: true, windows: getWindowsTabs(), version: getAppVersion() } }),
  })

  // resolve-instance — map a copyable tab instance id (`<machine>:<folder>-<rand>`) to the tab's
  // CURRENT live terminalId (+ sessionId/cwd/status). Read-only: it only reveals the handle so a
  // second LLM can then `scrollback`/`write-keys` it. `found:false` (still ok) when the tab is gone
  // or the id targets a different machine (`wrongMachine`).
  registerOp({
    name: 'control:resolve-instance',
    meta: { summary: 'Resolve a tab instance id to its live terminalId', reach: [...REMOTE_REACH], rw: 'ro', audit: 'never' },
    handler: (args): Result => {
      const body = (args[0] ?? {}) as any
      const instanceId = body?.instanceId
      const parsed = parseInstanceId(instanceId)
      if (!parsed) return { ok: false, error: 'bad instanceId', code: 'bad_args' }
      const self = getSelfName().toLowerCase()
      for (const w of getWindowsTabs()) {
        for (const t of w.tabs) {
          if (t.instanceId && t.instanceId === instanceId) {
            return { ok: true, data: {
              ok: true, found: true, instanceId,
              terminalId: t.terminalId, sessionId: t.sessionId, cwd: t.cwd,
              title: t.title, status: t.status, alive: t.streamable, windowId: w.windowId, machine: self,
            } }
          }
        }
      }
      // Not found: distinguish "wrong machine" (the caller should target peer `parsed.machine`) from "gone".
      return { ok: true, data: { ok: true, found: false, instanceId, machine: self, wrongMachine: parsed.machine.toLowerCase() !== self } }
    },
  })

  // scrollback — ring snapshot (one-shot peek, logged) or delta since a cursor (the
  // AI await-loop, NOT logged). Folds the tab's Claude turn-status into the reply.
  registerOp({
    name: 'control:scrollback',
    meta: { summary: 'Read a terminal\'s scrollback (snapshot or delta)', reach: [...REMOTE_REACH], rw: 'ro', audit: 'never' },
    handler: (args, ctx): Result => {
      const body = (args[0] ?? {}) as any
      const terminalId = body?.terminalId
      if (typeof terminalId !== 'string') return { ok: false, error: 'bad args', code: 'bad_args' }
      const sinceSeq = body?.sinceSeq
      if (sinceSeq !== undefined && (!Number.isInteger(sinceSeq) || sinceSeq < 0)) {
        return { ok: false, error: 'sinceSeq must be a non-negative integer', code: 'bad_args' }
      }
      const snap = typeof sinceSeq === 'number'
        ? getTerminalDeltaSince(terminalId, sinceSeq)
        : getTerminalSnapshot(terminalId)
      if (!snap) return { ok: false, error: 'unknown terminal', code: 'not_found' }
      if (sinceSeq === undefined) {
        const corrId = ctx.marker
        recordRemoteActivity({
          ts: Date.now(), side: 'controlled', via: corrId ? 'ai' : 'human', machine: machineOf(ctx),
          action: 'scrollback', target: terminalId, corrId,
          message: `${corrId ? 'AI' : 'human'} read screen of ${terminalId}`,
        })
      }
      return { ok: true, data: { ok: true, ...snap, status: getTabStatus(terminalId) } }
    },
  })

  // write-keys — one-shot keystroke injection (AI `send`/`unblock`). Logged via recordRemoteActivity
  // (dispatch audit:'never' — the handler logs directly with the corrId, avoiding a double entry).
  registerOp({
    name: 'control:write-keys',
    meta: { summary: 'Inject keystrokes into a terminal', reach: [...REMOTE_REACH], rw: 'rw', audit: 'never' },
    handler: (args, ctx): Result => {
      const body = (args[0] ?? {}) as any
      const terminalId = body?.terminalId
      const data = body?.data
      if (typeof terminalId !== 'string' || typeof data !== 'string') return { ok: false, error: 'bad args', code: 'bad_args' }
      if (!hasBufferedTerminal(terminalId)) return { ok: false, error: 'unknown terminal', code: 'not_found' }
      const bytes = data.slice(0, MAX_KEYS_BYTES)
      writeToPty(terminalId, bytes)
      const corrId = ctx.marker
      recordRemoteActivity({
        ts: Date.now(), side: 'controlled', via: corrId ? 'ai' : 'human', machine: machineOf(ctx),
        action: 'write-keys', target: terminalId, payload: bytes.slice(0, AUDIT_PAYLOAD_CAP), corrId,
        message: `${corrId ? 'AI' : 'human'} injection (${bytes.length} chars)`,
      })
      return { ok: true, data: { ok: true } }
    },
  })

  // open-tab — resolve + validate server-side, then ask a window to open it.
  registerOp({
    name: 'control:open-tab',
    meta: { summary: 'Open a tab (claude/cmd/powershell) in a window', reach: [...REMOTE_REACH], rw: 'rw', audit: 'never' },
    handler: (args, ctx): Result => {
      const body = (args[0] ?? {}) as OpenTabReq
      const payload = resolveOpenTab(body)
      if (!payload) return { ok: false, error: 'invalid open-tab (bad tabType/category/project)', code: 'bad_args' }
      const win = resolveTargetWindow((body as OpenTabReq)?.windowId)
      if (!win) return { ok: false, error: 'no window', code: 'no_window' }
      publishTo(win.webContents, 'control:open-tab', payload)
      const corrId = ctx.marker
      recordRemoteActivity({
        ts: Date.now(), side: 'controlled', via: corrId ? 'ai' : 'human', machine: machineOf(ctx),
        action: 'open-tab', target: payload.terminalId ?? payload.tabType,
        payload: payload.command?.slice(0, AUDIT_PAYLOAD_CAP), corrId,
        message: `${corrId ? 'AI' : 'human'} open-tab (${payload.tabType}${payload.terminalId ? ` → ${payload.terminalId}` : ''})`,
      })
      return { ok: true, data: { ok: true } }
    },
  })

  // close-tab — broadcast; the window holding the panel closes it.
  registerOp({
    name: 'control:close-tab',
    meta: { summary: 'Close a tab by terminalId', reach: [...REMOTE_REACH], rw: 'rw', audit: 'never' },
    handler: (args, ctx): Result => {
      const body = (args[0] ?? {}) as any
      const terminalId = body?.terminalId
      if (typeof terminalId !== 'string' || !/^[A-Za-z0-9_:-]{1,128}$/.test(terminalId)) return { ok: false, error: 'bad args', code: 'bad_args' }
      if (!hasBufferedTerminal(terminalId)) return { ok: false, error: 'unknown terminal', code: 'not_found' }
      publish('control:close-tab', { terminalId })
      const corrId = ctx.marker
      recordRemoteActivity({
        ts: Date.now(), side: 'controlled', via: corrId ? 'ai' : 'human', machine: machineOf(ctx),
        action: 'close-tab', target: terminalId, corrId,
        message: `${corrId ? 'AI' : 'human'} close-tab (${terminalId})`,
      })
      return { ok: true, data: { ok: true } }
    },
  })

  // put-task — drop a delegated task FILE under this machine's scratch dir (large-payload path).
  registerOp({
    name: 'control:put-task',
    meta: { summary: 'Drop a delegated-task file in the scratch dir', reach: [...REMOTE_REACH], rw: 'rw', audit: 'never' },
    handler: async (args, ctx): Promise<Result> => {
      const body = (args[0] ?? {}) as any
      const corrId = body?.corrId
      const text = body?.text
      if (typeof corrId !== 'string' || !/^[\w-]{1,128}$/.test(corrId)) return { ok: false, error: 'bad corrId', code: 'bad_args' }
      if (typeof text !== 'string') return { ok: false, error: 'bad args', code: 'bad_args' }
      if (Buffer.byteLength(text, 'utf-8') > MAX_TASK_BYTES) return { ok: false, error: 'task too large', code: 'too_large' }
      const dir = path.join(getRemoteControl().bridgeScratchDir || homedir(), '.jamat-tasks')
      const file = path.join(dir, `${corrId}.md`)
      try {
        await fsp.mkdir(dir, { recursive: true })
        await fsp.writeFile(file, text, 'utf-8')
      } catch (e: any) { return { ok: false, error: `write failed: ${String(e?.message ?? e)}`, code: 'write_failed' } }
      const marker = ctx.marker
      recordRemoteActivity({
        ts: Date.now(), side: 'controlled', via: marker ? 'ai' : 'human', machine: machineOf(ctx),
        action: 'put-task', target: `${corrId}.md`, corrId: marker, payload: text.slice(0, AUDIT_PAYLOAD_CAP),
        message: `${marker ? 'AI' : 'human'} dropped task file (${Buffer.byteLength(text, 'utf-8')} bytes)`,
      })
      return { ok: true, data: { ok: true, path: file } }
    },
  })

  // get-answer — read the delegated remote's answer FILE if it chose the file channel. Polled (not logged).
  registerOp({
    name: 'control:get-answer',
    meta: { summary: 'Read a delegated-task answer file', reach: [...REMOTE_REACH], rw: 'ro', audit: 'never' },
    handler: async (args): Promise<Result> => {
      const body = (args[0] ?? {}) as any
      const corrId = body?.corrId
      if (typeof corrId !== 'string' || !/^[\w-]{1,128}$/.test(corrId)) return { ok: false, error: 'bad corrId', code: 'bad_args' }
      const file = path.join(getRemoteControl().bridgeScratchDir || homedir(), '.jamat-tasks', `${corrId}.answer.md`)
      try { return { ok: true, data: { ok: true, found: true, text: await fsp.readFile(file, 'utf-8') } } }
      catch { return { ok: true, data: { ok: true, found: false } } }
    },
  })
}
