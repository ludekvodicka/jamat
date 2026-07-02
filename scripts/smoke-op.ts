/**
 * P0 op-core smoke (plan 002) — proves the substrate: dispatch + reach gate + devOnly gate +
 * positional validate + closed-by-default + no via-escalation. No domains wired yet.
 *
 *   npm run smoke:op
 */

import { registerOp, _resetRegistryForTests } from '../core/op/registry.js'
import { dispatch, setPackaged } from '../core/op/dispatch.js'
import type { OpCtx } from '../core/op/types.js'

let pass = 0
let fail = 0
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log('  ✓', name) } else { fail++; console.log('  ✗', name) }
}
const remoteCtx = (): OpCtx => ({ via: 'remote', corrId: 'smoke' })

async function main(): Promise<void> {
  _resetRegistryForTests()
  setPackaged(false)

  registerOp({ name: 'demo:echo', meta: { reach: ['ui', 'ai'], params: [{ type: 'string' }] }, handler: (a) => ({ ok: true, data: a[0] }) })
  registerOp({ name: 'demo:remote', meta: { reach: ['ui', 'ai', 'remote'] }, handler: () => ({ ok: true, data: 'r' }) })
  registerOp({ name: 'demo:dev', meta: { reach: ['ui', 'ai'], devOnly: true }, handler: () => ({ ok: true, data: 'd' }) })
  registerOp({ name: 'demo:viacheck', meta: { reach: ['ui', 'ai', 'remote'] }, handler: (_a, ctx) => ({ ok: true, data: ctx.via }) })
  registerOp({ name: 'demo:redispatch', meta: { reach: ['ui', 'ai', 'remote'] }, handler: (a, ctx) => dispatch('demo:viacheck', a, ctx) })

  // The "in-proc transport" is just dispatch with via:'ai' (no separate abstraction).
  const inproc = { op: (name: string, args: unknown[] = []) => dispatch(name, args, { via: 'ai', corrId: 'smoke' }) }

  const e = await inproc.op('demo:echo', ['hi'])
  check('in-proc op works (via ai)', e.ok === true && (e as any).data === 'hi')

  const reach = await dispatch('demo:echo', ['x'], remoteCtx())
  check('REACH: remote CANNOT reach a [ui,ai] op', reach.ok === false && (reach as any).code === 'reach_denied')

  const rok = await dispatch('demo:remote', [], remoteCtx())
  check('REACH: remote CAN reach a remote-tagged op', rok.ok === true)

  const unk = await inproc.op('nope:nope')
  check('unknown op rejected (no_op)', unk.ok === false && (unk as any).code === 'no_op')
  const proto = await inproc.op('__proto__')
  check('adversarial __proto__ rejected', proto.ok === false && (proto as any).code === 'no_op')
  const ctor = await inproc.op('constructor')
  check('adversarial constructor rejected', ctor.ok === false && (ctor as any).code === 'no_op')

  setPackaged(true)
  const dev = await inproc.op('demo:dev')
  check('devOnly op rejected when packaged', dev.ok === false && (dev as any).code === 'dev_only')
  setPackaged(false)
  const devok = await inproc.op('demo:dev')
  check('devOnly op allowed in dev', devok.ok === true)

  const badType = await inproc.op('demo:echo', [123])
  check('positional validate rejects wrong type', badType.ok === false && (badType as any).code === 'bad_args')
  const missing = await inproc.op('demo:echo', [])
  check('positional validate rejects missing required arg', missing.ok === false && (missing as any).code === 'bad_args')

  // via non-escalation: a remote-originated re-dispatch must STAY remote (never become ui/ai).
  const reVia = await dispatch('demo:redispatch', [], remoteCtx())
  check('via does NOT escalate on re-dispatch (stays remote)', reVia.ok === true && (reVia as any).data === 'remote')

  console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'} (${pass}/${pass + fail}) ===`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
