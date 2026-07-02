/**
 * Stream façade (plan 002 P3) — the single chokepoint every `IpcEventMap` push funnels
 * through, mirroring `dispatch` for ops. `publish` broadcasts to all renderer windows;
 * `publishTo`/`publishToFocused` target one window. They keep the EXACT V1 local mechanics
 * (same channel name + targeting, renderer `onX` untouched).
 *
 * The 33 streams (16 IpcEventMap + 17 menu:*) are registered in the core registry for DISCOVERY
 * + reach metadata (`listStreams`) — all `['ui','ai']` local renderer events. Streams are
 * published LOCALLY only; there is no remote stream subscriber yet (the PTY *remote* stream is a
 * separate ring/`seq`-backed path on the control WS in `op-server.ts`). `subscribe` is therefore a
 * no-op stub — wire a real one (over the op-server) when a remote/in-proc stream consumer arrives.
 */

import { BrowserWindow, type WebContents } from 'electron'
import { registerStream } from '../../../core/op/registry.js'
import type { Via } from '../../../core/op/types.js'
import type { IpcEventMap } from '../../../core/types/ipc-contracts.js'
import type { EmitArgs } from '../shared/typed-ipc'

/** Broadcast a stream to every renderer window. */
export function publish<K extends keyof IpcEventMap>(channel: K, ...args: EmitArgs<K>): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args)
}

/** Send a stream to ONE webContents. No-op if it's gone. */
export function publishTo<K extends keyof IpcEventMap>(wc: WebContents, channel: K, ...args: EmitArgs<K>): void {
  if (!wc.isDestroyed()) wc.send(channel, ...args)
}

/** Send a stream to the FOCUSED window. Used by the native menu click handlers + the menu:invoke
 *  op (a menu action targets the focused window). No-op if there's no focused window. */
export function publishToFocused<K extends keyof IpcEventMap>(channel: K, ...args: EmitArgs<K>): void {
  const win = BrowserWindow.getFocusedWindow()
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

// The IpcEventMap streams — all local renderer events → reach ['ui','ai']. (P5 added the
// 17 menu:* streams, ending the P1/P3 carve-out.)
const STREAM_NAMES: readonly (keyof IpcEventMap)[] = [
  'pty:output', 'pty:exit', 'pty:crash',
  'screen:title', 'screen:refit', 'screen:update-params', 'screen:open-tab',
  'file:changed', 'group:color-changed', 'error:log', 'usage:update', 'config:changed',
  'control:open-tab', 'control:close-tab',
  'remote:stream-frame', 'remote:session-active', 'remote:activity',
  'menu:new-tab', 'menu:new-tab-picker', 'menu:close-tab', 'menu:toggle-sidebar',
  'menu:toggle-notes', 'menu:toggle-maximize', 'menu:set-theme', 'menu:help',
  'menu:move-tab', 'menu:reset-layout', 'menu:settings', 'menu:new-tab-type',
  'menu:open-session-history', 'menu:open-file-changes', 'menu:open-sessions-search', 'menu:open-ideas',
]
const UI_AI: Via[] = ['ui', 'ai']

/** Register all local streams in the core registry (called once from the composition root). */
export function registerAllStreams(): void {
  for (const name of STREAM_NAMES) {
    registerStream({
      name,
      meta: { reach: [...UI_AI] },
      // No-op: streams are published locally (publish*/onX); no remote subscriber yet (see header).
      subscribe: () => () => {},
    })
  }
}
