/**
 * What this subsystem can observe of the Host, in its own words. The wire shapes are the Host's and
 * are imported from `app-host/app/wire/hostWire.ts`; nothing here restates one.
 */
import type { HostHello } from '../../app-host/app/wire/hostWire.js'

/**
 * `starting` is missing on purpose: it is hostControl's overlay while a spawn is in flight, and this
 * client cannot tell a Host that is booting from one that will never come.
 */
export type HostConnectionPresence = 'running' | 'unreachable'

export type HostCallErrorCode = 'host-unreachable' | 'no-lease' | 'op-rejected'

/**
 * `op-rejected` carries the status the Host answered with, and carries it as a required field.
 *
 * The status is the only thing that separates a refusal of the REQUEST from a refusal that is the
 * Host's condition at that moment - a capacity ceiling, a shutdown, a lapsed lease, a fault of its
 * own - and a caller deciding the fate of a record cannot tell those apart from one collapsed code.
 * Required rather than optional so that a caller constructing this shape has to say what the Host
 * answered instead of leaving a blank that classifies itself.
 *
 * The other two codes have no status because nothing answered: `host-unreachable` never reached the
 * Host, and `no-lease` is refused inside this client before any request is sent.
 */
export type HostCallFailure =
  | { ok: false; code: 'host-unreachable' | 'no-lease'; detail: string }
  | { ok: false; code: 'op-rejected'; status: number; detail: string }

export type HostCallResult<T = void> =
  | { ok: true; value: T }
  | HostCallFailure

/**
 * A ping: what the Host said about itself, and how long it took to say it. The latency is measured
 * around the request rather than reported by the Host, because what is being asked is whether this
 * client can still get an answer out of it at all.
 */
export interface HostHelloReading {
  hello: HostHello
  latencyMilliseconds: number
}
