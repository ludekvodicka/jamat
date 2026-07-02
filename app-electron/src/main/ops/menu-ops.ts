/**
 * Menu ops (plan 002 P5) — make the native menu enumerable + invokable through the op layer.
 *
 * The native Electron menu's click handlers publish `menu:<action>` streams to the focused
 * window (see ipc-windows). These ops expose the SAME actions to the op layer: `menu:list`
 * enumerates them, `menu:invoke(action, …args)` triggers one (publishing the same stream to
 * the focused window) — so the UI + the local AI/self can drive menu actions exactly as a human
 * clicking the menu would. Reach is `['ui','ai']` — deliberately NOT remote: the menu is a
 * local/self surface (a remote peer drives a peer's tabs via `control:open-tab`, not its menu;
 * and `menu:set-theme` triggers a renderer reload). Closed-by-default: only the known actions
 * are accepted (`MENU_ACTIONS`), never an arbitrary channel.
 */

import { registerOp } from '../../../../core/op/registry.js'
import type { Result } from '../../../../core/op/types.js'
import { publishToFocused } from '../streams'
import type { IpcEventMap } from '../../../../core/types/ipc-contracts.js'

/** The menu actions (the `menu:` channel suffix). Mirrors the native menu template + the
 *  preload `onMenuAction` allowlist. `set-theme`/`move-tab`/`new-tab-type` take one string arg. */
const MENU_ACTIONS = [
  'new-tab', 'new-tab-picker', 'close-tab', 'toggle-sidebar', 'toggle-notes', 'toggle-maximize',
  'set-theme', 'help', 'move-tab', 'reset-layout', 'settings', 'new-tab-type',
  'open-session-history', 'open-file-changes', 'open-sessions-search', 'open-ideas',
] as const

const REACH = ['ui', 'ai'] as const

export function registerMenuOps(): void {
  registerOp({
    name: 'menu:list',
    meta: { summary: 'List the invokable menu actions', reach: [...REACH], rw: 'ro', audit: 'never' },
    handler: (): Result => ({ ok: true, data: { ok: true, actions: MENU_ACTIONS } }),
  })

  registerOp({
    name: 'menu:invoke',
    meta: {
      summary: 'Trigger a menu action on the focused window',
      reach: [...REACH], rw: 'rw', audit: 'discrete',
      params: [{ type: 'string' }, { type: 'any', optional: true, rest: true }],
    },
    handler: (args): Result => {
      const action = String(args[0] ?? '')
      if (!(MENU_ACTIONS as readonly string[]).includes(action)) {
        return { ok: false, error: `unknown menu action: ${action}`, code: 'bad_args' }
      }
      // The channel is `menu:<known-action>` (validated above); publish it to the focused
      // window exactly as the native click handler does. Loose cast: the dynamic key resolves
      // to a union of EmitArgs, and the extra args are forwarded verbatim.
      ;(publishToFocused as (c: keyof IpcEventMap, ...a: unknown[]) => void)(`menu:${action}` as keyof IpcEventMap, ...args.slice(1))
      return { ok: true, data: { ok: true, action } }
    },
  })
}
