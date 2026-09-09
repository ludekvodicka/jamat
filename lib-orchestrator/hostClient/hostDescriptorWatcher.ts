import { readFile } from 'node:fs/promises'

import type { HostDescriptor } from '../../app-host/app/wire/hostWire.js'
import type { HostDebugStatus } from '../sessionManager/sessionManagerApi.types'
import { ErrorText } from '../shared/errorText'

export interface HostDescriptorWatcherDeps {
  descriptorFile: string
  /** Called on every transition only: a Host that keeps running is not news on every poll. */
  onChange: (descriptor: HostDescriptor | null) => void
  onError: (message: string) => void
  pollMilliseconds?: number
}

/**
 * The one thing that says whether a Host exists. The Host publishes its descriptor with tmp+rename,
 * so a read is either the whole previous file or the whole new one; a missing file is a Host that is
 * not running, which is a state and never an error.
 */
export class HostDescriptorWatcher {
  private static readonly defaultPollMillisecondsConst = 500
  private timer: ReturnType<typeof setInterval> | null = null
  private raw: string | null = null
  private descriptorValue: HostDescriptor | null = null
  private reading = false

  constructor(private readonly deps: HostDescriptorWatcherDeps) {}

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(
      () => this.detach(this.read()),
      this.deps.pollMilliseconds ?? HostDescriptorWatcher.defaultPollMillisecondsConst,
    )
    this.timer.unref()
    this.detach(this.read())
  }

  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  current(): HostDescriptor | null {
    return this.descriptorValue
  }

  /** The watch as the debug surface may see it: where it looks, how often, and at what. */
  debugView(): HostDebugStatus['watcher'] {
    return {
      descriptorFile: this.deps.descriptorFile,
      pollMilliseconds:
        this.deps.pollMilliseconds ?? HostDescriptorWatcher.defaultPollMillisecondsConst,
      identity: HostDescriptorWatcher.debugIdentityOf(this.descriptorValue),
    }
  }

  /** One read, awaited. The poll drives it; a caller that cannot wait a tick calls it directly. */
  async read(): Promise<void> {
    // A slow or contended disk must not stack reads behind each other, where the older answer would
    // land last and reinstate a descriptor that is already gone.
    if (this.reading) return
    this.reading = true
    try {
      let raw: string
      try {
        raw = await readFile(this.deps.descriptorFile, 'utf8')
      } catch {
        this.settle(null, null)
        return
      }
      if (raw === this.raw) return
      this.settle(raw, this.parse(raw))
    } finally {
      this.reading = false
    }
  }

  /**
   * The end of a read nobody waits for. `onChange` runs the client's whole reaction to a Host
   * appearing or going away - the session manager recomposes its snapshot in there, and that has
   * throws of its own - twice a second, on a timer with no caller. As a bare `void` an escape from
   * one of those becomes an unhandled rejection and takes the client's main process with it.
   */
  private detach(work: Promise<void>): void {
    void work.catch((error) =>
      this.deps.onError(`The Host descriptor watch failed: ${ErrorText.of(error)}`))
  }

  private settle(raw: string | null, descriptor: HostDescriptor | null): void {
    const changed = HostDescriptorWatcher.identityOf(this.descriptorValue)
      !== HostDescriptorWatcher.identityOf(descriptor)
    this.raw = raw
    this.descriptorValue = descriptor
    if (changed) this.deps.onChange(descriptor)
  }

  private static identityOf(descriptor: HostDescriptor | null): string | null {
    if (descriptor === null) return null
    return `${descriptor.hostInstanceId}:${descriptor.port}:${descriptor.token}`
  }

  /**
   * The same transition minus the token, and it is a second function on purpose: `identityOf` has to
   * keep the token, because a Host that reissued one is a Host to reconnect to, and this one has to
   * drop it, because the token is main-only and never leaves for a surface to draw.
   */
  private static debugIdentityOf(descriptor: HostDescriptor | null): string | null {
    if (descriptor === null) return null
    return `${descriptor.hostInstanceId}:${descriptor.port}`
  }

  private parse(raw: string): HostDescriptor | null {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.reportDamage(`is not JSON (${ErrorText.of(error)})`)
      return null
    }
    const problem = HostDescriptorWatcher.problemOf(parsed)
    if (problem !== null) {
      this.reportDamage(problem)
      return null
    }
    return parsed as HostDescriptor
  }

  /** Only what a call needs is checked: the rest of the descriptor is the Host's to describe. */
  private static problemOf(parsed: unknown): string | null {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return 'is not an object'
    const descriptor = parsed as Partial<HostDescriptor>
    if (descriptor.schemaVersion !== 1)
      return `has an unsupported schema version ${JSON.stringify(descriptor.schemaVersion)}`
    if (!Number.isInteger(descriptor.port) || (descriptor.port ?? 0) <= 0)
      return 'has no usable port'
    if (typeof descriptor.token !== 'string' || descriptor.token.length === 0)
      return 'has no token'
    if (typeof descriptor.hostInstanceId !== 'string' || descriptor.hostInstanceId.length === 0)
      return 'has no hostInstanceId'
    return null
  }

  /**
   * Once per damaged content, not once per poll: unchanged bytes are never parsed twice, so the
   * line repeats only when the file itself is written again, which the Host does at boot.
   */
  private reportDamage(problem: string): void {
    this.deps.onError(`The Host descriptor at ${this.deps.descriptorFile} ${problem}`)
  }
}
