/**
 * The op + stream registry — a closed-by-default, null-prototype map populated at startup by
 * `app-electron/src/main/op-registry.ts` (only known ops are registered → closed-by-default).
 * Lookups use `Object.hasOwn`, so an unknown / prototype-polluting name (`__proto__`, `constructor`)
 * never resolves. There is NO runtime/reflective dispatcher — the V1 `/debug/ipc-call` RCE class
 * cannot recur. core/ owns the registry; it never imports app-electron (app imports core + registers).
 */

import type { Op, Stream } from './types.js'

const OPS: Record<string, Op> = Object.create(null)
const STREAMS: Record<string, Stream> = Object.create(null)

export function registerOp(op: Op): void {
  if (Object.hasOwn(OPS, op.name)) throw new Error(`duplicate op: ${op.name}`)
  OPS[op.name] = op
}

export function registerStream(stream: Stream): void {
  if (Object.hasOwn(STREAMS, stream.name)) throw new Error(`duplicate stream: ${stream.name}`)
  STREAMS[stream.name] = stream
}

export function getOp(name: string): Op | undefined {
  return Object.hasOwn(OPS, name) ? OPS[name] : undefined
}

export function getStream(name: string): Stream | undefined {
  return Object.hasOwn(STREAMS, name) ? STREAMS[name] : undefined
}

/** Capability discovery (for `ops:list` / `menu:list` / remote introspection). */
export function listOps() {
  return Object.values(OPS).map((o) => ({
    name: o.name, reach: o.meta.reach, rw: o.meta.rw, devOnly: !!o.meta.devOnly, summary: o.meta.summary, menu: o.meta.menu,
  }))
}

export function listStreams() {
  return Object.values(STREAMS).map((s) => ({ name: s.name, reach: s.meta.reach, summary: s.meta.summary }))
}

/** Test-only: clear the registry between smoke runs. */
export function _resetRegistryForTests(): void {
  for (const k of Object.keys(OPS)) delete OPS[k]
  for (const k of Object.keys(STREAMS)) delete STREAMS[k]
}
