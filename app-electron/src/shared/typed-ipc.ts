/**
 * Typed wrappers around the IPC primitives + the op-layer bridge (plan 002).
 *
 * Renderer side: `invokeChannel`/`sendChannel` route through ONE op channel (`'op'`/`'opSend'`)
 * → the main `dispatch` chokepoint (via:'ui'); `onChannel` subscribes raw like the other stream
 * listeners (main-side emits go through the `streams.ts` façade). Signatures are unchanged, so the
 * preload shim and every renderer call site are byte-identical.
 *
 * Main side: `registerHandler`/`registerSend` register the handler AS AN OP (wrapping the existing
 * body) so the same handler is reachable by ui (IPC), ai (in-proc), and — for the control/debug/menu
 * set — remote. `mountOpAdapter()` mounts the SINGLE renderer→main IPC entry (`'op'`/`'opSend'`):
 * there is no per-channel `ipcMain.handle` anymore, so the dispatch chokepoint is structural.
 *
 * import-safe in renderer + preload + main (each function imports only what it uses at the call site).
 */

import { ipcRenderer, ipcMain, webContents, type IpcMainInvokeEvent, type IpcMainEvent, type IpcRendererEvent } from 'electron'
import type {
  IpcInvokeMap, IpcSendMap, IpcEventMap,
  IpcInvokeArgs, IpcInvokeResult, IpcSendArgs, IpcEventArgs,
} from '../../../core/types/ipc-contracts'
import { registerOp } from '../../../core/op/registry'
import { dispatch } from '../../../core/op/dispatch'
import type { OpCtx } from '../../../core/op/types'

export type EmitArgs<K extends keyof IpcEventMap> = Parameters<IpcEventMap[K]>

// ────────────────────────────────────────────────────────────────────────────
// Renderer side — invoke/send route through the op chokepoint
// ────────────────────────────────────────────────────────────────────────────

/** Invoke an op over IPC (via:'ui'). Unwraps the Result: returns `data`, throws on `ok:false`
 *  (matching V1's `ipcRenderer.invoke` reject-on-handler-throw). Business `{ok,error}` returns
 *  flow through as `data` (the handler's normal value), so error UX is unchanged. */
export function invokeChannel<K extends keyof IpcInvokeMap>(
  channel: K,
  ...args: IpcInvokeArgs<K>
): Promise<IpcInvokeResult<K>> {
  return ipcRenderer.invoke('op', channel, args).then((r: { ok: boolean; data?: unknown; error?: string; code?: string }) => {
    if (!r || r.ok === false) {
      const msg = r?.error ?? `op "${String(channel)}" failed`
      // A real main-handler throw (code:'threw') reproduces V1's Electron wrapper so renderer code
      // matching on err.message stays byte-identical; op-layer rejections (reach/validate) stay plain.
      throw new Error(r?.code === 'threw' ? `Error invoking remote method '${String(channel)}': ${msg}` : msg)
    }
    return r.data as IpcInvokeResult<K>
  })
}

/** Fire-and-forget send of an op over IPC (via:'ui'). One-way (no awaited round-trip) — keeps the
 *  hot paths (`pty:write`, `pty:resize`, `remote:stream-send-keys`) cheap. */
export function sendChannel<K extends keyof IpcSendMap>(
  channel: K,
  ...args: IpcSendArgs<K>
): void {
  ipcRenderer.send('opSend', channel, args)
}

/** Typed `ipcRenderer.on` for a main→renderer push channel. Unchanged in P1 (events stay raw). */
export function onChannel<K extends keyof IpcEventMap>(
  channel: K,
  callback: (...args: IpcEventArgs<K>) => void,
): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]) => callback(...(args as IpcEventArgs<K>))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

// ────────────────────────────────────────────────────────────────────────────
// Main side — handlers register as ops; the single op adapter dispatches
// ────────────────────────────────────────────────────────────────────────────

/** The write channels — their ops are `rw` for audit (mutate / spawn / persist). `abilities:manage`
 *  is the first ~/.claude mutator; like every IPC channel its reach is ['ui','ai'] (never remote). */
const WRITE_CHANNELS = new Set<string>([
  'file:write', 'file:open-in-vscode', 'commit:open-dialog', 'commit:open-log', 'notes:save', 'ideas:save',
  'group:create', 'group:rename', 'sessions:rename', 'session-description:save', 'sessions:open-in-tab', 'layout:save', 'pty:resume',
  'abilities:manage', 'usage:set-credentials', 'clipboard:write-text',
  'config:update', 'dialog:pick-directory', 'onboarding:complete',
])

/** Reconstruct the IpcMainInvokeEvent the existing handlers expect from the op ctx's senderId. The
 *  6 sender-dependent channels (pty/screen create+restore, file:watch, tabs:push, remote:stream-open)
 *  read `event.sender`; for ui calls senderId is set, so they get the real webContents. */
function synthEvent(ctx: OpCtx): IpcMainInvokeEvent {
  const sender = ctx.senderId != null ? webContents.fromId(ctx.senderId) : undefined
  return { sender } as unknown as IpcMainInvokeEvent
}

/** Register one IPC channel as an op wrapping the existing handler body. IPC channels are never
 *  network-reachable in V1, so reach = ['ui','ai']; the 'remote' set (control-server ops) is
 *  registered in P2. */
function registerChannelOp(channel: string, run: (ev: IpcMainInvokeEvent, args: unknown[]) => unknown, isSend: boolean): void {
  registerOp({
    name: channel,
    meta: { reach: ['ui', 'ai'], rw: isSend || WRITE_CHANNELS.has(channel) ? 'rw' : 'ro' },
    handler: async (args, ctx) => {
      const data = await run(synthEvent(ctx), args)
      return { ok: true, data: isSend ? undefined : data }
    },
  })
}

/** Register an invoke channel's handler AS AN OP. The renderer reaches it only via the `'op'`
 *  adapter → dispatch — there is no per-channel `ipcMain.handle` (single chokepoint, structural). */
export function registerHandler<K extends keyof IpcInvokeMap>(
  channel: K,
  handler: (event: IpcMainInvokeEvent, ...args: IpcInvokeArgs<K>) => IpcInvokeResult<K> | Promise<IpcInvokeResult<K>>,
): void {
  const erased = handler as (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
  registerChannelOp(channel, (ev, args) => erased(ev, ...args), false)
}

/** Register a fire-and-forget send channel's handler AS AN OP (reached only via the `'opSend'` adapter). */
export function registerSend(
  channel: keyof IpcSendMap,
  handler: (event: IpcMainEvent, ...args: any[]) => void,
): void {
  registerChannelOp(channel, (ev, args) => { handler(ev as unknown as IpcMainEvent, ...args) }, true)
}

let opSeq = 0
/** Mount the single renderer entry into the op layer. Call once at startup (after the domain
 *  `register*Ipc()` calls have registered their ops). */
export function mountOpAdapter(): void {
  ipcMain.handle('op', (e, name: string, args: unknown[]) =>
    dispatch(name, Array.isArray(args) ? args : [], { via: 'ui', corrId: `ipc-${e.sender.id}-${++opSeq}`, senderId: e.sender.id }),
  )
  ipcMain.on('opSend', (e, name: string, args: unknown[]) => {
    void dispatch(name, Array.isArray(args) ? args : [], { via: 'ui', corrId: `ipc-${e.sender.id}-${++opSeq}`, senderId: e.sender.id })
  })
}

// Main→renderer stream emits go through the stream façade (`app-electron/src/main/streams.ts`
// `publish`/`publishTo`/`publishToFocused`), registered in the core stream registry. `EmitArgs` is
// exported above for that façade's typed signatures.
