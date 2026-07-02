/**
 * Remote data-parity ops — the read/write surface that lets a REMOTE viewer do the same
 * data things a LOCAL session does: modified files / session-changes, file-diff (session +
 * VCS baseline), file-view, notes, ideas. (Direction #2.)
 *
 * Design: these are thin `control:*` wrappers (so they pass the op-registry security guard,
 * which only lets `control:*`/`debug:*` be `reach:'remote'`). Each one RE-DISPATCHES to the
 * existing local IPC op (`session-changes:get`, `file:read`, `notes:save`, …) as the trusted
 * control boundary (`via:'ai'`) — the underlying ops are `reach:['ui','ai']`, so this reuses
 * their EXACT handler logic (cross-session fallback, smart diff defaults, line-number
 * attachment) with zero duplication. The local panels keep calling the raw IPC ops directly;
 * only the remote path goes through these wrappers.
 *
 * SECURITY: the file-path ops (`file-read`, `file-diff-*`, `locate-region`) are the new attack
 * surface. Every caller-supplied path is scoped to the configured project roots
 * (`getAppConfig().categories[].path`) BEFORE the re-dispatch — arbitrary remote FS reads are
 * rejected (`code:'forbidden'`). All ops are `ro` except notes/ideas save.
 */

import { registerOp } from '../../../../core/op/registry.js'
import { dispatch } from '../../../../core/op/dispatch.js'
import type { OpCtx, Result } from '../../../../core/op/types.js'
import { scopeUnderRoots } from '../../../../core/menu-core/path-scope.js'
import { getAppConfig } from '../ipc-windows'
import { expandHome } from '../ipc-files'
import { recordRemoteActivity } from '../remote-activity'
import { getTerminalCwd } from '../pty-manager'
import { getTerminalSessionId } from '../screen-executor'

const REMOTE_REACH = ['ui', 'ai', 'remote'] as const
const AUDIT_PAYLOAD_CAP = 4096

function machineOf(ctx: OpCtx): string { return ctx.machine ?? '(local)' }

/**
 * Re-dispatch to a local `['ui','ai']` IPC op as the trusted control boundary. The remote caller
 * already cleared the `control:*` remote-reach gate; running the inner op as `via:'ai'` (NOT the
 * inbound `remote`) is a deliberate, scoped elevation — the same pattern self-control uses. `via`
 * does not auto-escalate, so we set it explicitly here. corrId/machine/marker carry through for audit.
 */
function reuse(name: string, args: unknown[], ctx: OpCtx): Promise<Result> {
  return dispatch(name, args, { via: 'ai', corrId: ctx.corrId, machine: ctx.machine, marker: ctx.marker })
}

/**
 * Resolve a caller path to an absolute path under one of the configured project roots, or null if
 * it escapes every root (or no config). `~` is expanded first (peer-side home), then the pure
 * `scopeUnderRoots` guard enforces the boundary. Defense-in-depth on top of the single-key reach gate.
 */
function scopeToProjectRoots(filePath: unknown): string | null {
  const cfg = getAppConfig()
  if (!cfg) return null
  const expanded = typeof filePath === 'string' ? expandHome(filePath) : filePath
  return scopeUnderRoots(expanded, cfg.categories.map((c) => c.path))
}

/** Log a discrete remote data access/mutation to the peer's Remote Activity Log (like control:scrollback). */
function logAct(ctx: OpCtx, action: string, target: string, message: string, payload?: string): void {
  const corrId = ctx.marker
  recordRemoteActivity({
    ts: Date.now(), side: 'controlled', via: corrId ? 'ai' : 'human', machine: machineOf(ctx),
    action, target, corrId, payload: payload?.slice(0, AUDIT_PAYLOAD_CAP),
    message: `${corrId ? 'AI' : 'human'} ${message}`,
  })
}

/**
 * A path-scoped wrapper: validate `args[0]` (the filePath) against the project roots, substitute
 * the resolved absolute path, then re-dispatch to `innerOp`. `audited` reads log to the activity tab.
 */
function pathScopedOp(name: string, innerOp: string, action: string, audited: boolean): void {
  registerOp({
    name,
    meta: { summary: `Remote ${action} (path-scoped)`, reach: [...REMOTE_REACH], rw: 'ro', audit: 'never' },
    handler: (args, ctx): Promise<Result> | Result => {
      const abs = scopeToProjectRoots(args[0])
      if (!abs) return { ok: false, error: 'path outside the configured project roots', code: 'forbidden' }
      if (audited) logAct(ctx, action, abs, `${action} ${abs}`)
      return reuse(innerOp, [abs, ...args.slice(1)], ctx)
    },
  })
}

/** A plain forwarder: re-dispatch `args` verbatim to `innerOp` (no path in the payload). */
function forwardOp(name: string, innerOp: string, summary: string, rw: 'ro' | 'rw'): void {
  registerOp({
    name,
    meta: { summary, reach: [...REMOTE_REACH], rw, audit: 'never' },
    handler: (args, ctx): Promise<Result> => reuse(innerOp, args, ctx),
  })
}

export function registerRemoteDataOps(): void {
  // ── session / changes (no caller path — projectDir is resolved against ~/.claude on the peer) ──
  forwardOp('control:session-list', 'sessions:list', 'List a project\'s sessions', 'ro')
  forwardOp('control:session-edit-flags', 'sessions:edit-flags', 'Per-session has-edits flags', 'ro')
  forwardOp('control:session-changes', 'session-changes:get', 'A session\'s per-turn file changes', 'ro')

  // session-model: model id/label + context-token usage for the session running on a terminal. The
  // controller passes only the terminalId it's viewing; we resolve its cwd (pty-manager) + sessionId
  // (screen-executor) SERVER-SIDE (never a caller path), then forward to the local session-model:get.
  // Lets a remote viewer show the peer session's model + context % in the status bar, same as local.
  registerOp({
    name: 'control:session-model',
    meta: { summary: 'Model + context usage for a terminal\'s session', reach: [...REMOTE_REACH], rw: 'ro', audit: 'never' },
    handler: (args, ctx): Promise<Result> | Result => {
      const terminalId = args[0]
      if (typeof terminalId !== 'string') return { ok: false, error: 'bad terminalId', code: 'bad_args' }
      const dir = getTerminalCwd(terminalId)
      if (!dir) return { ok: true, data: null } // unknown / non-streamable terminal → no model
      return reuse('session-model:get', [dir, getTerminalSessionId(terminalId)], ctx)
    },
  })

  // ── file diff + view + locate (caller path → scoped to project roots) ──
  pathScopedOp('control:file-diff-options', 'file-diff:list-options', 'diff-options', false)
  pathScopedOp('control:file-diff-baseline', 'file-diff:get-baseline', 'diff-baseline', true)
  pathScopedOp('control:file-read', 'file:read', 'file-read', true)
  pathScopedOp('control:locate-region', 'session-changes:locate-region', 'locate-region', false)
  // file-type is the open-file menu gate: returns 'file'|'dir'|null so the viewer only offers
  // "Open" for a real file. Read-only metadata (no content), so audit:'never' (a poll, not access).
  pathScopedOp('control:file-type', 'file:type', 'file-type', false)
  // list-recent backs the remote viewer's Recent Files sidebar — recently modified files in the
  // peer tab's project dir. Path-scoped on the dir; read-only metadata listing, so audit:'never'.
  pathScopedOp('control:list-recent', 'file:list-recent', 'list-recent', false)

  // ── notes (keyed by panelId == projectDir; read + write) ──
  forwardOp('control:notes-load', 'notes:load', 'Load a project\'s notes', 'ro')
  registerOp({
    name: 'control:notes-save',
    meta: { summary: 'Save a project\'s notes', reach: [...REMOTE_REACH], rw: 'rw', audit: 'never' },
    handler: (args, ctx): Promise<Result> => {
      logAct(ctx, 'notes-save', String(args[0] ?? ''), `saved notes for ${String(args[0] ?? '')}`)
      return reuse('notes:save', args, ctx)
    },
  })

  // ── ideas (keyed by windowId — per peer window, not per project; read + write) ──
  forwardOp('control:ideas-load', 'ideas:load', 'Load a window\'s ideas', 'ro')
  registerOp({
    name: 'control:ideas-save',
    meta: { summary: 'Save a window\'s ideas', reach: [...REMOTE_REACH], rw: 'rw', audit: 'never' },
    handler: (args, ctx): Promise<Result> => {
      logAct(ctx, 'ideas-save', String(args[0] ?? ''), `saved ideas for window ${String(args[0] ?? '')}`)
      return reuse('ideas:save', args, ctx)
    },
  })
}
