import type { ControllerLeaseResult, HostOpName } from '../../app-host/app/wire/hostWire.js'
import type { HostDebugStatus } from '../sessionManager/sessionManagerApi.types'
import { ErrorText } from '../shared/errorText'
import type { HostCallResult } from './hostClient.types'

export interface ControllerLeaseKeeperDeps {
  controllerId: string
  call: <T>(name: HostOpName, body: Record<string, unknown>) => Promise<HostCallResult<T>>
  onError: (message: string) => void
}

/**
 * The writer authority, held for as long as this client is attached to a Host. The Host grants a TTL
 * and every mutation is checked against it, so the only useful thing to do with a lease is to keep
 * renewing it before it lapses.
 *
 * **Every network operation goes through one chain**, and that is what makes `stop()` mean
 * something. The Host grants a lease before its answer reaches us, so a `stop()` that only looked at
 * what had already landed released nothing and left the Host controlled by a client that no longer
 * exists until the TTL lapsed: measured on 2026-08-25 as 8 failures in 24 loaded runs. The release
 * is therefore QUEUED BEHIND whatever acquire or renew is in flight, and a grant that arrives while
 * a stop is pending is still recorded, precisely so the queued release has something to send.
 *
 * `stop()` carries no deadline of its own. The bound is `AbortSignal.timeout` inside
 * `HostHttpClient`, which never rejects and answers unreachability as a value; a second deadline
 * here would be a second place deciding the same thing. A Host that accepts a connection and never
 * answers can therefore make an awaited `stop()` take as long as those calls do, which is a known
 * and accepted cost of releasing authority properly rather than leaving it to the TTL.
 */
export class ControllerLeaseKeeper {
  private static readonly minimumRenewMillisecondsConst = 250
  private static readonly retryMillisecondsConst = 1_000
  /**
   * Stamped onto every queued task and every timer. A `start()` against another Host raises it, and
   * a task that comes back holding an older stamp knows its answer belongs to a Host this keeper has
   * already left.
   */
  private generation = 0
  private running = false
  /** The last grant the Host holds for us, kept until a release consumes it. */
  private grant: ControllerLeaseResult | null = null
  private chain: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private failureReported = false

  constructor(private readonly deps: ControllerLeaseKeeperDeps) {}

  /**
   * Take the lease at the Host reachable now, dropping whatever an earlier Host granted. A restarted
   * Host does not know the old lease id, so carrying it over would only buy a 409 on the first
   * mutation instead of an honest `no-lease` until this succeeds.
   */
  async start(): Promise<void> {
    this.clearTimer()
    this.grant = null
    this.generation += 1
    this.running = true
    const generation = this.generation
    await this.enqueue(() => this.acquireTask(generation))
  }

  /** The id a mutation must carry, or null. An expired lease is no lease, and nothing queues. */
  leaseId(): string | null {
    if (!this.running || this.grant === null) return null
    if (this.grant.expiresAt <= Date.now()) return null
    return this.grant.controllerLeaseId
  }

  /**
   * The authority as it stands. `leaseId` is what a mutation would get, so an expired lease reads as
   * none while `expiresAt` still says when it lapsed - which is the whole diagnosis.
   */
  debugView(): HostDebugStatus['lease'] {
    return {
      controllerId: this.deps.controllerId,
      leaseId: this.leaseId(),
      expiresAt: this.grant?.expiresAt ?? null,
    }
  }

  /**
   * Detach: joins whatever lease call is in flight and releases what the Host ends up holding. A
   * client killed hard still leaves the lease to expire by its TTL, but that is the crash path and
   * not this one.
   */
  async stop(): Promise<void> {
    this.running = false
    this.clearTimer()
    await this.enqueue(() => this.releaseTask())
  }

  /**
   * One ordered lane for every lease call. The chain swallows its own rejections so one failed task
   * cannot poison the tasks behind it; the caller still sees its own.
   */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  private async acquireTask(generation: number): Promise<void> {
    if (generation !== this.generation) return
    const result = await this.deps.call<ControllerLeaseResult>(
      'controller.acquire',
      { controllerId: this.deps.controllerId },
    )
    if (generation !== this.generation) return
    if (result.ok) {
      // Recorded even when a stop is already pending: the queued release is what consumes it, and
      // the answer is the only carrier of the id the Host is holding for us.
      this.grant = result.value
      this.failureReported = false
      this.schedule(generation, ControllerLeaseKeeper.renewDelay(result.value.expiresAt))
      return
    }
    this.grant = null
    if (!this.running) return
    this.report(`The Host controller lease could not be taken: ${result.detail}`)
    this.schedule(generation, ControllerLeaseKeeper.retryMillisecondsConst)
  }

  private async renewTask(generation: number): Promise<void> {
    if (generation !== this.generation || !this.running) return
    const lease = this.grant
    if (lease === null) return this.acquireTask(generation)
    const renewed = await this.deps.call<ControllerLeaseResult>(
      'controller.renew',
      { controllerLeaseId: lease.controllerLeaseId },
    )
    if (generation !== this.generation) return
    if (renewed.ok) {
      this.grant = renewed.value
      this.failureReported = false
      this.schedule(generation, ControllerLeaseKeeper.renewDelay(renewed.value.expiresAt))
      return
    }
    // A refused renew means the lease is gone, not that this client stops being the writer: taking
    // it again is the whole job. Unless a stop landed while the renew was in flight, in which case
    // taking it again would hand the Host authority nobody is left to use.
    this.grant = null
    if (!this.running) return
    await this.acquireTask(generation)
  }

  /** Whatever the Host is holding for us goes back, whichever generation asked for it. */
  private async releaseTask(): Promise<void> {
    const lease = this.grant
    this.grant = null
    if (lease === null) return
    await this.deps.call('controller.release', { controllerLeaseId: lease.controllerLeaseId })
  }

  /**
   * Half of what the Host actually granted, never a constant of ours: the TTL is the Host's to
   * choose, and a client renewing on its own schedule lets the lease lapse the day the Host shortens
   * it.
   */
  private static renewDelay(expiresAt: number): number {
    return Math.max(
      ControllerLeaseKeeper.minimumRenewMillisecondsConst,
      Math.floor((expiresAt - Date.now()) / 2),
    )
  }

  private schedule(generation: number, delay: number): void {
    this.clearTimer()
    if (!this.running || generation !== this.generation) return
    this.timer = setTimeout(() => {
      this.timer = null
      // Nobody waits for a renew, so anything escaping it would be an unhandled rejection in the
      // client's main process rather than a line the user can read.
      void this.enqueue(() => this.renewTask(generation)).catch((error) =>
        this.deps.onError(`The Host controller lease renew failed: ${ErrorText.of(error)}`))
    }, delay)
    this.timer.unref()
  }

  private clearTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }

  /** Said once per failing stretch: the retry would otherwise report every second. */
  private report(message: string): void {
    if (this.failureReported) return
    this.failureReported = true
    this.deps.onError(message)
  }
}
