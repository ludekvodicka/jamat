/**
 * The op/stream layer's core types. Pure data — no electron, no HTTP, no UI (core/ is zero-dep).
 *
 * POSITIONAL model (plan 002 D1): an op handler takes the IPC channel's positional `args` tuple
 * 1:1, so the renderer shim is a generic passthrough (`op(name, [...args])`) with no per-channel
 * arg-name table. Every op also carries `meta.reach` (which transports may invoke it — the
 * parity+security core) and optional `devOnly`/`audit` flags enforced in dispatch.
 */

/** Every op returns a Result — never throws across the transport boundary. */
export type Result<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string }

/** Who is calling. Stamped by the transport adapter, never read from args, never escalated. */
export type Via = 'ui' | 'ai' | 'remote'

export interface OpCtx {
  via: Via
  corrId: string
  /** Originating webContents id (the `ui`/IPC transport injects it). The 6 sender-dependent
   *  channels read it; the 3 object-needing ones reconstruct `webContents.fromId(senderId)`. */
  senderId?: number
  /** Remote controller label (audit). */
  machine?: string
  /** X-Jamat corrId from the inbound request (audit). */
  marker?: string
}

/** One positional argument's spec (validated by core/op/validate.ts). */
export interface ArgSpec {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any'
  /** A trailing optional arg (e.g. `limit?`, `opts?`). */
  optional?: boolean
  /** The last spec may absorb all remaining args (e.g. `action:run(action, ...args)`). */
  rest?: boolean
}
/** Positional arg specs, one per parameter (optional — an op may skip validation). */
export type ParamSchema = ArgSpec[]

export interface MenuMeta { label: string; group?: string; accelerator?: string }

export interface OpMeta {
  summary?: string
  /** Which transports (vias) may invoke this op. Default `['ui','ai']`; only V1-network-reachable
   *  ops get `'remote'`. Enforced in dispatch AFTER name lookup. */
  reach: Via[]
  /** Audit/log hint only. */
  rw?: 'ro' | 'rw'
  /** Reject when the app is packaged (preserves V1's `app.isPackaged → 403` on shell/dev ops). */
  devOnly?: boolean
  /** Dispatch-level audit policy. `'discrete'` → log on success; default/`'never'` → success not
   *  logged (polls/per-keystroke don't flood). Failures (incl. reach/dev denials) are always logged. */
  audit?: 'discrete' | 'never'
  /** Positional arg specs. */
  params?: ParamSchema
  kind?: 'op' | 'stream'
  /** If set, the op is also a menu command (`menu:list`/`menu:invoke`). */
  menu?: MenuMeta
}

export interface Op {
  name: string
  handler: (args: unknown[], ctx: OpCtx) => Promise<Result> | Result
  meta: OpMeta
}

export type Emit<E> = (event: E) => void
export type Unsubscribe = () => void

export interface Stream {
  name: string
  subscribe: (args: unknown[], emit: Emit<unknown>, ctx: OpCtx) => Unsubscribe
  meta: { summary?: string; reach: Via[]; params?: ParamSchema }
}

// Note: there is no separate `Transport` abstraction. "In-proc" reaching the op layer is just
// `dispatch(name, args, { via:'ai', … })`; the IPC and HTTP/WS adapters call `dispatch` directly
// too. Self-control (core/jamat/http.ts) dispatches directly because it threads `ctx.marker`
// (AI-origin audit), which a generic `op(name, args)` signature wouldn't carry.
