/**
 * THE one choke point (plan 002 D5). Every caller — renderer (IPC, `ui`), local AI (in-proc, `ai`),
 * remote peer (HTTP/WS, `remote`) — funnels through here. Order: name lookup (closed-by-default) →
 * REACH check (which vias may invoke) → devOnly check (packaged builds) → positional validate →
 * handler → audit → Result. Never throws across the boundary.
 *
 * `via` is set by the transport adapter, never read from args. A handler that re-dispatches passes
 * its own `ctx` through, so `via` never escalates (a remote-originated chain stays `remote`).
 *
 * `devOnly` needs `app.isPackaged`, which is electron — core/ stays electron-free, so app-electron
 * injects it once at startup via `setPackaged()`.
 */

import { getOp } from './registry.js'
import { validateArgs } from './validate.js'
import { recordAudit } from './audit.js'
import type { OpCtx, Result } from './types.js'

let packaged = false
/** app-electron calls this once at startup with `app.isPackaged`. */
export function setPackaged(v: boolean): void { packaged = v }

function auditFail(ctx: OpCtx, op: string, note: string, rw?: string): void {
  recordAudit({ via: ctx.via, corrId: ctx.corrId, op, ok: false, rw, machine: ctx.machine, note })
}

export async function dispatch(name: string, args: unknown[] = [], ctx: OpCtx): Promise<Result> {
  const op = getOp(name)
  if (!op) {
    auditFail(ctx, name, 'no_op')
    return { ok: false, error: `unknown op: ${name}`, code: 'no_op' }
  }

  // REACH — which transports may invoke this op (preserves V1's actual reach; closed-by-default).
  if (!op.meta.reach.includes(ctx.via)) {
    auditFail(ctx, name, 'reach_denied', op.meta.rw)
    return { ok: false, error: `op "${name}" not reachable via "${ctx.via}"`, code: 'reach_denied' }
  }

  // devOnly — reject in packaged builds (preserves V1's app.isPackaged guard on shell/dev ops).
  if (op.meta.devOnly && packaged) {
    auditFail(ctx, name, 'dev_only', op.meta.rw)
    return { ok: false, error: `op "${name}" is dev-only`, code: 'dev_only' }
  }

  const v = validateArgs(op.meta.params, args)
  if (!v.ok) {
    auditFail(ctx, name, 'bad_args', op.meta.rw)
    return { ok: false, error: v.error, code: 'bad_args' }
  }

  try {
    const result = await op.handler(v.args, ctx)
    if (op.meta.audit === 'discrete') {
      recordAudit({ via: ctx.via, corrId: ctx.corrId, op: name, ok: result.ok, rw: op.meta.rw, machine: ctx.machine })
    }
    return result
  } catch (e: any) {
    auditFail(ctx, name, 'threw', op.meta.rw)
    return { ok: false, error: String(e?.message ?? e), code: 'threw' }
  }
}
