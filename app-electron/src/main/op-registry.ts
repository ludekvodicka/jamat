/**
 * The composition root for the op layer (plan 002): the single place where app-electron registers
 * every domain op/stream into the core registry, and wires the packaged flag into dispatch. P0 only
 * sets the packaged flag (no domain ops yet); P1 registers the 60 IPC ops, P2 the control/debug/
 * bridge ops, P3 the streams, P5 the menu ops. core/ never imports this; this imports core/.
 */

import { app } from 'electron'
import { setPackaged } from '../../../core/op/dispatch.js'
import { listOps } from '../../../core/op/registry.js'
import { logError } from './logger'
import { registerControlOps } from './ops/control-ops'
import { registerRemoteDataOps } from './ops/remote-data-ops'
import { registerDebugOps } from './ops/debug-ops'
import { registerBridgeOps } from './ops/bridge-ops'
import { registerMenuOps } from './ops/menu-ops'
import { registerAllStreams } from './streams'

export function registerAllOps(): void {
  setPackaged(app.isPackaged)
  // The 60 IPC ops auto-registered themselves via typed-ipc.registerHandler/registerSend (P1).
  // P2 adds the HTTP/WS-surface ops behind the same dispatch chokepoint:
  registerControlOps() // 7 control ops, reach ['ui','ai','remote']
  registerRemoteDataOps() // 11 control:* data-parity ops (file/diff/changes/notes/ideas), reach ['ui','ai','remote'], file paths scoped to project roots
  registerDebugOps()   // ~22 debug ops, reach ['ui','ai','remote'] (UI can debug a peer; +devOnly on build/stats)
  registerBridgeOps()  // 10 jamat verbs, reach ['ui','ai'] (local-only — no transitive peer→peer)
  registerMenuOps()    // menu:list + menu:invoke, reach ['ui','ai'] (local/self drive the native menu; not remote)
  // P3: the IpcEventMap streams behind the publish/publishTo façade (P5 added the 17 menu:* too).
  registerAllStreams()

  // Security guard (review 027g): the ONLY LAN-reachable ops are the control + debug families
  // (reach 'remote'). A new op accidentally tagged reach:'remote' outside those prefixes is a
  // surface drift — make it loud at startup instead of a silent expansion.
  const stray = listOps().filter((o) => o.reach.includes('remote') && !o.name.startsWith('control:') && !o.name.startsWith('debug:'))
  if (stray.length) {
    const msg = `SECURITY: unexpected remote-reachable ops (expected only control:*/debug:*): ${stray.map((o) => o.name).join(', ')}`
    logError('op-registry', msg)
    // Fail the boot loudly in dev (caught by the registerAllOps try/catch → app.quit) so a stray
    // remote surface can't ship unnoticed; packaged builds only log (don't crash a user's app).
    if (!app.isPackaged) throw new Error(msg)
  }
}
